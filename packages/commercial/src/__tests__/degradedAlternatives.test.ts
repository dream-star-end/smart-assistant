/**
 * provider 降级时的"建议改用"清单(模型权威批次 · R1 MINOR-4)。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/degradedAlternatives.test.ts
 *
 * 契约:gate 生效时归属**只认 catalog 的 provider_id**。legacy 的 findRouteProviderForModel
 * 是名字前缀推断 —— catalog 自定义 provider_id 的行会被推断错,导致"建议改用"里塞回**同一个
 * 已降级 provider** 的模型(把刚被 503 的用户指回同一个坑)。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import { PricingCache, type ModelPricing } from "../billing/pricing.js";
import { degradedAlternatives } from "../http/proxy/index.js";
import type { ModelAuthorityDecision } from "../http/proxy/modelAuthorityGate.js";

const UID = 42n;

function entry(
  entryId: number,
  modelId: string,
  providerId: string | null,
  over: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry {
  return {
    entryId,
    modelId,
    engine: "ccb",
    providerId,
    upstreamModelId: null,
    contextWindow: 1_000_000,
    capabilityProfile: {
      supportsVision: false,
      reasoning: { supported: ["high"], codexModelDefault: null },
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
    inputPerMtok: 100n,
    outputPerMtok: 100n,
    cacheReadPerMtok: 0n,
    cacheWritePerMtok: 0n,
    multiplier: "1.000",
    visibility: "public",
    sortOrder: 1,
    defaultEffort: null,
    ...over,
  };
}

/**
 * `glm-5.2-x` 的**名字**会被 legacy 前缀推断归到 ark,但 catalog 说它归 deepseek。
 * `deepseek-v4-pro` 反之:名字像 deepseek,catalog 说它归 ark。
 */
function snap(): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({
    entries: [
      entry(1, "glm-5.2", "ark"),
      entry(2, "glm-5.2-x", "deepseek"),
      entry(3, "deepseek-v4-pro", "ark"),
      entry(4, "claude-haiku-4-5", null), // admin 可见 → 不该出现在建议里
      entry(5, "glm-5.1", "ark", { state: "disabled" }), // 非 active → 不该出现
    ],
    aliases: new Map([["glm-latest", 1]]),
    pricing: new Map(
      [
        price("glm-5.2", { sortOrder: 10 }),
        price("glm-5.2-x", { sortOrder: 20 }),
        price("deepseek-v4-pro", { sortOrder: 30 }),
        price("claude-haiku-4-5", { sortOrder: 40, visibility: "admin" }),
        price("glm-5.1", { sortOrder: 50 }),
      ].map((p) => [p.modelId, p]),
    ),
    securityEpoch: 5n,
  });
}

function gateWith(s: ModelCatalogSnapshot): ModelAuthorityDecision {
  return {
    snapshot: s,
    canonicalModel: "glm-5.2-x",
    descriptor: s.resolve("glm-5.2-x")!,
    authorityKind: "local_catalog",
    executionRevision: s.executionRevision,
    projectionRevision: "x",
    claimedProjectionRevision: null,
    securityEpoch: s.securityEpoch,
    authorityTurnId: null,
    turnLeaseIssuedAtMs: null,
    turnLeaseVerifiedAtMs: null,
  };
}

function legacyPricing(): PricingCache {
  const rows: ModelPricing[] = [
    "glm-5.2",
    "glm-5.2-x",
    "deepseek-v4-pro",
  ].map((model_id, i) => ({
    model_id,
    display_name: model_id,
    input_per_mtok: 100n,
    output_per_mtok: 100n,
    cache_read_per_mtok: 0n,
    cache_write_per_mtok: 0n,
    multiplier: "1.000",
    enabled: true,
    sort_order: (i + 1) * 10,
    visibility: "public" as const,
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(0),
  }));
  const p = new PricingCache();
  p._setForTests(rows);
  return p;
}

describe("degradedAlternatives — gate 生效:归属按 catalog provider_id", () => {
  test("deepseek 降级 → 建议里剔掉 catalog 归 deepseek 的行(哪怕名字像 ark)", () => {
    const s = snap();
    const alts = degradedAlternatives({
      gate: gateWith(s),
      pricing: legacyPricing(),
      uid: UID,
      degraded: new Set(["deepseek"]),
    });
    // glm-5.2-x 的 catalog provider = deepseek → 必须被剔掉
    assert.ok(!alts.includes("glm-5.2-x"));
    // deepseek-v4-pro 的 catalog provider = ark(健康)→ 必须保留(legacy 推断会误剔)
    assert.ok(alts.includes("deepseek-v4-pro"));
    assert.deepEqual(alts, ["glm-5.2", "deepseek-v4-pro"]);
  });

  test("ark 降级 → 剔掉 catalog 归 ark 的行(deepseek-v4-pro 虽名字像 deepseek 也要剔)", () => {
    const s = snap();
    const alts = degradedAlternatives({
      gate: gateWith(s),
      pricing: legacyPricing(),
      uid: UID,
      degraded: new Set(["ark"]),
    });
    assert.deepEqual(alts, ["glm-5.2-x"]);
  });

  test("只建议 public 可见 + active 的行(admin 模型 / disabled 行不出现)", () => {
    const s = snap();
    const alts = degradedAlternatives({
      gate: gateWith(s),
      pricing: legacyPricing(),
      uid: UID,
      degraded: new Set<string>(),
    });
    assert.deepEqual(alts, ["glm-5.2", "glm-5.2-x", "deepseek-v4-pro"]);
    assert.ok(!alts.includes("claude-haiku-4-5"));
    assert.ok(!alts.includes("glm-5.1"));
  });
});

describe("degradedAlternatives — gate 未生效(legacy):保持既有行为", () => {
  test("走 PricingCache.listPublic + route registry 推断", () => {
    const alts = degradedAlternatives({
      gate: null,
      pricing: legacyPricing(),
      uid: UID,
      degraded: new Set<string>(),
    });
    assert.deepEqual(alts, ["glm-5.2", "glm-5.2-x", "deepseek-v4-pro"]);
  });
});
