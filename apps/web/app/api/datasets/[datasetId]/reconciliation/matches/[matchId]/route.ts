import { NextResponse } from "next/server";
import { z } from "zod";
import { recordReconciliationDecision } from "../../../../../../../../../packages/reconciliation/src/match-payments.js";

export const runtime = "nodejs";
const decisionSchema = z.object({ invoiceId: z.string().min(1).max(256).nullable(), reviewDurationSeconds: z.number().min(0).max(3600).default(0) }).strict();

export async function PATCH(request: Request, context: { params: Promise<{ datasetId: string; matchId: string }> }) {
  const { datasetId, matchId } = await context.params;
  if (!z.string().uuid().safeParse(datasetId).success || !z.string().uuid().safeParse(matchId).success) return NextResponse.json({ error: "Invalid match or dataset ID." }, { status: 400 });
  const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose a suggested invoice, or mark the payment as unmatched." }, { status: 400 });
  try { return NextResponse.json({ decision: await recordReconciliationDecision({ datasetId, matchId, ...parsed.data }) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save human decision." }, { status: 422 }); }
}
