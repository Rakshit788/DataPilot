import { NextResponse } from "next/server";
import { z } from "zod";
import { getReconciliation, runReconciliation } from "../../../../../../../packages/reconciliation/src/match-payments.js";

export const runtime = "nodejs";
const configSchema = z.object({
  paymentTable: z.string().min(1).max(63),
  invoiceTable: z.string().min(1).max(63),
  paymentIdColumn: z.string().min(1).max(63),
  invoiceIdColumn: z.string().min(1).max(63),
  paymentAmountColumn: z.string().min(1).max(63),
  invoiceAmountColumn: z.string().min(1).max(63),
  paymentNoteColumn: z.string().max(63).optional(),
  paymentKeyColumn: z.string().max(63).optional(),
  invoiceKeyColumn: z.string().max(63).optional(),
  manualReviewMinutes: z.number().min(0).max(60).default(3),
}).strict();

export async function GET(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!z.string().uuid().safeParse(datasetId).success) return NextResponse.json({ error: "Invalid dataset ID." }, { status: 400 });
  const offset = Math.floor(Math.max(0, Math.min(5_000, Number(new URL(request.url).searchParams.get("offset") ?? 0) || 0)));
  try { return NextResponse.json({ reconciliation: await getReconciliation(datasetId, offset) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load matches." }, { status: 503 }); }
}

export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const { datasetId } = await context.params;
  if (!z.string().uuid().safeParse(datasetId).success) return NextResponse.json({ error: "Invalid dataset ID." }, { status: 400 });
  const parsed = configSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose payment and invoice tables, their unique IDs and numeric amount columns." }, { status: 400 });
  const { paymentNoteColumn, paymentKeyColumn, invoiceKeyColumn, ...requiredConfig } = parsed.data;
  const config = {
    ...requiredConfig,
    ...(paymentNoteColumn === undefined ? {} : { paymentNoteColumn }),
    ...(paymentKeyColumn === undefined ? {} : { paymentKeyColumn }),
    ...(invoiceKeyColumn === undefined ? {} : { invoiceKeyColumn }),
  };
  try { return NextResponse.json(await runReconciliation(datasetId, config), { status: 201 }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Reconciliation failed." }, { status: 422 }); }
}
