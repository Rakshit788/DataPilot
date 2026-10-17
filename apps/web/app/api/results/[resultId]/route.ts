import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../../../../../../packages/db/src/pool.js";

export const runtime = "nodejs";
const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ resultId: string }> }) {
  const { resultId } = await context.params;
  if (!idSchema.safeParse(resultId).success) return NextResponse.json({ error: "Invalid result ID." }, { status: 400 });
  try {
    await ensureMetadataSchema();
    const result = await getPool().query(
      "SELECT q.id, q.columns, q.rows, q.returned_rows, q.truncated, q.execution_ms, a.generated_sql FROM query_results q JOIN analyses a ON a.id = q.analysis_id WHERE q.id = $1 AND q.expires_at > now()",
      [resultId],
    );
    if (!result.rowCount) return NextResponse.json({ error: "Result not found or expired." }, { status: 404 });
    return NextResponse.json({ result: result.rows[0] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load results." }, { status: 503 });
  }
}
