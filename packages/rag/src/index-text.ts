import { ensureMetadataSchema, getPool } from "../../db/src/pool.js";
import { quoteIdentifier } from "../../importer/src/identifiers.js";
import { embedTexts, vectorLiteral } from "./embeddings.js";

const maxDocuments = 20_000;
const maxChunkLength = 1_200;
const chunkOverlap = 160;

function splitText(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += maxChunkLength - chunkOverlap) {
    const chunk = clean.slice(start, start + maxChunkLength).trim();
    if (chunk) chunks.push(chunk);
    if (start + maxChunkLength >= clean.length) break;
  }
  return chunks;
}

export async function indexDatasetText(input: { datasetId: string; tableName: string; textColumns: string[]; sourceIdColumn: string }) {
  await ensureMetadataSchema();
  const pool = getPool();
  const dataset = await pool.query("SELECT schema_name, status FROM datasets WHERE id = $1", [input.datasetId]);
  if (!dataset.rowCount || dataset.rows[0].status !== "ready") throw new Error("Dataset not found or not ready.");
  const metadata = await pool.query(
    "SELECT c.column_name, c.inferred_type, c.sensitive, c.likely_primary_key FROM dataset_tables t JOIN dataset_columns c ON c.table_id = t.id WHERE t.dataset_id = $1 AND t.table_name = $2",
    [input.datasetId, input.tableName],
  );
  const columns = new Map(metadata.rows.map((row) => [row.column_name as string, row]));
  const idColumn = columns.get(input.sourceIdColumn);
  if (!idColumn || idColumn.sensitive) throw new Error("Choose a safe source ID column from this table.");
  if (!idColumn.likely_primary_key) throw new Error("The source ID column must be profiled as a likely unique key.");
  if (input.textColumns.some((name) => !columns.has(name) || columns.get(name)!.inferred_type !== "text" || columns.get(name)!.sensitive)) {
    throw new Error("Text search can only index non-sensitive text columns.");
  }
  const schemaName = dataset.rows[0].schema_name as string;
  const textExpression = input.textColumns.map((name) => "NULLIF(" + quoteIdentifier(name) + ", '')").join(", ");
  const query = "SELECT " + quoteIdentifier(input.sourceIdColumn) + "::text AS source_id, concat_ws(E'\n', " + textExpression + ") AS text " +
    "FROM " + quoteIdentifier(schemaName) + "." + quoteIdentifier(input.tableName) + " WHERE concat_ws(E'\n', " + textExpression + ") <> '' ORDER BY " + quoteIdentifier(input.sourceIdColumn) + " LIMIT " + maxDocuments;
  const sourceRows = await pool.query(query);
  const docs: Array<{ sourceId: string; text: string; chunk: string; part: number }> = [];
  for (const row of sourceRows.rows) {
    const parts = splitText(String(row.text ?? ""));
    parts.forEach((chunk, index) => docs.push({ sourceId: String(row.source_id), text: String(row.text), chunk, part: index + 1 }));
  }
  if (docs.length === 0) throw new Error("No non-empty text was found in the selected columns.");

  const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  const created = await pool.query(
    "INSERT INTO document_indexes (dataset_id, source_table, embedding_model, status, document_count, chunk_count) VALUES ($1,$2,$3,'indexing',$4,$5) RETURNING id",
    [input.datasetId, input.tableName, model, sourceRows.rowCount ?? sourceRows.rows.length, docs.length],
  );
  const indexId = created.rows[0].id as string;
  let savedChunks = 0;
  try {
    for (let offset = 0; offset < docs.length; offset += 16) {
      const batch = docs.slice(offset, offset + 16);
      const embedded = await embedTexts(batch.map((document) => document.chunk), "document");
      const values: unknown[] = [];
      const tuples = batch.map((document, batchIndex) => {
        const embedding = embedded.embeddings[batchIndex]!;
        const metadataValue = { part: document.part, columns: input.textColumns };
        const base = batchIndex * 8;
        values.push(indexId, input.datasetId, input.tableName, document.sourceId, document.chunk, JSON.stringify(metadataValue), vectorLiteral(embedding), embedded.model);
        return "($"+(base+1)+",$"+(base+2)+",$"+(base+3)+",$"+(base+4)+",$"+(base+5)+",$"+(base+6)+",$"+(base+7)+"::vector,$"+(base+8)+")";
      });
      await pool.query(
        "INSERT INTO document_chunks (index_id,dataset_id,source_table,source_id,chunk_text,source_metadata,embedding,embedding_model) VALUES " + tuples.join(", ") + " ON CONFLICT (index_id,source_id,chunk_text) DO NOTHING",
        values,
      );
      savedChunks += batch.length;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE document_indexes SET status = 'replaced' WHERE dataset_id = $1 AND source_table = $2 AND status = 'ready'", [input.datasetId, input.tableName]);
      await client.query("UPDATE document_indexes SET status = 'ready', completed_at = now() WHERE id = $1", [indexId]);
      await client.query("DELETE FROM document_indexes WHERE dataset_id = $1 AND source_table = $2 AND status = 'replaced'", [input.datasetId, input.tableName]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { indexId, sourceTable: input.tableName, documents: sourceRows.rowCount ?? sourceRows.rows.length, chunks: savedChunks, model: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text", truncated: (sourceRows.rowCount ?? sourceRows.rows.length) >= maxDocuments };
  } catch (error) {
    await pool.query("UPDATE document_indexes SET status = 'failed' WHERE id = $1", [indexId]);
    throw error;
  }
}

export async function searchDatasetText(datasetId: string, queryText: string, limit = 6) {
  await ensureMetadataSchema();
  const embedded = await embedTexts([queryText], "query");
  const vector = vectorLiteral(embedded.embeddings[0]!);
  const result = await getPool().query(
    'SELECT c.source_table AS "sourceTable", c.source_id AS "sourceId", c.chunk_text AS text, c.source_metadata AS metadata, 1 - (c.embedding <=> $2::vector) AS similarity ' +
    "FROM document_chunks c JOIN document_indexes i ON i.id = c.index_id " +
    "WHERE c.dataset_id = $1 AND i.status = 'ready' AND c.embedding_model = $3 " +
    "ORDER BY c.embedding <=> $2::vector LIMIT $4",
    [datasetId, vector, embedded.model, Math.max(1, Math.min(limit, 10))],
  );
  return { model: embedded.model, sources: result.rows };
}
