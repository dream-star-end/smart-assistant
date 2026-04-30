/**
 * T-20 — PricingCache 单元测试(不碰 DB)。
 *
 * - 覆盖公式 `perKtokCredits`(含 multiplier 精度 / 取整边界)
 * - PricingCache get/listPublic 行为(经 _setForTests 注入)
 * - load 失败不清空旧缓存(scheduleReload 的 onError 分支在 integ test 测)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PricingCache,
  canonicalizeModelId,
  perKtokCredits,
  type ModelPricing,
} from "../billing/pricing.js";

// visibility='admin' 锁定 0049 迁移后 haiku 的新状态(老 HIDDEN_FROM_PUBLIC_LIST
// 行为由 visibility 列表达;详见 pricing.ts 顶部注释)。
const haiku: ModelPricing = {
  model_id: "claude-haiku-4-5",
  display_name: "Claude Haiku 4.5",
  input_per_mtok: 80n,
  output_per_mtok: 400n,
  cache_read_per_mtok: 8n,
  cache_write_per_mtok: 100n,
  multiplier: "1.500",
  enabled: true,
  sort_order: 110,
  visibility: "admin",
  updated_at: new Date("2026-04-01T00:00:00Z"),
};

const sonnet: ModelPricing = {
  model_id: "claude-sonnet-4-6",
  display_name: "Claude Sonnet 4.6",
  input_per_mtok: 300n,
  output_per_mtok: 1500n,
  cache_read_per_mtok: 30n,
  cache_write_per_mtok: 375n,
  multiplier: "2.000",
  enabled: true,
  sort_order: 100,
  visibility: "public",
  updated_at: new Date("2026-04-01T00:00:00Z"),
};

const opus: ModelPricing = {
  model_id: "claude-opus-4-7",
  display_name: "Claude Opus 4.7",
  // 2026-04 Opus 4.7 platform.claude.com: $5 input / $25 output (migration 0020)
  input_per_mtok: 500n,
  output_per_mtok: 2500n,
  cache_read_per_mtok: 50n,
  cache_write_per_mtok: 625n,
  multiplier: "2.000",
  enabled: true,
  sort_order: 90,
  visibility: "public",
  updated_at: new Date("2026-04-01T00:00:00Z"),
};

const disabled: ModelPricing = {
  model_id: "claude-legacy",
  display_name: "Legacy",
  input_per_mtok: 100n,
  output_per_mtok: 500n,
  cache_read_per_mtok: 10n,
  cache_write_per_mtok: 125n,
  multiplier: "1.500",
  enabled: false,
  sort_order: 200,
  visibility: "public",
  updated_at: new Date("2026-04-01T00:00:00Z"),
};

// GPT 5.5 — 0050 seed 引入,visibility='admin' 默认对普通用户隐藏。
const gpt55: ModelPricing = {
  model_id: "gpt-5.5",
  display_name: "GPT 5.5 (Codex)",
  input_per_mtok: 500n,
  output_per_mtok: 2500n,
  cache_read_per_mtok: 50n,
  cache_write_per_mtok: 625n,
  multiplier: "2.000",
  enabled: true,
  sort_order: 110,
  visibility: "admin",
  updated_at: new Date("2026-04-29T00:00:00Z"),
};

// 隐藏型(visibility='hidden')—— 默认连 admin 都看不到,只对 grants 中的用户可见。
// 用于覆盖 listForUser 的边角分支;DB 里目前没有这种行实例。
const hiddenModel: ModelPricing = {
  model_id: "internal-tool",
  display_name: "Internal Tool",
  input_per_mtok: 100n,
  output_per_mtok: 500n,
  cache_read_per_mtok: 10n,
  cache_write_per_mtok: 125n,
  multiplier: "1.000",
  enabled: true,
  sort_order: 999,
  visibility: "hidden",
  updated_at: new Date("2026-04-29T00:00:00Z"),
};

describe("perKtokCredits (helper)", () => {
  test("sonnet input: 300 cents/Mtok * 2.0 = 600 cents/Mtok = 0.006 credits/ktok", () => {
    assert.equal(perKtokCredits(300n, "2.000"), "0.006000");
  });

  test("sonnet output: 1500 * 2.0 = 3000 / 100_000 = 0.030 credits/ktok", () => {
    assert.equal(perKtokCredits(1500n, "2.000"), "0.030000");
  });

  test("opus input: 1500 * 2.0 = 3000 / 100_000 = 0.030 credits/ktok", () => {
    assert.equal(perKtokCredits(1500n, "2.000"), "0.030000");
  });

  test("opus output: 7500 * 2.0 = 15000 / 100_000 = 0.150 credits/ktok", () => {
    assert.equal(perKtokCredits(7500n, "2.000"), "0.150000");
  });

  test("non-trivial multiplier 1.500", () => {
    // 300 * 1.5 / 100 / 1000 = 450 / 100_000 = 0.00450
    assert.equal(perKtokCredits(300n, "1.500"), "0.004500");
  });

  test("multiplier with 3-digit fractional part 2.123", () => {
    // 300 * 2.123 / 100_000 = 636.9 / 100_000 = 0.006369
    assert.equal(perKtokCredits(300n, "2.123"), "0.006369");
  });

  test("multiplier integer-only '1'", () => {
    // 300 * 1 / 100_000 = 0.003
    assert.equal(perKtokCredits(300n, "1"), "0.003000");
  });

  test("huge input_per_mtok doesn't lose precision", () => {
    // 1_000_000 cents/Mtok * 2.0 = 2_000_000 / 100_000 = 20 credits/ktok
    assert.equal(perKtokCredits(1_000_000n, "2.000"), "20.000000");
  });

  test("tiny price with rounding-down (6-decimal precision floor)", () => {
    // 1 cent/Mtok * 1.0 / 100_000 = 0.00001
    assert.equal(perKtokCredits(1n, "1.000"), "0.000010");
  });

  test("zero price yields 0.000000", () => {
    assert.equal(perKtokCredits(0n, "2.000"), "0.000000");
  });
});

describe("PricingCache (unit, no DB)", () => {
  test("get returns inserted entry; unknown → null", () => {
    const p = new PricingCache();
    p._setForTests([sonnet, opus]);
    assert.equal(p.size(), 2);
    assert.equal(p.get("claude-sonnet-4-6")?.display_name, "Claude Sonnet 4.6");
    assert.equal(p.get("nope"), null);
  });

  test("listPublic filters disabled + sorts by sort_order ascending", () => {
    const p = new PricingCache();
    p._setForTests([sonnet, opus, disabled]);
    const list = p.listPublic();
    // opus sort_order=90 < sonnet 100;disabled 过滤
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "claude-opus-4-7");
    assert.equal(list[1].id, "claude-sonnet-4-6");
    // per-ktok 字段格式对上(Opus 4.7 new pricing: 500/2500 × 2.0 → 0.010/0.050)
    assert.equal(list[0].input_per_ktok_credits, "0.010000");
    assert.equal(list[0].output_per_ktok_credits, "0.050000");
    assert.equal(list[1].input_per_ktok_credits, "0.006000");
    assert.equal(list[0].multiplier, "2.000");
  });

  test("stopListener / shutdown idempotent when never started", async () => {
    const p = new PricingCache();
    await p.stopListener(); // no-op, should not throw
    await p.shutdown();
    await p.shutdown();
    assert.equal(p.size(), 0);
  });

  test("shutdown clears cache", async () => {
    const p = new PricingCache();
    p._setForTests([sonnet]);
    assert.equal(p.size(), 1);
    await p.shutdown();
    assert.equal(p.size(), 0);
  });

  test("get accepts firstParty dated id and canonical id alike (haiku-4-5 path)", () => {
    // Bug 修复回归测试:
    //   ccb WebFetch 工具发出来的 model 字段是 firstParty 带日期形式
    //   (`claude-haiku-4-5-20251001`),DB 里存 canonical 短名 `claude-haiku-4-5`。
    //   修复前 PricingCache.get() 精确查 map → miss → anthropicProxy 返回
    //   400 UNKNOWN_MODEL,即便 boss 已经在 admin UI 把 Haiku enabled 翻 true。
    const p = new PricingCache();
    p._setForTests([haiku]);
    const dated = p.get("claude-haiku-4-5-20251001");
    const canonical = p.get("claude-haiku-4-5");
    assert.ok(dated !== null, "dated firstParty id should hit");
    assert.ok(canonical !== null, "canonical id should hit");
    assert.equal(dated, canonical);
  });

  test("get is case-insensitive for the input id", () => {
    const p = new PricingCache();
    p._setForTests([haiku]);
    assert.equal(
      p.get("CLAUDE-HAIKU-4-5-20251001")?.model_id,
      "claude-haiku-4-5",
    );
  });

  test("get does NOT confuse claude-opus-4-7 with claude-opus-4 (longest-first match)", () => {
    // 顺序回归:`claude-opus-4-7-20260101` 必须命中 opus-4-7,而不是
    // 抢先匹配到 `claude-opus-4`(同样在 CANONICAL_MODEL_IDS 里)。
    const p = new PricingCache();
    p._setForTests([opus]); // model_id = "claude-opus-4-7"
    assert.equal(p.get("claude-opus-4-7-20260101")?.model_id, "claude-opus-4-7");
  });

  test("haiku-4-5 is hidden from listPublic but reachable via get() (品牌 vs 路由二态分离)", () => {
    // 0049 后这条改由 visibility='admin' 表达。锁定:
    //   - listPublic (visibility='public' 过滤) 不含 haiku
    //   - get() 仍命中(给 anthropicProxy / WebFetch 路由用)
    const p = new PricingCache();
    p._setForTests([haiku, sonnet, opus]);

    const ids = p.listPublic().map((m) => m.id);
    assert.deepEqual(ids, ["claude-opus-4-7", "claude-sonnet-4-6"]);
    assert.ok(!ids.includes("claude-haiku-4-5"), "haiku must be hidden from public");

    assert.equal(p.get("claude-haiku-4-5")?.model_id, "claude-haiku-4-5");
    assert.equal(p.get("claude-haiku-4-5-20251001")?.model_id, "claude-haiku-4-5");
  });

  test("listPublic excludes visibility='admin' and 'hidden'", () => {
    const p = new PricingCache();
    p._setForTests([opus, sonnet, haiku, gpt55, hiddenModel]);
    const ids = p.listPublic().map((m) => m.id);
    assert.deepEqual(ids, ["claude-opus-4-7", "claude-sonnet-4-6"]);
  });
});

describe("PricingCache.listForUser (visibility OR grants)", () => {
  const allModels = [opus, sonnet, haiku, gpt55, hiddenModel, disabled];

  test("普通用户无 grants → 只看到 visibility='public' 模型", () => {
    const p = new PricingCache();
    p._setForTests(allModels);
    const ids = p
      .listForUser({ role: "user", grantedModelIds: new Set() })
      .map((m) => m.id);
    assert.deepEqual(ids, ["claude-opus-4-7", "claude-sonnet-4-6"]);
  });

  test("admin 看到 public + admin (haiku/gpt-5.5),仍不含 hidden", () => {
    const p = new PricingCache();
    p._setForTests(allModels);
    const ids = p
      .listForUser({ role: "admin", grantedModelIds: new Set() })
      .map((m) => m.id);
    // sort_order:opus 90, sonnet 100, haiku 110, gpt-5.5 110(并列时 stable)
    assert.deepEqual(ids, ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-5.5"]);
    assert.ok(!ids.includes("internal-tool"), "hidden 不应给默认 admin");
  });

  test("普通用户被 grant gpt-5.5 → 看到 public + grant 模型", () => {
    const p = new PricingCache();
    p._setForTests(allModels);
    const ids = p
      .listForUser({ role: "user", grantedModelIds: new Set(["gpt-5.5"]) })
      .map((m) => m.id);
    assert.deepEqual(ids, ["claude-opus-4-7", "claude-sonnet-4-6", "gpt-5.5"]);
  });

  test("普通用户被 grant hidden 模型 → 也能看到", () => {
    const p = new PricingCache();
    p._setForTests(allModels);
    const ids = p
      .listForUser({ role: "user", grantedModelIds: new Set(["internal-tool"]) })
      .map((m) => m.id);
    assert.ok(ids.includes("internal-tool"), "hidden 模型 grant 后该用户应可见");
  });

  test("admin 被 grant hidden 模型 → 也能看到", () => {
    // 验证 visibility OR grants 语义:admin 默认看不到 hidden,grant 是 OR 放大
    const p = new PricingCache();
    p._setForTests(allModels);
    const ids = p
      .listForUser({ role: "admin", grantedModelIds: new Set(["internal-tool"]) })
      .map((m) => m.id);
    assert.ok(ids.includes("internal-tool"));
    assert.ok(ids.includes("claude-haiku-4-5"));
    assert.ok(ids.includes("gpt-5.5"));
  });

  test("disabled 模型对任何身份都不出现", () => {
    const p = new PricingCache();
    p._setForTests([disabled]);
    assert.equal(p.listForUser({ role: "admin", grantedModelIds: new Set(["claude-legacy"]) }).length, 0);
    assert.equal(p.listForUser({ role: "user", grantedModelIds: new Set(["claude-legacy"]) }).length, 0);
  });

  test("空缓存 → 空列表", () => {
    const p = new PricingCache();
    assert.deepEqual(p.listForUser({ role: "admin", grantedModelIds: new Set() }), []);
  });

  test("grant 不存在的 model_id 不影响其他逻辑(无副作用)", () => {
    const p = new PricingCache();
    p._setForTests([sonnet]);
    const result = p.listForUser({
      role: "user",
      grantedModelIds: new Set(["does-not-exist", "sonnet-typo"]),
    });
    assert.deepEqual(
      result.map((m) => m.id),
      ["claude-sonnet-4-6"],
    );
  });

  test("hidden 模型不被自动给 admin —— 锁定语义,避免 'admin sees everything' 假设", () => {
    // 故意单独一条测试,因为这是反 admin 直觉的设计(plan v3 §E1 OR-语义):
    // visibility='hidden' 时 admin 必须显式被 grant 才能看到。
    const p = new PricingCache();
    p._setForTests([hiddenModel]);
    const ids = p
      .listForUser({ role: "admin", grantedModelIds: new Set() })
      .map((m) => m.id);
    assert.deepEqual(ids, []);
  });

  test("get rejects garbage prefix even when haiku row exists", () => {
    // 真实入口行为锁定:即便 DB 里有 haiku 这一条,前缀垃圾也不能命中。
    // canonicalizeModelId 单独有同样的拒绝测试,这里再多覆盖 PricingCache.get
    // 整条链路,防止以后有人误把 canonicalize 改宽松了。
    const p = new PricingCache();
    p._setForTests([haiku]);
    assert.equal(p.get("my-claude-haiku-4-5-20251001"), null);
    assert.equal(p.get("not-claude-haiku-4-5"), null);
  });
});

describe("canonicalizeModelId (边界层防御)", () => {
  test("canonical id returns itself", () => {
    assert.equal(canonicalizeModelId("claude-haiku-4-5"), "claude-haiku-4-5");
    assert.equal(canonicalizeModelId("claude-sonnet-4-6"), "claude-sonnet-4-6");
    assert.equal(canonicalizeModelId("claude-opus-4-7"), "claude-opus-4-7");
  });

  test("firstParty dated id maps to canonical", () => {
    assert.equal(
      canonicalizeModelId("claude-haiku-4-5-20251001"),
      "claude-haiku-4-5",
    );
    assert.equal(
      canonicalizeModelId("claude-sonnet-4-5-20250929"),
      "claude-sonnet-4-5",
    );
    assert.equal(
      canonicalizeModelId("claude-opus-4-1-20250805"),
      "claude-opus-4-1",
    );
  });

  test("more specific version wins over shorter prefix (顺序敏感性)", () => {
    // 验证 `claude-opus-4-1-...` 不会被 `claude-opus-4` 抢匹配
    assert.equal(
      canonicalizeModelId("claude-opus-4-1-20250805"),
      "claude-opus-4-1",
    );
    // sonnet-4-6 不会被 sonnet-4 抢
    assert.equal(
      canonicalizeModelId("claude-sonnet-4-6-anything"),
      "claude-sonnet-4-6",
    );
  });

  test("rejects garbage prefix (不接受 my-claude-haiku-4-5-...)", () => {
    // 边界:`includes()` 会误命中,我们用 `=== || startsWith(id + "-")` 严格匹配。
    // 这种垃圾输入应当原样返回,让上层 get() 走 map miss → null → UNKNOWN_MODEL,
    // 是符合"不可信外部 model 字段"的拒绝路径,不能悄悄归一化成已知模型。
    assert.equal(
      canonicalizeModelId("my-claude-haiku-4-5-20251001"),
      "my-claude-haiku-4-5-20251001",
    );
    assert.equal(
      canonicalizeModelId("not-claude-opus-4-7"),
      "not-claude-opus-4-7",
    );
  });

  test("rejects bare id with junk suffix that's not '-'-separated", () => {
    // `claude-haiku-4-5fake` 没有 `-` 分隔后缀,严格匹配应该不命中
    assert.equal(
      canonicalizeModelId("claude-haiku-4-5fake"),
      "claude-haiku-4-5fake",
    );
  });

  test("unknown model returns itself", () => {
    assert.equal(canonicalizeModelId("gpt-5"), "gpt-5");
    assert.equal(canonicalizeModelId("claude-some-future-model"), "claude-some-future-model");
    assert.equal(canonicalizeModelId(""), "");
  });

  test("uppercase input is normalized to lowercase canonical", () => {
    assert.equal(
      canonicalizeModelId("CLAUDE-HAIKU-4-5-20251001"),
      "claude-haiku-4-5",
    );
  });
});
