import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";

import {
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import type { IdentityStrategy } from "../auth/proxyIdentity.js";
import {
  LOCAL_CATALOG_HEADER,
  encodeLocalCatalogToken,
} from "../http/proxy/modelAuthorityGate.js";
import {
  makeAnthropicProxyHandler,
  type AnthropicProxyDeps,
} from "../http/anthropicProxy.js";
import { createLogger } from "../logging/logger.js";

const UID = 7n;
const CONTAINER_ID = 42n;
const MODEL = "deepseek-v4-pro";

const LEGACY_PRICING: ModelPricing = {
  model_id: MODEL,
  display_name: "DeepSeek V4 Pro",
  input_per_mtok: 300n,
  output_per_mtok: 1_500n,
  cache_read_per_mtok: 30n,
  cache_write_per_mtok: 375n,
  multiplier: "2.000",
  enabled: true,
  sort_order: 100,
  visibility: "public",
  extra_system_prompt: null,
  default_effort: null,
  updated_at: new Date("2026-07-01T00:00:00Z"),
};

function snapshot(): ModelCatalogSnapshot {
  const entry: ModelCatalogEntry = {
    entryId: 1,
    modelId: MODEL,
    engine: "ccb",
    providerId: "deepseek",
    upstreamModelId: null,
    contextWindow: 128_000,
    capabilityProfile: {
      supportsVision: false,
      reasoning: { supported: [], codexModelDefault: null },
      ccb: { capabilityZero: true, supportsThinking: true },
    },
    capabilitySchemaVersion: 1,
    state: "active",
    lockVersion: 0,
  };
  const pricing: ModelCatalogPricing = {
    modelId: MODEL,
    displayName: LEGACY_PRICING.display_name,
    inputPerMtok: LEGACY_PRICING.input_per_mtok,
    outputPerMtok: LEGACY_PRICING.output_per_mtok,
    cacheReadPerMtok: LEGACY_PRICING.cache_read_per_mtok,
    cacheWritePerMtok: LEGACY_PRICING.cache_write_per_mtok,
    multiplier: LEGACY_PRICING.multiplier,
    visibility: "public",
    sortOrder: 100,
    defaultEffort: null,
  };
  return new ModelCatalogSnapshot({
    entries: [entry],
    aliases: new Map(),
    pricing: new Map([[MODEL, pricing]]),
    securityEpoch: 7n,
  });
}

class MockReq extends Readable {
  url = "/v1/messages";
  method = "POST";
  headers: Record<string, string>;

  constructor(extraHeaders: Record<string, string> = {}) {
    super();
    this.headers = {
      host: "test.invalid",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...extraHeaders,
    };
    this.push(Buffer.from(JSON.stringify({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })));
    this.push(null);
  }
}

class MockRes {
  statusCode = 0;
  headersSent = false;
  chunks: Buffer[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  setHeader(): void {}
  writeHead(status: number): void {
    this.statusCode = status;
    this.headersSent = true;
  }
  write(chunk: string | Buffer): boolean {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return true;
  }
  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.write(chunk);
    this.emit("close");
  }
  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }
  once(event: string, cb: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => {
      this.off(event, wrapped);
      cb(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter((candidate) => candidate !== cb));
    return this;
  }
  emit(event: string): void {
    for (const cb of this.listeners.get(event)?.slice() ?? []) cb();
  }
  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function buildHandler(enforce: boolean) {
  const catalogSnapshot = snapshot();
  let fenceCalls = 0;
  let authorizeCalls = 0;
  const catalog = {
    async assertFresh() {
      fenceCalls += 1;
      return catalogSnapshot;
    },
    peek() {
      return catalogSnapshot;
    },
  } as unknown as NonNullable<AnthropicProxyDeps["modelCatalog"]>;
  const identity: IdentityStrategy = {
    async resolve() {
      return { uid: UID, containerId: CONTAINER_ID };
    },
    async authorize() {
      authorizeCalls += 1;
    },
  };
  const pricing = { get: (model: string) => model === MODEL ? LEGACY_PRICING : null } as PricingCache;
  const deps: AnthropicProxyDeps = {
    pgPool: {} as Pool,
    pricing,
    preCheckRedis: {
      async atomicReserve() { throw new Error("preCheck must not run"); },
      async releaseReservation() { return true; },
    },
    scheduler: {} as AnthropicProxyDeps["scheduler"],
    identity,
    loadUserModelAuthz: async () => ({ role: "user", grantedModelIds: new Set() }),
    rateLimitRedis: {
      async incr() { return 1; },
      async expire() { return 1; },
    },
    modelCatalog: catalog,
    modelAuthorityEnforce: enforce,
    // 故意不配 deepseek key：授权步骤之后、preCheck 之前稳定返回 503，测试不需接计费/上游桩。
    staticProviderKeys: {},
    logger: createLogger({ level: "error", out: () => undefined }),
  };
  return {
    handler: makeAnthropicProxyHandler(deps),
    catalogSnapshot,
    getFenceCalls: () => fenceCalls,
    getAuthorizeCalls: () => authorizeCalls,
  };
}

async function run(
  built: ReturnType<typeof buildHandler>,
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const req = new MockReq(headers);
  const res = new MockRes();
  await built.handler(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    { hostUuid: "self", boundIp: "172.30.0.10" },
  );
  return res;
}

describe("anthropic proxy model authority authz ownership", () => {
  test("enforced fenced gate is sole authz decision; legacy strategy is not called", async () => {
    const built = buildHandler(true);
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: built.catalogSnapshot.projectionRevisionFor({
        uid: UID.toString(),
        role: "user",
        grantedModelIds: new Set(),
      }),
      securityEpoch: built.catalogSnapshot.securityEpoch.toString(),
    });
    const res = await run(built, { [LOCAL_CATALOG_HEADER]: token });
    assert.equal(res.statusCode, 503, res.bodyText());
    assert.equal(built.getFenceCalls(), 1);
    assert.equal(built.getAuthorizeCalls(), 0);
  });

  test("shadow mode keeps the legacy strategy authorize path", async () => {
    const built = buildHandler(false);
    const res = await run(built);
    assert.equal(res.statusCode, 503, res.bodyText());
    assert.equal(built.getFenceCalls(), 0);
    assert.equal(built.getAuthorizeCalls(), 1);
  });
});
