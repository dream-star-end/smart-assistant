import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import {
  DEFAULT_SECONDARY_UTILITY_MODEL,
  _buildSecondaryUtilityModelEnv,
} from "@openclaude/gateway";
import {
  CAPABILITY_SCHEMA_VERSION,
  CatalogUnknownError,
  EpochStaleError,
  ModelCatalogCache,
  ModelCatalogSnapshot,
  PLATFORM_AUX_MODEL_IDS,
  PlatformAuxModelUnavailableError,
  UnknownCapabilitySchemaError,
  assertEpochFresh,
  canonicalJson,
  parseCapabilityProfile,
  platformAuxModels,
  shortRevision,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";

/**
 * 模型权威批次 · 切片 1 — modelCatalog 纯函数单测(不碰 DB)。
 * DB 侧(迁移/回填/状态机 trigger/兼容地板)在 modelCatalogDb.integ.test.ts。
 */

// ─── fixtures ────────────────────────────────────────────────────────────

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

function snap(args: {
  entries: ModelCatalogEntry[];
  aliases?: Array<[string, number]>;
  pricing?: ModelCatalogPricing[];
  epoch?: bigint;
}): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({
    entries: args.entries,
    aliases: new Map(args.aliases ?? []),
    pricing: new Map((args.pricing ?? args.entries.map((e) => price(e.modelId))).map((p) => [p.modelId, p])),
    securityEpoch: args.epoch ?? 1n,
  });
}

const GLM = entry({ entryId: 1, modelId: "glm-5.2" });
const SOL = entry({
  entryId: 2,
  modelId: "gpt-5.6-sol",
  engine: "codex",
  providerId: "codex",
  contextWindow: null,
  capabilityProfile: {
    supportsVision: false,
    reasoning: { supported: ["low", "medium", "high", "xhigh", "max"], codexModelDefault: "xhigh" },
    ccb: { capabilityZero: false, supportsThinking: false },
  },
});
const GROK = entry({
  entryId: 3,
  modelId: "grok-build",
  engine: "grok",
  providerId: "grok",
  upstreamModelId: "grok-build",
  contextWindow: 500_000,
  capabilityProfile: {
    supportsVision: false,
    reasoning: { supported: ["low", "medium", "high"], codexModelDefault: null },
    ccb: { capabilityZero: false, supportsThinking: false },
  },
});

// ─── canonicalJson ───────────────────────────────────────────────────────

describe("canonicalJson", () => {
  test("键序无关:两个书写顺序不同的等价对象产出同一字节串", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [3, 2], c: null } }),
      canonicalJson({ a: { c: null, d: [3, 2] }, b: 1 }),
    );
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  test("数组保序(顺序是语义的一部分)", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  test("undefined 丢弃、bigint 转字符串、非有限数拒绝", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
    assert.equal(canonicalJson({ a: 10n }), '{"a":"10"}');
    assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
  });
});

// ─── executionRevision ───────────────────────────────────────────────────

describe("executionRevision", () => {
  test("稳定:同一内容重复构造 → 同一 revision(全长 sha256,短形 12hex)", () => {
    const a = snap({ entries: [GLM, SOL] });
    const b = snap({ entries: [SOL, GLM] }); // 行序不同
    assert.equal(a.executionRevision, b.executionRevision);
    assert.match(a.executionRevision, /^[0-9a-f]{64}$/);
    assert.equal(shortRevision(a.executionRevision), a.executionRevision.slice(0, 12));
    assert.equal(shortRevision(a.executionRevision).length, 12);
  });

  test("R4-m5:staged / retired 历史行不进 revision(编辑未激活版本不抖动全局)", () => {
    const base = snap({ entries: [GLM] });
    const withStaged = snap({
      entries: [
        GLM,
        entry({ entryId: 9, modelId: "glm-5.3", state: "staged", contextWindow: 42 }),
        entry({ entryId: 10, modelId: "glm-5.0", state: "retired" }),
        entry({ entryId: 11, modelId: "glm-4.9", state: "disabled" }),
      ],
    });
    assert.equal(withStaged.executionRevision, base.executionRevision);
  });

  test("R4-m5:排除 entry_id / lock_version / 审计列", () => {
    const a = snap({ entries: [GLM] });
    const b = snap({ entries: [entry({ ...GLM, entryId: 777, lockVersion: 42 })] });
    assert.equal(a.executionRevision, b.executionRevision);
  });

  test("execution 字段任一变化 → revision 变(含 capability 放宽与 context 变化)", () => {
    const base = snap({ entries: [GLM] });
    const widened = snap({
      entries: [
        entry({
          ...GLM,
          capabilityProfile: {
            supportsVision: false,
            reasoning: { supported: ["low", "medium", "high", "max"], codexModelDefault: null },
            ccb: { capabilityZero: true, supportsThinking: true },
          },
        }),
      ],
    });
    const rewindowed = snap({ entries: [entry({ ...GLM, contextWindow: 200_000 })] });
    const reprovidered = snap({ entries: [entry({ ...GLM, providerId: "deepseek" })] });
    const upstreamed = snap({ entries: [entry({ ...GLM, upstreamModelId: "glm-5.2-0712" })] });
    for (const s of [widened, rewindowed, reprovidered, upstreamed]) {
      assert.notEqual(s.executionRevision, base.executionRevision);
    }
  });

  test("default_effort 是 execution descriptor 的一部分 → 进 revision;价格不进", () => {
    const base = snap({ entries: [GLM] });
    const effort = snap({ entries: [GLM], pricing: [price("glm-5.2", { defaultEffort: "max" })] });
    const pricier = snap({ entries: [GLM], pricing: [price("glm-5.2", { inputPerMtok: 99_999n })] });
    assert.notEqual(effort.executionRevision, base.executionRevision);
    assert.equal(pricier.executionRevision, base.executionRevision);
    assert.notEqual(pricier.billingRevision, base.billingRevision);
  });

  test("指向 active 行的 alias 进 revision;指向非 active 行的不进", () => {
    const base = snap({ entries: [GLM] });
    const aliased = snap({ entries: [GLM], aliases: [["glm-latest", 1]] });
    assert.notEqual(aliased.executionRevision, base.executionRevision);

    const staged = entry({ entryId: 5, modelId: "glm-5.3", state: "staged" });
    const aliasToStaged = snap({ entries: [GLM, staged], aliases: [["glm-next", 5]] });
    assert.equal(aliasToStaged.executionRevision, base.executionRevision);
  });
});

// ─── 视图 API ────────────────────────────────────────────────────────────

describe("视图 API", () => {
  test("isCodexModel / resolve / isRoutable", () => {
    const s = snap({ entries: [GLM, SOL] });
    assert.equal(s.isCodexModel("gpt-5.6-sol"), true);
    assert.equal(s.isCodexModel("glm-5.2"), false);
    assert.equal(s.isCodexModel("nope"), false);

    const d = s.resolve("gpt-5.6-sol");
    assert.ok(d);
    assert.equal(d.engine, "codex");
    assert.equal(d.upstreamModelId, "gpt-5.6-sol"); // null → 回落 canonical
    assert.equal(d.capabilityProfile.reasoning.codexModelDefault, "xhigh");
    assert.equal(s.resolve("unknown-model"), null);
    assert.equal(s.isRoutable("glm-5.2"), true);
    assert.equal(s.isRoutable("unknown-model"), false);
  });

  test("upstream_model_id 非空 → descriptor 用它", () => {
    const s = snap({ entries: [entry({ ...GLM, upstreamModelId: "glm-5.2-0712" })] });
    assert.equal(s.resolve("glm-5.2")?.upstreamModelId, "glm-5.2-0712");
  });

  test("account hard denial overrides public visibility/grants and only removes that model", () => {
    const s = snap({ entries: [GLM, SOL] });
    const scope = {
      uid: 1,
      role: "admin" as const,
      grantedModelIds: new Set(["glm-5.2"]),
      deniedModelIds: new Set(["glm-5.2"]),
    };
    assert.equal(s.canUseModel(scope, "glm-5.2"), false);
    assert.equal(s.canUseModel(scope, "gpt-5.6-sol"), true);
    assert.deepEqual(s.listForUser(scope).map((row) => row.modelId), ["gpt-5.6-sol"]);
  });

  test("active 但无价格行 → 不可路由(可用性与可计费不允许分裂)", () => {
    const s = new ModelCatalogSnapshot({
      entries: [GLM],
      aliases: new Map(),
      pricing: new Map(),
      securityEpoch: 1n,
    });
    assert.equal(s.isRoutable("glm-5.2"), false);
    assert.equal(s.resolve("glm-5.2"), null);
    assert.deepEqual(s.listForUser({ uid: 1, role: "admin", grantedModelIds: new Set() }), []);
  });

  test("disabled / staged / retired 行不可路由", () => {
    for (const state of ["disabled", "staged", "retired"] as const) {
      const s = snap({ entries: [entry({ ...GLM, state })] });
      assert.equal(s.isRoutable("glm-5.2"), false, state);
      assert.equal(s.resolve("glm-5.2"), null, state);
    }
  });

  test("capability schema 未来版本 → 不可路由 + resolve 抛(fail-closed,R2-m15)", () => {
    const future = entry({ ...GLM, capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION + 1 });
    const s = snap({ entries: [future] });
    assert.equal(s.isRoutable("glm-5.2"), false);
    assert.throws(() => s.resolve("glm-5.2"), UnknownCapabilitySchemaError);
  });

  test("aliasToCanonical:命中 → canonical;未命中 → 原样", () => {
    const s = snap({ entries: [GLM], aliases: [["glm-latest", 1]] });
    assert.equal(s.aliasToCanonical("glm-latest"), "glm-5.2");
    assert.equal(s.aliasToCanonical("glm-5.2"), "glm-5.2");
    assert.equal(s.aliasToCanonical("whatever"), "whatever");
    // alias 全链:isRoutable / resolve / isCodexModel 都吃 alias
    assert.equal(s.isRoutable("glm-latest"), true);
    assert.equal(s.resolve("glm-latest")?.canonicalModel, "glm-5.2");
  });

  test("billingPricingFor 从同一快照精确投影价格(alias 也归一)", () => {
    const loadedAt = new Date("2026-07-13T12:34:56.000Z");
    const s = new ModelCatalogSnapshot({
      entries: [GLM],
      aliases: new Map([["glm-latest", 1]]),
      pricing: new Map([["glm-5.2", price("glm-5.2", {
        displayName: "GLM 5.2",
        inputPerMtok: 123n,
        outputPerMtok: 456n,
        cacheReadPerMtok: 7n,
        cacheWritePerMtok: 8n,
        multiplier: "1.250",
        visibility: "hidden",
        sortOrder: 42,
        defaultEffort: "max",
      })]]),
      securityEpoch: 9n,
      loadedAt,
    });

    assert.deepEqual(s.billingPricingFor("glm-latest"), {
      model_id: "glm-5.2",
      display_name: "GLM 5.2",
      input_per_mtok: 123n,
      output_per_mtok: 456n,
      cache_read_per_mtok: 7n,
      cache_write_per_mtok: 8n,
      multiplier: "1.250",
      enabled: true,
      sort_order: 42,
      visibility: "hidden",
      extra_system_prompt: null,
      default_effort: "max",
      updated_at: loadedAt,
    });
    assert.equal(s.billingPricingFor("unknown"), null);
  });
});

// ─── listForUser + projectionRevision ────────────────────────────────────

describe("per-uid 投影", () => {
  const pub = entry({ entryId: 1, modelId: "pub-model" });
  const adminOnly = entry({ entryId: 2, modelId: "admin-model" });
  const hidden = entry({ entryId: 3, modelId: "hidden-model" });
  const s = snap({
    entries: [pub, adminOnly, hidden],
    pricing: [
      price("pub-model", { visibility: "public", sortOrder: 10 }),
      price("admin-model", { visibility: "admin", sortOrder: 20 }),
      price("hidden-model", { visibility: "hidden", sortOrder: 30 }),
    ],
  });
  const ids = (rows: Array<{ modelId: string }>): string[] => rows.map((r) => r.modelId);

  test("visibility 默认范围 OR 显式 grants(与 authzModels 同源)", () => {
    const user = { uid: 1, role: "user" as const, grantedModelIds: new Set<string>() };
    const admin = { uid: 1, role: "admin" as const, grantedModelIds: new Set<string>() };
    assert.equal(s.canUseModel(user, "pub-model"), true);
    assert.equal(s.canUseModel(user, "admin-model"), false);
    assert.equal(s.canUseModel(admin, "admin-model"), true);
    assert.equal(s.canUseModel(admin, "hidden-model"), false);
    assert.deepEqual(
      ids(s.listForUser(user)),
      ["pub-model"],
    );
    assert.deepEqual(
      ids(s.listForUser({ uid: 1, role: "admin", grantedModelIds: new Set() })),
      ["pub-model", "admin-model"], // admin 不自动 bypass hidden
    );
    assert.deepEqual(
      ids(s.listForUser({ uid: 1, role: "user", grantedModelIds: new Set(["admin-model", "hidden-model"]) })),
      ["pub-model", "admin-model", "hidden-model"],
    );
    // sort_order 升序
    assert.deepEqual(
      s.listForUser({ uid: 1, role: "admin", grantedModelIds: new Set(["hidden-model"]) }).map((r) => r.sortOrder),
      [10, 20, 30],
    );
  });

  test("Grok engine 是管理员硬闸:public/显式 grant 都不能给普通用户放行", () => {
    const grok = snap({
      entries: [GLM, GROK],
      pricing: [price("glm-5.2"), price("grok-build", { visibility: "public" })],
    });
    const user = { uid: 7, role: "user" as const, grantedModelIds: new Set(["grok-build"]) };
    const admin = { uid: 1, role: "admin" as const, grantedModelIds: new Set<string>() };
    assert.equal(grok.canUseModel(user, "grok-build"), false);
    assert.equal(grok.canUseModel(admin, "grok-build"), true);
    assert.equal(grok.isEngineReportedModel("grok-build"), true);
    assert.deepEqual(grok.listForUser(user).map((row) => row.modelId), ["glm-5.2"]);
    assert.deepEqual(grok.listForUser(admin).map((row) => row.modelId), ["glm-5.2", "grok-build"]);
  });

  test("projectionRevision 是 per-uid 的:同内容不同 uid → 不同 hash", () => {
    const a = s.projectionRevisionFor({ uid: 1, role: "user", grantedModelIds: new Set() });
    const b = s.projectionRevisionFor({ uid: 2, role: "user", grantedModelIds: new Set() });
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test("projectionRevision 稳定:同 uid 同可见集 → 同 hash;grants 变化 → 变", () => {
    const a = s.projectionRevisionFor({ uid: 7, role: "user", grantedModelIds: new Set() });
    const again = s.projectionRevisionFor({ uid: 7, role: "user", grantedModelIds: new Set() });
    const granted = s.projectionRevisionFor({ uid: 7, role: "user", grantedModelIds: new Set(["hidden-model"]) });
    assert.equal(a, again);
    assert.notEqual(a, granted);
  });

  test("全局 executionRevision ≠ 任何 per-uid projectionRevision(不下发全局 R2-M12)", () => {
    const p = s.projectionRevisionFor({ uid: 7, role: "admin", grantedModelIds: new Set() });
    assert.notEqual(p, s.executionRevision);
  });

  test("grants 只放大可见集,不改变价格/execution 面 → 不影响 executionRevision", () => {
    const before = s.executionRevision;
    s.projectionRevisionFor({ uid: 9, role: "user", grantedModelIds: new Set(["hidden-model"]) });
    assert.equal(s.executionRevision, before);
  });
});

// ─── capability_profile 解析 fail-closed ─────────────────────────────────

describe("parseCapabilityProfile", () => {
  test("合法 v1 形状", () => {
    const p = parseCapabilityProfile("m", {
      supports_vision: true,
      reasoning: { supported: ["high", "max"], codex_model_default: null },
      ccb: { capability_zero: false, supports_thinking: true },
    });
    assert.equal(p.supportsVision, true);
    assert.deepEqual(p.reasoning.supported, ["high", "max"]);
    assert.equal(p.reasoning.codexModelDefault, null);
  });

  test("畸形 → 抛(载入期发现,而不是把畸形 descriptor 签进 envelope)", () => {
    const bad: unknown[] = [
      null,
      [],
      { reasoning: { supported: [], codex_model_default: null } }, // 缺 supports_vision
      { supports_vision: true }, // 缺 reasoning
      { supports_vision: true, reasoning: { supported: "high", codex_model_default: null } },
      { supports_vision: true, reasoning: { supported: ["nope"], codex_model_default: null } },
      { supports_vision: true, reasoning: { supported: [], codex_model_default: "nope" } },
    ];
    for (const b of bad) {
      assert.throws(() => parseCapabilityProfile("m", b), TypeError, `should reject ${JSON.stringify(b)}`);
    }
  });
});

// ─── epoch fence ─────────────────────────────────────────────────────────

function fakeRunner(epoch: string | null): {
  query: <R extends QueryResultRow>(sql: string) => Promise<QueryResult<R>>;
  calls: number;
} {
  const runner = {
    calls: 0,
    query: async <R extends QueryResultRow>(): Promise<QueryResult<R>> => {
      runner.calls += 1;
      return {
        rows: (epoch === null ? [] : [{ epoch }]) as unknown as R[],
        command: "SELECT",
        rowCount: epoch === null ? 0 : 1,
        oid: 0,
        fields: [],
      };
    },
  };
  return runner;
}

describe("epoch fence", () => {
  test("epoch 相等 → 放行", async () => {
    const s = snap({ entries: [GLM], epoch: 5n });
    await assertEpochFresh(s, fakeRunner("5"));
  });

  test("epoch 漂移 → EpochStaleError(带两侧 epoch)", async () => {
    const s = snap({ entries: [GLM], epoch: 5n });
    await assert.rejects(
      () => assertEpochFresh(s, fakeRunner("6")),
      (err: unknown) => {
        assert.ok(err instanceof EpochStaleError);
        assert.equal(err.snapshotEpoch, 5n);
        assert.equal(err.dbEpoch, 6n);
        return true;
      },
    );
  });

  test("每次 fence 都真读 DB(无时间微缓存,R4-m3)", async () => {
    const s = snap({ entries: [GLM], epoch: 5n });
    const r = fakeRunner("5");
    await assertEpochFresh(s, r);
    await assertEpochFresh(s, r);
    await assertEpochFresh(s, r);
    assert.equal(r.calls, 3);
  });

  test("epoch 行缺失 → 抛(fail-closed,不当作 0)", async () => {
    const s = snap({ entries: [GLM], epoch: 1n });
    await assert.rejects(() => assertEpochFresh(s, fakeRunner(null)), /exactly one row/);
  });

  test("大 epoch 用 bigint 比较,不丢精度", async () => {
    const big = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    const s = snap({ entries: [GLM], epoch: big });
    await assertEpochFresh(s, fakeRunner(big.toString()));
    await assert.rejects(() => assertEpochFresh(s, fakeRunner((big + 1n).toString())), EpochStaleError);
  });
});

describe("ModelCatalogCache", () => {
  test("未加载 → current() 抛 CatalogUnknownError(执行/计费面 fail-closed)", () => {
    const c = new ModelCatalogCache();
    assert.throws(() => c.current(), CatalogUnknownError);
    assert.equal(c.peek(), null);
  });

  test("_setForTests(null) 模拟 epoch NOTIFY 后的 unknown 窗口 → 拒", () => {
    const c = new ModelCatalogCache();
    c._setForTests(snap({ entries: [GLM] }));
    assert.equal(c.current().isRoutable("glm-5.2"), true);
    c._setForTests(null);
    assert.throws(() => c.current(), CatalogUnknownError);
  });
});

// ─── 平台次级模型(BLOCKER 2026-07-12)────────────────────────────────────

describe("platformAuxModels —— 平台次级模型", () => {
  test("权威源 = gateway DEFAULT_SECONDARY_UTILITY_MODEL(不另抄字面量)", () => {
    // 这一条是**防第二权威源**的锚:容器里 ANTHROPIC_SMALL_FAST_MODEL 的实际取值由
    // gateway `_buildSecondaryUtilityModelEnv()` 决定(OPENCLAUDE_SECONDARY_MODEL 无注入方
    // → 恒取常量)。master 若在别处另抄一份 id,catalog/签名说 A、容器发 B,WebFetch 静默 403。
    assert.deepEqual(PLATFORM_AUX_MODEL_IDS, [DEFAULT_SECONDARY_UTILITY_MODEL]);
    assert.equal(
      _buildSecondaryUtilityModelEnv().ANTHROPIC_SMALL_FAST_MODEL,
      PLATFORM_AUX_MODEL_IDS[0],
    );
  });

  test("catalog active + 有价 → 返回 canonical id 集合(去重排序)", () => {
    const flash = entry({ entryId: 9, modelId: DEFAULT_SECONDARY_UTILITY_MODEL, providerId: "deepseek" });
    const s = snap({ entries: [GLM, flash] });
    assert.deepEqual(platformAuxModels(s), [DEFAULT_SECONDARY_UTILITY_MODEL]);
  });

  test("alias 归一:声明的 id 若是 alias,返回 canonical", () => {
    const flash = entry({ entryId: 9, modelId: "deepseek-flash-canonical", providerId: "deepseek" });
    const s = snap({
      entries: [GLM, flash],
      aliases: [[DEFAULT_SECONDARY_UTILITY_MODEL, 9]],
      pricing: [price("glm-5.2"), price("deepseek-flash-canonical")],
    });
    assert.deepEqual(platformAuxModels(s), ["deepseek-flash-canonical"]);
  });

  test("aux 不在 catalog active(disabled / 缺行)→ fail-closed 抛(签发期拒,不签'签了也用不了'的票)", () => {
    const disabled = entry({
      entryId: 9,
      modelId: DEFAULT_SECONDARY_UTILITY_MODEL,
      state: "disabled",
    });
    assert.throws(
      () => platformAuxModels(snap({ entries: [GLM, disabled] })),
      PlatformAuxModelUnavailableError,
    );
    // 整行缺失(catalog 里根本没有这个模型)
    assert.throws(() => platformAuxModels(snap({ entries: [GLM] })), PlatformAuxModelUnavailableError);
  });

  test("aux active 但**无价格行** → 抛(免费旁路不允许:计费与可用性不分裂)", () => {
    const flash = entry({ entryId: 9, modelId: DEFAULT_SECONDARY_UTILITY_MODEL });
    const s = snap({ entries: [GLM, flash], pricing: [price("glm-5.2")] });
    assert.throws(() => platformAuxModels(s), PlatformAuxModelUnavailableError);
  });

  test("aux 的 engine 不是 ccb → 抛(codex 不经 anthropic proxy,放进放行集只会白扩授权面)", () => {
    const wrongEngine = entry({
      entryId: 9,
      modelId: DEFAULT_SECONDARY_UTILITY_MODEL,
      engine: "codex",
      providerId: "codex",
    });
    assert.throws(
      () => platformAuxModels(snap({ entries: [GLM, wrongEngine] })),
      PlatformAuxModelUnavailableError,
    );
  });

  test("aux 的 capability schema 是未来版本 → 原样冒泡 UnknownCapabilitySchemaError(配置事故要响亮)", () => {
    const future = entry({
      entryId: 9,
      modelId: DEFAULT_SECONDARY_UTILITY_MODEL,
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION + 1,
    });
    assert.throws(
      () => platformAuxModels(snap({ entries: [GLM, future] })),
      UnknownCapabilitySchemaError,
    );
  });
});
