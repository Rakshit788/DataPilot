# DataPilot

DataPilot is a local-first analytics workbench for exploring CSV datasets with database-backed, conversational analysis. The product scope and safety requirements are documented in [DATAPILOT_IMPLEMENTATION_GUIDE.md](DATAPILOT_IMPLEMENTATION_GUIDE.md).

## Current status

The initial workspace dashboard and CSV profiling flow are implemented. The next milestone is persisting profiled datasets in PostgreSQL, then adding safe analytical queries and conversational follow-ups.

## Local PostgreSQL

1. Copy `.env.example` to `.env`. The example password is for local development; replace it in both `POSTGRES_PASSWORD` and `DATABASE_URL` before using a non-local database.
2. Start PostgreSQL with `docker compose up -d postgres`.
3. Check readiness with `docker compose ps`.

The database is available at `localhost:5432`, with database `datapilot` and local development role `datapilot_app`. The compose password is intended only for local development. Production and generated-query execution must use separate least-privilege roles, as described in the implementation guide.

## CSV profiling

Install the Node.js dependencies with `npm install`, then place Olist source CSV files under `data/raw/`. Run `npm run profile:csv` to print one JSON profile per CSV file, including row count, inferred column types, null percentages, approximate distinct counts, numeric/date ranges, likely key columns, sensitive-name flags, and up to five sample rows. To inspect another folder, pass its path: `npm run profile:csv -- ./path/to/csv-files`.

Profiles are generated on demand and are not saved to the database yet. Distinct counts are estimated with a fixed-size bitmap; key uniqueness checks are exact for columns whose names look like IDs. Sample values under sensitive-looking column names are redacted. Key and sensitivity labels are heuristic hints that need review; they are not confirmed relationships or a privacy classification.

## Web app

Install dependencies with `npm install`, then run `npm run dev` and open the local URL printed by Next.js. The first screen lets you upload up to eight CSV files (50 MB each), profiles them on the server, and shows column types, missingness, likely keys, and a small redacted sample. Uploads are analyzed in memory and are not persisted yet.

## Planned build order

1. Inspect and profile Olist source CSVs.
2. Add repeatable migrations and a read-only analytics role.
3. Implement guarded SQL execution.
4. Connect Ollama with a bounded tool-call loop.
5. Build the analyst interface, follow-ups, charts and CSV export.

Do not put Olist source files, uploaded data, credentials, or generated results into Git.
