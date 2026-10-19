import type { AnthropicProxyDeps } from "./shared.js";
import type { PickUpstreamDeps } from "./upstream.js";

export interface ApiKeyPoolWiring {
  apiKeyPoolConfigured: (service: string) => boolean;
  selectApiKey: NonNullable<PickUpstreamDeps["selectApiKey"]>;
  apiKeyPoolHasMembers: (service: string) => boolean;
}

/** One scope for config validation, selection and fallback. Unscoped routes keep
 * undefined callbacks; fallback services outside the scope keep their static key. */
export function scopedApiKeyPoolWiring(
  mode: AnthropicProxyDeps["apiKeyPoolEnabled"],
  providerId: string | undefined,
  pool: ApiKeyPoolWiring,
): Partial<ApiKeyPoolWiring> {
  if (mode === true) return pool;
  const enabled = (service: string) => typeof mode !== "boolean" && mode?.includes(service) === true;
  if (providerId === undefined || !enabled(providerId)) return {};
  return {
    apiKeyPoolConfigured: (service) => enabled(service) && pool.apiKeyPoolConfigured(service),
    selectApiKey: (service, sticky, userId) => enabled(service)
      ? pool.selectApiKey(service, sticky, userId)
      : Promise.resolve(null),
    apiKeyPoolHasMembers: (service) => enabled(service) && pool.apiKeyPoolHasMembers(service),
  };
}
