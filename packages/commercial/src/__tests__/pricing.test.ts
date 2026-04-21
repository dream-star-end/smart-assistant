/**
 * T-20 — PricingCache 单元测试(不碰 DB)。
 *
 * - 覆盖公式 `perKtokCredits`(含 multiplier 精度 / 取整边界)
 * - PricingCache get/listPublic 行为(经 _setForTests 注入)
 * - load 失败不清空旧缓存(scheduleReload 的 onError 分支在 integ test 测)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PricingCache, perKtokCredits, type ModelPricing } from "../billing/pricing.js";

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
  updated_at: new Date("2026-04-01T00:00:00Z"),
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
});
