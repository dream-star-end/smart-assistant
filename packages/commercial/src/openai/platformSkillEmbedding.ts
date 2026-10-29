import { type EmbeddingProviderConfig, skillEmbeddingConfigFromEnv } from "@openclaude/storage";

import { selectOpenAiPlatformKey } from "./openAiPlatformKey.js";

/** Skill-embedding config, switched to text-embedding-3-large only when an OpenAI key exists. */
export async function resolvePlatformSkillEmbeddingConfig(): Promise<EmbeddingProviderConfig> {
  const openAiApiKey = await selectOpenAiPlatformKey("skill-embed");
  return skillEmbeddingConfigFromEnv(process.env, { openAiApiKey });
}
