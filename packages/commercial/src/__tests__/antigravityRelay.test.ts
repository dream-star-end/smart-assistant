/**
 * Antigravity relay (OCV5-415 P2): route binding, method/model allowlists,
 * token injection, per-call metering, budget stop, interim pool policy and
 * settlement math. No live Google traffic.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/antigravityRelay.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, test } from "node:test";

import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  ANTIGRAVITY_INTERIM_POLICY,
  classifyAntigravityUpstream,
  decideAntigravityInterim,
  parseRetryAfterMs,
  type AntigravityPoolOutcome,
} from "../account-pool/antigravityPoolInterim.js";
import {
  _resetAntigravityRelayRoutesForTests,
  expireAntigravityRelayRoute,
  mintAntigravityRelayRoute,
  resolveAntigravityRelayRoute,
} from "../billing/antigravityRouteContext.js";
import {
  mapAntigravityUsage,
  planAntigravitySettle,
  type AntigravityUsageTotals,
} from "../billing/antigravitySettle.js";
import type { ModelPricing } from "../billing/pricing.js";
import {
  ANTIGRAVITY_RELAY_PREFIX,
  ANTIGRAVITY_UPSTREAM_BASE_URL,
  AntigravityUsageTap,
  makeAntigravityRelayHandler,
  type AntigravityRelayDeps,
  type AntigravityUsageRow,
} from "../http/internalAntigravityRelay.js";

const SECRET = "b".repeat(64);
const CONTAINER_TOKEN = `oc-v3.11.${SECRET}`;
const CTX = { hostUuid: "host-self", boundIp: "172.30.0.11" };
const REQUEST_ID = "d".repeat(32);
const FULL_TOKEN = "ya29.full-scope-account-token";

function repo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null;
      return {
        id: 11,
        user_id: 42,
        bound_ip: CTX.boundIp,
        host_uuid: CTX.hostUuid,
        secret_hash: hashSecret(SECRET),
      };
    },
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function mintRoute(modelId = "antigravity-gemini-3.8-flash", budget = 1_000n): Promise<string> {
  _resetAntigravityRelayRoutesForTests();
  const minted = await mintAntigravityRelayRoute({
    containerId: 11,
    userId: 42,
    requestId: REQUEST_ID,
    modelId,
    accountId: 7n,
    budgetCredits: budget,
    relayPort: 18789,
  });
  return minted.token;
}

interface Upstream {
  status: number;
  headers?: Record<string, string>;
  body: string[];
}

interface Captured {
  url?: string;
  auth?: string;
  headers?: Record<string, string>;
  body?: string;
  calls: number;
  usage: AntigravityUsageRow[];
  outcomes: Array<{ accountId: bigint; outcome: AntigravityPoolOutcome }>;
}

async function relay(
  path: string,
  init: { method?: string; body?: string; auth?: string; headers?: Record<string, string> },
  upstream: Upstream,
  extra: Partial<AntigravityRelayDeps> = {},
): Promise<{ status: number; text: string; captured: Captured }> {
  const captured: Captured = { calls: 0, usage: [], outcomes: [] };
  const handler = makeAntigravityRelayHandler({
    identityRepo: repo(),
    clientSecret: "GOCSPX-test-secret-not-real-000",
    freshToken: async () => Buffer.from(FULL_TOKEN, "utf8"),
    reportOutcome: async (accountId, outcome) => { captured.outcomes.push({ accountId, outcome }); },
    recordUsage: async (row) => { captured.usage.push(row); },
    meteredCost: async () => 0n,
    requestFn: (async (url: unknown, opts: { headers?: Record<string, string>; body?: Buffer }) => {
      captured.calls += 1;
      captured.url = String(url);
      captured.headers = opts.headers ?? {};
      captured.auth = opts.headers?.authorization;
      captured.body = opts.body?.toString("utf8");
      return {
        statusCode: upstream.status,
        headers: upstream.headers ?? { "content-type": "text/event-stream" },
        body: Readable.from(upstream.body.map((chunk) => Buffer.from(chunk, "utf8"))),
      };
    }) as never,
    ...extra,
  });
  const server = createServer((req, res) => {
    void handler(req, res, CTX);
  });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "POST",
      headers: {
        authorization: init.auth ?? `Bearer ${CONTAINER_TOKEN}`,
        "content-type": "application/json",
        "user-agent": "antigravity/cli/1.3.4",
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    return { status: res.status, text: await res.text(), captured };
  } finally {
    await close(server);
  }
}

const SSE = [
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"po"}]}}]}}\n\n',
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ng"}]}}],"usageMetadata":{"promptTokenCount":11885,"candid',
  'atesTokenCount":1,"totalTokenCount":11914,"thoughtsTokenCount":28,"cachedContentTokenCount":9000}}}\n\n',
];

function generateBody(model: string, requestType = "agent"): string {
  return JSON.stringify({ model, project: "p-1", request: { contents: [] }, requestId: "r", requestType, userAgent: "antigravity" });
}

afterEach(() => {
  _resetAntigravityRelayRoutesForTests();
});

describe("Antigravity relay handler", () => {
  test("generate call: injects the account token, streams, and meters usageMetadata", async () => {
    const token = await mintRoute();
    const { status, text, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody("gemini-3.8-flash-high"), headers: { "x-goog-api-key": "nope", cookie: "a=b" } },
      { status: 200, body: SSE },
    );
    assert.equal(status, 200);
    assert.equal(text, SSE.join(""));
    assert.equal(captured.url, `${ANTIGRAVITY_UPSTREAM_BASE_URL}/v1internal:streamGenerateContent?alt=sse`);
    assert.equal(captured.auth, `Bearer ${FULL_TOKEN}`);
    // Only the allowlisted headers survive (fetch adds `accept` itself).
    assert.deepEqual(Object.keys(captured.headers ?? {}).sort(), ["accept", "authorization", "content-type", "user-agent"]);
    assert.equal(JSON.parse(captured.body ?? "{}").model, "gemini-3.8-flash-high");
    assert.deepEqual(captured.usage, [{
      requestId: REQUEST_ID,
      userId: 42n,
      accountId: 7n,
      routeModelId: "antigravity-gemini-3.8-flash",
      upstreamModel: "gemini-3.8-flash-high",
      requestType: "agent",
      statusCode: 200,
      promptTokens: 11885,
      candidatesTokens: 1,
      thoughtsTokens: 28,
      cachedTokens: 9000,
    }]);
    assert.deepEqual(captured.outcomes, [{ accountId: 7n, outcome: { kind: "success" } }]);
  });

  test("title generation model is allowed and metered on the turn", async () => {
    const token = await mintRoute("antigravity-claude-sonnet-4.6");
    const { status, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody("gemini-3.5-flash-lite", "checkpoint") },
      { status: 200, body: SSE },
    );
    assert.equal(status, 200);
    assert.equal(captured.usage[0]?.upstreamModel, "gemini-3.5-flash-lite");
    assert.equal(captured.usage[0]?.routeModelId, "antigravity-claude-sonnet-4.6");
  });

  test("refuses a model outside the route allowlist before calling Google", async () => {
    const token = await mintRoute("antigravity-gemini-3.8-flash");
    const { status, text, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody("claude-opus-4-6-thinking") },
      { status: 200, body: SSE },
    );
    assert.equal(status, 403);
    assert.match(text, /ANTIGRAVITY_MODEL_NOT_ALLOWED/);
    assert.equal(captured.calls, 0);
  });

  test("stops new generate calls once metered cost reaches the admission budget", async () => {
    const token = await mintRoute("antigravity-gemini-3.8-flash", 50n);
    const { status, text, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody("gemini-3.8-flash-low") },
      { status: 200, body: SSE },
      { meteredCost: async () => 50n },
    );
    assert.equal(status, 402);
    assert.match(text, /ANTIGRAVITY_BUDGET_EXHAUSTED/);
    assert.equal(captured.calls, 0);
  });

  test("fails closed when pricing is not loaded (no unmetered calls)", async () => {
    const token = await mintRoute();
    const { status, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody("gemini-3.8-flash-low") },
      { status: 200, body: SSE },
      { meteredCost: async () => null },
    );
    assert.equal(status, 503);
    assert.equal(captured.calls, 0);
  });

  test("metadata calls pass through without metering; unknown methods are refused", async () => {
    const token = await mintRoute();
    const ok = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:loadCodeAssist`,
      { body: '{"metadata":{"ideType":"ANTIGRAVITY"}}' },
      { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=y" }, body: ['{"currentTier":{}}'] },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.text, '{"currentTier":{}}');
    assert.equal(ok.captured.usage.length, 0);
    assert.equal(ok.captured.body, '{"metadata":{"ideType":"ANTIGRAVITY"}}');

    for (const method of ["onboardUser", "generateContent", "setUserSettings"]) {
      const refused = await relay(
        `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:${method}`,
        { body: "{}" },
        { status: 200, body: ["{}"] },
      );
      assert.equal(refused.status, 405, method);
      assert.equal(refused.captured.calls, 0, method);
    }
    const query = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:loadCodeAssist?key=x`,
      { body: "{}" },
      { status: 200, body: ["{}"] },
    );
    assert.equal(query.status, 400);
  });

  test("requires container identity and a live route bound to that container", async () => {
    const token = await mintRoute();
    const path = `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:loadCodeAssist`;
    const noAuth = await relay(path, { body: "{}", auth: "Bearer ya29.limited-cli-token" }, { status: 200, body: ["{}"] });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.captured.calls, 0);
    await expireAntigravityRelayRoute(token);
    const expired = await relay(path, { body: "{}" }, { status: 200, body: ["{}"] });
    assert.equal(expired.status, 404);
    assert.equal(expired.captured.calls, 0);
  });

  test("429 from Google is reported to the pool and passed to the CLI", async () => {
    const token = await mintRoute();
    const { status, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:streamGenerateContent?alt=sse`,
      { body: generateBody("gemini-3.8-flash-high") },
      { status: 429, headers: { "content-type": "application/json", "retry-after": "40" }, body: ['{"error":{"code":429}}'] },
    );
    assert.equal(status, 429);
    assert.deepEqual(captured.outcomes, [{ accountId: 7n, outcome: { kind: "rate_limited", retryAfterMs: 40_000 } }]);
    assert.equal(captured.usage[0]?.statusCode, 429);
    assert.equal(captured.usage[0]?.promptTokens, 0);
  });

  test("not configured → 503 without touching Google", async () => {
    const token = await mintRoute();
    const { status, captured } = await relay(
      `${ANTIGRAVITY_RELAY_PREFIX}/route/${token}/v1internal:loadCodeAssist`,
      { body: "{}" },
      { status: 200, body: ["{}"] },
      { clientSecret: "" },
    );
    assert.equal(status, 503);
    assert.equal(captured.calls, 0);
  });
});

describe("Antigravity route context", () => {
  test("binds container, user, account and budget; rejects other containers", async () => {
    const token = await mintRoute("antigravity-gpt-oss-120b", 77n);
    const route = await resolveAntigravityRelayRoute({ token, containerId: 11, userId: 42 });
    assert.equal(route?.accountId, 7n);
    assert.equal(route?.budgetCredits, 77n);
    assert.equal(route?.modelId, "antigravity-gpt-oss-120b");
    assert.equal(await resolveAntigravityRelayRoute({ token, containerId: 12, userId: 42 }), null);
    assert.equal(await resolveAntigravityRelayRoute({ token, containerId: 11, userId: 43 }), null);
  });

  test("refuses non-Antigravity models and empty budgets", async () => {
    const base = { containerId: 11, userId: 42, requestId: REQUEST_ID, accountId: 7n, relayPort: 18789 };
    await assert.rejects(mintAntigravityRelayRoute({ ...base, modelId: "glm-5.3-zai", budgetCredits: 5n }), /not allowlisted/);
    await assert.rejects(mintAntigravityRelayRoute({ ...base, modelId: "antigravity-gemini-3.8-flash", budgetCredits: 0n }), /budget/);
  });
});

describe("AntigravityUsageTap", () => {
  test("keeps the last usageMetadata across chunk boundaries and ignores non-data lines", () => {
    const tap = new AntigravityUsageTap();
    for (const chunk of SSE) tap.push(chunk);
    tap.push(": keepalive\n");
    tap.end();
    assert.deepEqual(tap.usage, { prompt: 11885, candidates: 1, thoughts: 28, cached: 9000 });
  });

  test("an unterminated last event is still read at end", () => {
    const tap = new AntigravityUsageTap();
    tap.push('data: {"response":{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}}');
    tap.end();
    assert.deepEqual(tap.usage, { prompt: 5, candidates: 2, thoughts: 0, cached: 0 });
  });
});

describe("Antigravity interim pool policy (TODO OCV5-424)", () => {
  const now = 1_000_000;
  const state = { healthScore: 100, backoffLevel: 0, status: "active" };

  test("429 Retry-After is clamped to 15s..15min; without it 30s·2^level", () => {
    const p = ANTIGRAVITY_INTERIM_POLICY;
    const short = decideAntigravityInterim(state, { kind: "rate_limited", retryAfterMs: 1_000 }, now);
    assert.equal(short?.cooldownUntil?.getTime(), now + p.rateLimitMinMs);
    const long = decideAntigravityInterim(state, { kind: "rate_limited", retryAfterMs: 99 * 60_000 }, now);
    assert.equal(long?.cooldownUntil?.getTime(), now + p.rateLimitMaxMs);
    const none = decideAntigravityInterim({ ...state, backoffLevel: 2 }, { kind: "rate_limited", retryAfterMs: null }, now);
    assert.equal(none?.cooldownUntil?.getTime(), now + 120_000);
    assert.equal(none?.cooldownReason, "rate_limited");
    assert.equal(none?.backoffLevel, 3);
  });

  test("auth failures cool down 5min·2^level up to 6h and never disable", () => {
    const first = decideAntigravityInterim(state, { kind: "auth_invalid" }, now);
    assert.equal(first?.status, "cooldown");
    assert.equal(first?.cooldownUntil?.getTime(), now + 5 * 60_000);
    const capped = decideAntigravityInterim({ ...state, backoffLevel: 10 }, { kind: "auth_invalid" }, now);
    assert.equal(capped?.cooldownUntil?.getTime(), now + 6 * 3_600_000);
  });

  test("upstream errors cost health and cool only on the third strike", () => {
    const one = decideAntigravityInterim(state, { kind: "upstream_error" }, now);
    assert.equal(one?.status, "active");
    assert.equal(one?.healthScore, 80);
    const three = decideAntigravityInterim({ ...state, healthScore: 60 }, { kind: "upstream_error" }, now);
    assert.equal(three?.status, "cooldown");
    assert.equal(three?.cooldownReason, "upstream");
  });

  test("success after an expired cooldown restarts from half-open health", () => {
    const next = decideAntigravityInterim({ healthScore: 20, backoffLevel: 3, status: "cooldown" }, { kind: "success" }, now);
    assert.deepEqual(next, {
      status: "active", cooldownUntil: null, cooldownReason: null, backoffLevel: 0, healthScore: 60, success: true,
    });
  });

  test("client and network errors do not change the account", () => {
    assert.equal(decideAntigravityInterim(state, { kind: "client_error" }, now), null);
    assert.equal(decideAntigravityInterim(state, { kind: "network" }, now), null);
  });

  test("classification and Retry-After parsing", () => {
    assert.deepEqual(classifyAntigravityUpstream(200, {}, now), { kind: "success" });
    assert.deepEqual(classifyAntigravityUpstream(429, {}, now), { kind: "rate_limited", retryAfterMs: null });
    assert.deepEqual(classifyAntigravityUpstream(403, {}, now), { kind: "auth_invalid" });
    assert.deepEqual(classifyAntigravityUpstream(503, {}, now), { kind: "upstream_error" });
    assert.deepEqual(classifyAntigravityUpstream(400, {}, now), { kind: "client_error" });
    assert.equal(parseRetryAfterMs("7", now), 7_000);
    assert.equal(parseRetryAfterMs(new Date(now + 9_000).toUTCString(), now) !== null, true);
    assert.equal(parseRetryAfterMs("soon", now), null);
  });
});

describe("Antigravity settlement math", () => {
  const pricing = {
    model_id: "antigravity-gemini-3.8-flash",
    display_name: "Gemini 3.8 Flash (Antigravity)",
    input_per_mtok: 120n,
    output_per_mtok: 150n,
    cache_read_per_mtok: 5n,
    cache_write_per_mtok: 0n,
    multiplier: "1.000",
    enabled: true,
  } as unknown as ModelPricing;
  const totals: AntigravityUsageTotals = {
    promptTokens: 12_008n, candidatesTokens: 4n, thoughtsTokens: 28n, cachedTokens: 9_000n, calls: 2,
  };

  test("cached tokens come out of prompt; thoughts bill as output", () => {
    assert.deepEqual(mapAntigravityUsage(totals), {
      input_tokens: 3_008n, output_tokens: 32n, cache_read_tokens: 9_000n, cache_write_tokens: 0n,
    });
  });

  test("only a successful turn with output is charged", () => {
    const ok = planAntigravitySettle({ engineStatus: "success", totals, pricing });
    assert.ok(ok.costCredits > 0n);
    assert.equal(ok.settleStatus, "success");
    const failed = planAntigravitySettle({ engineStatus: "error", totals, pricing, terminalCode: "ENGINE_ERROR" });
    assert.equal(failed.costCredits, 0n);
    assert.match(failed.snapshotJson, /antigravity_engine_not_success/);
    const silent = planAntigravitySettle({
      engineStatus: "success", totals: { ...totals, candidatesTokens: 0n, thoughtsTokens: 0n }, pricing,
    });
    assert.equal(silent.costCredits, 0n);
    assert.match(silent.snapshotJson, /no_output/);
  });
});
