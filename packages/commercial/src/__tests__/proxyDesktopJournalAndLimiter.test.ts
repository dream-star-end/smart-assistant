import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { IdentityStrategy } from "../auth/proxyIdentity.js";
import type { PricingCache } from "../billing/pricing.js";
import {
  buildProxyJournalCtxJson,
  ConcurrencyLimiter,
  FallbackRateLimiter,
  makeAnthropicProxyHandler,
  type AnthropicProxyDeps,
} from "../http/anthropicProxy.js";
import { createLogger } from "../logging/logger.js";

class MockReq extends Readable {
  method = "POST";
  url = "/v1/messages";
  headers: Record<string, string>;
  constructor(headers: Record<string, string> = {}) {
    super();
    this.headers = { "content-type": "application/json", ...headers };
    this.push(JSON.stringify({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }));
    this.push(null);
  }
}

class MockRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  setHeader(k: string, v: string) { this.headers[k] = v; }
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
  }
  end(chunk?: string) { this.body += chunk ?? ""; }
}

describe("proxy desktop journal ctx + shared limiter", () => {
  test("enforce=false still writes runtimeKind for desktop; docker stays undefined", () => {
    assert.equal(buildProxyJournalCtxJson({ gate: null }), undefined);
    assert.deepEqual(
      buildProxyJournalCtxJson({ gate: null, runtimeKind: "desktop" }),
      { source: "ccb_proxy", runtimeKind: "desktop" },
    );
    assert.equal(
      buildProxyJournalCtxJson({ gate: null, runtimeKind: undefined }),
      undefined,
    );
  });

  test("shared ConcurrencyLimiter is honored by both handler instances", async () => {
    const concurrency = new ConcurrencyLimiter(1);
    const fallback = new FallbackRateLimiter(60, 10);
    const held = concurrency.acquire("uid:7");
    assert.ok(held);
    const identity: IdentityStrategy = {
      async resolve() { return { uid: 7n, containerId: 1n }; },
      async authorize() {},
    };
    const deps: AnthropicProxyDeps = {
      pgPool: {} as Pool,
      pricing: { get: () => null } as unknown as PricingCache,
      preCheckRedis: { async atomicReserve() { throw new Error("no"); }, async releaseReservation() { return true; } },
      scheduler: {} as AnthropicProxyDeps["scheduler"],
      identity,
      loadUserModelAuthz: async () => ({ role: "user", grantedModelIds: new Set() }),
      rateLimitRedis: { async incr() { return 1; }, async expire() { return 1; } },
      concurrencyLimiter: concurrency,
      fallbackLimiter: fallback,
      logger: createLogger({ level: "error", out: () => undefined }),
    };
    const docker = makeAnthropicProxyHandler(deps);
    const desktop = makeAnthropicProxyHandler({ ...deps, runtimeKind: "desktop" });
    const res1 = new MockRes();
    await docker(
      new MockReq() as unknown as IncomingMessage,
      res1 as unknown as ServerResponse,
      { hostUuid: "self", boundIp: "1.1.1.1" },
    );
    assert.equal(res1.statusCode, 429);
    assert.match(res1.body, /CONCURRENT_LIMIT/);
    const res2 = new MockRes();
    await desktop(
      new MockReq() as unknown as IncomingMessage,
      res2 as unknown as ServerResponse,
      { hostUuid: "self", boundIp: "1.1.1.1" },
    );
    assert.equal(res2.statusCode, 429);
    held!();
  });
});
