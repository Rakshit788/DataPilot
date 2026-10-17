import { NextResponse } from "next/server";
import { z } from "zod";
import { getLatestEvaluation, runEvaluation } from "../../../../../../../../packages/evaluation/run-evaluation.js";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!z.string().uuid().safeParse(datasetId).success) return NextResponse.json({ error: "Invalid dataset ID." }, { status: 400 });
  try { return NextResponse.json({ evaluation: await getLatestEvaluation(datasetId) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load evaluation." }, { status: 503 }); }
}

export async function POST(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!z.string().uuid().safeParse(datasetId).success) return NextResponse.json({ error: "Invalid dataset ID." }, { status: 400 });
  try { return NextResponse.json(await runEvaluation(datasetId), { status: 201 }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Evaluation could not run." }, { status: 422 }); }
}
