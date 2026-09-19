/**
 * `GET /api/anthropic/v1/usage` — unit tests for the pure projection and the
 * HTTP handler wrapper (http/proxy/externalUsage.ts).
 *
 * 跑法: npx tsx --test src/__tests__/externalUsage.unit.test.ts
 *
 * 锁住的不变量:
 *   1. is_valid = spendable > 0 且(无上限 或 上限未耗尽);remaining_limit 不为负。
 *   2. 所有大数字段序列化为字符串;key_prefix 以 `oc-cc.` 开头(与列表页展示同型)。
 *   3. handler:非 GET → 405;身份失败 → 与 /v1/messages 同一 401 泛化文案;
 *      identity 无 apiKey 快照(容器身份误接)→ 503;窗口统计失败降级为 0 不影响余额;
 *      成功 → 200 + cache-control: no-store,响应体不出现 "cursor"。
 *   4. 响应能被前端生成的 CC Switch 用量脚本 extractor 正确消费(remaining/used/total)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  makeExternalUsageHandler,
  projectExternalUsage,
  type ExternalUsageResponse,
} from "../http/proxy/externalUsage.js";
import { IdentityError, type ProxyIdentity } from "../auth/proxyIdentity.js";
import type { ApiKeySummary } from "../auth/apiKeyRepo.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

const KEY = { id: 8n, creditLimit: null as bigint | null, spentCredits: 200n };
const META = { label: "test1", keyPrefix: "6491shtk" };
const WINDOW = { requests: "12", credits: "200", input_tokens: "1000", output_tokens: "300" };

function fakeReq(method = "GET", headers: Record<string, string> = {}): IncomingMessage {
  return { method, headers: { host: "x.invalid", ...headers }, url: "/api/anthropic/v1/usage" } as unknown as IncomingMessage;
}

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  getHeader(k: string) { return this.headers[k.toLowerCase()]; }
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers ?? {})) this.headers[k.toLowerCase()] = v;
    return this;
  }
  end(chunk?: string) { if (chunk) this.body += chunk; }
  json<T = unknown>(): T { return JSON.parse(this.body) as T; }
}

const IDENTITY: ProxyIdentity = { uid: 3n, containerId: null, apiKey: KEY };

function summary(over: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: 8n,
    label: "test1",
    keyPrefix: "6491shtk",
    createdAt: new Date("2026-09-08T00:00:00Z"),
    lastUsedAt: null,
    disabledAt: null,
    creditLimit: null,
    spentCredits: 200n,
    ...over,
  };
}

function buildHandler(over: {
  resolve?: () => Promise<ProxyIdentity>;
  balance?: bigint;
  list?: ApiKeySummary[];
  windowImpl?: () => Promise<typeof WINDOW>;
} = {}) {
  return makeExternalUsageHandler({
    resolveIdentity: over.resolve ?? (async () => IDENTITY),
    repo: { list: async () => over.list ?? [summary()] },
    readBalance: async () => over.balance ?? 12345n,
    readWindow: over.windowImpl ?? (async () => WINDOW),
  });
}

// ─── projection ──────────────────────────────────────────────────────────────

describe("projectExternalUsage — 纯投影", () => {
  test("无上限:remaining_limit=null,is_valid 取决于余额>0", () => {
    const r = projectExternalUsage({ spendable: 12345n, key: KEY, meta: META, window: WINDOW });
    assert.equal(r.object, "usage");
    assert.equal(r.unit, "credits");
    assert.equal(r.balance.spendable, "12345");
    assert.equal(r.key.id, "8");
    assert.equal(r.key.label, "test1");
    assert.equal(r.key.key_prefix, "oc-cc.6491shtk");
    assert.equal(r.key.spent_credits, "200");
    assert.equal(r.key.credit_limit, null);
    assert.equal(r.key.remaining_limit, null);
    assert.equal(r.key.is_valid, true);
    assert.deepEqual(r.window, { range: "30d", ...WINDOW });
    const zero = projectExternalUsage({ spendable: 0n, key: KEY, meta: META, window: WINDOW });
    assert.equal(zero.key.is_valid, false);
  });

  test("有上限:remaining_limit = max(limit - spent, 0);耗尽 → is_valid=false", () => {
    const under = projectExternalUsage({
      spendable: 999n,
      key: { ...KEY, creditLimit: 1000n, spentCredits: 900n },
      meta: META,
      window: WINDOW,
    });
    assert.equal(under.key.remaining_limit, "100");
    assert.equal(under.key.is_valid, true);
    const over = projectExternalUsage({
      spendable: 999n,
      key: { ...KEY, creditLimit: 1000n, spentCredits: 1200n },
      meta: META,
      window: WINDOW,
    });
    assert.equal(over.key.remaining_limit, "0");
    assert.equal(over.key.credit_limit, "1000");
    assert.equal(over.key.is_valid, false);
  });

  test("meta 缺失(list 未含该 key)→ label/key_prefix 为 null,其余照常", () => {
    const r = projectExternalUsage({ spendable: 1n, key: KEY, meta: null, window: WINDOW });
    assert.equal(r.key.label, null);
    assert.equal(r.key.key_prefix, null);
    assert.equal(r.key.is_valid, true);
  });
});

// ─── handler ─────────────────────────────────────────────────────────────────

describe("makeExternalUsageHandler — HTTP 包装", () => {
  test("GET + 有效身份 → 200 no-store,body 为投影,全文无 cursor", async () => {
    const h = buildHandler();
    const res = new FakeRes();
    await h(fakeReq("GET", { "user-agent": "cc-switch/usage" }), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["content-type"], "application/json");
    const body = res.json<ExternalUsageResponse>();
    assert.equal(body.balance.spendable, "12345");
    assert.equal(body.key.label, "test1");
    assert.equal(body.key.is_valid, true);
    assert.doesNotMatch(res.body, /cursor/i);
  });

  test("非 GET → 405 + allow: GET,不进鉴权", async () => {
    let resolved = 0;
    const h = buildHandler({ resolve: async () => { resolved++; return IDENTITY; } });
    const res = new FakeRes();
    await h(fakeReq("POST"), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "GET");
    assert.equal(resolved, 0);
  });

  test("身份失败(IdentityError)→ 401 与 /v1/messages 同一泛化文案", async () => {
    const h = buildHandler({ resolve: async () => { throw new IdentityError("API_KEY_INVALID", "revoked"); } });
    const res = new FakeRes();
    await h(fakeReq(), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 401);
    const body = res.json<{ error: { code: string; message: string } }>();
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal(body.error.message, "container identity verification failed");
    assert.doesNotMatch(res.body, /revoked/);
  });

  test("非 IdentityError 异常透传(交给 router handleError → 500)", async () => {
    const h = buildHandler({ resolve: async () => { throw new Error("db down"); } });
    await assert.rejects(h(fakeReq(), new FakeRes() as unknown as ServerResponse), /db down/);
  });

  test("identity 无 apiKey 快照(容器身份误接)→ 503 EXTERNAL_PROXY_UNAVAILABLE", async () => {
    const h = buildHandler({ resolve: async () => ({ uid: 3n, containerId: 9n }) });
    const res = new FakeRes();
    await h(fakeReq(), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json<{ error: { code: string } }>().error.code, "EXTERNAL_PROXY_UNAVAILABLE");
  });

  test("窗口统计失败 → 降级为 0,余额与 key 信息照常 200", async () => {
    const h = buildHandler({ windowImpl: async () => { throw new Error("analytics down"); } });
    const res = new FakeRes();
    await h(fakeReq(), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
    const body = res.json<ExternalUsageResponse>();
    assert.equal(body.balance.spendable, "12345");
    assert.deepEqual(body.window, { range: "30d", requests: "0", credits: "0", input_tokens: "0", output_tokens: "0" });
  });

  test("与前端 CC Switch 用量脚本 extractor 契约对齐(remaining/used/total/unit)", async () => {
    // 与 web-react ApiKeysSection.buildCcSwitchUsageScript 的 extractor 同一算法(手写镜像,
    // 防止服务端字段改名后前端脚本静默失效)。
    const h = buildHandler({ list: [summary({ creditLimit: 1000n })] , resolve: async () => ({
      ...IDENTITY,
      apiKey: { id: 8n, creditLimit: 1000n, spentCredits: 900n },
    }) });
    const res = new FakeRes();
    await h(fakeReq(), res as unknown as ServerResponse);
    const r = res.json<ExternalUsageResponse>();
    const spendable = Number(r.balance.spendable);
    const spent = Number(r.key.spent_credits);
    const limit = r.key.credit_limit === null ? null : Number(r.key.credit_limit);
    const remaining = limit === null ? spendable : Math.min(spendable, Math.max(limit - spent, 0));
    assert.equal(remaining, 100);
    assert.equal(spent, 900);
    assert.equal(limit, 1000);
    assert.equal(r.key.is_valid, true);
  });
});
