import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../../../../../../../packages/db/src/pool.js";

export const runtime = "nodejs";
const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!idSchema.safeParse(datasetId).success) return NextResponse.json({ error: "Invalid dataset ID." }, { status: 400 });
  try {
    await ensureMetadataSchema();
    const result = await getPool().query(
      "SELECT c.id, COALESCE(jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content, 'metadata', m.metadata) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS messages " +
      "FROM conversations c LEFT JOIN LATERAL (SELECT id, role, content, metadata, created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 20) m ON true " +
      "WHERE c.dataset_id = $1 GROUP BY c.id ORDER BY max(c.updated_at) DESC LIMIT 1",
      [datasetId],
    );
    return NextResponse.json({ conversation: result.rows[0] ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load conversation." }, { status: 503 });
  }
}
