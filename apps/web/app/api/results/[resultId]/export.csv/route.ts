import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../../../../../../../packages/db/src/pool.js";

export const runtime = "nodejs";
const idSchema = z.string().uuid();

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export async function GET(_request: Request, context: { params: Promise<{ resultId: string }> }) {
  const { resultId } = await context.params;
  if (!idSchema.safeParse(resultId).success) return NextResponse.json({ error: "Invalid result ID." }, { status: 400 });
  try {
    await ensureMetadataSchema();
    const result = await getPool().query("SELECT columns, rows FROM query_results WHERE id = $1 AND expires_at > now()", [resultId]);
    if (!result.rowCount) return NextResponse.json({ error: "Result not found or expired." }, { status: 404 });
    const columns = result.rows[0].columns as Array<{ name: string }>;
    const rows = result.rows[0].rows as Record<string, unknown>[];
    const lines = [columns.map((column) => csvCell(column.name)).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column.name])).join(","))];
    return new Response("\uFEFF" + lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="datapilot-results-' + resultId.slice(0, 8) + '.csv"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not export this result." }, { status: 503 });
  }
}
