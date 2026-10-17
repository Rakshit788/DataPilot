const dimension = 768;

export async function embedTexts(texts: string[], purpose: "document" | "query") {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  const input = texts.map((text) => (purpose === "document" ? "search_document: " : "search_query: ") + text);
  const response = await fetch(baseUrl + "/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS ?? 60_000)),
    body: JSON.stringify({ model, input }),
  });
  if (!response.ok) throw new Error("Ollama embedding endpoint returned HTTP " + response.status + ".");
  const payload = await response.json() as { embeddings?: number[][] };
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) throw new Error("Ollama returned an invalid embedding batch.");
  for (const embedding of payload.embeddings) {
    if (embedding.length !== dimension || embedding.some((value) => !Number.isFinite(value))) {
      throw new Error("Embedding model dimension does not match the configured pgvector schema (768).");
    }
  }
  return { model, embeddings: payload.embeddings };
}

export function vectorLiteral(embedding: number[]) {
  return "[" + embedding.join(",") + "]";
}

export const embeddingDimension = dimension;
