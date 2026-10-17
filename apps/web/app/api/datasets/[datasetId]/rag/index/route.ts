import { NextResponse } from "next/server";
import { z } from "zod";
import { indexDatasetText } from "../../../../../../../../packages/rag/src/index-text.js";

export const runtime = "nodejs";
const inputSchema = z.object({
  tableName: z.string().min(1).max(128),
  textColumns: z.array(z.string().min(1).max(128)).min(1).max(12),
  sourceIdColumn: z.string().min(1).max(128),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!z.string().uuid().safeParse(datasetId).success) return NextResponse.json({ error: "Invalid dataset ID." }, { status: 400 });
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide a table, a safe source ID column, and one or more text columns." }, { status: 400 });
  try {
    const result = await indexDatasetText({ datasetId, ...parsed.data });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not index this table." }, { status: 422 });
  }
}
