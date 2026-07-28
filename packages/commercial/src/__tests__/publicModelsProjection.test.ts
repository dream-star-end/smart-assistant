/**
 * `/api/public/models` 的 **catalog 投影**单测(模型权威批次 · 方案 §6;R1 MAJOR-5)。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/publicModelsProjection.test.ts
 *
 * 契约(改前先改测试):
 *   - 行集 = fenced catalog snapshot 的 active ∧ 可见 ∧ 有价 —— **staged / retired / disabled /
 *     无价行恒不出现**;alias **不作为独立条目**(只做归一,不成行)。
 *   - 价格 = 同一快照里的 pricing join(per-ktok credits);supported_efforts = catalog
 *     capability_profile(**不是** protocol 静态 modelReasoningPolicy)。
 *   - provider 归属 = catalog.provider_id;degraded 按它注解(**不再** findRouteProviderForModel
 *     推断 —— catalog 自定义 provider_id 的行会被 legacy 推断错,把 degraded 标到错误的模型上)。
 *   - catalog 快照 unknown / fence 失败 → 503 MODEL_CATALOG_UNAVAILABLE(fail-closed,
 *     **不**回落 legacy 投影 —— 那等于让第二套判定源在故障窗口复活)。
 *   - catalog 未注入 → legacy PricingCache 投影(装配未接线 / 单测兼容路径)。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { QueryResult } from "pg";
import { SignJWT } from "jose";

import {
  CatalogUnknownError,
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import { PricingCache, type ModelPricing } from "../billing/pricing.js";
import { getDegradedProviders, _resetGateForTest } from "../admin/providerHealthGate.js";
import {
  handleListPublicModels,
  type CommercialHttpDeps,
  type PublicModelProjection,
} from "../http/handlers.js";
import { HttpError } from "../http/util.js";

// ─── fixtures ────────────────────────────────────────────────────────────

function entry(
  over: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, "entryId" | "modelId">,
): ModelCatalogEntry {
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
    displayName: `名字:${modelId}`,
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

/**
 * 关键 fixture:`glm-5.2-x` 的**名字看起来属于 ark**(legacy findRouteProviderForModel 会按
 * 前缀把它推断成 ark),但 catalog 里它的 provider_id = 'deepseek'。degraded 只降级 deepseek 时:
 *   - 按 catalog 归属(正确)→ glm-5.2-x 被标 degraded;
 *   - 按 legacy 推断(错误)→ 它被当成 ark,不标 —— 用户点进去必然失败。
 */
const ACTIVE = entry({ entryId: 1, modelId: "glm-5.2" });
const CUSTOM_PROVIDER = entry({ entryId: 2, modelId: "glm-5.2-x", providerId: "deepseek" });
const CODEX = entry({
  entryId: 3,
  modelId: "gpt-5.6-sol",
  engine: "codex",
  providerId: "codex",
  contextWindow: null,
  capabilityProfile: {
    supportsVision: true,
    reasoning: { supported: ["low", "high"], codexModelDefault: "high" },
    ccb: { capabilityZero: false, supportsThinking: false },
  },
});
const STAGED = entry({ entryId: 4, modelId: "glm-6.0-preview", state: "staged" });
const RETIRED = entry({ entryId: 5, modelId: "glm-4.9", state: "retired" });
const DISABLED = entry({ entryId: 6, modelId: "glm-5.1", state: "disabled" });
/** active 但**无价格行** → 免费旁路,不可路由 → 不进任何投影。 */
const UNPRICED = entry({ entryId: 7, modelId: "glm-free", providerId: "ark" });
/** visibility=admin(仅 admin / grant 可见)。 */
const ADMIN_ONLY = entry({ entryId: 8, modelId: "claude-haiku-4-5", providerId: null });

function snap(epoch = 5n): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({
    entries: [ACTIVE, CUSTOM_PROVIDER, CODEX, STAGED, RETIRED, DISABLED, UNPRICED, ADMIN_ONLY],
    // alias 指向 active 行 —— 投影里**不能**多出一条 'glm-latest'。
    aliases: new Map([
      ["glm-latest", 1],
      ["glm-preview", 4], // 指向 staged 行:同样不得出现
    ]),
    pricing: new Map(
      [
        price("glm-5.2", { sortOrder: 10 }),
        price("glm-5.2-x", { sortOrder: 20 }),
        price("gpt-5.6-sol", { sortOrder: 30, inputPerMtok: 1500n, multiplier: "2.000" }),
        price("glm-6.0-preview", { sortOrder: 40 }),
        price("glm-4.9", { sortOrder: 50 }),
        price("glm-5.1", { sortOrder: 60 }),
        price("claude-haiku-4-5", { sortOrder: 70, visibility: "admin" }),
        // glm-free 故意没有价格行
      ].map((p) => [p.modelId, p]),
    ),
    securityEpoch: epoch,
  });
}

function makeReq(auth?: string): IncomingMessage {
  return { headers: auth ? { authorization: auth } : {}, url: "/api/public/models", method: "GET" } as
    unknown as IncomingMessage;
}

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

function deps(over: Partial<CommercialHttpDeps> = {}): CommercialHttpDeps {
  return {
    jwtSecret: new Uint8Array(32),
    ...over,
  } as unknown as CommercialHttpDeps;
}

function catalogOf(s: ModelCatalogSnapshot) {
  return { async assertFresh() { return s; } };
}

/** provider_ops 读桩:预热 providerHealthGate 的 TTL 缓存,handler 内部那次调用直接命中,不碰 DB。 */
async function primeDegraded(providerIds: string[]): Promise<void> {
  _resetGateForTest();
  await getDegradedProviders(Date.now(), {
    async query() {
      return {
        rows: providerIds.map((provider_id) => ({
          provider_id,
          health_status: "degraded",
          health_mode: "auto",
          degraded_since: new Date(Date.now() - 60_000),
          degrade_reason: "probe",
        })),
        rowCount: providerIds.length,
      } as unknown as QueryResult;
    },
  });
}

async function listAnon(d: CommercialHttpDeps): Promise<PublicModelProjection[]> {
  const res = makeRes();
  await handleListPublicModels(makeReq(), res, {} as never, d);
  assert.equal(res.statusCode, 200);
  return res.body.models as PublicModelProjection[];
}

async function authToken(secret: Uint8Array, sub = "42"): Promise<string> {
  return new SignJWT({ role: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setExpirationTime("15m")
    .sign(secret);
}

beforeEach(async () => {
  await primeDegraded([]);
});

// ─── 行集:staged / retired / disabled / 无价 / alias 恒不出现 ────────────────

describe("/api/public/models — catalog 投影行集", () => {
  test("只出 active ∧ public ∧ 有价的行;staged/retired/disabled/无价/admin 一律不出现", async () => {
    const models = await listAnon(deps({ modelCatalog: catalogOf(snap()) }));
    assert.deepEqual(
      models.map((m) => m.id),
      ["glm-5.2", "glm-5.2-x", "gpt-5.6-sol"],
    );
    const raw = JSON.stringify(models);
    for (const forbidden of ["glm-6.0-preview", "glm-4.9", "glm-5.1", "glm-free", "claude-haiku-4-5"]) {
      assert.doesNotMatch(raw, new RegExp(forbidden), `${forbidden} 不得出现在公共投影`);
    }
  });

  test("alias 不是独立条目(指向 active 的 alias 不多出一行;指向 staged 的 alias 更不会)", async () => {
    const models = await listAnon(deps({ modelCatalog: catalogOf(snap()) }));
    assert.equal(models.filter((m) => m.id === "glm-latest").length, 0);
    assert.equal(models.filter((m) => m.id === "glm-preview").length, 0);
  });

  test("按 sort_order 排序;价格 = 快照 pricing join 的 per-ktok credits(含 multiplier)", async () => {
    const models = await listAnon(deps({ modelCatalog: catalogOf(snap()) }));
    // 600 分/Mtok × 1.000 / 100_000 = 0.006 credits/ktok
    assert.equal(models[0].input_per_ktok_credits, "0.006000");
    assert.equal(models[0].output_per_ktok_credits, "0.024000");
    assert.equal(models[0].display_name, "名字:glm-5.2");
    // 1500 分/Mtok × 2.000 / 100_000 = 0.03 credits/ktok
    const sol = models.find((m) => m.id === "gpt-5.6-sol")!;
    assert.equal(sol.input_per_ktok_credits, "0.030000");
    assert.equal(sol.multiplier, "2.000");
  });

  test("supported_efforts 来自 catalog capability_profile(非 protocol 静态策略)", async () => {
    const models = await listAnon(deps({ modelCatalog: catalogOf(snap()) }));
    assert.deepEqual(models.find((m) => m.id === "glm-5.2")!.supported_efforts, ["high", "max"]);
    assert.deepEqual(models.find((m) => m.id === "gpt-5.6-sol")!.supported_efforts, ["low", "high"]);
  });

  test("登录用户投影使用 epoch-aware authz loader，并应用 account hard denial", async () => {
    const secret = new Uint8Array(32);
    let requiredEpoch: bigint | undefined;
    const token = await authToken(secret);
    const res = makeRes();
    await handleListPublicModels(
      makeReq(`Bearer ${token}`),
      res,
      {} as never,
      deps({
        jwtSecret: secret,
        modelCatalog: catalogOf(snap()),
        loadUserModelAuthz: async (_uid, epoch) => {
          requiredEpoch = epoch;
          return {
            role: "user",
            grantedModelIds: new Set<string>(),
            deniedModelIds: new Set(["glm-5.2"]),
          };
        },
      }),
    );
    assert.equal(requiredEpoch, 5n);
    assert.deepEqual(
      (res.body.models as PublicModelProjection[]).map((model) => model.id),
      ["glm-5.2-x", "gpt-5.6-sol"],
    );
  });
});

// ─── degraded:按 catalog provider_id ────────────────────────────────────────

describe("/api/public/models — degraded 按 catalog provider_id", () => {
  test("catalog 自定义 provider_id 的行按 catalog 归属标 degraded(legacy 前缀推断会标错)", async () => {
    await primeDegraded(["deepseek"]);
    const models = await listAnon(deps({ modelCatalog: catalogOf(snap()) }));
    const byId = new Map(models.map((m) => [m.id, m]));
    // glm-5.2-x 名字像 ark,但 catalog 说它归 deepseek → 必须被标 degraded
    assert.equal(byId.get("glm-5.2-x")!.provider_id, "deepseek");
    assert.equal(byId.get("glm-5.2-x")!.degraded, true);
    // 同名前缀的 glm-5.2 归 ark(健康)→ 不标
    assert.equal(byId.get("glm-5.2")!.provider_id, "ark");
    assert.equal(byId.get("glm-5.2")!.degraded, undefined);
  });

  test("只注解不过滤(UX 红线:降级模型仍在列表里,由前端标「暂不可用」)", async () => {
    await primeDegraded(["ark", "deepseek", "codex"]);
    const models = await listAnon(deps({ modelCatalog: catalogOf(snap()) }));
    assert.equal(models.length, 3);
    assert.ok(models.every((m) => m.degraded === true));
  });
});

// ─── fail-closed:快照 unknown ───────────────────────────────────────────────

describe("/api/public/models — fail-closed", () => {
  test("catalog 快照 unknown → 503 MODEL_CATALOG_UNAVAILABLE(不回落 legacy 投影)", async () => {
    const pricing = new PricingCache();
    pricing._setForTests([legacyRow("glm-5.2")]);
    const d = deps({
      pricing,
      modelCatalog: {
        async assertFresh(): Promise<ModelCatalogSnapshot> {
          throw new CatalogUnknownError();
        },
      },
    });
    await assert.rejects(
      handleListPublicModels(makeReq(), makeRes(), {} as never, d),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 503);
        assert.equal(err.code, "MODEL_CATALOG_UNAVAILABLE");
        return true;
      },
    );
  });
});

// ─── legacy 兼容路径(catalog 未接线)────────────────────────────────────────

function legacyRow(modelId: string, over: Partial<ModelPricing> = {}): ModelPricing {
  return {
    model_id: modelId,
    display_name: modelId,
    input_per_mtok: 600n,
    output_per_mtok: 2400n,
    cache_read_per_mtok: 120n,
    cache_write_per_mtok: 0n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 10,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(),
    ...over,
  };
}

describe("/api/public/models — catalog 未注入 → legacy 投影(兼容)", () => {
  test("走 PricingCache.listPublic;无 provider_id 字段", async () => {
    const pricing = new PricingCache();
    pricing._setForTests([legacyRow("glm-5.2"), legacyRow("glm-5.1", { enabled: false })]);
    const models = await listAnon(deps({ pricing }));
    assert.deepEqual(models.map((m) => m.id), ["glm-5.2"]);
    assert.equal(models[0].provider_id, undefined);
  });

  test("pricing 与 catalog 都没有 → 503 PRICING_NOT_READY", async () => {
    await assert.rejects(
      handleListPublicModels(makeReq(), makeRes(), {} as never, deps()),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.code, "PRICING_NOT_READY");
        return true;
      },
    );
  });
});
