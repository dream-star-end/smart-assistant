/**
 * T-23 — preCheck 单元测试(不碰 DB,余额通过 mock 注入;Redis 用 InMemory 版)。
 *
 * 覆盖 estimateMaxCost + InMemoryPreCheckRedis + 输入校验。
 * preCheck 函数本身依赖 getBalance(走真 PG),放 integ 测。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateMaxCost,
  InMemoryPreCheckRedis,
} from "../billing/preCheck.js";
import type { ModelPricing } from "../billing/pricing.js";

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

describe("estimateMaxCost", () => {
  test("sonnet 1M tokens @ output 1500 * 2.0 = 3000 分", () => {
    assert.equal(estimateMaxCost(1_000_000, sonnet), 3000n);
  });

  test("小 tokens 向上取整 ≥ 1 分", () => {
    // 1 tok * 1500 * 2 / 1e9 = 3e-6 分 → ceil 1
    assert.equal(estimateMaxCost(1, sonnet), 1n);
  });

  test("0 tokens → 0 分(不被 ceiling 抬高)", () => {
    assert.equal(estimateMaxCost(0, sonnet), 0n);
  });

  test("non-integer / negative / Infinity → TypeError", () => {
    assert.throws(() => estimateMaxCost(1.5, sonnet), TypeError);
    assert.throws(() => estimateMaxCost(-1, sonnet), TypeError);
    assert.throws(() => estimateMaxCost(Number.POSITIVE_INFINITY, sonnet), TypeError);
    assert.throws(() => estimateMaxCost(Number.NaN, sonnet), TypeError);
  });

  test("不同 multiplier 参与:1.5x", () => {
    const m15 = { ...sonnet, multiplier: "1.500" };
    // 1M * 1500 * 1.5 / 1e6 = 2250
    assert.equal(estimateMaxCost(1_000_000, m15), 2250n);
  });
});

describe("InMemoryPreCheckRedis", () => {
  test("set / get / del 往返", async () => {
    const r = new InMemoryPreCheckRedis();
    await r.set("k1", "100", 60);
    assert.equal(await r.get("k1"), "100");
    assert.equal(await r.del("k1"), 1);
    assert.equal(await r.get("k1"), null);
    assert.equal(await r.del("k1"), 0); // 二次 del → 0
  });

  test("sumByPrefix 聚合同前缀", async () => {
    const r = new InMemoryPreCheckRedis();
    await r.set("precheck:user:1:req-a", "100", 60);
    await r.set("precheck:user:1:req-b", "250", 60);
    await r.set("precheck:user:2:req-c", "999", 60);
    const total = await r.sumByPrefix("precheck:user:1:");
    assert.equal(total, 350n);
  });

  test("TTL 过期后 sumByPrefix 不再计入", async () => {
    const r = new InMemoryPreCheckRedis();
    let t = 1_000_000;
    r.setNowFn(() => t);
    await r.set("precheck:user:7:req-x", "500", 1); // TTL 1s
    assert.equal(await r.sumByPrefix("precheck:user:7:"), 500n);
    t += 2_000; // 过 2s
    assert.equal(await r.sumByPrefix("precheck:user:7:"), 0n);
    assert.equal(await r.get("precheck:user:7:req-x"), null);
  });

  test("脏数据(非 BigInt)不 throw,只是不计入", async () => {
    const r = new InMemoryPreCheckRedis();
    await r.set("precheck:user:9:req-a", "not-a-number", 60);
    await r.set("precheck:user:9:req-b", "42", 60);
    assert.equal(await r.sumByPrefix("precheck:user:9:"), 42n);
  });
});
