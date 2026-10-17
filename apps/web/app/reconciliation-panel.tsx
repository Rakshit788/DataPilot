"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Column = { name: string; inferredType: string; likelyPrimaryKey: boolean; sensitive: boolean };
type Table = { tableName?: string; file: string; columns: Column[]; rowCount: number };
type Config = { paymentTable: string; invoiceTable: string; paymentIdColumn: string; invoiceIdColumn: string; paymentAmountColumn: string; invoiceAmountColumn: string; paymentNoteColumn: string; paymentKeyColumn: string; invoiceKeyColumn: string; manualReviewMinutes: number };
type Candidate = { invoiceId: string; invoiceAmount: number | null; confidence: number; exactKeyMatch: boolean; rationale: string };
type Match = { id: string; paymentId: string; paymentAmount: number | null; invoiceId: string | null; invoiceAmount: number | null; confidence: number; exactKeyMatch: boolean; rationale: string; candidates: Candidate[]; status: string; straightThrough: boolean; humanReviewed: boolean; humanInvoiceId: string | null; humanDecision: string | null };
type Report = { run: { id: string; totalPayments: number; straightThrough: number; needsReview: number; unmatched: number; manualReviewMinutes: number }; metrics: { stpRate: number; labeledAuto: number; accuracyRate: number | null; estimatedHoursSaved: number }; matches: Match[]; offset: number; hasMore: boolean; history: Array<{ labeledAuto: number; stpRate: number | string; accuracyRate: number | string | null; estimatedHoursSaved: number | string; createdAt: string }> };

const idOf = (table: Table) => table.tableName ?? table.file.replace(/\.csv$/i, "");
const numbers = (table?: Table) => table?.columns.filter((column) => column.inferredType === "number") ?? [];
const texts = (table?: Table) => table?.columns.filter((column) => column.inferredType === "text" && !column.sensitive) ?? [];
const first = (values: Column[]) => values[0]?.name ?? "";

export default function ReconciliationPanel({ datasetId, tables }: { datasetId: string; tables: Table[] }) {
  const [config, setConfig] = useState<Config>({ paymentTable: "", invoiceTable: "", paymentIdColumn: "", invoiceIdColumn: "", paymentAmountColumn: "", invoiceAmountColumn: "", paymentNoteColumn: "", paymentKeyColumn: "", invoiceKeyColumn: "", manualReviewMinutes: 3 });
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const seenAt = useRef(new Map<string, number>());
  const payment = tables.find((table) => idOf(table) === config.paymentTable);
  const invoice = tables.find((table) => idOf(table) === config.invoiceTable);
  const paymentColumns = useMemo(() => payment?.columns ?? [], [payment]);
  const invoiceColumns = useMemo(() => invoice?.columns ?? [], [invoice]);

  async function refresh(page = offset) {
    const response = await fetch("/api/datasets/" + datasetId + "/reconciliation?offset=" + page).then((res) => res.json());
    if (response.reconciliation) {
      setReport(response.reconciliation);
      setOffset(response.reconciliation.offset);
      for (const match of response.reconciliation.matches) if (!seenAt.current.has(match.id)) seenAt.current.set(match.id, Date.now());
    }
  }

  useEffect(() => {
    if (!tables.length) return;
    setReport(null);
    setSelected({});
    setOffset(0);
    const pay = tables.find((table) => /payment|remit|cash|receipt/i.test(idOf(table))) ?? tables[0]!;
    const inv = tables.find((table) => table !== pay && /invoice|bill|receivable/i.test(idOf(table))) ?? tables.find((table) => table !== pay) ?? tables[0]!;
    const matchedKey = pay.columns.find((column) => inv.columns.some((other) => other.name === column.name) && /invoice|tax|customer|account/i.test(column.name));
    setConfig({ paymentTable: idOf(pay), invoiceTable: idOf(inv), paymentIdColumn: first(pay.columns.filter((column) => column.likelyPrimaryKey && !column.sensitive)), invoiceIdColumn: first(inv.columns.filter((column) => column.likelyPrimaryKey && !column.sensitive)), paymentAmountColumn: first(numbers(pay)), invoiceAmountColumn: first(numbers(inv)), paymentNoteColumn: first(texts(pay)), paymentKeyColumn: matchedKey?.name ?? "", invoiceKeyColumn: matchedKey?.name ?? "", manualReviewMinutes: 3 });
    void refresh().catch(() => undefined);
  }, [datasetId, tables]);

  function changeTable(kind: "payment" | "invoice", name: string) {
    const table = tables.find((item) => idOf(item) === name);
    if (!table) return;
    if (kind === "payment") setConfig((old) => ({ ...old, paymentTable: name, paymentIdColumn: first(table.columns.filter((column) => column.likelyPrimaryKey && !column.sensitive)), paymentAmountColumn: first(numbers(table)), paymentNoteColumn: first(texts(table)), paymentKeyColumn: "", invoiceKeyColumn: "" }));
    else setConfig((old) => ({ ...old, invoiceTable: name, invoiceIdColumn: first(table.columns.filter((column) => column.likelyPrimaryKey && !column.sensitive)), invoiceAmountColumn: first(numbers(table)), paymentKeyColumn: "", invoiceKeyColumn: "" }));
  }

  async function run() {
    setBusy(true); setError(""); setNotice("");
    try {
      const body: Record<string, unknown> = { ...config };
      if (!config.paymentNoteColumn) delete body.paymentNoteColumn;
      if (!config.paymentKeyColumn) { delete body.paymentKeyColumn; delete body.invoiceKeyColumn; }
      const response = await fetch("/api/datasets/" + datasetId + "/reconciliation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Reconciliation failed.");
      setOffset(0);
      await refresh(0);
      setNotice("High-confidence results are simulated local matches; they do not post to a ledger.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Reconciliation failed."); }
    finally { setBusy(false); }
  }

  async function decide(match: Match, invoiceId: string | null) {
    setError(""); setNotice("");
    try {
      const seconds = Math.max(0, (Date.now() - (seenAt.current.get(match.id) ?? Date.now())) / 1000);
      const response = await fetch("/api/datasets/" + datasetId + "/reconciliation/matches/" + match.id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoiceId, reviewDurationSeconds: seconds }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save this decision.");
      await refresh();
      setNotice("Human decision saved as ground truth.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this decision."); }
  }

  const options = (items: Column[], value: string, onChange: (value: string) => void, label: string, emptyLabel?: string) =>
    <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{emptyLabel && <option value="">{emptyLabel}</option>}{items.map((column) => <option key={column.name} value={column.name}>{column.name}{column.sensitive ? " · sensitive, server-side only" : ""}</option>)}</select></label>;

  return <section className="reconciliation-section" id="reconciliation">
    <div className="section-header"><div><span className="section-kicker">PAYMENT RECONCILIATION</span><h2>Match remittances to invoices</h2></div><span className="fresh-pill"><i /> EXACT · SEMANTIC · HUMAN REVIEW</span></div>
    <p className="reconciliation-intro">Exact identifiers are checked first. If they miss, indexed invoice text retrieves candidates and an amount-aware ranker scores them. This deterministic heuristic score is not a calibrated probability: scores at or above 85% become simulated straight-through matches; lower scores go to human review.</p>
    <div className="reconciliation-config">
      <label>Payment table<select value={config.paymentTable} onChange={(event) => changeTable("payment", event.target.value)}>{tables.map((table) => <option key={idOf(table)} value={idOf(table)}>{idOf(table)}</option>)}</select></label>
      <label>Invoice table<select value={config.invoiceTable} onChange={(event) => changeTable("invoice", event.target.value)}>{tables.filter((table) => idOf(table) !== config.paymentTable).map((table) => <option key={idOf(table)} value={idOf(table)}>{idOf(table)}</option>)}</select></label>
      {options(paymentColumns.filter((column) => column.likelyPrimaryKey && !column.sensitive), config.paymentIdColumn, (value) => setConfig({ ...config, paymentIdColumn: value }), "Payment row ID")}
      {options(invoiceColumns.filter((column) => column.likelyPrimaryKey && !column.sensitive), config.invoiceIdColumn, (value) => setConfig({ ...config, invoiceIdColumn: value }), "Invoice row ID")}
      {options(numbers(payment), config.paymentAmountColumn, (value) => setConfig({ ...config, paymentAmountColumn: value }), "Payment amount")}
      {options(numbers(invoice), config.invoiceAmountColumn, (value) => setConfig({ ...config, invoiceAmountColumn: value }), "Invoice amount due")}
      {options(paymentColumns, config.paymentKeyColumn, (value) => setConfig({ ...config, paymentKeyColumn: value, invoiceKeyColumn: value ? config.invoiceKeyColumn : "" }), "Exact key · payment", "Skip exact key")}
      {options(invoiceColumns, config.invoiceKeyColumn, (value) => setConfig({ ...config, invoiceKeyColumn: value }), "Exact key · invoice", "Skip exact key")}
      {options(texts(payment), config.paymentNoteColumn, (value) => setConfig({ ...config, paymentNoteColumn: value }), "Remittance note", "Skip semantic search")}
      <label>Manual review baseline · minutes<input type="number" min="0" max="60" step="0.5" value={config.manualReviewMinutes} onChange={(event) => setConfig({ ...config, manualReviewMinutes: Math.min(60, Math.max(0, Number(event.target.value))) })} /></label>
      <button className="primary-button" disabled={busy || !payment || !invoice || !config.paymentIdColumn || !config.invoiceIdColumn || !config.paymentAmountColumn || !config.invoiceAmountColumn || (!config.paymentNoteColumn && !config.paymentKeyColumn)} onClick={() => void run()}>{busy ? "Matching payments…" : "Run reconciliation"}</button>
    </div>
    <p className="reconciliation-note">Index invoice description text with “Index text for search” first to enable semantic candidates. Sensitive exact keys are compared only on the local server; they are not embedded or shown in this queue. Amount comparisons use uploaded values as-is, so use matching currency units.</p>
    {error && <div className="error-message" role="alert">{error}</div>}{notice && <div className="reconciliation-notice" role="status">{notice}</div>}
    {report && <>
      <div className="reconciliation-metrics">
        <div><span>STP RATE</span><strong>{(report.metrics.stpRate * 100).toFixed(1)}%</strong><small>{report.run.straightThrough} of {report.run.totalPayments} payments</small></div>
        <div><span>AUTO-MATCH ACCURACY</span><strong>{report.metrics.accuracyRate === null ? "Awaiting labels" : (report.metrics.accuracyRate * 100).toFixed(1) + "%"}</strong><small>{report.metrics.labeledAuto} auto matches human-reviewed</small></div>
        <div><span>ESTIMATED TIME SAVED</span><strong>{report.metrics.estimatedHoursSaved.toFixed(1)} hrs</strong><small>{report.run.manualReviewMinutes} min manual baseline · estimate</small></div>
        <div><span>REVIEW QUEUE</span><strong>{report.run.needsReview + report.run.unmatched}</strong><small>{report.run.needsReview} suggestions · {report.run.unmatched} no candidate</small></div>
      </div>
      {report.history.length > 1 && <details className="reconciliation-history"><summary>Feedback metric history <span>{report.history.length} saved snapshots</span></summary><div className="history-table"><div><b>Recorded</b><b>STP</b><b>Labeled auto matches</b><b>Accuracy</b><b>Estimated hours saved</b></div>{report.history.slice(-10).reverse().map((item, index) => <div key={item.createdAt + index}><span>{new Date(item.createdAt).toLocaleString()}</span><span>{(Number(item.stpRate) * 100).toFixed(1)}%</span><span>{item.labeledAuto}</span><span>{item.accuracyRate === null ? "Awaiting labels" : (Number(item.accuracyRate) * 100).toFixed(1) + "%"}</span><span>{Number(item.estimatedHoursSaved).toFixed(1)}</span></div>)}</div></details>}
      <div className="reconciliation-results-head"><strong>Human review & auto-match audit</strong><span>Run {report.run.id.slice(0, 8)} · showing {offset + 1}–{offset + report.matches.length}</span></div>
      <div className="reconciliation-match-list">{report.matches.map((match) => <article key={match.id} className={"match-card " + match.status}>
        <div className="match-main"><div><span className={"match-status " + match.status}>{match.status.replaceAll("_", " ")}</span><strong>Payment {match.paymentId}</strong></div><span className="match-amount">{match.paymentAmount === null ? "Amount unavailable" : Number(match.paymentAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>
        <div className="match-evidence"><span>Prediction: {match.invoiceId ?? "No candidate"}</span>{match.invoiceAmount !== null && <span>Invoice amount {Number(match.invoiceAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}<b>{(Number(match.confidence) * 100).toFixed(1)}% confidence</b>{match.exactKeyMatch && <em>Exact key</em>}</div>
        <p>{match.rationale}</p>
        {match.humanReviewed ? <div className="ground-truth">Ground truth: {match.humanDecision === "no_match" ? "no matching invoice" : match.humanDecision + " · " + match.humanInvoiceId}{match.straightThrough && <small>Auto-match label: {match.humanInvoiceId === match.invoiceId ? "correct" : "incorrect"}</small>}</div> : <div className="match-review-controls">
          <select aria-label="Select invoice candidate" value={selected[match.id] ?? match.invoiceId ?? ""} onChange={(event) => setSelected({ ...selected, [match.id]: event.target.value })}><option value="">No matching invoice</option>{match.candidates.map((candidate) => <option key={candidate.invoiceId} value={candidate.invoiceId}>{candidate.invoiceId} · {(candidate.confidence * 100).toFixed(1)}% · {candidate.invoiceAmount === null ? "amount n/a" : Number(candidate.invoiceAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</option>)}</select>
          <button className="confirmed-button" onClick={() => { const choice = Object.prototype.hasOwnProperty.call(selected, match.id) ? selected[match.id] : match.invoiceId ?? ""; void decide(match, choice || null); }}>Save decision</button>
        </div>}
        {match.candidates.length > 1 && <details className="candidate-details"><summary>Ranked candidates <span>{match.candidates.length}</span></summary><ol>{match.candidates.map((candidate) => <li key={candidate.invoiceId}><span>{candidate.invoiceId}</span><b>{(candidate.confidence * 100).toFixed(1)}%</b><small>{candidate.rationale}</small></li>)}</ol></details>}
      </article>)}{report.matches.length === 0 && <p className="reconciliation-note">No payments were found in the latest run.</p>}</div>
      <div className="reconciliation-pagination"><button className="subtle-button" disabled={offset === 0} onClick={() => void refresh(Math.max(0, offset - 100))}>Previous 100</button><span>{offset + 1}–{offset + report.matches.length} of {report.run.totalPayments}</span><button className="subtle-button" disabled={!report.hasMore} onClick={() => void refresh(offset + 100)}>Next 100</button></div>
    </>}
  </section>;
}
