/**
 * 模型权威批次 · 切片 5 —— per-uid catalog 下发端点(http/internalModelCatalog.ts)。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/internalModelCatalog.test.ts
 *
 * 覆盖(方案 §6 + §8):
 *   - per-uid 严格过滤:hidden/admin 模型无 grant **不下发**;有 grant 才出现
 *   - 全局 executionRevision **不下发**(只给 per-uid projectionRevision)
 *   - seed 模型不"强塞"进无授权用户的投影(R2-M8),端点也不因此 500
 *   - 窄 epoch 端点:body { epoch } + X-OpenClaude-Security-Epoch 响应头
 *   - 快照 unknown / authz 读失败 → 503(fail-closed,绝不按 public 兜底)
 *   - 非 GET / 无 bearer → 405 / 401
 *   - **两条 path 不在 browser→container 代理 allowlist**(gateway 侧 + commercial 侧双断言)
 *   - assertSeedModelsActive:seed 模型缺失/未 active → 抛(启动断言 + deploy 门)
 */

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import { matchBridgeApiAllowlist, matchCommercialContainerApiProxy } from "@openclaude/gateway";

import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import type { UserModelAuthz } from "../auth/userModelAuthz.js";
import {
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import {
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
  PLATFORM_SEED_MODEL_IDS,
  SECURITY_EPOCH_HEADER,
  assertSeedModelsActive,
  makeModelCatalogHandler,
  type WireCatalogResponse,
} from "../http/internalModelCatalog.js";

const SECRET = "a".repeat(64);
const TOKEN = `oc-v3.7.${SECRET}`;
const CTX = { hostUuid: "host-1", boundIp: "172.31.0.7" };

function repoFor(userId = 42): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null;
      return {
        id: 7,
        user_id: userId,
        bound_ip: boundIp,
        host_uuid: hostUuid,
        secret_hash: hashSecret(SECRET),
      };
    },
  };
}

function entry(over: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, "entryId" | "modelId">): ModelCatalogEntry {
  return {
    engine: "ccb",
    providerId: "ark",
    upstreamModelId: null,
    contextWindow: 1_000_000,
    capabilityProfile: {
      supportsVision: false,
      reasoning: { supported: ["high", "max"], codexModelDefault: null },
      ccb: { capabilityZero: true, supportsThinking: true },
    },
    capabilitySchemaVersion: 1,
    state: "active",
    lockVersion: 0,
    ...over,
  };
}

function price(modelId: string, over: Partial<ModelCatalogPricing> = {}): ModelCatalogPricing {
  return {
    modelId,
    displayName: modelId,
    inputPerMtok: 600n,
    outputPerMtok: 2400n,
    cacheReadPerMtok: 120n,
    cacheWritePerMtok: 0n,
    multiplier: "1.000",
    visibility: "public",
    sortOrder: 100,
    defaultEffort: null,
    ...over,
  };
}

/** 公开 glm-5.2 / 隐藏 secret-model(仅 grant 可见)/ admin 可见 admin-model。 */
function snapshot(epoch = 5n): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({
    entries: [
      entry({ entryId: 1, modelId: "glm-5.2" }),
      entry({ entryId: 2, modelId: "secret-model", upstreamModelId: "vendor-x-1" }),
      entry({ entryId: 3, modelId: "admin-model" }),
    ],
    aliases: new Map([
      ["glm-latest", 1],
      ["secret-latest", 2],
    ]),
    pricing: new Map(
      [
        price("glm-5.2", { defaultEffort: "high" }),
        price("secret-model", { visibility: "hidden" }),
        price("admin-model", { visibility: "admin" }),
      ].map((p) => [p.modelId, p]),
    ),
    securityEpoch: epoch,
  });
}

function makeReq(opts: { method?: string; auth?: string; url?: string }): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = opts.method ?? "GET";
  req.url = opts.url ?? MODEL_CATALOG_PATH;
  req.headers = {};
  if (opts.auth) req.headers.authorization = opts.auth;
  return req;
}

// biome-ignore lint/suspicious/noExplicitAny: 测试 res 桩
function makeRes(): ServerResponse & { body: any; headers: Record<string, any> } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    setHeader(k: string, v: string | number) {
      this.headers[k.toLowerCase()] = v;
    },
    end(s?: string) {
      // biome-ignore lint/suspicious/noExplicitAny: 测试 res 桩
      (this as any).body = s ? JSON.parse(s) : {};
    },
    // biome-ignore lint/suspicious/noExplicitAny: 测试 res 桩
  } as any;
  return res;
}

function handler(args: {
  snapshot?: ModelCatalogSnapshot;
  authz?: UserModelAuthz;
  assertFreshFails?: boolean;
  authzFails?: boolean;
  readEpoch?: () => Promise<bigint>;
}) {
  const snap = args.snapshot ?? snapshot();
  return makeModelCatalogHandler({
    identityRepo: repoFor(),
    catalog: {
      async assertFresh() {
        if (args.assertFreshFails) throw new Error("db down");
        return snap;
      },
    },
    async loadUserModelAuthz() {
      if (args.authzFails) throw new Error("authz db down");
      return args.authz ?? { role: "user", grantedModelIds: new Set<string>() };
    },
    readEpoch: args.readEpoch ?? (async () => snap.securityEpoch),
  });
}

describe("internalModelCatalog — per-uid 投影下发", () => {
  test("普通用户无 grant:只见 public;hidden/admin 模型不下发", async () => {
    const h = handler({});
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}` }), res, CTX);
    assert.equal(res.statusCode, 200);
    const body = res.body as WireCatalogResponse;
    assert.deepEqual(
      body.models.map((m) => m.model_id),
      ["glm-5.2"],
    );
    // 不下发 upstream_model_id / execution_revision(平台内部事实,容器无需也不该知道)
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /vendor-x-1/);
    assert.doesNotMatch(raw, /execution_revision/);
    assert.ok(body.projection_revision.length > 0);
    assert.equal(body.security_epoch, "5");
    assert.equal(res.headers[SECURITY_EPOCH_HEADER], "5");
    assert.deepEqual(body.aliases, { "glm-latest": "glm-5.2" });
  });

  test("有 grant 的 hidden 模型 → 出现在该 uid 的投影里(且带执行语义字段)", async () => {
    const h = handler({
      authz: { role: "user", grantedModelIds: new Set(["secret-model"]) },
    });
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}` }), res, CTX);
    const body = res.body as WireCatalogResponse;
    assert.deepEqual(
      body.models.map((m) => m.model_id).sort(),
      ["glm-5.2", "secret-model"],
    );
    const glm = body.models.find((m) => m.model_id === "glm-5.2")!;
    assert.equal(glm.engine, "ccb");
    assert.equal(glm.provider_id, "ark");
    assert.equal(glm.default_effort, "high");
    assert.deepEqual([...glm.supported_efforts], ["high", "max"]);
    assert.equal(glm.supports_vision, false);
    assert.deepEqual(body.aliases, {
      "glm-latest": "glm-5.2",
      "secret-latest": "secret-model",
    });
  });

  test("admin 角色 → 见 admin 可见模型(与 canUseModel 同源规则)", async () => {
    const h = handler({ authz: { role: "admin", grantedModelIds: new Set<string>() } });
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}` }), res, CTX);
    const body = res.body as WireCatalogResponse;
    assert.ok(body.models.some((m) => m.model_id === "admin-model"));
    // hidden 仍需显式 grant,admin 角色不自动获得
    assert.ok(!body.models.some((m) => m.model_id === "secret-model"));
  });

  test("projectionRevision 随 uid 的可见集变化(换 grant → 换 revision)", async () => {
    const res1 = makeRes();
    await handler({})(makeReq({ auth: `Bearer ${TOKEN}` }), res1, CTX);
    const res2 = makeRes();
    await handler({ authz: { role: "user", grantedModelIds: new Set(["secret-model"]) } })(
      makeReq({ auth: `Bearer ${TOKEN}` }),
      res2,
      CTX,
    );
    assert.notEqual(
      (res1.body as WireCatalogResponse).projection_revision,
      (res2.body as WireCatalogResponse).projection_revision,
    );
  });

  test("seed 模型未授权给该 uid → **不强塞、不 500**,只是不出现(R2-M8)", async () => {
    // seed 模型建成 hidden(仅 grant 可见)且该用户没有 grant。
    const snap = new ModelCatalogSnapshot({
      entries: [entry({ entryId: 1, modelId: "glm-5.2" })],
      aliases: new Map(),
      pricing: new Map([["glm-5.2", price("glm-5.2", { visibility: "hidden" })]]),
      securityEpoch: 5n,
    });
    const res = makeRes();
    await handler({ snapshot: snap })(makeReq({ auth: `Bearer ${TOKEN}` }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as WireCatalogResponse).models, []);
  });
});

describe("internalModelCatalog — epoch 窄端点", () => {
  test("GET /model-catalog-epoch → { epoch } + 响应头(直接读 DB 单行,不读进程快照)", async () => {
    const h = handler({ readEpoch: async () => 9n });
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, url: MODEL_CATALOG_EPOCH_PATH }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { epoch: "9" });
    assert.equal(res.headers[SECURITY_EPOCH_HEADER], "9");
  });

  test("epoch 读失败 → 503(容器据此拒本地路径新 turn)", async () => {
    const h = handler({
      readEpoch: async () => {
        throw new Error("db down");
      },
    });
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, url: MODEL_CATALOG_EPOCH_PATH }), res, CTX);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error.code, "MODEL_CATALOG_UNAVAILABLE");
  });
});

describe("internalModelCatalog — fail-closed 与鉴权", () => {
  test("快照 unknown / DB 不可达 → 503(不返回陈旧投影)", async () => {
    const res = makeRes();
    await handler({ assertFreshFails: true })(makeReq({ auth: `Bearer ${TOKEN}` }), res, CTX);
    assert.equal(res.statusCode, 503);
  });

  test("authz 读失败 → 503(**不**按 public 兜底 —— 那会让撤 grant 延后生效)", async () => {
    const res = makeRes();
    await handler({ authzFails: true })(makeReq({ auth: `Bearer ${TOKEN}` }), res, CTX);
    assert.equal(res.statusCode, 503);
  });

  test("无 bearer → 401;非 GET → 405", async () => {
    const res1 = makeRes();
    await handler({})(makeReq({}), res1, CTX);
    assert.equal(res1.statusCode, 401);

    const res2 = makeRes();
    await handler({})(makeReq({ method: "POST", auth: `Bearer ${TOKEN}` }), res2, CTX);
    assert.equal(res2.statusCode, 405);
  });
});

describe("internalModelCatalog — 不进 browser→container 代理 allowlist", () => {
  test("两条 path 在 bridge allowlist / commercial 容器代理里都不可命中(双侧断言)", () => {
    for (const path of [MODEL_CATALOG_PATH, MODEL_CATALOG_EPOCH_PATH]) {
      for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD"]) {
        assert.equal(
          matchBridgeApiAllowlist(path, method),
          null,
          `${method} ${path} 不得进 bridge allowlist`,
        );
        assert.equal(
          matchCommercialContainerApiProxy(path, method),
          null,
          `${method} ${path} 不得进 browser→container 代理`,
        );
      }
    }
  });
});

describe("internalModelCatalog — seed 完整性(全局断言)", () => {
  test("seed 模型全部 active → 通过", () => {
    const entries = PLATFORM_SEED_MODEL_IDS.map((id, i) =>
      entry({ entryId: i + 1, modelId: id }),
    );
    const snap = new ModelCatalogSnapshot({
      entries,
      aliases: new Map(),
      pricing: new Map(entries.map((e) => [e.modelId, price(e.modelId)])),
      securityEpoch: 1n,
    });
    assert.doesNotThrow(() => assertSeedModelsActive(snap));
  });

  test("某个 seed 模型缺失 / 非 active → 抛(启动断言 + deploy 门)", () => {
    const entries = PLATFORM_SEED_MODEL_IDS.slice(1).map((id, i) =>
      entry({ entryId: i + 1, modelId: id }),
    );
    const snap = new ModelCatalogSnapshot({
      entries,
      aliases: new Map(),
      pricing: new Map(entries.map((e) => [e.modelId, price(e.modelId)])),
      securityEpoch: 1n,
    });
    assert.throws(() => assertSeedModelsActive(snap), /seed models missing/);
  });

  test("seed 清单从既有权威派生(平台默认 + 隐藏审查员 + codex 队长 + 预设 agent)", () => {
    assert.ok(PLATFORM_SEED_MODEL_IDS.includes("glm-5.2"));
    assert.ok(PLATFORM_SEED_MODEL_IDS.length >= 4);
    // 去重
    assert.equal(new Set(PLATFORM_SEED_MODEL_IDS).size, PLATFORM_SEED_MODEL_IDS.length);
  });
});
