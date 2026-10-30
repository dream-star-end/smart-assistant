/**
 * Master → agent-sandbox env for local semantic core-memory recall.
 *
 * Missing keys are skipped so we never inject KEY=undefined. With no OpenAI
 * key the container env stays on the historical DashScope pin
 * (EMBEDDING_BATCH_SIZE=10). When an OpenAI key is configured, embeddings
 * switch to text-embedding-3-large at 1024 dimensions and the batch size
 * follows the OpenAI default instead of the DashScope cap.
 *
 * When `opts` includes `openAiApiKey`, that value is the only authority.
 * Explicit null or blank means the service pool has no usable key and must
 * not be revived from OPENAI_API_KEY. The env key is read only when the
 * override is omitted. Persistent archival/session vectors are rebuilt on
 * model change inside the vector store; this env still names the model the
 * new process will embed with.
 */

import {
  OPENAI_EMBEDDING_BASE_URL,
  OPENAI_LARGE_EMBEDDING_DIMENSIONS,
  OPENAI_LARGE_EMBEDDING_MODEL,
  defaultEmbeddingBatchSize,
} from "@openclaude/storage";

export const CORE_MEMORY_EMBEDDING_FORWARD_KEYS = [
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_API_KEY",
  "EMBEDDING_BASE_URL",
] as const;

function cleanOpenAiKey(value: string | null | undefined): string {
  const key = (value ?? "").trim();
  if (!key || /[\r\n\0]/.test(key)) return "";
  return key;
}

export function buildCoreMemoryEmbeddingContainerEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  opts: { openAiApiKey?: string | null } = {},
): string[] {
  const openAiKey = Object.prototype.hasOwnProperty.call(opts, "openAiApiKey")
    ? cleanOpenAiKey(opts.openAiApiKey)
    : cleanOpenAiKey(sourceEnv.OPENAI_API_KEY);
  if (openAiKey) {
    const explicitBatch = sourceEnv.EMBEDDING_BATCH_SIZE?.trim();
    const batch =
      explicitBatch && /^\d+$/.test(explicitBatch) && Number(explicitBatch) > 0
        ? explicitBatch
        : String(defaultEmbeddingBatchSize(OPENAI_EMBEDDING_BASE_URL));
    return [
      "EMBEDDING_PROVIDER=openai",
      `EMBEDDING_MODEL=${OPENAI_LARGE_EMBEDDING_MODEL}`,
      `EMBEDDING_DIMENSIONS=${OPENAI_LARGE_EMBEDDING_DIMENSIONS}`,
      `EMBEDDING_BASE_URL=${OPENAI_EMBEDDING_BASE_URL}`,
      `EMBEDDING_API_KEY=${openAiKey}`,
      `EMBEDDING_BATCH_SIZE=${batch}`,
      "OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC=1",
    ];
  }
  const out: string[] = [];
  for (const key of CORE_MEMORY_EMBEDDING_FORWARD_KEYS) {
    const value = sourceEnv[key]?.trim();
    if (value) out.push(`${key}=${value}`);
  }
  out.push("EMBEDDING_BATCH_SIZE=10");
  out.push("OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC=1");
  return out;
}

export function appendCoreMemoryEmbeddingEnv(
  env: string[],
  opts: { openAiApiKey?: string | null } = {},
): void {
  env.push(...buildCoreMemoryEmbeddingContainerEnv(process.env, opts));
}
