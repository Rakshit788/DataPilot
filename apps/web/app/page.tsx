"use client";

import { useRef, useState } from "react";

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
  rowCount: number;
  columns: Column[];
  likelyPrimaryKeys: string[];
  likelyJoinKeys: string[];
  sample: Record<string, string>[];
};

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

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    const body = new FormData();
    Array.from(files).forEach((file) => body.append("files", file));
    try {
      const response = await fetch("/api/datasets/profile", { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not profile these files.");
      setProfiles(result.profiles);
      setSelected(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not profile these files.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
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
          <a className="nav-item disabled" href="#analyses"><Icon name="chart" /> Analyses</a>
        </nav>
        <div className="sidebar-bottom"><a className="nav-item disabled" href="#settings"><Icon name="settings" /> Settings</a><div className="user-card"><div className="user-avatar">R</div><div className="workspace-copy"><strong>Rakshit</strong><span className="user-plan">Free workspace</span></div><span className="chevron">···</span></div></div>
      </aside>

      <main className="main-content" id="overview">
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>Overview</strong></div><div className="top-actions"><span className="local-badge"><i /> Local workspace</span><button className="icon-button" aria-label="Search"><Icon name="search" /></button><div className="top-avatar">R</div></div></header>
        <div className="content-wrap">
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR DATA, IN CONTEXT</div><h1>Good data starts<br />with <em>understanding.</em></h1><p className="lead">Bring your data in. DataPilot will map what’s there before you ask a single question.</p></div><div className="heading-aside"><div className="aside-icon"><Icon name="spark" /></div><span>YOUR ANALYST IS<br /><strong>READY WHEN YOU ARE</strong></span></div></section>

          {profiles.length === 0 ? (
            <section className={`upload-card ${busy ? "is-busy" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }}>
              <input ref={inputRef} type="file" accept=".csv,text/csv" multiple hidden onChange={(event) => void upload(event.target.files)} />
              <div className="upload-illustration"><div className="upload-orbit orbit-one" /><div className="upload-orbit orbit-two" /><div className="upload-icon"><Icon name={busy ? "spark" : "upload"} /></div><span className="float-chip chip-a">.CSV</span><span className="float-chip chip-b">↗</span></div>
              <h2>{busy ? "Reading your data…" : "Let’s start with your data"}</h2>
              <p>Drop in one or more CSV files. We’ll map the columns, check data quality,<br className="desktop-break" /> and show you what’s inside.</p>
              <button className="primary-button" disabled={busy} onClick={() => inputRef.current?.click()}><Icon name="upload" /> {busy ? "Profiling files" : "Choose CSV files"}</button>
              <div className="upload-hint"><span>CSV files</span><b>·</b><span>Up to 50 MB each</span><b>·</b><span>Up to 8 files</span></div>
              {error && <div className="error-message" role="alert">{error}</div>}
            </section>
          ) : (
            <>
              <section className="stats-grid">
                <div className="stat-card"><span className="stat-label">DATASETS</span><div className="stat-value">{profiles.length}<span className="stat-suffix"> files</span></div><span className="stat-note">Loaded into this workspace</span></div>
                <div className="stat-card"><span className="stat-label">ROWS PROFILED</span><div className="stat-value">{totalRows.toLocaleString()}</div><span className="stat-note">Across all uploaded files</span></div>
                <div className="stat-card"><span className="stat-label">COLUMNS MAPPED</span><div className="stat-value">{totalColumns}</div><span className="stat-note">{nullableColumns} with missing values</span></div>
                <button className="add-dataset" onClick={() => inputRef.current?.click()}><span className="add-icon">+</span><span><strong>Add data</strong><small>Upload more CSV files</small></span><input ref={inputRef} type="file" accept=".csv,text/csv" multiple hidden onChange={(event) => void upload(event.target.files)} /></button>
              </section>
              {error && <div className="error-message" role="alert">{error}</div>}
              <section className="data-section" id="datasets"><div className="section-header"><div><span className="section-kicker">DATA INVENTORY</span><h2>Your data, mapped out</h2></div><span className="fresh-pill"><i /> PROFILED JUST NOW</span></div>
                <div className="data-layout"><div className="table-list"><div className="table-list-head">TABLES <span>{profiles.length}</span></div>{profiles.map((profile, index) => <button key={profile.file} onClick={() => setSelected(index)} className={`table-item ${selected === index ? "selected" : ""}`}><span className="table-glyph"><Icon name="database" /></span><span className="table-info"><strong>{profile.file.replace(/\.csv$/i, "")}</strong><small>{profile.rowCount.toLocaleString()} rows · {profile.columns.length} columns</small></span><span className="table-arrow">›</span></button>)}</div>
                  {activeProfile && <div className="profile-panel"><div className="profile-title"><div><span className="table-glyph large"><Icon name="database" /></span><div><h3>{activeProfile.file.replace(/\.csv$/i, "")}</h3><span>{activeProfile.rowCount.toLocaleString()} rows <b>·</b> {activeProfile.columns.length} columns</span></div></div><button className="subtle-button" onClick={() => inputRef.current?.click()}>＋ Add files</button></div>
                    <div className="profile-highlights"><div><span>LIKELY KEY</span><strong>{activeProfile.likelyPrimaryKeys[0] ?? "Not detected"}</strong></div><div><span>KEY CANDIDATES</span><strong>{activeProfile.likelyJoinKeys.length || "None"}</strong></div><div><span>NEEDS ATTENTION</span><strong>{activeProfile.columns.filter((column) => column.nullPercent > 0).length} columns</strong></div></div>
                    <div className="column-table-wrap"><table className="column-table"><thead><tr><th>Column</th><th>Type</th><th>Missing</th><th>Distinct ≈</th></tr></thead><tbody>{activeProfile.columns.map((column) => <tr key={column.name}><td><span className="column-name">{column.name}</span>{column.likelyPrimaryKey && <span className="key-tag">PK</span>}{column.sensitive && <span className="sensitive-tag">SENSITIVE</span>}</td><td><span className="type-pill">{column.inferredType}</span></td><td><span className={column.nullPercent > 0 ? "missing-value" : "ok-value"}>{column.nullPercent}%</span></td><td>{column.approximateDistinctCount.toLocaleString()}</td></tr>)}</tbody></table></div>
                    {activeProfile.sample.length > 0 && <details className="preview-details"><summary>Preview sample <span>Sensitive-looking fields are redacted</span></summary><div className="column-table-wrap"><table className="column-table preview-table"><thead><tr>{activeProfile.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead><tbody>{activeProfile.sample.map((row, index) => <tr key={index}>{activeProfile.columns.map((column) => <td key={column.name}>{row[column.name] || <span className="empty-cell">—</span>}</td>)}</tr>)}</tbody></table></div></details>}
                  </div>}
                </div>
              </section>
              <section className="next-step"><div className="next-icon"><Icon name="spark" /></div><div><span className="section-kicker">NEXT UP</span><h3>Ready to ask your data a question?</h3><p>Once the analysis engine is connected, you’ll be able to explore this dataset in plain language.</p></div><button className="coming-soon" disabled>Analyst chat <span>Coming next</span></button></section>
            </>
          )}
          <footer className="page-footer"><span>DATAPILOT <b>·</b> LOCAL-FIRST DATA ANALYSIS</span><span>Your data stays in this workspace</span></footer>
        </div>
      </main>
    </div>
  );
}
