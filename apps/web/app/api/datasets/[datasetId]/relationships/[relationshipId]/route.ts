import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../../../../../../../../packages/db/src/pool.js";

export const runtime = "nodejs";
const paramsSchema = z.object({ datasetId: z.string().uuid(), relationshipId: z.string().uuid() });
const bodySchema = z.object({ confirmed: z.boolean() }).strict();

export async function PATCH(request: Request, context: { params: Promise<{ datasetId: string; relationshipId: string }> }) {
  const params = paramsSchema.safeParse(await context.params);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!params.success || !body.success) return NextResponse.json({ error: "Invalid relationship update." }, { status: 400 });
  try {
    await ensureMetadataSchema();
    const result = await getPool().query(
      "UPDATE dataset_relationships SET confirmed = $3 WHERE id = $1 AND dataset_id = $2 RETURNING id, confirmed",
      [params.data.relationshipId, params.data.datasetId, body.data.confirmed],
    );
    if (!result.rowCount) return NextResponse.json({ error: "Relationship not found." }, { status: 404 });
    return NextResponse.json({ relationship: result.rows[0] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update relationship." }, { status: 503 });
  }
}
