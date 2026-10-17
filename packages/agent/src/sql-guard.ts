import sqlParser from "node-sql-parser";
import { ensureMetadataSchema, getPool, getReadOnlyPool } from "../../db/src/pool.js";
import { quoteIdentifier } from "../../importer/src/identifiers.js";

const { Parser } = sqlParser;
const parser = new Parser();
const maxRows = Number(process.env.MAX_QUERY_ROWS ?? 500);
const timeoutMs = Number(process.env.QUERY_TIMEOUT_MS ?? 10_000);

type TableAccess = { tableName: string; columns: Set<string> };

export type QueryExecution = {
  datasetId: string;
  sql: string;
  explanation: string;
};

function astObjects(value: unknown, visit: (object: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) astObjects(item, visit);
    return;
  }
  const object = value as Record<string, unknown>;
  visit(object);
  for (const child of Object.values(object)) astObjects(child, visit);
}

function aliasesFor(value: unknown) {
  const aliases = new Map<string, string>();
  astObjects(value, (object) => {
    if (!("db" in object) || !("table" in object)) return;
    const table = object.table;
    if (typeof table === "string") {
      const actual = table.toLowerCase();
      aliases.set(typeof object.as === "string" ? object.as.toLowerCase() : actual, actual);
    } else if (table && typeof table === "object") {
      const name = (table as Record<string, unknown>).value;
      if (typeof name === "string") aliases.set(typeof object.as === "string" ? object.as.toLowerCase() : name.toLowerCase(), name.toLowerCase());
    }
  });
  return aliases;
}

function ensureReadOnlySelect(sql: string) {
  if (sql.length > 100_000) throw new Error("The query exceeds the SQL length limit.");
  const astValue = parser.astify(sql, { database: "Postgresql" });
  const statements = Array.isArray(astValue) ? astValue : [astValue];
  if (statements.length !== 1) throw new Error("Only one SQL statement is allowed.");
  const statement = statements[0] as Record<string, unknown>;
  if (statement.type !== "select") throw new Error("Only read-only SELECT queries are allowed.");
  if (statement.into && typeof statement.into === "object" && (statement.into as Record<string, unknown>).position) {
    throw new Error("SELECT INTO is not allowed.");
  }
  const columnRefs: string[] = parser.columnList(sql, { database: "Postgresql" });
  if (columnRefs.some((reference) => reference.endsWith("::(.*)"))) {
    throw new Error("Wildcard columns are not allowed. List the columns you need.");
  }
  return statement;
}

function applyRowLimit(statement: Record<string, unknown>) {
  const limit = statement.limit as { value?: Array<{ type?: string; value?: number | string }> } | null;
  const value = limit?.value?.[0];
  const numericLimit = value ? Number(value.value) : null;
  if (!limit || !Array.isArray(limit.value) || limit.value.length === 0 || !Number.isFinite(numericLimit) || numericLimit > maxRows) {
    statement.limit = { seperator: "", value: [{ type: "number", value: maxRows + 1 }] };
  }
  return parser.sqlify(statement, { database: "Postgresql" });
}

export async function runAnalyticsQuery({ datasetId, sql }: QueryExecution) {
  await ensureMetadataSchema();
  const metadata = await getPool().query(
    `SELECT d.schema_name, d.status, t.table_name, c.column_name, c.sensitive
     FROM datasets d
     JOIN dataset_tables t ON t.dataset_id = d.id
     JOIN dataset_columns c ON c.table_id = t.id
     WHERE d.id = $1`,
    [datasetId],
  );
  if (metadata.rowCount === 0) throw new Error("Dataset not found or has no queryable columns.");
  const schemaName = metadata.rows[0].schema_name as string;
  if (metadata.rows[0].status !== "ready") throw new Error("Dataset is not ready for queries.");

  const tables = new Map<string, TableAccess>();
  for (const row of metadata.rows) {
    const name = row.table_name as string;
    const existing = tables.get(name) ?? { tableName: name, columns: new Set<string>() };
    if (!row.sensitive) existing.columns.add(row.column_name as string);
    tables.set(name, existing);
  }

  let statement: Record<string, unknown>;
  try {
    statement = ensureReadOnlySelect(sql);
  } catch (error) {
    throw new Error(`SQL rejected: ${error instanceof Error ? error.message : "Invalid SQL."}`);
  }

  const cteNames = new Set<string>();
  for (const cte of (statement.with as Array<{ name?: { value?: string } }> | null) ?? []) {
    if (cte.name?.value) cteNames.add(cte.name.value.toLowerCase());
  }
  const selectAliases = new Set<string>();
  for (const selected of (statement.columns as Array<{ as?: string | null }> | null) ?? []) {
    if (selected.as) selectAliases.add(selected.as.replaceAll('"', "").toLowerCase());
  }
  const tableRefs = parser.tableList(sql, { database: "Postgresql" });
  let datasetTableCount = 0;
  for (const reference of tableRefs) {
    const [operation, schema, table] = reference.split("::");
    const normalizedTable = table?.replaceAll('"', "").toLowerCase();
    const normalizedSchema = schema === "null" ? null : schema?.replaceAll('"', "").toLowerCase();
    if (operation !== "select") throw new Error("Only SELECT table access is permitted.");
    if (normalizedTable && cteNames.has(normalizedTable)) continue;
    if (!normalizedTable || !tables.has(normalizedTable)) throw new Error(`Table ${normalizedTable ?? "(unknown)"} is not part of this dataset.`);
    if (normalizedSchema && normalizedSchema !== schemaName.toLowerCase()) throw new Error("Cross-schema table access is not permitted.");
    datasetTableCount++;
  }
  if (datasetTableCount === 0) throw new Error("The query must read at least one table from the selected dataset.");

  const tableAliases = aliasesFor(statement);

  const confirmed = await getPool().query(
    "SELECT source_table, source_column, target_table, target_column FROM dataset_relationships WHERE dataset_id = $1 AND confirmed = true",
    [datasetId],
  );
  const confirmedPairs = new Set<string>();
  for (const relationship of confirmed.rows) {
    const source = String(relationship.source_table).toLowerCase();
    const sourceColumn = String(relationship.source_column).toLowerCase();
    const target = String(relationship.target_table).toLowerCase();
    const targetColumn = String(relationship.target_column).toLowerCase();
    confirmedPairs.add(source + "." + sourceColumn + "=" + target + "." + targetColumn);
    confirmedPairs.add(target + "." + targetColumn + "=" + source + "." + sourceColumn);
  }
  const cteLineage = new Map<string, Map<string, { table: string; column: string }>>();
  const cteSafeColumns = new Map<string, Set<string>>();
  const columnName = (value: unknown) => {
    if (typeof value === "string") return value.replaceAll('"', "").toLowerCase();
    if (value && typeof value === "object") {
      const expr = (value as Record<string, unknown>).expr;
      if (expr && typeof expr === "object") return String((expr as Record<string, unknown>).value ?? "").replaceAll('"', "").toLowerCase();
    }
    return "";
  };
  const resolveLineage = (owner: string, column: string, aliases = tableAliases): { table: string; column: string } | null => {
    const actual = aliases.get(owner) ?? owner;
    if (tables.get(actual)?.columns.has(column)) return { table: actual, column };
    const fromCte = cteLineage.get(actual)?.get(column);
    if (fromCte) return fromCte;
    if (!owner) {
      const candidates = [...tables.values()].filter((table) => table.columns.has(column));
      if (candidates.length === 1) return { table: candidates[0]!.tableName, column };
    }
    return null;
  };
  for (const cte of (statement.with as Array<{ name?: { value?: string }; stmt?: Record<string, unknown> }> | null) ?? []) {
    const cteName = cte.name?.value?.toLowerCase();
    if (!cteName || !cte.stmt) continue;
    const cteAliases = aliasesFor(cte.stmt.from);
    const output = new Map<string, { table: string; column: string }>();
    const safeOutputs = new Set<string>();
    for (const selected of (cte.stmt.columns as Array<{ as?: string | null; expr?: Record<string, unknown> }> | null) ?? []) {
      const expression = selected.expr;
      const references: Array<{ table?: unknown; column?: unknown }> = [];
      astObjects(expression, (node) => { if (node.type === "column_ref") references.push(node as { table?: unknown; column?: unknown }); });
      const lineages = references.map((reference) => resolveLineage(String(reference.table ?? "").replaceAll('"', "").toLowerCase(), columnName(reference.column), cteAliases));
      const sourceColumn = expression?.type === "column_ref" ? columnName(expression.column) : "";
      const outputName = (selected.as ?? sourceColumn).replaceAll('"', "").toLowerCase();
      if (outputName && lineages.every(Boolean)) safeOutputs.add(outputName);
      if (expression?.type === "column_ref" && lineages[0] && outputName) output.set(outputName, lineages[0]);
    }
    cteLineage.set(cteName, output);
    cteSafeColumns.set(cteName, safeOutputs);
  }

  let unapprovedJoin = false;
  astObjects(statement, (select) => {
    if (select.type !== "select" || !Array.isArray(select.from)) return;
    const selectAliases = aliasesFor(select.from);
    for (const source of select.from.slice(1) as Array<Record<string, unknown>>) {
      if (!source.join || !source.on) { unapprovedJoin = true; continue; }
      let hasConfirmedKey = false;
      astObjects(source.on, (expression) => {
        if (expression.type !== "binary_expr" || expression.operator !== "=") return;
        const left = expression.left as Record<string, unknown> | undefined;
        const right = expression.right as Record<string, unknown> | undefined;
        if (left?.type !== "column_ref" || right?.type !== "column_ref") return;
        const leftOwner = String(left.table ?? "").replaceAll('"', "").toLowerCase();
        const rightOwner = String(right.table ?? "").replaceAll('"', "").toLowerCase();
        const leftLineage = resolveLineage(leftOwner, columnName(left.column), selectAliases);
        const rightLineage = resolveLineage(rightOwner, columnName(right.column), selectAliases);
        if (leftLineage && rightLineage && confirmedPairs.has(leftLineage.table + "." + leftLineage.column + "=" + rightLineage.table + "." + rightLineage.column)) hasConfirmedKey = true;
      });
      if (!hasConfirmedKey) unapprovedJoin = true;
    }
  });
  if (unapprovedJoin) throw new Error("SQL rejected: each join must use a confirmed key relationship in its ON clause.");

  const physicalTables = new Set(tableRefs.map((reference) => reference.split("::")[2]?.replaceAll('"', "").toLowerCase()).filter((name): name is string => !!name && tables.has(name)));
  if (physicalTables.size > 1) {
    const connected = new Set([physicalTables.values().next().value as string]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const relationship of confirmed.rows) {
        const source = relationship.source_table as string;
        const target = relationship.target_table as string;
        if (!physicalTables.has(source) || !physicalTables.has(target)) continue;
        if (connected.has(source) && !connected.has(target)) { connected.add(target); changed = true; }
        if (connected.has(target) && !connected.has(source)) { connected.add(source); changed = true; }
      }
    }
    if (connected.size !== physicalTables.size) throw new Error("SQL rejected: the query joins tables without a confirmed relationship. Review and confirm the suggested join first.");

    let invalidJoin = false;
    astObjects(statement, (object) => {
      if (object.type !== "select" || !Array.isArray(object.from)) return;
      for (const source of object.from.slice(1) as Array<Record<string, unknown>>) {
        if (!source.join || !source.on) invalidJoin = true;
      }
    });
    if (invalidJoin) throw new Error("SQL rejected: joins must include an explicit ON condition.");
  }

  const columnRefs: string[] = parser.columnList(sql, { database: "Postgresql" });
  for (const reference of columnRefs) {
    const [, ownerRaw, columnRaw] = reference.split("::");
    const owner = ownerRaw?.replaceAll('"', "").toLowerCase();
    const column = columnRaw?.replaceAll('"', "").toLowerCase();
    if (!column || column === "(.*)") throw new Error("Wildcard or unresolved columns are not allowed.");
    const actualTable = owner ? tables.has(owner) ? owner : tableAliases.get(owner) ?? owner : null;
    const candidates = actualTable ? [tables.get(actualTable)].filter(Boolean) as TableAccess[] : [...tables.values()];
    if (candidates.some((candidate) => candidate.columns.has(column))) continue;
    if (!owner && selectAliases.has(column)) continue;
    if (owner && cteSafeColumns.get(actualTable ?? owner)?.has(column)) continue;
    throw new Error(`Column ${column} is unavailable in this dataset or is marked sensitive.`);
  }

  const safeSql = applyRowLimit(statement);
  const client = await getReadOnlyPool().connect();
  const startedAt = performance.now();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schemaName)}, pg_catalog`);
    const result = await client.query(safeSql);
    const executionMs = Math.round(performance.now() - startedAt);
    return {
      sql: safeSql,
      columns: result.fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID })),
      rows: result.rows.slice(0, maxRows),
      returnedRows: Math.min(result.rowCount ?? result.rows.length, maxRows),
      truncated: result.rows.length > maxRows,
      executionMs,
      explanation: "",
    };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
