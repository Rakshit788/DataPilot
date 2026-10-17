import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../../../../../../../packages/db/src/pool.js";

export const runtime = "nodejs";
const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!idSchema.safeParse(datasetId).success) return NextResponse.json({ error: "Invalid dataset ID." }, { status: 400 });
  try {
    await ensureMetadataSchema();
    const [dataset, tables, relationships] = await Promise.all([
      getPool().query("SELECT id, name, status, schema_name, created_at FROM datasets WHERE id = $1", [datasetId]),
      getPool().query(
        "SELECT t.table_name, t.row_count, t.source_file, jsonb_agg(jsonb_build_object('name', c.column_name, 'sourceName', c.source_name, 'type', c.inferred_type, 'nullPercent', c.null_percent, 'likelyPrimaryKey', c.likely_primary_key, 'likelyJoinKey', c.likely_join_key, 'sensitive', c.sensitive) ORDER BY c.id) AS columns " +
        "FROM dataset_tables t JOIN dataset_columns c ON c.table_id = t.id WHERE t.dataset_id = $1 GROUP BY t.id ORDER BY t.table_name",
        [datasetId],
      ),
      getPool().query("SELECT id, source_table AS \"sourceTable\", source_column AS \"sourceColumn\", target_table AS \"targetTable\", target_column AS \"targetColumn\", cardinality, match_percent AS \"matchPercent\", confidence, confirmed FROM dataset_relationships WHERE dataset_id = $1 ORDER BY source_table, source_column", [datasetId]),
    ]);
    if (!dataset.rowCount) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
    return NextResponse.json({ dataset: dataset.rows[0], tables: tables.rows, relationships: relationships.rows });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load schema." }, { status: 503 });
  }
}
