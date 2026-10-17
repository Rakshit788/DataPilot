import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../../../../../packages/db/src/pool.js";

export const runtime = "nodejs";
const requestSchema = z.object({ resultId: z.string().uuid(), measureColumn: z.string().min(1).max(128), relativeReduction: z.number().gt(0).lte(1) }).strict();

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide a result ID, a numeric measure column, and a relative reduction between 0 and 1." }, { status: 400 });
  try {
    await ensureMetadataSchema();
    const found = await getPool().query("SELECT id, columns, rows FROM query_results WHERE id = $1 AND expires_at > now()", [parsed.data.resultId]);
    if (!found.rowCount) return NextResponse.json({ error: "Result not found or expired." }, { status: 404 });
    const columns = found.rows[0].columns as Array<{ name: string }>;
    const rows = found.rows[0].rows as Array<Record<string, unknown>>;
    if (!columns.some((column) => column.name === parsed.data.measureColumn)) return NextResponse.json({ error: "That column is not part of this result." }, { status: 400 });
    if (rows.length !== 1) return NextResponse.json({ error: "Scenario calculations require a single baseline result row. Summarize the metric first." }, { status: 422 });
    const baseline = Number(rows[0]?.[parsed.data.measureColumn]);
    if (!Number.isFinite(baseline) || baseline < 0) return NextResponse.json({ error: "The selected baseline must be a non-negative number." }, { status: 422 });
    const projected = baseline * (1 - parsed.data.relativeReduction);
    const avoided = baseline - projected;
    const assumptions = { measureColumn: parsed.data.measureColumn, relativeReduction: parsed.data.relativeReduction, unit: "relative proportion", observedBaseline: true };
    const saved = await getPool().query(
      "INSERT INTO scenarios (result_id, assumptions, formula, baseline, projected, avoided) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at",
      [parsed.data.resultId, JSON.stringify(assumptions), "projected = baseline × (1 - relative reduction)", baseline, projected, avoided],
    );
    return NextResponse.json({ scenarioId: saved.rows[0].id, assumptions, formula: "projected = baseline × (1 - relative reduction)", baseline, projected, avoided, createdAt: saved.rows[0].created_at }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Scenario calculation failed." }, { status: 500 });
  }
}
