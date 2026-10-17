import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../../../../../packages/db/src/pool.js";
import { importCsvDataset } from "../../../../../packages/importer/src/import-dataset.js";

export const runtime = "nodejs";

const maxFileBytes = 50 * 1024 * 1024;
const maxFiles = 8;
const uploadSchema = z.array(z.custom<File>((value) => value instanceof File)).min(1).max(maxFiles);

export async function GET() {
  try {
    await ensureMetadataSchema();
    const result = await getPool().query(
      `SELECT d.id, d.name, d.status, d.created_at,
              COALESCE(jsonb_agg(jsonb_build_object('file', t.source_file, 'tableName', t.table_name, 'rowCount', t.row_count, 'columns', t.profile->'columns', 'sample', t.profile->'sample', 'likelyPrimaryKeys', t.profile->'likelyPrimaryKeys', 'likelyJoinKeys', t.profile->'likelyJoinKeys')) FILTER (WHERE t.id IS NOT NULL), '[]'::jsonb) AS tables,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'sourceTable', r.source_table, 'sourceColumn', r.source_column, 'targetTable', r.target_table, 'targetColumn', r.target_column, 'cardinality', r.cardinality, 'matchPercent', r.match_percent, 'confidence', r.confidence, 'confirmed', r.confirmed) ORDER BY r.source_table, r.source_column) FROM dataset_relationships r WHERE r.dataset_id = d.id), '[]'::jsonb) AS relationships
       FROM datasets d LEFT JOIN dataset_tables t ON t.dataset_id = d.id
       GROUP BY d.id ORDER BY d.created_at DESC LIMIT 100`,
    );
    return NextResponse.json({ datasets: result.rows });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load datasets." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > maxFileBytes) return NextResponse.json({ error: "Total upload size exceeds the 50 MB limit." }, { status: 413 });
    const form = await request.formData();
    const parsed = uploadSchema.safeParse(form.getAll("files"));
    if (!parsed.success) return NextResponse.json({ error: `Choose between 1 and ${maxFiles} CSV files.` }, { status: 400 });
    const files = parsed.data;
    let totalBytes = 0;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".csv")) return NextResponse.json({ error: `${file.name} is not a CSV file.` }, { status: 415 });
      if (file.size > maxFileBytes) return NextResponse.json({ error: `${file.name} exceeds the 50 MB per-file limit.` }, { status: 413 });
      totalBytes += file.size;
    }
    if (totalBytes > maxFileBytes) return NextResponse.json({ error: "Total upload size exceeds the 50 MB limit." }, { status: 413 });
    const dataset = await importCsvDataset(files);
    return NextResponse.json({ dataset }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not import these CSV files.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
