import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { ensureMetadataSchema, getPool } from "../../db/src/pool.js";
import { profileCsvStream } from "./profile-csv.js";
import { quoteIdentifier, uniqueIdentifiers } from "./identifiers.js";

const maxRows = 1_000_000;

function pgType(type: string, columnName: string) {
  if (/(^id$|_id$|^id_)/i.test(columnName)) return "text";
  if (type === "number") return "numeric";
  if (type === "date/time") return "timestamptz";
  if (type === "boolean") return "boolean";
  return "text";
}

function toDatabaseValue(value: string | undefined, type: string) {
  if (value === undefined || value === "") return null;
  if (type === "boolean") return /^(true|yes)$/i.test(value) ? "true" : "false";
  return value;
}

export async function importCsvDataset(files: File[]) {
  await ensureMetadataSchema();
  const client = await getPool().connect();
  const datasetId = randomUUID();
  const schemaName = `ds_${datasetId.replaceAll("-", "")}`;
  const olistFiles = new Set(["olist_orders_dataset.csv", "olist_order_items_dataset.csv", "olist_order_payments_dataset.csv", "olist_order_reviews_dataset.csv", "olist_customers_dataset.csv", "olist_products_dataset.csv", "olist_sellers_dataset.csv", "product_category_name_translation.csv"]);
  const isOlist = files.length > 1 && files.every((file) => olistFiles.has(file.name.toLowerCase()));
  const datasetName = isOlist ? "Olist Brazilian E-Commerce" : files.length === 1 ? files[0]!.name.replace(/\.csv$/i, "") : `${files.length} CSV files`;
  const sourceMetadata = isOlist ? { sourceUrl: "https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce", license: "Check the source dataset license before redistribution." } : {};
  const allProfiles: Array<Record<string, unknown>> = [];
  const importedTableMeta: Array<{ tableName: string; rowCount: number; columns: Array<{ name: string; sourceName: string; likelyPrimaryKey: boolean; likelyJoinKey: boolean }> }> = [];
  const tableNames = uniqueIdentifiers(files.map((file) => file.name.replace(/\.csv$/i, "")));

  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO datasets (id, name, source, schema_name, status, source_metadata) VALUES ($1, $2, $3, $4, 'importing', $5)", [datasetId, datasetName, isOlist ? "olist_kaggle" : "csv_upload", schemaName, JSON.stringify(sourceMetadata)]);
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex]!;
      const bytes = Buffer.from(await file.arrayBuffer());
      const profile = await profileCsvStream(Readable.from([bytes]), file.name);
      if (profile.columns.length === 0) throw new Error(`${file.name} has no header row.`);
      if (profile.columns.length > 256) throw new Error(`${file.name} has more than 256 columns.`);
      if (profile.rowCount > maxRows) throw new Error(`${file.name} exceeds the ${maxRows.toLocaleString()} row import limit.`);

      const sourceColumns = profile.columns.map((column) => column.name);
      const dbColumns = uniqueIdentifiers(sourceColumns);
      const typeByDbName = new Map(profile.columns.map((column, index) => [dbColumns[index]!, /(^id$|_id$|^id_)/i.test(column.name) ? "text" : column.inferredType]));
      const tableName = tableNames[fileIndex]!;
      const primaryKey = profile.columns.find((column) => column.likelyPrimaryKey);
      const primaryKeyName = primaryKey ? dbColumns[profile.columns.indexOf(primaryKey)] : undefined;
      const columnDefinitions = dbColumns.map((name, index) => `${quoteIdentifier(name)} ${pgType(typeByDbName.get(name)!, sourceColumns[index]!)}`);
      if (primaryKeyName) columnDefinitions.push(`PRIMARY KEY (${quoteIdentifier(primaryKeyName)})`);
      const tableSql = `CREATE TABLE ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} (${columnDefinitions.join(", ")})`;
      await client.query(tableSql);
      await client.query("GRANT USAGE ON SCHEMA " + quoteIdentifier(schemaName) + " TO datapilot_reader");
      await client.query("GRANT SELECT ON ALL TABLES IN SCHEMA " + quoteIdentifier(schemaName) + " TO datapilot_reader");

      const parser = Readable.from([bytes]).pipe(parse({
        bom: true,
        columns: (headers: string[]) => {
          const cleaned = headers.map((header) => header.trim());
          if (cleaned.length !== sourceColumns.length || cleaned.some((header, index) => header !== sourceColumns[index])) throw new Error("CSV headers changed while importing.");
          return dbColumns;
        },
        skip_empty_lines: true,
        trim: true,
      }));
      const batch: Record<string, string>[] = [];
      let inserted = 0;
      const batchLimit = Math.max(1, Math.min(400, Math.floor(60_000 / dbColumns.length)));
      const flush = async () => {
        if (batch.length === 0) return;
        const values: unknown[] = [];
        const tuples = batch.map((row, rowIndex) => {
          const placeholders = dbColumns.map((column, columnIndex) => {
            values.push(toDatabaseValue(row[column], typeByDbName.get(column)!));
            return `$${rowIndex * dbColumns.length + columnIndex + 1}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        await client.query(`INSERT INTO ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} (${dbColumns.map(quoteIdentifier).join(", ")}) VALUES ${tuples.join(", ")}`, values);
        inserted += batch.length;
        batch.length = 0;
      };

      for await (const record of parser as AsyncIterable<Record<string, string>>) {
        batch.push(record);
        if (batch.length >= batchLimit) await flush();
      }
      await flush();

      const mappedColumns = profile.columns.map((column, index) => ({ ...column, inferredType: /(^id$|_id$|^id_)/i.test(column.name) ? "text" : column.inferredType, sourceName: column.name, name: dbColumns[index]! }));
      const mappedSample = profile.sample.map((row) => Object.fromEntries(Object.entries(row).map(([name, value]) => [dbColumns[sourceColumns.indexOf(name)]!, value])));
      const profileForStorage = { ...profile, tableName, columns: mappedColumns, sample: mappedSample };
      const tableResult = await client.query(
        "INSERT INTO dataset_tables (dataset_id, table_name, source_file, row_count, profile) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [datasetId, tableName, file.name, inserted, JSON.stringify(profileForStorage)],
      );
      const tableId = tableResult.rows[0].id as string;
      for (let index = 0; index < mappedColumns.length; index++) {
        const column = mappedColumns[index]!;
        await client.query(
          `INSERT INTO dataset_columns (table_id, column_name, source_name, inferred_type, null_count, null_percent, approximate_distinct_count, likely_primary_key, likely_join_key, sensitive, sample_summary)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [tableId, column.name, column.sourceName, column.inferredType, column.nullCount, column.nullPercent, column.approximateDistinctCount, column.likelyPrimaryKey, column.likelyJoinKey, column.sensitive, JSON.stringify(mappedSample.map((row) => row[column.name] ?? ""))],
        );
      }
      allProfiles.push({ ...profileForStorage, rowCount: inserted });
      importedTableMeta.push({ tableName, rowCount: inserted, columns: mappedColumns.map((column) => ({ name: column.name, sourceName: column.sourceName, likelyPrimaryKey: column.likelyPrimaryKey, likelyJoinKey: column.likelyJoinKey })) });
    }

    const relationships: Array<Record<string, unknown>> = [];
    for (const source of importedTableMeta) {
      for (const sourceColumn of source.columns) {
        for (const target of importedTableMeta) {
          if (target.tableName === source.tableName) continue;
          const targetColumn = target.columns.find((column) => column.likelyPrimaryKey && column.sourceName.toLowerCase() === sourceColumn.sourceName.toLowerCase());
          if (!targetColumn) continue;
          if (sourceColumn.likelyPrimaryKey && (source.rowCount < target.rowCount || (source.rowCount === target.rowCount && source.tableName < target.tableName))) continue;
          const match = await client.query(
            `SELECT count(*) FILTER (WHERE s.${quoteIdentifier(sourceColumn.name)} IS NOT NULL) AS source_values,
                    count(*) FILTER (WHERE s.${quoteIdentifier(sourceColumn.name)} IS NOT NULL AND t.${quoteIdentifier(targetColumn.name)} IS NOT NULL) AS matched_values
             FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(source.tableName)} s
             LEFT JOIN ${quoteIdentifier(schemaName)}.${quoteIdentifier(target.tableName)} t ON s.${quoteIdentifier(sourceColumn.name)} = t.${quoteIdentifier(targetColumn.name)}`,
          );
          const sourceValues = Number(match.rows[0].source_values);
          const matchedValues = Number(match.rows[0].matched_values);
          const matchPercent = sourceValues === 0 ? 0 : matchedValues / sourceValues * 100;
          const confidence = sourceValues === 0 ? 0 : matchedValues / sourceValues;
          const relationship = { sourceTable: source.tableName, sourceColumn: sourceColumn.name, targetTable: target.tableName, targetColumn: targetColumn.name, cardinality: sourceColumn.likelyPrimaryKey ? "one_to_one" : "many_to_one", matchPercent: Number(matchPercent.toFixed(2)), confidence: Number(confidence.toFixed(4)), confirmed: false };
          await client.query(
            "INSERT INTO dataset_relationships (dataset_id, source_table, source_column, target_table, target_column, cardinality, match_percent, confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [datasetId, relationship.sourceTable, relationship.sourceColumn, relationship.targetTable, relationship.targetColumn, relationship.cardinality, relationship.matchPercent, relationship.confidence],
          );
          relationships.push(relationship);
        }
      }
    }

    await client.query("UPDATE datasets SET status = 'ready' WHERE id = $1", [datasetId]);
    await client.query("COMMIT");
    return { id: datasetId, name: datasetName, source: isOlist ? "olist_kaggle" : "csv_upload", sourceMetadata, status: "ready", tables: allProfiles, relationships };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
