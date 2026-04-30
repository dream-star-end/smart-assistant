/**
 * T-21 — 扣费计算器单元测试。
 *
 * 覆盖:
 *   - 已知 usage + pricing → 已知 cost(sonnet / opus / multiplier 变体)
 *   - 极大 token(10^12 级)不溢出,不退化到 Number
 *   - 极小 usage(1 tok × 任何一维 > 0)向上取整到至少 1 分
 *   - 全零 usage → 精确 0,不被 ceiling 抬高
 *   - 4 维混合计算
 *   - 非法输入(负数 / 负 multiplier)抛 TypeError
 *   - 支持 number / bigint 入参混用
 *   - snapshot 字段完整,数字以 string 序列化,含 captured_at ISO
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeCost, type TokenUsage } from "../billing/calculator.js";
import type { ModelPricing } from "../billing/pricing.js";

/** Sonnet 4.6 对齐 0007_seed_pricing.sql 真实种子值。 */
const sonnet: ModelPricing = {
  model_id: "claude-sonnet-4-6",
  display_name: "Claude Sonnet 4.6",
  input_per_mtok: 300n,      // 分/Mtok
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
  input_per_mtok: 1500n,
  output_per_mtok: 7500n,
  cache_read_per_mtok: 150n,
  cache_write_per_mtok: 1875n,
  multiplier: "2.000",
  enabled: true,
  sort_order: 90,
  visibility: "public",
  updated_at: new Date("2026-04-01T00:00:00Z"),
};

/** 1.5 倍率,用来验证 NUMERIC(6,3) 整数放大确实走通 */
const mid: ModelPricing = {
  ...sonnet,
  model_id: "test-mid",
  display_name: "Test Mid",
  multiplier: "1.500",
};

function usageOf(input = 0, output = 0, cacheRead = 0, cacheWrite = 0): TokenUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}

describe("computeCost — known cases", () => {
  test("all-zero usage → cost=0, snapshot frozen", () => {
    const captured = new Date("2026-04-17T10:00:00Z");
    const r = computeCost(usageOf(0, 0, 0, 0), sonnet, captured);
    assert.equal(r.cost_credits, 0n);
    assert.equal(r.snapshot.model_id, "claude-sonnet-4-6");
    assert.equal(r.snapshot.input_per_mtok, "300");
    assert.equal(r.snapshot.output_per_mtok, "1500");
    assert.equal(r.snapshot.cache_read_per_mtok, "30");
    assert.equal(r.snapshot.cache_write_per_mtok, "375");
    assert.equal(r.snapshot.multiplier, "2.000");
    assert.equal(r.snapshot.display_name, "Claude Sonnet 4.6");
    assert.equal(r.snapshot.captured_at, "2026-04-17T10:00:00.000Z");
  });

  test("sonnet 1M input only: 1M * 300 * 2.0 / 1M = 600 分", () => {
    const r = computeCost(usageOf(1_000_000, 0, 0, 0), sonnet);
    assert.equal(r.cost_credits, 600n);
  });

  test("sonnet 1M output: 1M * 1500 * 2.0 / 1M = 3000 分", () => {
    const r = computeCost(usageOf(0, 1_000_000, 0, 0), sonnet);
    assert.equal(r.cost_credits, 3000n);
  });

  test("opus 1M input: 1M * 1500 * 2.0 / 1M = 3000 分", () => {
    const r = computeCost(usageOf(1_000_000, 0, 0, 0), opus);
    assert.equal(r.cost_credits, 3000n);
  });

  test("opus mixed: 500k in + 200k out + 100k cache_read + 50k cache_write", () => {
    // 精确算:
    //   input  500_000 * 1500 * 2 / 1_000_000 = 1500
    //   output 200_000 * 7500 * 2 / 1_000_000 = 3000
    //   cr     100_000 *  150 * 2 / 1_000_000 = 30
    //   cw      50_000 * 1875 * 2 / 1_000_000 = 187.5  → 总和 4717.5 → ceil 4718
    const r = computeCost(usageOf(500_000, 200_000, 100_000, 50_000), opus);
    assert.equal(r.cost_credits, 4718n);
  });

  test("multiplier 1.5 参与换算正确", () => {
    // 1M * 300 * 1.5 / 1M = 450
    const r = computeCost(usageOf(1_000_000, 0, 0, 0), mid);
    assert.equal(r.cost_credits, 450n);
  });
});

describe("computeCost — 极小 usage 仍至少 1 分", () => {
  test("1 input tok on sonnet: 1 * 300 * 2 / 1e9 = 6e-7 分 → ceil 到 1", () => {
    const r = computeCost(usageOf(1, 0, 0, 0), sonnet);
    assert.equal(r.cost_credits, 1n);
  });

  test("1 cache_read tok on sonnet(最便宜的一维): 1 * 30 * 2 / 1e9 → ceil 1", () => {
    const r = computeCost(usageOf(0, 0, 1, 0), sonnet);
    assert.equal(r.cost_credits, 1n);
  });

  test("1 每维 → 仅 ceiling 一次,不在每维各 ceiling 累加", () => {
    // 每维各 1 tok:scaled = (300+1500+30+375) * 2 = 4410 → / 1e9 ceil → 1
    // 若错误地每维 ceiling 再求和会是 4
    const r = computeCost(usageOf(1, 1, 1, 1), sonnet);
    assert.equal(r.cost_credits, 1n);
  });
});

describe("computeCost — 极大 token 不溢出", () => {
  test("10^12 tok × 10^4 分/Mtok × 10^3 mul 仍精确(BigInt 无上限)", () => {
    // 1_000_000_000_000 tok(10^12)放进 input 维
    // = 10^12 * 300 * 2 / 1e6 = 6 * 10^8 分(精确,不经 Number)
    const r = computeCost(usageOf(1_000_000_000_000, 0, 0, 0), sonnet);
    assert.equal(r.cost_credits, 600_000_000n);
  });

  test("bigint 入参:10^15 tok 远超 Number.MAX_SAFE_INTEGER", () => {
    // 使用 bigint 避免 number → BigInt 丢精度
    const usage: TokenUsage = {
      input_tokens: 10n ** 15n,
      output_tokens: 0n,
      cache_read_tokens: 0n,
      cache_write_tokens: 0n,
    };
    // 10^15 * 300 * 2 / 1e6 = 6 * 10^11 分
    const r = computeCost(usage, sonnet);
    assert.equal(r.cost_credits, 600_000_000_000n);
  });
});

describe("computeCost — 入参类型 & 校验", () => {
  test("支持 number / bigint 混用", () => {
    const usage: TokenUsage = {
      input_tokens: 1_000_000,     // number
      output_tokens: 1_000_000n,   // bigint
      cache_read_tokens: 0,
      cache_write_tokens: 0n,
    };
    const r = computeCost(usage, sonnet);
    // 600 + 3000 = 3600
    assert.equal(r.cost_credits, 3600n);
  });

  test("负 input_tokens → TypeError", () => {
    assert.throws(
      () => computeCost(usageOf(-1, 0, 0, 0), sonnet),
      (err: unknown) =>
        err instanceof TypeError && /input_tokens.*non-negative/.test((err as Error).message),
    );
  });

  test("负 output_tokens(bigint) → TypeError", () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: -1n,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    assert.throws(() => computeCost(usage, sonnet), TypeError);
  });

  test("负 multiplier → TypeError", () => {
    const bad: ModelPricing = { ...sonnet, multiplier: "-1.000" };
    assert.throws(() => computeCost(usageOf(1, 0, 0, 0), bad), TypeError);
  });
});

describe("computeCost — snapshot 结构", () => {
  test("snapshot 字段与 pricing 对上、价格以 string 序列化", () => {
    const at = new Date("2026-04-17T12:34:56.789Z");
    const { snapshot } = computeCost(usageOf(1, 2, 3, 4), opus, at);
    // 所有数字字段都是 string(为了 JSON.stringify 稳定)
    assert.equal(typeof snapshot.input_per_mtok, "string");
    assert.equal(typeof snapshot.output_per_mtok, "string");
    assert.equal(typeof snapshot.cache_read_per_mtok, "string");
    assert.equal(typeof snapshot.cache_write_per_mtok, "string");
    assert.equal(typeof snapshot.multiplier, "string");
    assert.equal(snapshot.model_id, opus.model_id);
    assert.equal(snapshot.display_name, opus.display_name);
    assert.equal(snapshot.multiplier, opus.multiplier);
    assert.equal(snapshot.captured_at, at.toISOString());
  });

  test("snapshot 可 JSON.stringify 往返,不含 BigInt", () => {
    const { snapshot } = computeCost(usageOf(100, 100, 100, 100), sonnet);
    const s = JSON.stringify(snapshot);
    const parsed = JSON.parse(s);
    assert.equal(parsed.model_id, "claude-sonnet-4-6");
    assert.equal(parsed.input_per_mtok, "300");
    assert.equal(parsed.multiplier, "2.000");
  });

  test("captured_at 省略时使用 now;结果单调不回退", () => {
    const before = Date.now();
    const { snapshot } = computeCost(usageOf(1, 0, 0, 0), sonnet);
    const t = Date.parse(snapshot.captured_at);
    assert.ok(t >= before - 5, `captured_at ${snapshot.captured_at} should be >= ${before}`);
    assert.ok(t <= Date.now() + 5);
  });
});
