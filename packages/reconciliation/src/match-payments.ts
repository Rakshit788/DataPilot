import { createHash } from "node:crypto";
import { ensureMetadataSchema, getPool } from "../../db/src/pool.js";
import { quoteIdentifier } from "../../importer/src/identifiers.js";
import { searchDatasetTexts } from "../../rag/src/index-text.js";

const confidenceThreshold = 0.85;
const maxPayments = 5_000;
const maxInvoices = 200_000;
const topCandidates = 8;

async function saveMetricSnapshot(runId: string) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT r.total_payments,r.stp_count,r.manual_review_minutes,
            count(*) FILTER (WHERE m.human_reviewed AND m.straight_through) AS labeled_auto,
            count(*) FILTER (WHERE m.human_reviewed AND m.straight_through AND m.human_invoice_id IS NOT DISTINCT FROM m.matched_invoice_id) AS correct_auto
     FROM reconciliation_runs r LEFT JOIN reconciliation_matches m ON m.run_id=r.id WHERE r.id=$1 GROUP BY r.id`,
    [runId],
  );
  if (!result.rowCount) return;
  const row = result.rows[0]!;
  const labeled = Number(row.labeled_auto);
  const stpRate = Number(row.total_payments) ? Number(row.stp_count) / Number(row.total_payments) : 0;
  const accuracy = labeled ? Number(row.correct_auto) / labeled : null;
  const hoursSaved = Number(row.stp_count) * Number(row.manual_review_minutes) / 60;
  await pool.query("INSERT INTO reconciliation_metric_snapshots (run_id,labeled_auto_count,stp_rate,accuracy_rate,estimated_hours_saved) VALUES ($1,$2,$3,$4,$5)", [runId, labeled, stpRate, accuracy, hoursSaved]);
}

type MatchConfig = {
  paymentTable: string;
  invoiceTable: string;
  paymentIdColumn: string;
  invoiceIdColumn: string;
  paymentAmountColumn: string;
  invoiceAmountColumn: string;
  paymentNoteColumn?: string;
  paymentKeyColumn?: string;
  invoiceKeyColumn?: string;
  manualReviewMinutes: number;
};

function numeric(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function amountAgreement(payment: number | null, invoice: number | null) {
  if (payment === null || invoice === null) return null;
  const scale = Math.max(Math.abs(payment), Math.abs(invoice), 0.01);
  const relativeDifference = Math.abs(payment - invoice) / scale;
  return relativeDifference <= 0.005 ? 1 : Math.max(0, 1 - (relativeDifference - 0.005) / 0.05);
}

export async function runReconciliation(datasetId: string, config: MatchConfig) {
  await ensureMetadataSchema();
  const pool = getPool();
  const dataset = await pool.query("SELECT schema_name,status FROM datasets WHERE id = $1", [datasetId]);
  if (!dataset.rowCount || dataset.rows[0].status !== "ready") throw new Error("Dataset not found or not ready.");
  const metadata = await pool.query(
    "SELECT t.table_name,c.column_name,c.inferred_type,c.sensitive,c.likely_primary_key FROM dataset_tables t JOIN dataset_columns c ON c.table_id=t.id WHERE t.dataset_id=$1 AND t.table_name = ANY($2::text[])",
    [datasetId, [config.paymentTable, config.invoiceTable]],
  );
  const tables = new Map<string, Map<string, { type: string; sensitive: boolean; primary: boolean }>>();
  for (const row of metadata.rows) {
    const columns = tables.get(row.table_name) ?? new Map();
    columns.set(row.column_name, { type: row.inferred_type, sensitive: row.sensitive, primary: row.likely_primary_key });
    tables.set(row.table_name, columns);
  }
  const paymentColumns = tables.get(config.paymentTable);
  const invoiceColumns = tables.get(config.invoiceTable);
  if (!paymentColumns || !invoiceColumns || config.paymentTable === config.invoiceTable) throw new Error("Choose two different tables from this dataset.");
  const requireColumn = (columns: typeof paymentColumns, name: string, label: string) => {
    const column = columns?.get(name);
    if (!column) throw new Error(`The selected ${label} column is not in this table.`);
    return column;
  };
  const paymentId = requireColumn(paymentColumns, config.paymentIdColumn, "payment ID");
  const invoiceId = requireColumn(invoiceColumns, config.invoiceIdColumn, "invoice ID");
  if (!paymentId.primary || !invoiceId.primary || paymentId.sensitive || invoiceId.sensitive) throw new Error("Choose non-sensitive row IDs profiled as unique keys. Sensitive values may be selected only as internal exact-match keys.");
  if (requireColumn(paymentColumns, config.paymentAmountColumn, "payment amount").type !== "number" || requireColumn(invoiceColumns, config.invoiceAmountColumn, "invoice amount").type !== "number") {
    throw new Error("Payment and invoice amount columns must be numeric.");
  }
  if (!!config.paymentKeyColumn !== !!config.invoiceKeyColumn) throw new Error("Choose both sides of the exact-match key, or leave both blank.");
  if (config.paymentKeyColumn) requireColumn(paymentColumns, config.paymentKeyColumn, "payment exact key");
  if (config.invoiceKeyColumn) requireColumn(invoiceColumns, config.invoiceKeyColumn, "invoice exact key");
  if (config.paymentNoteColumn) {
    const note = requireColumn(paymentColumns, config.paymentNoteColumn, "payment note");
    if (note.type !== "text" || note.sensitive) throw new Error("Payment notes must be non-sensitive text.");
  }
  if (!config.paymentNoteColumn && !config.paymentKeyColumn) throw new Error("Select an exact-match key, a payment note, or both.");

  const schemaName = dataset.rows[0].schema_name as string;
  const invoiceQuery = `SELECT ${quoteIdentifier(config.invoiceIdColumn)}::text AS row_id, ${quoteIdentifier(config.invoiceAmountColumn)}::numeric AS amount FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(config.invoiceTable)} ORDER BY ${quoteIdentifier(config.invoiceIdColumn)} LIMIT ${maxInvoices}`;
  const paymentQuery = `SELECT ${quoteIdentifier(config.paymentIdColumn)}::text AS row_id, ${quoteIdentifier(config.paymentAmountColumn)}::numeric AS amount, ${config.paymentNoteColumn ? quoteIdentifier(config.paymentNoteColumn) + "::text" : "NULL::text"} AS note FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(config.paymentTable)} ORDER BY ${quoteIdentifier(config.paymentIdColumn)} LIMIT ${maxPayments}`;
  const [invoiceResult, paymentResult, invoiceCountResult, paymentCountResult] = await Promise.all([
    pool.query(invoiceQuery), pool.query(paymentQuery),
    pool.query(`SELECT count(*)::bigint AS count FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(config.invoiceTable)}`),
    pool.query(`SELECT count(*)::bigint AS count FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(config.paymentTable)}`),
  ]);
  const invoiceCount = Number(invoiceCountResult.rows[0].count);
  const paymentCount = Number(paymentCountResult.rows[0].count);
  if (paymentCount > maxPayments || invoiceCount > maxInvoices) throw new Error(`This local matching run supports up to ${maxPayments.toLocaleString()} payments and ${maxInvoices.toLocaleString()} invoices. Split the files into smaller runs.`);
  if (!invoiceResult.rows.length || !paymentResult.rows.length) throw new Error("Both tables need at least one row.");
  const invoices = new Map<string, { id: string; amount: number | null }>();
  for (const row of invoiceResult.rows) {
    const id = String(row.row_id);
    invoices.set(id, { id, amount: numeric(row.amount) });
  }

  const exactMatchesByPayment = new Map<string, string[]>();
  if (config.paymentKeyColumn && config.invoiceKeyColumn) {
    const indexSuffix = createHash("sha1").update(schemaName + "." + config.invoiceTable + "." + config.invoiceKeyColumn + "." + config.invoiceAmountColumn).digest("hex").slice(0, 12);
    const indexName = "reconcile_exact_" + indexSuffix;
    await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(schemaName)}.${quoteIdentifier(config.invoiceTable)} (UPPER(BTRIM(${quoteIdentifier(config.invoiceKeyColumn)}::text)),${quoteIdentifier(config.invoiceAmountColumn)})`);
    const exactQuery =
      `SELECT p.${quoteIdentifier(config.paymentIdColumn)}::text AS payment_id, matched.invoice_id FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(config.paymentTable)} p ` +
      `CROSS JOIN LATERAL (SELECT i.${quoteIdentifier(config.invoiceIdColumn)}::text AS invoice_id FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(config.invoiceTable)} i ` +
      `WHERE UPPER(BTRIM(p.${quoteIdentifier(config.paymentKeyColumn)}::text)) = UPPER(BTRIM(i.${quoteIdentifier(config.invoiceKeyColumn)}::text)) ` +
      `ORDER BY CASE WHEN p.${quoteIdentifier(config.paymentAmountColumn)} IS NULL OR i.${quoteIdentifier(config.invoiceAmountColumn)} IS NULL THEN 1 ELSE 0 END, abs(i.${quoteIdentifier(config.invoiceAmountColumn)} - p.${quoteIdentifier(config.paymentAmountColumn)}), i.${quoteIdentifier(config.invoiceIdColumn)} LIMIT ${topCandidates}) matched ` +
      `WHERE p.${quoteIdentifier(config.paymentKeyColumn)} IS NOT NULL`;
    const exactRows = await pool.query(exactQuery);
    for (const row of exactRows.rows) {
      const paymentKey = String(row.payment_id);
      const invoiceKey = String(row.invoice_id);
      const matches = exactMatchesByPayment.get(paymentKey);
      if (matches) matches.push(invoiceKey); else exactMatchesByPayment.set(paymentKey, [invoiceKey]);
    }
  }

  const semanticNeeded = !!config.paymentNoteColumn && paymentResult.rows.some((row) => String(row.note ?? "").trim() && !exactMatchesByPayment.has(String(row.row_id)));
  if (semanticNeeded) {
    const ready = await pool.query("SELECT 1 FROM document_indexes WHERE dataset_id=$1 AND source_table=$2 AND status='ready' AND embedding_model=$3 LIMIT 1", [datasetId, config.invoiceTable, process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text"]);
    if (!ready.rowCount) throw new Error("Index the invoice table's non-sensitive text columns before running semantic reconciliation.");
  }
  const runResult = await pool.query(
    "INSERT INTO reconciliation_runs (dataset_id,payment_table,invoice_table,config,status,total_payments,manual_review_minutes) VALUES ($1,$2,$3,$4,'running',$5,$6) RETURNING id",
    [datasetId, config.paymentTable, config.invoiceTable, JSON.stringify(config), paymentResult.rows.length, config.manualReviewMinutes],
  );
  const runId = runResult.rows[0].id as string;
  const startedAt = performance.now();
  let stp = 0, review = 0, unmatched = 0;
  try {
    const payments = paymentResult.rows;
    for (let offset = 0; offset < payments.length; offset += 16) {
      const batch = payments.slice(offset, offset + 16);
      const rowsToInsert: Array<{ paymentId: string; paymentAmount: number | null; invoiceId: string | null; invoiceAmount: number | null; confidence: number; exact: boolean; rationale: string; candidates: unknown[]; status: string; straightThrough: boolean }> = [];
      const noteIndexes = config.paymentNoteColumn ? batch.map((row, index) => {
        return String(row.note ?? "").trim() && !exactMatchesByPayment.has(String(row.row_id)) ? index : -1;
      }).filter((index) => index >= 0) : [];
      const notes = noteIndexes.map((index) => String(batch[index]!.note).slice(0, 2_000));
      const semantic = notes.length ? await searchDatasetTexts(datasetId, notes, 12, config.invoiceTable) : null;
      for (let index = 0; index < batch.length; index++) {
        const payment = batch[index]!;
        const paymentIdValue = String(payment.row_id);
        const paymentAmount = numeric(payment.amount);
        const exactIds = exactMatchesByPayment.get(paymentIdValue) ?? [];
        const semanticIndex = noteIndexes.indexOf(index);
        const sources = (semanticIndex < 0 ? [] : semantic?.results[semanticIndex]?.sources ?? []) as Array<{ sourceId: string; similarity: number }>;
        const semanticScores = new Map<string, number>();
        for (const source of sources) semanticScores.set(source.sourceId, Math.max(semanticScores.get(source.sourceId) ?? 0, Math.max(0, Math.min(1, Number(source.similarity)))));
        const candidateIds = exactIds.length
          ? new Set(exactIds.slice(0, topCandidates))
          : new Set(semanticScores.keys());
        const exactIdSet = new Set(exactIds);
        const candidates = [...candidateIds].map((id) => {
          const invoice = invoices.get(id);
          if (!invoice) return null;
          const isExact = exactIdSet.has(id);
          const similarity = semanticScores.get(id) ?? 0;
          const amountScore = amountAgreement(paymentAmount, invoice.amount);
          const confidence = isExact
            ? amountScore === null ? 0.84 : 0.5 + 0.5 * amountScore
            : amountScore === null ? similarity * 0.72 : similarity * amountScore;
          const rationale = isExact
            ? amountScore === null ? "Exact key match; amount comparison was unavailable." : `Exact key match; amount agreement ${(amountScore * 100).toFixed(1)}%.`
            : `Semantic note similarity ${(similarity * 100).toFixed(1)}%; amount agreement ${amountScore === null ? "unavailable" : (amountScore * 100).toFixed(1) + "%"}.`;
          return { invoiceId: id, invoiceAmount: invoice.amount, confidence: Number(confidence.toFixed(5)), semanticSimilarity: Number(similarity.toFixed(5)), amountAgreement: amountScore === null ? null : Number(amountScore.toFixed(5)), exactKeyMatch: isExact, rationale };
        }).filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
          .sort((left, right) => right.confidence - left.confidence).slice(0, topCandidates);
        const best = candidates[0];
        const confidence = best?.confidence ?? 0;
        const straightThrough = !!best && confidence >= confidenceThreshold;
        const status = straightThrough ? "auto_applied" : best ? "needs_review" : "unmatched";
        if (straightThrough) stp++; else if (best) review++; else unmatched++;
        const rationale = best?.rationale ?? "No exact key or indexed text candidate was found.";
        rowsToInsert.push({ paymentId: paymentIdValue, paymentAmount, invoiceId: best?.invoiceId ?? null, invoiceAmount: best?.invoiceAmount ?? null, confidence, exact: best?.exactKeyMatch ?? false, rationale, candidates, status, straightThrough });
      }
      const values: unknown[] = [];
      const tuples = rowsToInsert.map((row, index) => {
        const base = index * 11;
        values.push(runId, row.paymentId, row.paymentAmount, row.invoiceId, row.invoiceAmount, row.confidence, row.exact, row.rationale, JSON.stringify(row.candidates), row.status, row.straightThrough);
        return "($" + (base + 1) + ",$" + (base + 2) + ",$" + (base + 3) + ",$" + (base + 4) + ",$" + (base + 5) + ",$" + (base + 6) + ",$" + (base + 7) + ",$" + (base + 8) + ",$" + (base + 9) + ",$" + (base + 10) + ",$" + (base + 11) + ")";
      });
      await pool.query("INSERT INTO reconciliation_matches (run_id,payment_source_id,payment_amount,matched_invoice_id,invoice_amount,confidence,exact_key_match,rationale,candidates,status,straight_through) VALUES " + tuples.join(","), values);
    }
    const durationMs = Math.round(performance.now() - startedAt);
    await pool.query("UPDATE reconciliation_runs SET status='completed',stp_count=$2,review_count=$3,unmatched_count=$4,duration_ms=$5,completed_at=now() WHERE id=$1", [runId, stp, review, unmatched, durationMs]);
    await saveMetricSnapshot(runId);
    return { runId, totalPayments: paymentResult.rows.length, straightThrough: stp, needsReview: review, unmatched, durationMs, confidenceThreshold, manualReviewMinutes: config.manualReviewMinutes };
  } catch (error) {
    await pool.query("UPDATE reconciliation_runs SET status='failed' WHERE id=$1", [runId]);
    throw error;
  }
}

export async function getReconciliation(datasetId: string, offset = 0) {
  await ensureMetadataSchema();
  const pool = getPool();
  const run = await pool.query("SELECT * FROM reconciliation_runs WHERE dataset_id=$1 AND status='completed' ORDER BY created_at DESC LIMIT 1", [datasetId]);
  if (!run.rowCount) return null;
  const data = run.rows[0]!;
  const summary = await pool.query(
    `SELECT count(*) FILTER (WHERE human_reviewed) AS labeled,
            count(*) FILTER (WHERE human_reviewed AND straight_through AND human_invoice_id IS NOT DISTINCT FROM matched_invoice_id) AS correct_auto,
            count(*) FILTER (WHERE human_reviewed AND straight_through) AS labeled_auto,
            count(*) FILTER (WHERE status='needs_review') AS pending_review,
            count(*) FILTER (WHERE status='unmatched' AND NOT human_reviewed) AS pending_unmatched
     FROM reconciliation_matches WHERE run_id=$1`, [data.id],
  );
  const counts = summary.rows[0]!;
  const stpCount = Number(data.stp_count);
  const total = Number(data.total_payments);
  const labeledAuto = Number(counts.labeled_auto);
  const correctAuto = Number(counts.correct_auto);
  const matches = await pool.query(
    "SELECT id,payment_source_id AS \"paymentId\",payment_amount AS \"paymentAmount\",matched_invoice_id AS \"invoiceId\",invoice_amount AS \"invoiceAmount\",confidence,exact_key_match AS \"exactKeyMatch\",rationale,candidates,status,straight_through AS \"straightThrough\",human_reviewed AS \"humanReviewed\",human_invoice_id AS \"humanInvoiceId\",human_decision AS \"humanDecision\",review_duration_seconds AS \"reviewDurationSeconds\" FROM reconciliation_matches WHERE run_id=$1 ORDER BY CASE WHEN status='needs_review' THEN 0 WHEN status='unmatched' THEN 1 ELSE 2 END,confidence DESC LIMIT 101 OFFSET $2",
    [data.id, Math.max(0, offset)],
  );
  const history = await pool.query("SELECT labeled_auto_count AS \"labeledAuto\",stp_rate AS \"stpRate\",accuracy_rate AS \"accuracyRate\",estimated_hours_saved AS \"estimatedHoursSaved\",created_at AS \"createdAt\" FROM reconciliation_metric_snapshots WHERE run_id=$1 ORDER BY created_at DESC LIMIT 30", [data.id]);
  const manualMinutes = Number(data.manual_review_minutes);
  return {
    run: { id: data.id, paymentTable: data.payment_table, invoiceTable: data.invoice_table, status: data.status, createdAt: data.created_at, totalPayments: total, straightThrough: stpCount, needsReview: Number(counts.pending_review), unmatched: Number(counts.pending_unmatched), durationMs: Number(data.duration_ms ?? 0), manualReviewMinutes: manualMinutes },
    metrics: { stpRate: total ? stpCount / total : 0, labeledAuto: labeledAuto, accuracyRate: labeledAuto ? correctAuto / labeledAuto : null, estimatedHoursSaved: stpCount * manualMinutes / 60 },
    matches: matches.rows.slice(0, 100), offset: Math.max(0, offset), hasMore: matches.rows.length > 100, history: history.rows.reverse(),
  };
}

export async function recordReconciliationDecision(input: { datasetId: string; matchId: string; invoiceId: string | null; reviewDurationSeconds: number }) {
  await ensureMetadataSchema();
  const pool = getPool();
  const matchResult = await pool.query(
    "SELECT m.*,r.dataset_id FROM reconciliation_matches m JOIN reconciliation_runs r ON r.id=m.run_id WHERE m.id=$1 AND r.dataset_id=$2 AND r.status='completed'",
    [input.matchId, input.datasetId],
  );
  if (!matchResult.rowCount) throw new Error("Reconciliation match not found.");
  const match = matchResult.rows[0]!;
  const candidates = match.candidates as Array<{ invoiceId: string }>;
  if (input.invoiceId && !candidates.some((candidate) => candidate.invoiceId === input.invoiceId)) throw new Error("Choose one of the candidate invoices shown for this payment.");
  const decision = input.invoiceId === null ? "no_match" : input.invoiceId === match.matched_invoice_id ? "approved" : "overridden";
  const status = input.invoiceId === null ? "unmatched" : decision;
  const updated = await pool.query(
    "UPDATE reconciliation_matches SET status=$2,human_reviewed=true,human_invoice_id=$3,human_decision=$4,reviewed_at=now(),review_duration_seconds=$5 WHERE id=$1 RETURNING id,status,human_invoice_id AS \"humanInvoiceId\",human_decision AS \"humanDecision\",straight_through AS \"straightThrough\"",
    [input.matchId, status, input.invoiceId, decision, input.reviewDurationSeconds],
  );
  await saveMetricSnapshot(match.run_id as string);
  return updated.rows[0];
}
