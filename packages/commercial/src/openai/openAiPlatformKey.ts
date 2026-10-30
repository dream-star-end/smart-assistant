/**
 * Platform OpenAI key.
 *
 * Prefers an active encrypted pool_api_keys row for service "openai"
 * (admin 账号与服务池, last-4 hint only on read-back). Once that pool has any
 * openai member it is the authority: a disabled or cooling key does not fall
 * through to OPENAI_API_KEY. With no pool row, OPENAI_API_KEY is the fallback.
 * Lookup failures mean "not configured". The key is never logged.
 */
import { apiKeyPoolHasMembers, apiKeyPoolShouldQuery, selectApiKey } from "../account-pool/apiKeyPool.js";

const TTL_MS = 15_000;

let cached: { key: string; at: number } | null = null;

function cleanKey(value: string | null | undefined): string {
  const key = (value ?? "").trim();
  if (!key || /[\r\n\0]/.test(key)) return "";
  return key;
}

export function resetOpenAiPlatformKeyCacheForTests(): void {
  cached = null;
}

export async function selectOpenAiPlatformKey(sticky = "openai-platform"): Promise<string | null> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.key;
  if (apiKeyPoolShouldQuery("openai")) {
    let pooled = "";
    try {
      const selected = await selectApiKey("openai", sticky);
      pooled = cleanKey(selected?.apiKey);
    } catch {
      pooled = "";
    }
    // After selectApiKey the snapshot is fresh. A pool that holds openai rows
    // owns the key, including "none usable" after an admin disable.
    if (apiKeyPoolHasMembers("openai")) {
      if (pooled) cached = { key: pooled, at: now };
      else cached = null;
      return pooled || null;
    }
    if (pooled) {
      cached = { key: pooled, at: now };
      return pooled;
    }
  }
  const envKey = cleanKey(process.env.OPENAI_API_KEY) || null;
  if (envKey) cached = { key: envKey, at: now };
  else cached = null;
  return envKey;
}
