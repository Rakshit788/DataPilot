import { Pool } from "pg";

let pool: Pool | undefined;
let readOnlyPool: Pool | undefined;
let migration: Promise<void> | undefined;

export function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  return pool;
}

export function getReadOnlyPool() {
  if (!process.env.DATABASE_READONLY_URL) throw new Error("DATABASE_READONLY_URL is not configured; generated SQL requires the dedicated read-only role.");
  readOnlyPool ??= new Pool({ connectionString: process.env.DATABASE_READONLY_URL, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  return readOnlyPool;
}

const migrationSql = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source text NOT NULL DEFAULT 'csv_upload',
  schema_name text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('importing', 'ready', 'failed')),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dataset_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  source_file text NOT NULL,
  row_count bigint NOT NULL DEFAULT 0,
  grain_description text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (dataset_id, table_name)
);
CREATE TABLE IF NOT EXISTS dataset_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES dataset_tables(id) ON DELETE CASCADE,
  column_name text NOT NULL,
  source_name text NOT NULL,
  inferred_type text NOT NULL,
  null_count bigint NOT NULL DEFAULT 0,
  null_percent numeric(7,4) NOT NULL DEFAULT 0,
  approximate_distinct_count bigint NOT NULL DEFAULT 0,
  likely_primary_key boolean NOT NULL DEFAULT false,
  likely_join_key boolean NOT NULL DEFAULT false,
  sensitive boolean NOT NULL DEFAULT false,
  sample_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (table_id, column_name)
);
CREATE TABLE IF NOT EXISTS dataset_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_table text NOT NULL,
  source_column text NOT NULL,
  target_table text NOT NULL,
  target_column text NOT NULL,
  cardinality text NOT NULL DEFAULT 'many_to_one',
  match_percent numeric(7,4) NOT NULL DEFAULT 0,
  confidence numeric(5,4) NOT NULL DEFAULT 0,
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, source_table, source_column, target_table, target_column)
);
ALTER TABLE dataset_columns ADD COLUMN IF NOT EXISTS source_name text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New analysis',
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  question text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'needs_clarification')),
  generated_sql text,
  result_id uuid,
  chart_spec jsonb,
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms integer,
  model_name text,
  prompt_tokens integer,
  response_tokens integer,
  fallback_source text,
  error_category text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS query_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  columns jsonb NOT NULL,
  rows jsonb NOT NULL,
  returned_rows integer NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  execution_ms integer NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS prompt_tokens integer;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS response_tokens integer;
ALTER TABLE analyses DROP CONSTRAINT IF EXISTS analyses_result_id_fkey;
ALTER TABLE analyses ADD CONSTRAINT analyses_result_id_fkey FOREIGN KEY (result_id) REFERENCES query_results(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS tool_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  step integer NOT NULL,
  tool_name text NOT NULL,
  arguments_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  duration_ms integer,
  error_category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, step)
);
ALTER TABLE tool_traces ADD COLUMN IF NOT EXISTS result_summary jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES query_results(id) ON DELETE CASCADE,
  assumptions jsonb NOT NULL,
  formula text NOT NULL,
  baseline numeric NOT NULL,
  projected numeric NOT NULL,
  avoided numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  total_cases integer NOT NULL DEFAULT 0,
  passed_cases integer NOT NULL DEFAULT 0,
  failed_cases integer NOT NULL DEFAULT 0,
  skipped_cases integer NOT NULL DEFAULT 0,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  case_key text NOT NULL,
  question text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  expected_rows jsonb,
  actual_rows jsonb,
  analysis_id uuid REFERENCES analyses(id) ON DELETE SET NULL,
  result_id uuid REFERENCES query_results(id) ON DELETE SET NULL,
  error text,
  duration_ms integer NOT NULL DEFAULT 0,
  UNIQUE (run_id, case_key)
);
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  payment_table text NOT NULL,
  invoice_table text NOT NULL,
  config jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  total_payments integer NOT NULL DEFAULT 0,
  stp_count integer NOT NULL DEFAULT 0,
  review_count integer NOT NULL DEFAULT 0,
  unmatched_count integer NOT NULL DEFAULT 0,
  manual_review_minutes numeric(7,2) NOT NULL DEFAULT 3,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS reconciliation_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  payment_source_id text NOT NULL,
  payment_amount numeric,
  matched_invoice_id text,
  invoice_amount numeric,
  confidence numeric(6,5) NOT NULL DEFAULT 0,
  exact_key_match boolean NOT NULL DEFAULT false,
  rationale text NOT NULL DEFAULT '',
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('auto_applied', 'needs_review', 'approved', 'overridden', 'unmatched')),
  straight_through boolean NOT NULL DEFAULT false,
  human_reviewed boolean NOT NULL DEFAULT false,
  human_invoice_id text,
  human_decision text,
  reviewed_at timestamptz,
  review_duration_seconds numeric(8,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, payment_source_id)
);
CREATE INDEX IF NOT EXISTS reconciliation_runs_dataset_created_idx ON reconciliation_runs(dataset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reconciliation_matches_run_status_idx ON reconciliation_matches(run_id, status, confidence DESC);
CREATE TABLE IF NOT EXISTS reconciliation_metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  labeled_auto_count integer NOT NULL DEFAULT 0,
  stp_rate numeric(7,6) NOT NULL DEFAULT 0,
  accuracy_rate numeric(7,6),
  estimated_hours_saved numeric(10,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_snapshots_run_created_idx ON reconciliation_metric_snapshots(run_id, created_at DESC);
CREATE TABLE IF NOT EXISTS document_indexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_table text NOT NULL,
  embedding_model text NOT NULL,
  status text NOT NULL CHECK (status IN ('indexing', 'ready', 'failed', 'replaced')),
  document_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  index_id uuid NOT NULL REFERENCES document_indexes(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_table text NOT NULL,
  source_id text NOT NULL,
  chunk_text text NOT NULL,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768) NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (index_id, source_id, chunk_text)
);
CREATE INDEX IF NOT EXISTS document_chunks_dataset_idx ON document_chunks(dataset_id);
CREATE INDEX IF NOT EXISTS conversations_dataset_updated_idx ON conversations(dataset_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS analyses_conversation_created_idx ON analyses(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS evaluation_runs_dataset_created_idx ON evaluation_runs(dataset_id, created_at DESC);
`;

export async function ensureMetadataSchema() {
  migration ??= (async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(742018635)");
      await client.query(migrationSql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })().catch((error) => {
    migration = undefined;
    throw error;
  });
  await migration;
}
