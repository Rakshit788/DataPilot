# DataPilot

DataPilot is a local-first analytics workbench for exploring CSV datasets with database-backed, conversational analysis. The product scope and safety requirements are documented in [DATAPILOT_IMPLEMENTATION_GUIDE.md](DATAPILOT_IMPLEMENTATION_GUIDE.md).

## Current status

DataPilot includes a local workspace, streaming CSV profiling, transactional PostgreSQL imports, a dataset-scoped read-only SQL boundary, Ollama tool orchestration, saved conversations/results/traces, charts, CSV export, deterministic what-if scenarios, pgvector-backed semantic search, a reference-query evaluation suite, and a human-reviewed payment reconciliation workflow.

## Local PostgreSQL

1. Copy the root `.env.example` to `.env` for Docker Compose. Copy `apps/web/.env.example` to `apps/web/.env.local` for Next.js. Keep the app database URLs aligned with the matching PostgreSQL passwords.
2. Start PostgreSQL with `docker compose up -d postgres`.
3. Check readiness with `docker compose ps`.

The database is available at `localhost:5432`, with application role `datapilot_app` and generated-query role `datapilot_reader`. The compose passwords are intended only for local development. PostgreSQL runs the read-only role initialization script when it creates a new data volume; if you already have an initialized volume, apply that role setup manually or reset the local volume before importing datasets.

## Import data

Install dependencies with `npm install`. Upload one or more CSV files from the workspace, or put the eight Olist source files in `data/raw/` and choose **Load Olist demo data**. The Olist loader imports orders, items, payments, reviews, customers, products, sellers, and category translations; geolocation is deferred. Imported datasets use a generated PostgreSQL schema and normalized, typed table/column names. Source files and imported rows are not committed to Git.

The profiler reports row counts, inferred types, null percentages, approximate distinct counts, numeric/date ranges, likely keys, and a safely sampled preview. Distinct counts are estimated with a fixed-size bitmap; key-candidate uniqueness checks are exact. Sensitive-looking fields are redacted in previews and excluded from model schema inspection.

## Web app

After PostgreSQL is ready, configure `OLLAMA_BASE_URL` and `OLLAMA_CHAT_MODEL` in `.env`, install/start Ollama, and pull the configured model. Run `npm run dev` and open the local URL printed by Next.js. CSV uploads are limited to 50 MB total and eight files. Imports run in a database transaction; invalid files roll back the dataset import.

The analyst page sends natural-language questions to Ollama. Tool calls are validated, SQL is parsed as one `SELECT`, constrained to the selected dataset schema and non-sensitive columns, run with the dedicated reader role, a statement timeout, and a result cap. Answers show the executed query, stored result rows, tool trace, optional chart, and CSV export. Follow-ups reuse the stored conversation. The what-if control applies a deterministic relative reduction to a single-row numeric result and labels the output as a projection.

To enable text search, configure `OLLAMA_EMBED_MODEL` (default `nomic-embed-text`), pull that model in Ollama, and use a PostgreSQL image with pgvector support. Select a table and choose **Index text for search**; DataPilot indexes only profiled non-sensitive text columns and requires a likely unique source key. The analyst can retrieve semantic evidence and returns source table/row citations. SQL remains the source for numeric analysis.

Choose **Run evaluation** to run the reference cases in `packages/evaluation/questions.json`. Cases unsupported by the current dataset schema are skipped. Supported cases execute an independent reference query and the analyst question, compare returned row values independent of row/column order, and persist timing, expected/actual rows, and run totals in PostgreSQL. The bundled suite targets Olist fields.

For invoice/payment CSV pairs, upload both files into the same dataset, then use **Match remittances to invoices**. Select non-sensitive unique row IDs, numeric amounts, an optional exact key (such as invoice or tax ID), and a payment note. Exact keys are checked first; only payments without an exact key candidate fall back to invoice-table semantic search. Index non-sensitive invoice description text before using that fallback. The reranker weighs note similarity and amount agreement. Its score is a deterministic heuristic, not a calibrated probability. Scores at 85% or higher are marked simulated straight-through; lower-scoring candidates appear in human review. Human decisions are stored as labels, and the panel reports STP rate, accuracy on human-labeled auto matches, and estimated hours saved from the configured manual-review baseline. Each reviewer action stores a metric snapshot to show how labeled accuracy changes over time. This workflow does not connect to or write to a general ledger.

The metadata schema is initialized on first API use. For a fresh Docker volume, the compose initialization script creates the `datapilot_reader` role. If you have an older initialized PostgreSQL volume, create the role from `packages/db/init/001-readonly-role.sql` and re-import datasets so that it receives schema/table grants.

## Limits and next layers

The app is currently a local single-workspace prototype with no user authentication or cross-user tenancy. Relationship suggestions require review, model-generated SQL can need a retry, and the model must be available locally. Dataset uploads store raw values in isolated schemas; sensitive-looking fields are hidden from generated-query tools and excluded from text indexing but remain available to the local database owner. Reconciliation supports up to 5,000 payments and 200,000 invoices per run; semantic candidate retrieval depends on the invoice text index, while exact keys are compared against the full invoice table. It is a local matching simulation with no ERP or ledger posting. The time-saved number is an estimate based on the manual review baseline, and accuracy is reported only for auto-matches with human-provided labels. Evaluation currently covers a small Olist-focused reference suite.

See [DATAPILOT_IMPLEMENTATION_GUIDE.md](DATAPILOT_IMPLEMENTATION_GUIDE.md) for product scope, metric grain rules, source attribution, and reliability requirements.

Do not put Olist source files, uploaded data, credentials, or generated results into Git.
