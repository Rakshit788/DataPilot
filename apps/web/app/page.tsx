"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import ResultsChart, { type ChartSpec } from "./results-chart";

type Column = {
  name: string;
  inferredType: string;
  nullCount: number;
  nullPercent: number;
  approximateDistinctCount: number;
  likelyPrimaryKey: boolean;
  likelyJoinKey: boolean;
  sensitive: boolean;
  min?: number | string | null;
  max?: number | string | null;
};

type Profile = {
  file: string;
  tableName?: string;
  rowCount: number;
  columns: Column[];
  likelyPrimaryKeys: string[];
  likelyJoinKeys: string[];
  sample: Record<string, string>[];
};

type QueryResult = { columns: Array<{ name: string; dataTypeId?: number }>; rows: Record<string, unknown>[]; returned_rows?: number; truncated?: boolean; execution_ms?: number; generated_sql?: string };
type ChatResult = { analysisId: string; conversationId: string; answer: string; resultId: string | null; chart?: unknown; sources?: Array<{ sourceTable: string; sourceId: string; text: string; similarity: number }>; trace: Array<{ step: number; tool: string; status: string; durationMs: number; error?: string }>; model: string; durationMs: number };
type ScenarioResult = { baseline: number; projected: number; avoided: number; formula: string; assumptions: { relativeReduction: number; measureColumn: string } };
type Relationship = { id: string; sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string; cardinality: string; matchPercent: number | string; confidence: number | string; confirmed: boolean };

function Icon({ name }: { name: "grid" | "database" | "chart" | "settings" | "upload" | "search" | "spark" }) {
  const paths: Record<string, string> = {
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
    database: "M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3ZM3 6v6c0 1.66 4.03 3 9 3s9-1.34 9-3V6M3 12v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6",
    chart: "M4 19V5m0 14h17M8 15l3-4 3 2 6-7",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2m9-9h-2M5 12H3m15.36-6.36-1.42 1.42M7.06 16.94l-1.42 1.42m12.72 0-1.42-1.42M7.06 7.06 5.64 5.64",
    upload: "M12 16V4m0 0L7 9m5-5 5 5M4 16v4h16v-4",
    search: "m20 20-4.2-4.2M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
    spark: "m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z",
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

function validChartSpec(value: unknown): ChartSpec | null {
  if (!value || typeof value !== "object") return null;
  const chart = value as Partial<ChartSpec>;
  if (!["bar", "line", "pie", "scatter", "table"].includes(chart.type ?? "")) return null;
  if (typeof chart.xKey !== "string" || typeof chart.yKey !== "string" || typeof chart.title !== "string") return null;
  return chart as ChartSpec;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [datasetName, setDatasetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const [conversationId, setConversationId] = useState("");
  const [chatText, setChatText] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [chatResult, setChatResult] = useState<ChatResult | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [scenarioRate, setScenarioRate] = useState(10);
  const [scenario, setScenario] = useState<ScenarioResult | null>(null);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [ragBusy, setRagBusy] = useState(false);
  const [ragMessage, setRagMessage] = useState("");

  useEffect(() => {
    fetch("/api/datasets").then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load datasets.");
      const dataset = result.datasets?.[0];
      if (dataset) {
        setDatasetId(dataset.id);
        setDatasetName(dataset.name);
        setProfiles(dataset.tables ?? []);
        setRelationships(dataset.relationships ?? []);
        fetch("/api/datasets/" + dataset.id + "/conversations").then((response) => response.json()).then(async (payload) => {
          const conversation = payload.conversation;
          if (!conversation) return;
          setConversationId(conversation.id);
          const lastAssistant = [...(conversation.messages ?? [])].reverse().find((message: { role: string }) => message.role === "assistant");
          if (lastAssistant?.metadata?.analysisId) {
            setChatResult(lastAssistant.metadata as ChatResult);
            if (lastAssistant.metadata.resultId) {
              const resultResponse = await fetch("/api/results/" + lastAssistant.metadata.resultId);
              const resultData = await resultResponse.json();
              if (resultResponse.ok) setQueryResult(resultData.result);
            }
          }
        }).catch(() => undefined);
      }
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not connect to PostgreSQL."));
  }, []);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    const body = new FormData();
    Array.from(files).forEach((file) => body.append("files", file));
    try {
      const response = await fetch("/api/datasets", { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not import these files.");
      setDatasetId(result.dataset.id);
      setDatasetName(result.dataset.name);
      setProfiles(result.dataset.tables);
      setRelationships(result.dataset.relationships ?? []);
      setSelected(0);
      setConversationId("");
      setChatResult(null);
      setQueryResult(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not profile these files.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function importOlist() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/datasets/olist/import", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not import Olist.");
      setDatasetId(result.dataset.id);
      setDatasetName(result.dataset.name);
      setProfiles(result.dataset.tables);
      setRelationships(result.dataset.relationships ?? []);
      setSelected(0);
      setConversationId("");
      setChatResult(null);
      setQueryResult(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import Olist.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRelationship(relationship: Relationship) {
    const response = await fetch(`/api/datasets/${datasetId}/relationships/${relationship.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: !relationship.confirmed }) });
    const result = await response.json();
    if (!response.ok) {
      setError(result.error ?? "Could not update this relationship.");
      return;
    }
    setRelationships((items) => items.map((item) => item.id === relationship.id ? { ...item, confirmed: result.relationship.confirmed } : item));
  }

  async function indexTextTable(profile: Profile) {
    const tableName = profile.tableName ?? profile.file.replace(/\.csv$/i, "");
    const idColumn = profile.columns.find((column) => column.likelyPrimaryKey && !column.sensitive);
    const textColumns = profile.columns.filter((column) => column.inferredType === "text" && !column.sensitive).map((column) => column.name).slice(0, 12);
    if (!idColumn || textColumns.length === 0) { setRagMessage("This table needs a safe unique key and at least one non-sensitive text column."); return; }
    setRagBusy(true); setRagMessage("");
    try {
      const response = await fetch(`/api/datasets/${datasetId}/rag/index`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tableName, sourceIdColumn: idColumn.name, textColumns }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not index this table.");
      setRagMessage(`Indexed ${result.documents.toLocaleString()} documents into ${result.chunks.toLocaleString()} searchable chunks.`);
    } catch (cause) { setRagMessage(cause instanceof Error ? cause.message : "Could not index this table."); }
    finally { setRagBusy(false); }
  }

  async function askQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!datasetId || !chatText.trim()) return;
    setChatBusy(true);
    setChatError("");
    setQueryResult(null);
    setScenario(null);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ datasetId, conversationId: conversationId || undefined, message: chatText.trim() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Analysis failed.");
      setChatResult(result);
      setConversationId(result.conversationId);
      setChatText("");
      if (result.resultId) {
        const resultResponse = await fetch("/api/results/" + result.resultId);
        const payload = await resultResponse.json();
        if (resultResponse.ok) {
          setQueryResult(payload.result);
          setScenario(null);
        }
      }
    } catch (cause) {
      setChatError(cause instanceof Error ? cause.message : "Analysis failed.");
    } finally {
      setChatBusy(false);
    }
  }

  async function runScenario(column: string) {
    if (!chatResult?.resultId) return;
    setScenarioBusy(true);
    setChatError("");
    try {
      const response = await fetch("/api/scenarios", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resultId: chatResult.resultId, measureColumn: column, relativeReduction: scenarioRate / 100 }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Scenario calculation failed.");
      setScenario(payload);
    } catch (cause) {
      setChatError(cause instanceof Error ? cause.message : "Scenario calculation failed.");
    } finally {
      setScenarioBusy(false);
    }
  }

  const activeProfile = profiles[selected];
  const totalRows = profiles.reduce((sum, profile) => sum + profile.rowCount, 0);
  const totalColumns = profiles.reduce((sum, profile) => sum + profile.columns.length, 0);
  const nullableColumns = profiles.flatMap((profile) => profile.columns).filter((column) => column.nullPercent > 0).length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark"><Icon name="spark" /></span><span>datapilot<span className="brand-dot">.</span></span></a>
        <div className="workspace-switch"><div className="workspace-avatar">W</div><div className="workspace-copy"><span className="muted-label">WORKSPACE</span><strong>My workspace</strong></div><span className="chevron">⌄</span></div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="nav-list">
          <a className="nav-item active" href="#overview"><Icon name="grid" /> Overview</a>
          <a className="nav-item" href="#datasets"><Icon name="database" /> Datasets <span className="nav-count">{profiles.length || "0"}</span></a>
          <a className="nav-item" href="#analyst"><Icon name="chart" /> Analyses</a>
        </nav>
        <div className="sidebar-bottom"><a className="nav-item disabled" href="#settings"><Icon name="settings" /> Settings</a><div className="user-card"><div className="user-avatar">R</div><div className="workspace-copy"><strong>Rakshit</strong><span className="user-plan">Free workspace</span></div><span className="chevron">···</span></div></div>
      </aside>

      <main className="main-content" id="overview">
        <input ref={inputRef} type="file" accept=".csv,text/csv" multiple hidden onChange={(event) => void upload(event.target.files)} />
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>Overview</strong></div><div className="top-actions"><span className="local-badge"><i /> Local workspace</span><button className="icon-button" aria-label="Search"><Icon name="search" /></button><div className="top-avatar">R</div></div></header>
        <div className="content-wrap">
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR DATA, IN CONTEXT</div><h1>Good data starts<br />with <em>understanding.</em></h1><p className="lead">Bring your data in. DataPilot will map what’s there before you ask a single question.</p></div><div className="heading-aside"><div className="aside-icon"><Icon name="spark" /></div><span>YOUR ANALYST IS<br /><strong>READY WHEN YOU ARE</strong></span></div></section>

          {profiles.length === 0 ? (
            <section className={`upload-card ${busy ? "is-busy" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }}>
              <div className="upload-illustration"><div className="upload-orbit orbit-one" /><div className="upload-orbit orbit-two" /><div className="upload-icon"><Icon name={busy ? "spark" : "upload"} /></div><span className="float-chip chip-a">.CSV</span><span className="float-chip chip-b">↗</span></div>
              <h2>{busy ? "Importing your data…" : "Let’s start with your data"}</h2>
              <p>Drop in one or more CSV files. We’ll map the columns, check data quality,<br className="desktop-break" /> and show you what’s inside.</p>
              <div className="upload-actions"><button className="primary-button" disabled={busy} onClick={() => inputRef.current?.click()}><Icon name="upload" /> {busy ? "Importing files" : "Choose CSV files"}</button><button className="secondary-button" disabled={busy} onClick={() => void importOlist()}>{busy ? "Working…" : "Load Olist demo data"}</button></div>
              <div className="upload-hint"><span>CSV files</span><b>·</b><span>50 MB total for uploads</span><b>·</b><span>Olist source files go in data/raw/</span></div>
              {error && <div className="error-message" role="alert">{error}</div>}
            </section>
          ) : (
            <>
              <section className="stats-grid">
                <div className="stat-card"><span className="stat-label">DATASET</span><div className="stat-value stat-name">{datasetName || "Untitled"}</div><span className="stat-note">Stored in PostgreSQL</span></div>
                <div className="stat-card"><span className="stat-label">ROWS PROFILED</span><div className="stat-value">{totalRows.toLocaleString()}</div><span className="stat-note">Across all uploaded files</span></div>
                <div className="stat-card"><span className="stat-label">COLUMNS MAPPED</span><div className="stat-value">{totalColumns}</div><span className="stat-note">{nullableColumns} with missing values</span></div>
                <button className="add-dataset" onClick={() => inputRef.current?.click()}><span className="add-icon">+</span><span><strong>Add related files</strong><small>Import another dataset</small></span></button>
              </section>
              {error && <div className="error-message" role="alert">{error}</div>}
              <section className="data-section" id="datasets"><div className="section-header"><div><span className="section-kicker">DATA INVENTORY</span><h2>Your data, mapped out</h2></div><span className="fresh-pill"><i /> PROFILED JUST NOW</span></div>
                <div className="data-layout"><div className="table-list"><div className="table-list-head">TABLES <span>{profiles.length}</span></div>{profiles.map((profile, index) => <button key={profile.file} onClick={() => setSelected(index)} className={`table-item ${selected === index ? "selected" : ""}`}><span className="table-glyph"><Icon name="database" /></span><span className="table-info"><strong>{profile.file.replace(/\.csv$/i, "")}</strong><small>{profile.rowCount.toLocaleString()} rows · {profile.columns.length} columns</small></span><span className="table-arrow">›</span></button>)}</div>
                  {activeProfile && <div className="profile-panel"><div className="profile-title"><div><span className="table-glyph large"><Icon name="database" /></span><div><h3>{activeProfile.file.replace(/\.csv$/i, "")}</h3><span>{activeProfile.rowCount.toLocaleString()} rows <b>·</b> {activeProfile.columns.length} columns</span></div></div><div className="profile-actions"><button className="subtle-button" disabled={ragBusy} onClick={() => void indexTextTable(activeProfile)}>{ragBusy ? "Indexing text…" : "Index text for search"}</button><button className="subtle-button" onClick={() => inputRef.current?.click()}>＋ Add files</button></div></div>
                    {ragMessage && <div className="rag-message" role="status">{ragMessage}</div>}
                    <div className="profile-highlights"><div><span>LIKELY KEY</span><strong>{activeProfile.likelyPrimaryKeys[0] ?? "Not detected"}</strong></div><div><span>KEY CANDIDATES</span><strong>{activeProfile.likelyJoinKeys.length || "None"}</strong></div><div><span>NEEDS ATTENTION</span><strong>{activeProfile.columns.filter((column) => column.nullPercent > 0).length} columns</strong></div></div>
                    <div className="column-table-wrap"><table className="column-table"><thead><tr><th>Column</th><th>Type</th><th>Missing</th><th>Distinct ≈</th></tr></thead><tbody>{activeProfile.columns.map((column) => <tr key={column.name}><td><span className="column-name">{column.name}</span>{column.likelyPrimaryKey && <span className="key-tag">PK</span>}{column.sensitive && <span className="sensitive-tag">SENSITIVE</span>}</td><td><span className="type-pill">{column.inferredType}</span></td><td><span className={column.nullPercent > 0 ? "missing-value" : "ok-value"}>{column.nullPercent}%</span></td><td>{column.approximateDistinctCount.toLocaleString()}</td></tr>)}</tbody></table></div>
                    {activeProfile.sample.length > 0 && <details className="preview-details"><summary>Preview sample <span>Sensitive-looking fields are redacted</span></summary><div className="column-table-wrap"><table className="column-table preview-table"><thead><tr>{activeProfile.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead><tbody>{activeProfile.sample.map((row, index) => <tr key={index}>{activeProfile.columns.map((column) => <td key={column.name}>{row[column.name] || <span className="empty-cell">—</span>}</td>)}</tr>)}</tbody></table></div></details>}
                  </div>}
                </div>
                {relationships.length > 0 && <div className="relationship-list"><div className="relationship-heading"><div><span className="section-kicker">JOIN SUGGESTIONS</span><strong>Review table relationships</strong></div><span>{relationships.filter((relationship) => relationship.confirmed).length} confirmed</span></div>{relationships.map((relationship) => <div className="relationship-row" key={relationship.id}><span className="relationship-flow"><strong>{relationship.sourceTable}.{relationship.sourceColumn}</strong><b>→</b><strong>{relationship.targetTable}.{relationship.targetColumn}</strong></span><span className="relationship-match">{Number(relationship.matchPercent).toFixed(1)}% match · {relationship.cardinality.replace("_", " ")}</span><button className={relationship.confirmed ? "confirmed-button" : "subtle-button"} onClick={() => void confirmRelationship(relationship)}>{relationship.confirmed ? "✓ Confirmed" : "Review & confirm"}</button></div>)}</div>}
              </section>
              <section className="analyst-section" id="analyst">
                <div className="section-header"><div><span className="section-kicker">DATA ANALYST</span><h2>Ask a question about your data</h2></div><span className="fresh-pill"><i /> OLLAMA · POSTGRESQL</span></div>
                <form className="question-form" onSubmit={(event) => void askQuestion(event)}><textarea value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Which categories have the highest average freight cost?" maxLength={4000} rows={2} /><div className="question-footer"><span>Answers are computed from your dataset and show the SQL used.</span><button className="primary-button" disabled={chatBusy || !chatText.trim()}><Icon name="spark" /> {chatBusy ? "Analyzing…" : "Ask DataPilot"}</button></div></form>
                {chatError && <div className="error-message" role="alert">{chatError}</div>}
                {chatResult && <div className="analysis-card"><div className="answer-header"><span className="answer-mark"><Icon name="spark" /></span><div><strong>DataPilot</strong><small>{chatResult.model} · {(chatResult.durationMs / 1000).toFixed(1)}s · {chatResult.analysisId.slice(0, 8)}</small></div>{chatResult.resultId && <a className="export-button" href={`/api/results/${chatResult.resultId}/export.csv`}>↓ Export CSV</a>}</div>
                  <p className="answer-text">{chatResult.answer}</p>
                  {chatResult.sources && chatResult.sources.length > 0 && <details className="source-details"><summary>Text evidence <span>{chatResult.sources.length} retrieved sources</span></summary><ul>{chatResult.sources.map((source, index) => <li key={`${source.sourceTable}-${source.sourceId}-${index}`}><strong>{source.sourceTable} · {source.sourceId}</strong><small>{Math.round(source.similarity * 100)}% match</small><p>{source.text}</p></li>)}</ul></details>}
                  {chatResult.trace.length > 0 && <details className="trace-details"><summary>Execution trace <span>{chatResult.trace.length} tool steps</span></summary><ol>{chatResult.trace.map((trace) => <li key={trace.step}><span className={`trace-status ${trace.status}`}>{trace.status === "succeeded" ? "✓" : "!"}</span><strong>{trace.tool}</strong><small>{trace.durationMs} ms{trace.error ? ` · ${trace.error}` : ""}</small></li>)}</ol></details>}
                  {queryResult && <><div className="result-heading"><strong>Query results</strong><span>{queryResult.returned_rows ?? queryResult.rows.length} rows{queryResult.truncated ? " · showing first 500" : ""}{queryResult.execution_ms ? ` · ${queryResult.execution_ms} ms` : ""}</span></div>
                    <ResultsChart rows={queryResult.rows} columns={queryResult.columns} spec={validChartSpec(chatResult.chart)} />
                    <div className="column-table-wrap result-table-wrap"><table className="column-table"><thead><tr>{queryResult.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead><tbody>{queryResult.rows.slice(0, 100).map((row, rowIndex) => <tr key={rowIndex}>{queryResult.columns.map((column) => <td key={column.name}>{row[column.name] === null || row[column.name] === undefined ? <span className="empty-cell">—</span> : String(row[column.name])}</td>)}</tr>)}</tbody></table></div>
                    {queryResult.rows.length > 100 && <small className="table-footnote">Showing 100 rows in the page. The CSV export contains all returned rows.</small>}
                    <details className="sql-details"><summary>Executed SQL</summary><pre>{queryResult.generated_sql}</pre></details>
                    {chatResult.resultId && queryResult.rows.length === 1 && <div className="scenario-box"><div><span className="section-kicker">WHAT-IF SCENARIO</span><strong>Model a relative reduction</strong><small>Projection only. It does not represent an observed outcome.</small></div><div className="scenario-controls"><select aria-label="Measure column" id="scenario-measure">{queryResult.columns.filter((column) => Number.isFinite(Number(queryResult.rows[0]?.[column.name]))).map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select><label><input type="number" min="1" max="100" value={scenarioRate} onChange={(event) => setScenarioRate(Math.min(100, Math.max(1, Number(event.target.value))))} /> %</label><button className="subtle-button" disabled={scenarioBusy} onClick={() => { const select = document.getElementById("scenario-measure") as HTMLSelectElement | null; if (select) void runScenario(select.value); }}>{scenarioBusy ? "Calculating…" : "Calculate"}</button></div>{scenario && <div className="scenario-result"><span>Baseline <strong>{scenario.baseline.toLocaleString()}</strong></span><span>Projected <strong>{scenario.projected.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span><span>Difference <strong>{scenario.avoided.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span><small>{scenario.formula}; {scenario.assumptions.relativeReduction * 100}% relative reduction in {scenario.assumptions.measureColumn}.</small></div>}</div>}
                  </>}
                </div>}
              </section>
            </>
          )}
          <footer className="page-footer"><span>DATAPILOT <b>·</b> LOCAL-FIRST DATA ANALYSIS</span><span>Your data stays in this workspace</span></footer>
        </div>
      </main>
    </div>
  );
}
