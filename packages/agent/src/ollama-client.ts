export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
};

export type OllamaTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type OllamaReply = { message: OllamaMessage; model?: string; prompt_eval_count?: number; eval_count?: number; total_duration?: number };

export async function ollamaChat(messages: OllamaMessage[], tools: OllamaTool[]) {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const model = process.env.OLLAMA_CHAT_MODEL ?? "qwen3:1.7b";
  const response = await fetch(baseUrl + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS ?? 60_000)),
    body: JSON.stringify({ model, messages, tools, stream: false }),
  });
  if (!response.ok) throw new Error("Ollama returned HTTP " + response.status + ". Check that the local model server is running.");
  const payload = await response.json() as OllamaReply;
  if (!payload.message || typeof payload.message.content !== "string") throw new Error("Ollama returned an invalid chat response.");
  return { ...payload, model: payload.model ?? model };
}
