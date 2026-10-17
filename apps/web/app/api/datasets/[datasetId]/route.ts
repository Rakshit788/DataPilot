import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../../../../../../packages/db/src/pool.js";

export const runtime = "nodejs";
const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!idSchema.safeParse(datasetId).success) return NextResponse.json({ error: "Invalid dataset ID." }, { status: 400 });
  try {
    await ensureMetadataSchema();
    const result = await getPool().query(
      `SELECT d.id, d.name, d.status, d.source, d.source_metadata, d.created_at,
              COALESCE(jsonb_agg(t.profile ORDER BY t.source_file) FILTER (WHERE t.id IS NOT NULL), '[]'::jsonb) AS tables
       FROM datasets d LEFT JOIN dataset_tables t ON t.dataset_id = d.id
       WHERE d.id = $1 GROUP BY d.id`,
      [datasetId],
    );
    if (!result.rowCount) return NextResponse.json({ error: "Dataset not found." }, { status: 404 });
    return NextResponse.json({ dataset: result.rows[0] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load dataset." }, { status: 503 });
  }
}
