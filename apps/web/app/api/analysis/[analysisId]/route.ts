import { NextResponse } from "next/server";
import { z } from "zod";
import { getAnalysis } from "../../../../../../packages/agent/src/analysis-agent.js";

export const runtime = "nodejs";
const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await context.params;
  if (!idSchema.safeParse(analysisId).success) return NextResponse.json({ error: "Invalid analysis ID." }, { status: 400 });
  try {
    const analysis = await getAnalysis(analysisId);
    if (!analysis) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });
    return NextResponse.json({ analysis });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load analysis." }, { status: 503 });
  }
}
