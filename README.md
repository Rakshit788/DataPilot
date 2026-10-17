# DataPilot

DataPilot is a local-first analytics workbench for exploring CSV datasets with database-backed, conversational analysis. The product scope and safety requirements are documented in [DATAPILOT_IMPLEMENTATION_GUIDE.md](DATAPILOT_IMPLEMENTATION_GUIDE.md).

## Current status

The repository foundation and a streaming CSV profiler are in place. The first implementation milestone is the data foundation: inspect and profile the Olist dataset, then expose reliable schema and relationship metadata before adding generated SQL.

## Local PostgreSQL

1. Copy `.env.example` to `.env` and change `POSTGRES_PASSWORD` in your local environment if you expose the database beyond your machine.
2. Start PostgreSQL with `docker compose up -d postgres`.
3. Check readiness with `docker compose ps`.

The database is available at `localhost:5432`, with database `datapilot` and local development role `datapilot_app`. The compose password is intended only for local development. Production and generated-query execution must use separate least-privilege roles, as described in the implementation guide.

## CSV profiling

Install the Node.js dependencies with `npm install`, then place Olist source CSV files under `data/raw/`. Run `npm run profile:csv` to print one JSON profile per CSV file, including row count, inferred column types, null percentages, approximate distinct counts, numeric/date ranges, likely key columns, sensitive-name flags, and up to five sample rows. To inspect another folder, pass its path: `npm run profile:csv -- ./path/to/csv-files`.

Profiles are generated on demand and are not saved to the database yet. Distinct counts are estimated with a fixed-size bitmap; key uniqueness checks are exact for columns whose names look like IDs. Sample values under sensitive-looking column names are redacted. Key and sensitivity labels are heuristic hints that need review; they are not confirmed relationships or a privacy classification.

## Planned build order

1. Inspect and profile Olist source CSVs.
2. Add repeatable migrations and a read-only analytics role.
3. Implement guarded SQL execution.
4. Connect Ollama with a bounded tool-call loop.
5. Build the analyst interface, follow-ups, charts and CSV export.

Do not put Olist source files, uploaded data, credentials, or generated results into Git.
