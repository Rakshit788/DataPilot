# DataPilot — Conversational AI Data Analyst

> **Purpose:** Build an interactive, local-first AI analytics workbench where a user uploads CSV data, asks business questions in natural language, lets an LLM generate and execute SQL through controlled tools, explores charts, asks follow-up questions, runs what-if scenarios, and exports results.
>
> **Primary demo dataset:** Olist Brazilian E-Commerce Public Dataset.  
> **Target demo:** A user asks an unprepared question, watches the agent inspect the schema and execute tools, sees a result computed from data, then asks a follow-up that changes the analysis.

---

## 1. Product goal

DataPilot should feel like an analyst who can investigate a dataset, not like a chatbot that simply writes paragraphs.

### Core user journey

1. Upload one or more CSV files, or load the predefined Olist dataset.
2. Preview the data and see a data-quality/profile report.
3. Ask a question such as: “Which product categories have the highest late-delivery rate?”
4. The agent inspects available tables and columns, generates SQL, and asks the backend to execute it.
5. The backend validates the query and executes it against a read-only database role.
6. The frontend displays the actual query, result table, chart, explanation, and execution trace.
7. The user asks a follow-up: “Now show only São Paulo, exclude canceled orders, and compare the top five categories.”
8. The agent uses conversation state to update the analysis and rerun the query.
9. The user runs a what-if scenario, saves the analysis, or exports the results.

### What makes this useful for an FDE interview

The project demonstrates the full pilot workflow:

- Onboard an unfamiliar dataset.
- Profile its quality and understand the schema.
- Translate a client's natural-language question into a data query.
- Execute analysis rather than merely produce a plausible answer.
- Explain results with traceable evidence.
- Handle follow-up requests and ambiguity.
- Quantify measurable outcomes while stating assumptions.

### Explicit non-goals for the first version

Do not start by building a complex multi-agent framework, a large vector database, or autonomous write access to production systems. The first milestone is a trustworthy text-to-SQL workflow. RAG, advanced scenario analysis, and generalized CSV support should be added after that vertical slice works.

---

## 2. Scope and milestones

### MVP (must work)

- Load the Olist dataset from CSV files.
- Show table names, row counts, columns, types, missing values, and likely join keys.
- Accept natural-language questions.
- Use Ollama to generate SQL using the provided schema and tool definitions.
- Execute only permitted read-only SQL.
- Show the exact SQL and actual result rows.
- Render a basic chart from returned data.
- Support conversational follow-ups by retaining dataset ID, prior question, query summary, and active filters.
- Export query results to CSV.
- Record tool calls, errors, latency, and model/fallback source.

### V1 (after MVP is stable)

- Arbitrary user CSV uploads.
- Schema and join suggestions with user confirmation.
- What-if calculator with explicit assumptions.
- RAG over review text and dataset documentation.
- Saved analyses and shareable pilot report.
- Evaluation dashboard comparing generated answers with known expected results.

### Stretch goals

- Multiple uploaded datasets per workspace.
- Natural-language generated data-quality checks.
- Chart recommendations and dashboard layouts.
- Background imports using Redis/BullMQ.
- Optional specialist agents, only when tests show they improve accuracy or latency.

---

## 3. Dataset and domain constraints

### Olist source

Download the Olist Brazilian E-Commerce Public Dataset from Kaggle:

- https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce

The dataset contains historical, anonymized e-commerce order records and related CSVs such as orders, order items, customers, payments, reviews, products, sellers, geolocation, and category-name translation. It is useful for operational analytics, delivery performance, payment patterns, reviews, and seller/category trends.

**Be precise about the domain:** Olist is historical e-commerce data, not a corporate ERP/AR ledger. Do not claim that this dataset validates cash-application accuracy or HighRadius-specific financial ROI. Use it to demonstrate the general client-pilot workflow: data onboarding, analytics, evidence, interaction, and ROI methodology.

### Important grain and join rules

Understand what one row represents before generating SQL:

- `orders`: generally one row per order.
- `order_items`: one row per item within an order; an order can have multiple items and sellers.
- `order_payments`: one row per payment installment/sequence; an order can have more than one payment row.
- `order_reviews`: review records; verify uniqueness and any repeated order/review relationships in the actual file.
- `customers`: includes an order-level `customer_id` and a `customer_unique_id` that can connect repeat purchases from the same underlying customer.
- `products`, `sellers`, and category translation provide lookup dimensions.

**Join fan-out warning:** Joining `order_items` and `order_payments` directly to `orders` and then summing both measures can multiply amounts when an order has multiple items and multiple payment rows. Aggregate each fact table to the intended grain first, then join the aggregates. If the grain or metric definition is ambiguous, the agent should ask or state the chosen definition.

### Demo questions to support

- Which product categories have the highest average freight cost?
- What is the delivery lateness rate by month?
- Which sellers have the highest late-delivery rate among sellers with at least 20 associated orders?
- How do review scores differ between on-time and late-delivered orders?
- Which states have the highest order volume and average order value?
- How do payment methods vary by order value?
- For orders with several items, which categories contribute the most to order value?
- Follow-up: “Now restrict this to São Paulo, exclude canceled orders, and show the top five.”
- What-if: “If late deliveries fell by 10% relative, how many fewer late orders would that represent in this filtered set?”

Keep test questions tied to columns actually present in the uploaded files. The app must not invent customer lifetime value, profit, SLA, or true margin if the dataset does not contain the inputs required to calculate them.

---

## 4. Recommended technology stack

### Main stack

- **Frontend:** Next.js App Router, React, TypeScript, Tailwind CSS.
- **Charts:** Recharts or another React chart library.
- **API:** Express + TypeScript. Using Next.js Route Handlers instead of Express is also viable, but choose one API boundary and keep it consistent.
- **Database:** PostgreSQL.
- **Database access:** `pg` or Prisma. If using Prisma, use parameterized query APIs and do not bypass the safety policy for model-generated SQL.
- **Local LLM:** Ollama with a small tool-capable model, initially `qwen3:1.7b` as a hardware-conscious starting point. Validate its tool-call reliability on your machine before building the full pipeline. If quality is insufficient and resources allow, test a larger tag.
- **Embeddings:** Ollama embedding model such as `nomic-embed-text` for the optional RAG phase.
- **Vector search:** PostgreSQL + `pgvector`, only when RAG is added.
- **CSV parsing:** a maintained CSV parser such as `csv-parse`.
- **Validation:** Zod for request payloads and structured outputs.
- **Optional jobs:** Redis + BullMQ for large imports and long-running jobs.

### Why keep SQL as the source of truth?

Structured numeric questions should be answered by executing SQL against the dataset. The LLM chooses and composes analysis; PostgreSQL calculates counts, sums, averages, joins, and rankings. RAG is for semantic evidence from text, such as review comments or documentation—not a replacement for SQL aggregations.

---

## 5. High-level architecture

```mermaid
flowchart TD
    U[User uploads CSVs or selects Olist] --> FE[Next.js UI]
    FE --> API[Express API]
    API --> ING[CSV parser and profiler]
    ING --> DB[(PostgreSQL dataset tables)]
    ING --> META[(Dataset and schema metadata)]
    FE -->|Natural-language question| API
    API --> ORCH[Agent orchestrator]
    ORCH --> OLLAMA[Ollama chat model]
    OLLAMA -->|Tool call: inspect schema / query data / search text| ORCH
    ORCH --> GUARD[Tool validation and SQL guard]
    GUARD --> DB
    DB --> ORCH
    ORCH --> OLLAMA
    ORCH --> RESULTS[Persist query, result metadata, trace]
    RESULTS --> FE
    FE --> CHART[Table and chart renderer]
    FE --> EXPORT[CSV report export]
```

### Main responsibilities

- **Frontend:** uploads data, displays profile results, sends user questions, renders charts/tables, shows trace and downloads reports.
- **API:** validates requests, handles upload, starts analysis, enforces user/dataset boundaries, returns results.
- **Importer:** parses CSV files, profiles columns, normalizes column names, loads rows and saves metadata.
- **Agent orchestrator:** sends relevant schema and tool definitions to Ollama, executes approved tool calls, appends tool results, and loops until final response or a limit is hit.
- **SQL guard:** rejects unsafe statements and enforces allowed schemas, read-only access, timeouts, and row limits.
- **PostgreSQL:** stores imported data, dataset metadata, conversations, queries, results, evaluations, and (later) embeddings.
- **Ollama:** runs the local model. It does not execute SQL itself; it requests the application’s SQL tool.

---

## 6. Suggested repository structure

```text
datapilot/
  apps/
    web/                       # Next.js UI
      app/
        page.tsx               # Landing / dataset selection
        datasets/[id]/page.tsx  # Dataset overview and profile
        analyst/[id]/page.tsx   # Chat + result table + chart
        api/                    # Only if choosing Next.js Route Handlers
      components/
        upload-dropzone.tsx
        dataset-profile.tsx
        analyst-chat.tsx
        execution-trace.tsx
        results-table.tsx
        results-chart.tsx
        export-button.tsx
    api/                       # Express API (if separate)
      src/
        routes/
        middleware/
        server.ts
  packages/
    db/
      migrations/
      src/
        pool.ts
        metadata-repository.ts
    importer/
      src/
        parse-csv.ts
        profile.ts
        normalize-columns.ts
        infer-types.ts
        load-dataset.ts
        olist-loader.ts
    agent/
      src/
        ollama-client.ts
        orchestrator.ts
        prompts.ts
        tools.ts
        conversation-context.ts
        sql-guard.ts
        result-summary.ts
    analytics/
      src/
        chart-spec.ts
        scenario-engine.ts
        metrics.ts
    rag/                       # V1, not MVP blocker
      src/
        chunk-documents.ts
        embed.ts
        search.ts
    evaluation/
      questions.json
      run-evaluation.ts
  docker-compose.yml
  .env.example
  README.md
```

If you already have a monorepo with a different layout, keep it. The separation of responsibilities matters more than exact folder names.

---

## 7. Phase 0 — Environment setup

### Install and verify Ollama

Install Ollama for your OS, then run:

```bash
ollama pull qwen3:1.7b
ollama pull nomic-embed-text
ollama list
```

The embedding model is needed only when implementing RAG; you can defer pulling it until that phase.

Smoke-test the chat model:

```bash
ollama run qwen3:1.7b "Reply with exactly: MODEL_OK"
```

Then test the API:

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "qwen3:1.7b",
  "messages": [{"role":"user","content":"Reply with exactly MODEL_OK"}],
  "stream": false
}'
```

If tool calls are unreliable with the selected model, test a different supported model tag before committing to the agent implementation. Do not assume that successful text generation proves tool calling works.

### Environment variables

Create `.env.example` (do not commit real credentials):

```dotenv
DATABASE_URL=postgresql://datapilot_app:change_me@localhost:5432/datapilot
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=qwen3:1.7b
OLLAMA_EMBED_MODEL=nomic-embed-text
UPLOAD_DIR=./data/uploads
MAX_UPLOAD_MB=50
MAX_QUERY_ROWS=500
QUERY_TIMEOUT_MS=10000
MAX_AGENT_TOOL_STEPS=6
```

Use environment variables on the server only. Never expose the database connection string or private server configuration to browser code.

### Database setup

- Start PostgreSQL locally or with Docker Compose.
- Create a dedicated application role for DataPilot.
- Create a separate read-only role for running generated analytical SQL.
- Do not use a PostgreSQL superuser as the application or generated-query role.
- Keep migrations under version control.

For the initial MVP, PostgreSQL alone is enough. Add `pgvector` only when you implement the RAG phase.

---

## 8. Phase 1 — Load the Olist dataset correctly

### Download and inspect

1. Download the Olist CSV archive from Kaggle.
2. Keep the original files unchanged under a local `data/raw/` folder (do not commit large data files to Git).
3. Write an import script that prints each file's header, row count, sample rows, null counts, and suspected key columns.
4. Record the dataset license and source link in the app's dataset metadata.
5. Import only the tables required for initial questions; geolocation can be large and may be deferred.

### Create a predefined Olist schema

Use stable table names such as:

- `olist_orders`
- `olist_order_items`
- `olist_order_payments`
- `olist_order_reviews`
- `olist_customers`
- `olist_products`
- `olist_sellers`
- `olist_category_translation`

Map source columns explicitly. Use proper timestamp, numeric, and integer types where validated. Preserve source IDs as text unless there is a strong reason to do otherwise.

### Build a dataset profile

For each table and column, record:

- row count;
- column name and data type;
- null percentage;
- approximate distinct count;
- min/max for numeric and date columns;
- likely primary key and foreign keys;
- whether the column may contain personal or sensitive data;
- a small, safely sampled preview.

Show the profile on the dataset page before the user chats with the analyst. An FDE needs to demonstrate that the input was understood, not simply uploaded.

### Verify relationships

Write automated checks for expected keys and row counts. For joins, test whether keys are unique before calling them one-to-one. Do not silently assume relationships from similar column names.

---

## 9. Phase 2 — Add general CSV upload

Start with CSVs and defer Excel/PDF uploads. Make onboarding reliable before supporting more formats.

### Upload process

1. Validate size and file type server-side.
2. Parse headers and sample rows using a CSV parser; handle quoted commas, escaped quotes, newlines, and UTF-8 correctly.
3. Normalize column names to safe identifiers, e.g. `Order Date` → `order_date`.
4. Detect types conservatively: integer, decimal, date/timestamp, boolean, or text.
5. Show a mapping screen allowing the user to correct types before import.
6. Generate table identifiers server-side, using a dataset-specific namespace/ID; never use a raw uploaded filename as a SQL identifier.
7. Load the data in a transaction or tracked import job, and store row-level import errors.
8. Run a post-import profile and show the user the counts of imported/rejected rows.

### Dynamic table safety

SQL parameters protect values, not SQL identifiers such as schema, table, or column names. Therefore:

- Generate identifiers yourself and validate them against a strict allowlist.
- Quote identifiers using a trusted database helper, never by concatenating unchecked input.
- Bind all literal values as parameters.
- Restrict each analysis to the selected dataset's allowlisted tables and columns.
- Do not let model-generated SQL refer to arbitrary system tables or other users' datasets.

### Handling multiple CSV files

For the MVP, let users upload one CSV or choose a preconfigured Olist bundle. Later, allow a group of files and suggest joins based on matching key values and names. Display join suggestions and ask the user to confirm ambiguous relationships before using them.

---

## 10. Phase 3 — Text-to-SQL agent

This is the core project milestone. Do not skip directly to RAG or multi-agent orchestration.

### The interaction contract

Input to the agent:

- dataset ID;
- user question;
- recent conversation messages;
- selected dataset schema;
- documented metric definitions;
- available tool definitions;
- allowed tables and columns.

Output from the agent should be structured and should distinguish:

- final answer;
- SQL query actually executed (if any);
- query result reference;
- chart recommendation;
- assumptions and clarifying questions;
- execution trace and error status.

Do not allow the model to invent rows or metrics. Explanations should refer to the execution result ID and its returned rows.

### Initial tools

Implement these tools as server-side functions:

1. `inspect_dataset(dataset_id)` — return allowed table/column metadata, types, row counts, keys and relationships.
2. `run_analytics_query(dataset_id, sql, explanation)` — validate and run one read-only query; return columns, limited rows, row count and execution time.
3. `get_query_result(result_id)` — retrieve a previously executed result for a follow-up or export.
4. `export_query_result(result_id, format)` — create a CSV export from a stored, validated result.

Add RAG and scenario tools later. The model requests tools; the application executes them. The model itself does not connect directly to PostgreSQL.

### Agent loop

Implement the following bounded loop:

1. Call Ollama `/api/chat` with system instructions, conversation history, schema context, and tool definitions.
2. If the response contains a tool call, validate tool name and arguments against Zod schemas.
3. Execute only registered tools; reject unknown tools and invalid arguments.
4. Append the assistant tool-call message and the tool result in the message format expected by Ollama.
5. Call the model again so it can interpret the tool result or request another tool.
6. Stop on a final answer, error, timeout, or `MAX_AGENT_TOOL_STEPS`.
7. Persist the final answer, tool trace, SQL, results, timing, model name and whether any fallback was used.

Avoid a loop that calls the model repeatedly without a maximum number of tool steps. Record each model and tool error in a trace that the UI can display.

### System prompt outline

Use a strict system prompt along these lines (refine it using your evaluation set):

```text
You are DataPilot, an analytics assistant for the currently selected dataset.
Use tools to inspect schema and calculate all numeric answers.
Never invent counts, percentages, sums, or data values.
Only use the allowed tables and columns provided by the application.
Use one read-only SQL query at a time through run_analytics_query.
Prefer explicit column names and clear CTEs. Avoid SELECT *.
Respect table grain, join cardinality, nulls, and the documented definition of each metric.
If the schema cannot answer a question, say what data is missing.
If a metric is ambiguous, ask a concise clarification or state a reasonable assumption.
When a query fails, inspect the error and retry at most the configured number of times.
Cite result IDs, data columns, and retrieved source IDs for material claims.
Do not claim a query or action succeeded unless the tool returned success.
```

### SQL generation strategy

For every question, have the model first inspect relevant schema information (or use cached schema metadata), then draft a query. For a follow-up, pass a compact summary of the previous analysis, metric definitions, active filters, and result ID rather than blindly attaching the entire result table to every prompt.

Do not simply regex-remove suspicious SQL and execute the remaining text. Use defense in depth:

- Require a single `SELECT` or read-only `WITH ... SELECT` statement.
- Reject multiple statements and all data-changing/DDL/administrative commands (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `COPY`, `GRANT`, etc.).
- Prefer a PostgreSQL parser or a constrained query builder over fragile regex-only validation.
- Verify every referenced schema/table/column against the selected dataset's allowlist.
- Run using a read-only database role and a read-only transaction.
- Apply statement timeout and maximum returned row count.
- Avoid exposing sensitive columns unless the user has permission.
- Log SQL and execution outcome; do not log secrets.

Read-only SQL can still be expensive. Put timeouts, row limits, and dataset authorization in place from the start.

### Error correction

When SQL fails, return a sanitized database error to the model, preserving enough detail to fix the query but not disclosing credentials or internal infrastructure. Permit at most one or two correction attempts. If it still fails, show the query, error category, and a request to refine the question rather than pretending it succeeded.

---

## 11. Phase 4 — API routes and payloads

A small API surface is enough for the MVP. Example routes (adapt to your chosen Express/Next API boundary):

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/datasets/upload` | Upload one/more allowed CSV files |
| `POST` | `/api/datasets/olist/import` | Start/import the Olist demo data |
| `GET` | `/api/datasets/:datasetId` | Dataset metadata and import status |
| `GET` | `/api/datasets/:datasetId/profile` | Table and column profile |
| `GET` | `/api/datasets/:datasetId/schema` | Allowed SQL schema metadata |
| `POST` | `/api/chat` | Start an analysis turn and agent loop |
| `GET` | `/api/analysis/:analysisId` | Fetch query, status, results, and chart spec |
| `GET` | `/api/results/:resultId/export.csv` | Download query result as CSV |
| `POST` | `/api/scenarios` | Run a saved what-if calculation (V1) |

Suggested chat request:

```json
{
  "datasetId": "dataset_123",
  "conversationId": "conversation_456",
  "message": "Which sellers have the highest late-delivery rate?",
  "priorAnalysisId": null
}
```

Suggested response (shape only):

```json
{
  "analysisId": "analysis_789",
  "status": "completed",
  "answer": "The query found the highest late-delivery rates among sellers meeting the order threshold.",
  "resultId": "result_321",
  "chart": {
    "type": "bar",
    "xKey": "seller_id",
    "yKey": "late_rate_pct",
    "title": "Late-delivery rate by seller"
  },
  "traceId": "trace_654"
}
```

This is illustrative output; the real answer and numbers must come from the database result. Validate all request/response objects with Zod or another runtime schema validator.

---

## 12. Phase 5 — Results UI and chart rendering

Build the analyst page with four major areas:

1. **Chat thread:** user questions, clarifications, answers, follow-up actions.
2. **Execution trace:** schema inspected, SQL generated, validation outcome, SQL execution time, number of rows, tool errors/retries.
3. **Results:** actual query, table, row count, and download control.
4. **Visualization:** chart built from returned columns and rows.

### Chart specification

The LLM may propose a chart specification, but validate it on the server/client before rendering:

- `type`: allow only `bar`, `line`, `pie`, `scatter`, or `table` initially.
- `xKey`, `yKey`, optional series keys: each must exist in result columns.
- Never execute code or render arbitrary HTML generated by the model.
- If returned rows are unsuitable for the chosen chart, display a table or ask the model for another chart spec.

For reliability, chart configs should reference result column names rather than embedding generated arrays separately. The frontend then renders the actual result rows.

---

## 13. Phase 6 — Follow-up questions and conversation state

A useful analyst must understand follow-ups such as:

- “Only include São Paulo.”
- “Now use revenue instead of order count.”
- “Compare these figures with the previous month.”
- “Keep the same filters but show the bottom 10.”

Persist conversation state rather than relying only on a long raw chat transcript.

Suggested analysis context:

```json
{
  "datasetId": "dataset_123",
  "previousAnalysisId": "analysis_789",
  "metric": "late_delivery_rate",
  "groupBy": ["seller_id"],
  "filters": [{"column":"customer_state","operator":"=","value":"SP"}],
  "timeRange": null,
  "sort": {"column":"late_rate_pct","direction":"desc"},
  "limit": 10
}
```

The context is an application-maintained summary, not permission to reuse stale results. When the question changes a filter or metric, generate and execute a new query and create a new analysis record.

If the follow-up is ambiguous—e.g. “show the best ones”—ask whether “best” means lowest delay, highest sales, highest review score, or another metric, unless the previous context makes it unambiguous.

---

## 14. Phase 7 — What-if scenario engine

What-if analysis must calculate outputs deterministically. The model can translate natural language to explicit scenario parameters, but the scenario engine performs the arithmetic.

Example request:

> “What if we reduced late deliveries by 10% among the current filtered orders?”

Clarify that a 10% reduction is relative, unless the user specifies 10 percentage points.

For a relative reduction:

- `baseline_late_orders` = query result for current filters.
- `target_reduction_rate` = `0.10`.
- `projected_late_orders` = `baseline_late_orders * (1 - target_reduction_rate)`.
- `projected_orders_avoiding_late_delivery` = `baseline_late_orders - projected_late_orders`.

Round only for display; retain the underlying precision. Mark projected metrics as scenarios, not observed facts. If user asks for financial savings but the dataset lacks cost-per-late-delivery or penalty data, ask for the assumption or show a range using an editable assumption instead of inventing a dollar amount.

Store each scenario with:

- input query/result ID;
- assumptions and units;
- formula/version;
- baseline result;
- projected result;
- timestamp and creator.

---

## 15. Phase 8 — Add RAG where it is genuinely useful

Do not use vector search to calculate sums or percentages. Use SQL for structured numeric analysis and RAG for semantically searching text, such as customer reviews and data dictionary documentation.

### Initial RAG corpus

- Olist review title and review text.
- Data dictionary and column definitions.
- Optional policy/metric notes written for the demo.

### RAG pipeline

1. Clean text while preserving source identifiers.
2. Split large text into bounded chunks (reviews may be short and need little or no chunking).
3. Generate embeddings using the Ollama embedding endpoint and a consistent embedding model.
4. Store chunk text, source ID, table/row metadata and embedding in PostgreSQL with `pgvector`.
5. Embed the user's semantic query.
6. Retrieve nearest chunks, and apply metadata filters where appropriate.
7. Return the source text and original review IDs to the agent.
8. Ask the model to distinguish source-backed observations from speculation.

Use the same embedding model for indexing and querying; if it changes, re-embed the corpus or version the embeddings. Verify the model's vector dimension before defining the pgvector column. Start with exact vector search; only introduce ANN indexes when measured scale justifies it.

### Example question that benefits from SQL + RAG

“Which categories have the highest late-delivery rate, and what complaints do customers mention in those categories?”

- SQL computes the late-delivery rate by category.
- RAG retrieves relevant review texts.
- The application joins qualitative evidence to the category IDs when the source mapping supports it.
- The LLM summarizes patterns and cites review IDs.

Avoid claiming that review text proves the cause of delays. A complaint may be correlated with late delivery without being its cause.

---

## 16. Phase 9 — CSV export and pilot report

Allow the user to export:

- current query results as CSV;
- a summary report containing question, metric definitions, filters, execution time, findings, caveats, and source references;
- optionally, chart images or a PDF in a later version.

Export from stored result data or rerun a validated query—not from LLM-generated prose. Use server-side authorization, safe filenames, and correct CSV escaping. If output could be opened in spreadsheet software, protect against CSV formula injection by escaping cells beginning with characters such as `=`, `+`, `-`, or `@` when appropriate.

### Pilot metrics to report

- import success rate and rejected rows;
- query execution success rate;
- numerical correctness on a test set;
- SQL correction/retry rate;
- average and p95 latency;
- number of tool calls per question;
- follow-up consistency;
- RAG retrieval relevance (once enabled);
- time needed for a user to obtain an answer versus the defined manual baseline.

Do not claim “hours saved” based on intuition. Time a small set of equivalent analyst tasks or clearly label the result as an assumption-based estimate.

---

## 17. Database design for application metadata

Imported dataset tables are separate from DataPilot's own metadata tables.

Suggested application tables:

- `datasets`: ID, name, source, owner/workspace ID, import status, created time, license/source metadata.
- `dataset_tables`: dataset ID, physical schema/table names, row count, grain description.
- `dataset_columns`: table ID, column name, inferred/confirmed type, null percentage, sensitivity flag, sample summary.
- `dataset_relationships`: source table/column, target table/column, cardinality, confidence, confirmation status.
- `conversations`: ID, dataset ID, owner, created time.
- `messages`: conversation ID, role, content, structured metadata.
- `analyses`: ID, conversation ID, question, generated SQL, result ID, status, duration, model name, assumptions.
- `query_results`: result ID, dataset ID, column metadata, row data or an export artifact pointer, expiry time.
- `tool_traces`: analysis ID, step, tool name, arguments summary, status, duration, error category.
- `scenarios`: input result ID, assumptions, formula, baseline and projected metrics.
- `document_chunks`: source ID, dataset ID, text, metadata and embedding (V1 RAG).

For large result sets, do not store an unlimited amount of JSON in the main row. Store bounded previews plus an export artifact or a reproducible query reference where appropriate. Apply per-dataset access checks on every API route.

---

## 18. Evaluation strategy — prove the agent actually works

Create a fixed evaluation file with roughly 20–30 questions and expected answers/queries. Include:

- simple counts and totals;
- `GROUP BY` and sorting;
- joins across two and three tables;
- null and date handling;
- canceled/undelivered orders;
- repeated payments and multiple order items;
- ambiguous metric wording;
- follow-up filters;
- invalid questions for which data is missing;
- attempted requests for unauthorized columns/tables;
- SQL errors and timeout behaviour;
- qualitative questions that require RAG after V1.

For deterministic questions, compare numeric outputs to known reference SQL results, allowing small numeric tolerance where appropriate. Do not judge only by how fluent the final response sounds.

### Minimum pass criteria for the demo

- The query result matches the independently verified expected result for every core test.
- The displayed chart uses the exact result rows returned by SQL.
- A follow-up filter changes the executed query and resulting data.
- A failed query never appears as a successful result.
- Generated SQL cannot modify data or access another dataset.
- Every displayed numerical claim maps to a query result.
- Fallback output is labelled and not misrepresented as model-generated.
- RAG statements include source references, and the application handles “no relevant evidence found.”

Log model name, latency, prompt/response token counts if available, tool calls, SQL outcome, and errors. This makes failure analysis and tuning concrete.

---

## 19. Security and reliability checklist

Before showing the project to an interviewer, verify all of these:

- [ ] Database credentials are never sent to the browser.
- [ ] Generated SQL executes under a read-only role.
- [ ] SQL is parsed/validated and limited to the selected dataset's allowlist.
- [ ] One statement only; DDL, writes and administrative commands are rejected.
- [ ] Query timeout and maximum result rows are enforced.
- [ ] Dynamic schema/table/column identifiers come from validated server metadata.
- [ ] Upload size, file type, row count, and parse errors are limited and reported.
- [ ] Dataset authorization is checked on all reads, queries, exports, and traces.
- [ ] Tool names and parameters are validated; unknown tool requests are rejected.
- [ ] Agent loop has a maximum step count and timeouts.
- [ ] Model failures are surfaced; fallback use is recorded.
- [ ] User-provided CSV cells and retrieved documents are treated as untrusted data, never as system instructions.
- [ ] CSV export escapes values and is protected against formula injection.
- [ ] Sensitive columns are masked/excluded where needed.
- [ ] No real client data is uploaded to a public model API; this project is configured for local Ollama.
- [ ] License and dataset source are shown in the dataset metadata.

---

## 20. Day-by-day build plan

### Day 1 — Data foundation

- Create the repo and local PostgreSQL environment.
- Download Olist and inspect the CSVs.
- Write an import script for orders, items, payments, customers, products, sellers, and reviews.
- Verify row counts, data types, keys and relationships.
- Create the dataset profile page.

**Exit test:** The app imports the dataset and displays correct table/column summaries.

### Day 2 — SQL execution layer

- Add dataset schema metadata and an `inspect_dataset` tool.
- Create the read-only database role.
- Implement SQL validation, allowed schema/table checks, statement timeout and result limits.
- Test with handwritten SQL before involving the model.

**Exit test:** A valid `SELECT` works; an `UPDATE`, `DROP`, multi-statement query, unknown table, and slow query are rejected/terminated.

### Day 3 — Ollama text-to-SQL

- Implement the Ollama chat client.
- Send schema metadata, documented metrics, and the `run_analytics_query` tool definition.
- Implement the bounded tool-call loop.
- Save generated SQL, result references, and step-level trace.
- Test about 10 questions with known outputs.

**Exit test:** Model-generated queries produce database-backed answers, and failures are visible.

### Day 4 — Analyst UX and follow-ups

- Build chat interface, SQL disclosure, result table and chart renderer.
- Store conversation and analysis context.
- Implement follow-up filters and metric changes.
- Add clarification handling for ambiguous requests.

**Exit test:** Ask a question, add a filter, change a metric, and verify that each follow-up produces a new correct query.

### Day 5 — Uploads and exports

- Add CSV upload, schema inference, preview, type corrections and import error report.
- Add data namespace/allowlist per dataset.
- Add CSV export from actual query results.

**Exit test:** A second unrelated CSV can be uploaded and queried without access to the Olist dataset or another workspace.

### Day 6 — What-if + RAG

- Add explicit, deterministic scenario calculations.
- Ingest review text and dataset documentation.
- Enable pgvector, embed documents and implement `search_reviews`.
- Combine SQL metrics and relevant review evidence in one answer.

**Exit test:** Numeric metrics come from SQL, qualitative summaries cite retrieved reviews, and unsupported explanations are labelled uncertain.

### Day 7 — Evaluation and interview demo

- Run the complete evaluation set.
- Fix the highest-impact failures.
- Show trace viewer and error states.
- Prepare 3–4 live demo prompts, including a follow-up and what-if request.
- Produce a concise pilot report with measured results, limitations, and possible next steps.

**Exit test:** You can explain every number shown in the UI, show how it was calculated, and point to the tool trace behind it.

---

## 21. Suggested live demo script

Use this as a rehearsal script, not as hardcoded outputs. Actual values must be computed at runtime.

1. **Upload:** Load the Olist dataset. Show table counts and data-quality profile.
2. **Analysis:** Ask, “What is the monthly late-delivery rate for delivered orders?”
3. **Inspect:** Expand the trace to show schema inspected, SQL generated, SQL validation, execution time, and result rows.
4. **Follow-up:** Ask, “Now compare the rate by customer state and show the five highest states with at least 100 delivered orders.”
5. **Qualitative retrieval:** Ask, “For the most delayed categories, what do relevant customer reviews say?” Show review IDs and explain that reviews suggest themes but don't prove causes.
6. **What-if:** Ask, “What if late deliveries reduced by 10% relative in this filtered dataset?” Display baseline, formula and projected count.
7. **Export:** Download the actual query results as CSV.
8. **Failure case:** Ask for a metric the dataset cannot support, or deliberately trigger an invalid query in a test environment. Show the system saying it lacks the required fields or safely rejecting the query.

The strongest interview demo includes one success case, one contextual follow-up, one what-if calculation, and one honest failure case.

---

## 22. Definition of done

Call DataPilot MVP complete only when:

- [ ] Olist dataset can be imported reproducibly.
- [ ] Users can inspect data before asking questions.
- [ ] Ollama actually generates SQL tool calls (not a mocked SQL string).
- [ ] The backend validates and executes the query against PostgreSQL.
- [ ] The UI shows the exact executed SQL and its real results.
- [ ] Charts are based on returned result rows.
- [ ] Follow-up questions preserve the intended context and rerun queries.
- [ ] Exports contain actual query output.
- [ ] What-if outputs are deterministic and labelled as scenarios.
- [ ] Every evaluation question has a recorded pass/fail outcome.
- [ ] RAG, if enabled, shows source references and handles no-evidence cases.
- [ ] Security limits and failure reporting are tested.
- [ ] The README documents setup, data source, architecture, limitations, and demo prompts.

---

## 23. Official/reference links

- Olist public dataset: https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce
- Ollama API overview: https://docs.ollama.com/api
- Ollama tool calling: https://docs.ollama.com/capabilities/tool-calling
- Ollama embeddings API: https://docs.ollama.com/api/embed
- Next.js App Router: https://nextjs.org/docs/app
- PostgreSQL `COPY`: https://www.postgresql.org/docs/current/sql-copy.html
- pgvector repository and documentation: https://github.com/pgvector/pgvector

---

## Final build principle

**Build in this order: correct data import → safe SQL execution → real Ollama tool calling → correct results → follow-up context → charts/exports → deterministic what-if → RAG → evaluation.**

A smaller end-to-end flow with correct numbers, visible evidence, and tested safety boundaries is more compelling than a large architecture where the AI tools are present but don't actually work.
