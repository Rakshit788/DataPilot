import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeQuestion } from "../../../../../packages/agent/src/analysis-agent.js";

export const runtime = "nodejs";
const requestSchema = z.object({
  datasetId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4_000),
}).strict();

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide a dataset ID and a question up to 4,000 characters." }, { status: 400 });
  try {
    const { conversationId, ...input } = parsed.data;
    return NextResponse.json(await analyzeQuestion(conversationId ? { ...input, conversationId } : input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed.";
    const status = /ollama/i.test(message) ? 503 : /not found|not ready|does not belong/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
