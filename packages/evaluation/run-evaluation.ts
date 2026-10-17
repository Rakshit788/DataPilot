import { z } from "zod";
import { ensureMetadataSchema, getPool } from "../db/src/pool.js";
import { analyzeQuestion } from "../agent/src/analysis-agent.js";
import { runAnalyticsQuery } from "../agent/src/sql-guard.js";
import cases from "./questions.json";

const caseSchema = z.object({ id: z.string(), question: z.string(), table: z.string(), columns: z.array(z.string()), sql: z.string() });
const suite = z.array(caseSchema).parse(cases);

function canonicalValue(value: unknown) {
  if (value === null || value === undefined) return "null";
  const numeric = Number(value);
  if (typeof value !== "boolean" && String(value).trim() !== "" && Number.isFinite(numeric)) return "n:" + numeric.toPrecision(12);
  return "s:" + String(value).trim().toLowerCase();
}

function canonicalRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => Object.values(row).map(canonicalValue).sort().join("|")).sort();
}

function rowsMatch(expected: Array<Record<string, unknown>>, actual: Array<Record<string, unknown>>) {
  const left = canonicalRows(expected);
  const right = canonicalRows(actual);
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

export async function runEvaluation(datasetId: string) {
  await ensureMetadataSchema();
  const pool = getPool();
  const available = await pool.query(
    "SELECT t.table_name, array_agg(c.column_name) AS columns FROM dataset_tables t JOIN dataset_columns c ON c.table_id = t.id WHERE t.dataset_id = $1 GROUP BY t.table_name",
    [datasetId],
  );
  if (!available.rowCount) throw new Error("Dataset not found or has no tables.");
  const schema = new Map(available.rows.map((row) => [row.table_name as string, new Set(row.columns as string[])]));
  const run = await pool.query("INSERT INTO evaluation_runs (dataset_id,status,total_cases) VALUES ($1,'running',$2) RETURNING id", [datasetId, suite.length]);
  const runId = run.rows[0].id as string;
  const started = performance.now();
  const report: Array<Record<string, unknown>> = [];
  let passed = 0, failed = 0, skipped = 0;

  for (const testCase of suite) {
    const missing = !schema.has(testCase.table) ? [testCase.table] : testCase.columns.filter((column) => !schema.get(testCase.table)!.has(column));
    if (missing.length) {
      skipped++;
      const result = { id: testCase.id, question: testCase.question, status: "skipped", reason: "Missing table or columns: " + missing.join(", ") };
      await pool.query("INSERT INTO evaluation_cases (run_id,case_key,question,status,error) VALUES ($1,$2,$3,'skipped',$4)", [runId, testCase.id, testCase.question, result.reason]);
      report.push(result);
      continue;
    }
    const caseStarted = performance.now();
    let analysisId: string | null = null;
    let resultId: string | null = null;
    try {
      const reference = await runAnalyticsQuery({ datasetId, sql: testCase.sql, explanation: "Independent evaluation reference query" });
      const analysis = await analyzeQuestion({ datasetId, message: testCase.question });
      analysisId = analysis.analysisId;
      resultId = analysis.resultId;
      const actual = resultId ? await pool.query("SELECT rows FROM query_results WHERE id = $1 AND dataset_id = $2", [resultId, datasetId]) : null;
      const actualRows = (actual?.rows[0]?.rows ?? []) as Array<Record<string, unknown>>;
      const matched = !!resultId && rowsMatch(reference.rows, actualRows);
      const duration = Math.round(performance.now() - caseStarted);
      const status = matched ? "passed" : "failed";
      if (matched) passed++; else failed++;
      const result = { id: testCase.id, question: testCase.question, status, durationMs: duration, expectedRows: reference.rows, actualRows, analysisId, resultId };
      await pool.query("INSERT INTO evaluation_cases (run_id,case_key,question,status,expected_rows,actual_rows,analysis_id,result_id,error,duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [runId, testCase.id, testCase.question, status, JSON.stringify(reference.rows), JSON.stringify(actualRows), analysisId, resultId, matched ? null : resultId ? "Generated result did not match the independent reference result." : "The assistant returned no query result.", duration]);
      report.push(result);
    } catch (error) {
      failed++;
      const duration = Math.round(performance.now() - caseStarted);
      const message = error instanceof Error ? error.message.slice(0, 500) : "Evaluation case failed.";
      const result = { id: testCase.id, question: testCase.question, status: "failed", durationMs: duration, error: message, analysisId, resultId };
      await pool.query("INSERT INTO evaluation_cases (run_id,case_key,question,status,analysis_id,result_id,error,duration_ms) VALUES ($1,$2,$3,'failed',$4,$5,$6,$7)", [runId, testCase.id, testCase.question, analysisId, resultId, message, duration]);
      report.push(result);
    }
  }
  const durationMs = Math.round(performance.now() - started);
  await pool.query("UPDATE evaluation_runs SET status = 'completed', passed_cases = $2, failed_cases = $3, skipped_cases = $4, duration_ms = $5, completed_at = now() WHERE id = $1", [runId, passed, failed, skipped, durationMs]);
  return { runId, datasetId, total: suite.length, passed, failed, skipped, durationMs, cases: report };
}

export async function getLatestEvaluation(datasetId: string) {
  await ensureMetadataSchema();
  const found = await getPool().query("SELECT * FROM evaluation_runs WHERE dataset_id = $1 ORDER BY created_at DESC LIMIT 1", [datasetId]);
  if (!found.rowCount) return null;
  const run = found.rows[0];
  const details = await getPool().query("SELECT case_key AS id, question, status, expected_rows AS \"expectedRows\", actual_rows AS \"actualRows\", error, duration_ms AS \"durationMs\" FROM evaluation_cases WHERE run_id = $1 ORDER BY case_key", [run.id]);
  return { ...run, cases: details.rows };
}
