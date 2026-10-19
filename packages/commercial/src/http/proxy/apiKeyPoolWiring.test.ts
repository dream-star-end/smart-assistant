import test from "node:test";
import assert from "node:assert/strict";
import { getStaticProvider } from "@openclaude/protocol";
import { scopedApiKeyPoolWiring, type ApiKeyPoolWiring } from "./apiKeyPoolWiring.js";
import { pickUpstream, validateUpstreamConfig, type PickUpstreamDeps } from "./upstream.js";
import { rootLogger } from "../../logging/logger.js";
import { proveGoPoolWiring } from "../../__tests__/goPoolWiringProof.js";

const log = rootLogger.child({ subsys: "apiKeyPoolWiring.test" });
const scheduler: PickUpstreamDeps["scheduler"] = {
  pick: async () => { throw new Error("unexpected OAuth selection"); },
  release: async () => { throw new Error("unexpected OAuth release"); },
};
const go = { kind: "static" as const, provider: getStaticProvider("opencodego"), upstreamModel: "gpt-6-luna" };
const body = { model: "opencode-gpt-6-luna", max_tokens: 64, messages: [{ role: "user", content: "hi" }],
  metadata: { session_id: "stable-session" } };
function poolSpy() {
  const calls: string[] = [];
  const pool: ApiKeyPoolWiring = {
    apiKeyPoolConfigured: (service) => { calls.push(`configured:${service}`); return true; },
    apiKeyPoolHasMembers: (service) => { calls.push(`members:${service}`); return true; },
    selectApiKey: async (service) => {
      calls.push(`select:${service}`);
      return { service, memberId: "enabled-member", apiKey: "synthetic-pool-key" };
    },
  };
  return { calls, pool };
}

test("OCV5-520 ordinary Go uses its enabled pool identity and preserves request bytes", async () => {
  assert.match(await proveGoPoolWiring(), /^\[ocv5-520-go-pool-wiring\] PASS/);
});

test("OCV5-520 disabled modes and ordinary non-Go routes leave all callbacks undefined", () => {
  const { calls, pool } = poolSpy();
  for (const mode of [undefined, false, []] as const) {
    assert.deepEqual(scopedApiKeyPoolWiring(mode, "opencodego", pool), {});
  }
  for (const service of [undefined, "deepseek", "ark", "claude"]) {
    assert.deepEqual(scopedApiKeyPoolWiring(["opencodego"], service, pool), {});
  }
  assert.deepEqual(calls, []);
});

test("OCV5-520 all-service mode retains the original callbacks including OAuth fallback", async () => {
  const { calls, pool } = poolSpy();
  assert.equal(scopedApiKeyPoolWiring(true, undefined, pool), pool);
  const full = scopedApiKeyPoolWiring(true, "opencodego", pool);
  assert.equal(full.apiKeyPoolConfigured?.("deepseek"), true);
  assert.equal(full.apiKeyPoolHasMembers?.("claude"), true);
  assert.equal((await full.selectApiKey?.("claude", "s", 765n))?.service, "claude");
  assert.deepEqual(calls, ["configured:deepseek", "members:claude", "select:claude"]);
});

test("OCV5-520 Go scope applies to configuration, selection and fallback members together", async () => {
  const { calls, pool } = poolSpy();
  const wiring = scopedApiKeyPoolWiring(["opencodego"], "opencodego", pool);
  assert.equal(validateUpstreamConfig(go, wiring), null);
  assert.equal(wiring.apiKeyPoolConfigured?.("deepseek"), false);
  assert.equal(wiring.apiKeyPoolHasMembers?.("deepseek"), false);
  assert.equal(await wiring.selectApiKey?.("deepseek", "s"), null);
  assert.deepEqual(calls, ["configured:opencodego"]);
  assert.deepEqual(validateUpstreamConfig(go, {}), { kind: "static_not_configured", providerId: "opencodego" });
});

test("OCV5-520 nonempty Go pool rejects null or failed selection without using the env key", async () => {
  for (const fail of [false, true]) {
    const { pool } = poolSpy();
    const wiring = scopedApiKeyPoolWiring(["opencodego"], "opencodego", {
      ...pool, selectApiKey: async () => { if (fail) throw new Error("synthetic pool read failure"); return null; },
    });
    const result = await pickUpstream({ scheduler, staticProviderKeys: { opencodego: "synthetic-disabled-env" }, ...wiring }, body, go, log);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "pool_unavailable");
  }
});

test("OCV5-520 empty Go pool retains the legacy static key behavior", async () => {
  const { pool } = poolSpy();
  const wiring = scopedApiKeyPoolWiring(["opencodego"], "opencodego", {
    ...pool, selectApiKey: async () => null, apiKeyPoolHasMembers: () => false,
  });
  const result = await pickUpstream({ scheduler, staticProviderKeys: { opencodego: "synthetic-env" }, ...wiring }, body, go, log);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const headers: Record<string, string> = {};
  result.session.applyUpstreamAuth(headers, structuredClone(body), log);
  assert.equal(headers["x-api-key"], "synthetic-env");
  assert.equal(result.session.poolMember, null);
});

test("OCV5-520 non-Go primary retains its static key without reading another service pool", async () => {
  const { calls, pool } = poolSpy();
  const route = { kind: "static" as const, provider: getStaticProvider("deepseek"), upstreamModel: "deepseek-v4-pro" };
  const result = await pickUpstream({ scheduler, staticProviderKeys: { deepseek: "synthetic-ds-env" },
    ...scopedApiKeyPoolWiring(["opencodego"], "deepseek", pool) }, body, route, log);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const headers: Record<string, string> = {};
  result.session.applyUpstreamAuth(headers, structuredClone(body), log);
  assert.equal(headers.authorization, "Bearer synthetic-ds-env");
  assert.equal(result.session.poolMember, null);
  assert.deepEqual(calls, []);
});
