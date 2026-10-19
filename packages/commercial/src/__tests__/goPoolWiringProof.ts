import assert from "node:assert/strict";
import { getStaticProvider } from "@openclaude/protocol";
import { scopedApiKeyPoolWiring, type ApiKeyPoolWiring } from "../http/proxy/apiKeyPoolWiring.js";
import { pickUpstream, validateUpstreamConfig, type PickUpstreamDeps } from "../http/proxy/upstream.js";
import { rootLogger } from "../logging/logger.js";

/** OCV5-520: synthetic credentials only, no network/DB. Exercise the candidate's
 * ordinary Go wiring and real auth builder, including stable request bytes. */
export async function proveGoPoolWiring(): Promise<string> {
  const route = { kind: "static" as const, provider: getStaticProvider("opencodego"), upstreamModel: "gpt-6-luna" };
  const body = { model: "opencode-gpt-6-luna", max_tokens: 64,
    system: [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "continue this task" }],
    metadata: { session_id: "go-pool-proof-session" }, output_config: { effort: "high" } };
  const scheduler: PickUpstreamDeps["scheduler"] = {
    pick: async () => { throw new Error("unexpected OAuth selection"); },
    release: async () => { throw new Error("unexpected OAuth release"); },
  };
  const calls: unknown[] = [];
  const pool: ApiKeyPoolWiring = {
    apiKeyPoolConfigured: (service) => service === "opencodego",
    apiKeyPoolHasMembers: (service) => service === "opencodego",
    selectApiKey: async (service, sticky, userId) => {
      calls.push([service, sticky, userId]);
      return { service, memberId: "enabled-member", apiKey: "synthetic-enabled-key" };
    },
  };
  const wiring = scopedApiKeyPoolWiring(["opencodego"], "opencodego", pool);
  assert.equal(validateUpstreamConfig(route, wiring), null, "GO_POOL_WITHOUT_ENV_REJECTED");
  const log = rootLogger.child({ subsys: "go-pool-proof" });
  const staticProviderKeys = { opencodego: "synthetic-disabled-env" };
  const selected = await pickUpstream({ scheduler, staticProviderKeys, ...wiring }, body, route, log, 765n);
  assert.equal(selected.ok, true, "GO_POOL_NOT_SELECTED");
  if (!selected.ok) throw new Error("GO_POOL_NOT_SELECTED");
  const legacy = await pickUpstream({ scheduler, staticProviderKeys }, body, route, log, 765n);
  assert.equal(legacy.ok, true);
  if (!legacy.ok) throw new Error("GO_LEGACY_NOT_SELECTED");
  const nextBody = structuredClone(body);
  const oldBody = structuredClone(body);
  const headers: Record<string, string> = {};
  const oldHeaders: Record<string, string> = {};
  selected.session.applyUpstreamAuth(headers, nextBody, log);
  legacy.session.applyUpstreamAuth(oldHeaders, oldBody, log);
  assert.equal(headers["x-api-key"], "synthetic-enabled-key", "GO_DISABLED_ENV_WAS_USED");
  assert.deepEqual(selected.session.poolMember, { service: "opencodego", memberId: "enabled-member" });
  assert.deepEqual(calls, [["opencodego", body.metadata.session_id, 765n]]);
  assert.equal(JSON.stringify(nextBody), JSON.stringify(oldBody), "GO_REQUEST_BYTES_CHANGED");
  assert.equal(headers["x-opencode-session"], body.metadata.session_id, "GO_SESSION_HEADER_CHANGED");
  delete headers["x-api-key"];
  delete oldHeaders["x-api-key"];
  assert.deepEqual(headers, oldHeaders, "GO_NON_AUTH_HEADERS_CHANGED");
  const unavailable = scopedApiKeyPoolWiring(["opencodego"], "opencodego", {
    ...pool, selectApiKey: async () => null,
  });
  const refused = await pickUpstream({ scheduler, staticProviderKeys, ...unavailable }, body, route, log, 765n);
  assert.equal(refused.ok, false, "GO_DISABLED_ENV_FALLBACK");
  if (!refused.ok) assert.equal(refused.error.kind, "pool_unavailable");
  assert.deepEqual(scopedApiKeyPoolWiring(["opencodego"], "deepseek", pool), {});
  return "[ocv5-520-go-pool-wiring] PASS — ordinary Go uses an enabled pool identity instead of disabled static credentials while request bytes and session headers stay stable";
}
