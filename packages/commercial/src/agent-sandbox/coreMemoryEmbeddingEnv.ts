/**
 * Master → agent-sandbox env for local semantic core-memory recall.
 *
 * Missing keys are skipped so we never inject KEY=undefined. Batch size is
 * pinned to DashScope's limit; the feature gate is always on and retrieval
 * fail-closes when embeddings are unconfigured.
 */

export const CORE_MEMORY_EMBEDDING_FORWARD_KEYS = [
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_API_KEY",
  "EMBEDDING_BASE_URL",
] as const;

export function buildCoreMemoryEmbeddingContainerEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  for (const key of CORE_MEMORY_EMBEDDING_FORWARD_KEYS) {
    const value = sourceEnv[key]?.trim();
    if (value) out.push(`${key}=${value}`);
  }
  out.push("EMBEDDING_BATCH_SIZE=10");
  out.push("OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC=1");
  return out;
}

export function appendCoreMemoryEmbeddingEnv(env: string[]): void {
  env.push(...buildCoreMemoryEmbeddingContainerEnv(process.env));
}
