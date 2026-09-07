/**
 * `GET /api/anthropic/v1/models` — unit tests for the pure projection and the
 * HTTP handler wrapper (http/proxy/externalModels.ts).
 *
 * 跑法: npx tsx --test src/__tests__/externalModels.unit.test.ts
 *
 * 锁住的不变量:
 *   1. 只列 cursor-engine 目录行,且必须 enabled + canUseModel 通过(role / grants /
 *      visibility / denials)。其它引擎(gpt-*、kimi-*)即使 enabled 也不出现。
 *   2. 公开 id 去掉 `cursor-` 前缀;整个响应体(含 display_name / owned_by)不出现
 *      "cursor" 字样 —— 这是产品要求,不是巧合。
 *   3. 同时满足 Anthropic(type:"model", created_at, has_more, first_id/last_id)
 *      与 OpenAI(object:"model", owned_by, created)两种 list 形状。
 *   4. 排序 = sort_order 升序,同 sort_order 按公开 id 字典序。
 *   5. handler:非 GET → 405;身份失败 → 与 /v1/messages 相同的 401 泛化文案;
 *      成功 → 200 + cache-control: no-store。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  makeExternalModelsHandler,
  projectExternalModels,
  type ExternalModelsResponse,
} from "../http/proxy/externalModels.js";
import { IdentityError, type ProxyIdentity } from "../auth/proxyIdentity.js";
import type { UserModelAuthz } from "../auth/userModelAuthz.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

function pricingRow(model_id: string, over: Partial<ModelPricing> = {}): ModelPricing {
  return {
    model_id,
    display_name: over.display_name ?? model_id,
    input_per_mtok: 300n,
    output_per_mtok: 1500n,
    cache_read_per_mtok: 30n,
    cache_write_per_mtok: 375n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 100,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

function fakePricing(rows: ModelPricing[]): PricingCache {
  const m = new Map(rows.map((r) => [r.model_id, r]));
  return { get: (id: string) => m.get(id) ?? null } as unknown as PricingCache;
}

const ADMIN_AUTHZ: UserModelAuthz = { role: "admin", grantedModelIds: new Set() };
const USER_AUTHZ: UserModelAuthz = { role: "user", grantedModelIds: new Set() };

const OWNED_BY = "clarvy";

// ─── projection ──────────────────────────────────────────────────────────────

describe("projectExternalModels — scope + shape", () => {
  test("only cursor-engine rows that are enabled and authorised; public ids strip the prefix", () => {
    const pricing = fakePricing([
      pricingRow("cursor-fable-5.1-high", { display_name: "Fable 5.1 High", sort_order: 10 }),
      pricingRow("cursor-sonnet-5-high", { display_name: "Sonnet 5 High", sort_order: 20 }),
      // disabled → excluded even though public
      pricingRow("cursor-opus-5-high", { enabled: false, sort_order: 5 }),
      // non-cursor engine → excluded even though enabled + public
      pricingRow("gpt-6-astra", { sort_order: 1 }),
      pricingRow("kimi-k3", { sort_order: 2 }),
    ]);
    const rows = projectExternalModels(pricing, ADMIN_AUTHZ, OWNED_BY);
    assert.deepEqual(rows.map((r) => r.id), ["fable-5.1-high", "sonnet-5-high"]);
    for (const r of rows) {
      assert.equal(r.type, "model");
      assert.equal(r.object, "model");
      assert.equal(r.owned_by, OWNED_BY);
      assert.equal(typeof r.created, "number");
      assert.equal(r.created_at, "2026-09-01T00:00:00Z");
      assert.equal(r.created, Math.floor(Date.parse(r.created_at) / 1000));
    }
    assert.equal(rows[0]!.display_name, "Fable 5.1 High");
    // 产品硬要求:这条 surface 任何字段都不能出现 cursor 字样
    assert.doesNotMatch(JSON.stringify(rows), /cursor/i);
  });

  test("honours canUseModel: visibility=admin needs admin role or grant; denials win", () => {
    const pricing = fakePricing([
      pricingRow("cursor-fable-5.1-high", { visibility: "admin", sort_order: 1 }),
      pricingRow("cursor-sonnet-5-high", { visibility: "public", sort_order: 2 }),
      pricingRow("cursor-grok-4.6-high", { visibility: "hidden", sort_order: 3 }),
    ]);
    // plain user: only the public row
    assert.deepEqual(
      projectExternalModels(pricing, USER_AUTHZ, OWNED_BY).map((r) => r.id),
      ["sonnet-5-high"],
    );
    // user with grants on admin+hidden rows sees them
    assert.deepEqual(
      projectExternalModels(
        pricing,
        { role: "user", grantedModelIds: new Set(["cursor-fable-5.1-high", "cursor-grok-4.6-high"]) },
        OWNED_BY,
      ).map((r) => r.id),
      ["fable-5.1-high", "sonnet-5-high", "grok-4.6-high"],
    );
    // admin sees admin-visibility but not hidden without a grant
    assert.deepEqual(
      projectExternalModels(pricing, ADMIN_AUTHZ, OWNED_BY).map((r) => r.id),
      ["fable-5.1-high", "sonnet-5-high"],
    );
    // account-scoped denial removes an otherwise-public row
    assert.deepEqual(
      projectExternalModels(
        pricing,
        { role: "admin", grantedModelIds: new Set(), deniedModelIds: new Set(["cursor-sonnet-5-high"]) },
        OWNED_BY,
      ).map((r) => r.id),
      ["fable-5.1-high"],
    );
  });

  test("sorts by sort_order then public id; empty catalog → empty list", () => {
    const pricing = fakePricing([
      pricingRow("cursor-sonnet-5-high", { sort_order: 50 }),
      pricingRow("cursor-fable-5.1-high", { sort_order: 50 }),
      pricingRow("cursor-auto", { sort_order: 1 }),
    ]);
    assert.deepEqual(
      projectExternalModels(pricing, ADMIN_AUTHZ, OWNED_BY).map((r) => r.id),
      ["auto", "fable-5.1-high", "sonnet-5-high"],
    );
    assert.deepEqual(projectExternalModels(fakePricing([]), ADMIN_AUTHZ, OWNED_BY), []);
  });
});

// ─── handler ─────────────────────────────────────────────────────────────────

class MockRes {
  statusCode = 0;
  headers: Record<string, string | number | readonly string[]> = {};
  body = "";
  ended = false;
  headersSent = false;
  setHeader(k: string, v: string | number | readonly string[]) { this.headers[k.toLowerCase()] = v; }
  writeHead(status: number, headers?: Record<string, string | number | readonly string[]>) {
    this.statusCode = status;
    if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    this.headersSent = true;
  }
  end(chunk?: string | Buffer) {
    if (chunk != null) this.body += chunk.toString();
    this.ended = true;
  }
  json(): unknown { return JSON.parse(this.body); }
}

function mockReq(method = "GET", headers: Record<string, string> = {}): IncomingMessage {
  return { method, url: "/api/anthropic/v1/models", headers: { host: "x.invalid", ...headers } } as unknown as IncomingMessage;
}

const IDENTITY: ProxyIdentity = {
  uid: 7n,
  role: "admin",
  containerId: null,
  hostUuid: "external-api-key",
  boundIp: "external-api-key",
  apiKeyId: 42n,
} as unknown as ProxyIdentity;

function buildHandler(over: {
  resolve?: (req: IncomingMessage) => Promise<ProxyIdentity>;
  authz?: UserModelAuthz;
  pricing?: PricingCache;
} = {}) {
  const loads: bigint[] = [];
  const handler = makeExternalModelsHandler({
    resolveIdentity: over.resolve ?? (async () => IDENTITY),
    pricing: over.pricing ?? fakePricing([
      pricingRow("cursor-fable-5.1-high", { display_name: "Fable 5.1 High", sort_order: 1 }),
      pricingRow("cursor-gemini-3.8-flash-low", { display_name: "Gemini 3.8 Flash Low", sort_order: 2 }),
    ]),
    loadUserModelAuthz: async (uid) => { loads.push(uid); return over.authz ?? ADMIN_AUTHZ; },
    ownedBy: OWNED_BY,
  });
  return { handler, loads };
}

describe("makeExternalModelsHandler — HTTP envelope", () => {
  test("GET → 200 dual-shape list, no-store, request id echoed, authz loaded for the key owner", async () => {
    const { handler, loads } = buildHandler();
    const res = new MockRes();
    await handler(mockReq(), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/json");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(typeof res.headers["x-request-id"], "string");
    assert.deepEqual(loads, [7n]);
    const body = res.json() as ExternalModelsResponse;
    assert.equal(body.object, "list");
    assert.equal(body.has_more, false);
    assert.deepEqual(body.data.map((d) => d.id), ["fable-5.1-high", "gemini-3.8-flash-low"]);
    assert.equal(body.first_id, "fable-5.1-high");
    assert.equal(body.last_id, "gemini-3.8-flash-low");
    assert.doesNotMatch(res.body, /cursor/i);
  });

  test("empty result → first_id/last_id null", async () => {
    const { handler } = buildHandler({ pricing: fakePricing([]) });
    const res = new MockRes();
    await handler(mockReq(), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
    const body = res.json() as ExternalModelsResponse;
    assert.deepEqual(body.data, []);
    assert.equal(body.first_id, null);
    assert.equal(body.last_id, null);
  });

  test("non-GET → 405 with Allow: GET, identity not resolved", async () => {
    let resolved = 0;
    const { handler } = buildHandler({ resolve: async () => { resolved++; return IDENTITY; } });
    const res = new MockRes();
    await handler(mockReq("POST"), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 405);
    assert.equal(resolved, 0);
    const body = res.json() as { error: { code: string; allow?: string } };
    assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
  });

  test("IdentityError → generic 401 identical to /v1/messages (anti-enumeration), authz not loaded", async () => {
    for (const code of ["MISSING_API_KEY", "BAD_API_KEY_FORMAT", "INVALID_API_KEY", "API_KEY_DISABLED"]) {
      const { handler, loads } = buildHandler({
        resolve: async () => { throw new IdentityError(code, `internal reason for ${code}`); },
      });
      const res = new MockRes();
      await handler(mockReq(), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 401, code);
      const body = res.json() as { error: { code: string; message: string } };
      assert.equal(body.error.code, "UNAUTHORIZED");
      assert.equal(body.error.message, "container identity verification failed");
      assert.doesNotMatch(res.body, new RegExp(code));
      assert.deepEqual(loads, []);
    }
  });

  test("non-IdentityError from resolveIdentity propagates (router maps to 500)", async () => {
    const { handler } = buildHandler({ resolve: async () => { throw new Error("db down"); } });
    const res = new MockRes();
    await assert.rejects(
      () => handler(mockReq(), res as unknown as ServerResponse),
      /db down/,
    );
    assert.equal(res.ended, false);
  });
});
