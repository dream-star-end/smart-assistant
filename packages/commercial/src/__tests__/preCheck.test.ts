/**
 * T-23 — preCheck 单元测试。
 *
 * 覆盖:
 *   - estimateMaxCost(纯函数)
 *   - InMemoryPreCheckRedis(原子 reserve / release / 过期 / 幂等覆写 / 并发)
 *   - 边界:bigint 精度上限、空值
 *
 * preCheck() 自身依赖 getBalance(走真 PG),放 integ 测;这里只测 atomicReserve 行为。
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
  visibility: "public",
  updated_at: new Date("2026-04-01T00:00:00Z"),
};

describe("estimateMaxCost", () => {
  test("sonnet 1M tokens @ output 1500 * 2.0 = 3000 分", () => {
    assert.equal(estimateMaxCost(1_000_000, sonnet), 3000n);
  });

  test("小 tokens 向上取整 ≥ 1 分", () => {
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
    assert.equal(estimateMaxCost(1_000_000, m15), 2250n);
  });
});

describe("InMemoryPreCheckRedis.atomicReserve — 单请求", () => {
  test("余额充足:写入,locked = needed = maxCost", async () => {
    const r = new InMemoryPreCheckRedis();
    const out = await r.atomicReserve({
      userId: 1n,
      requestId: "req-a",
      balance: 1000n,
      maxCost: 100n,
      ttlSeconds: 60,
    });
    assert.equal(out.ok, true);
    assert.equal(out.locked, 100n);
    assert.equal(out.needed, 100n);
    assert.equal(r.totalLocked(1n), 100n);
  });

  test("余额不足:不写入,返回 ok=false 且 needed/locked 反映现状", async () => {
    const r = new InMemoryPreCheckRedis();
    await r.atomicReserve({
      userId: 1n, requestId: "req-a", balance: 100n, maxCost: 80n, ttlSeconds: 60,
    });
    const out = await r.atomicReserve({
      userId: 1n, requestId: "req-b", balance: 100n, maxCost: 50n, ttlSeconds: 60,
    });
    assert.equal(out.ok, false);
    assert.equal(out.locked, 80n);
    assert.equal(out.needed, 130n);
    // 第二次失败不应该写入
    assert.equal(r.totalLocked(1n), 80n);
  });

  test("正好等于 balance 也通过(>= 语义)", async () => {
    const r = new InMemoryPreCheckRedis();
    const out = await r.atomicReserve({
      userId: 5n, requestId: "req-x", balance: 100n, maxCost: 100n, ttlSeconds: 60,
    });
    assert.equal(out.ok, true);
    assert.equal(out.needed, 100n);
  });
});

describe("InMemoryPreCheckRedis.atomicReserve — 幂等覆写", () => {
  test("同 reqId 第二次覆写第一次的 maxCost,total 不重复累计", async () => {
    const r = new InMemoryPreCheckRedis();
    await r.atomicReserve({
      userId: 7n, requestId: "req-i", balance: 1000n, maxCost: 100n, ttlSeconds: 60,
    });
    assert.equal(r.totalLocked(7n), 100n);

    // 同一 reqId 重新预扣更大的 cost — 应当替换,而不是累计
    const out = await r.atomicReserve({
      userId: 7n, requestId: "req-i", balance: 1000n, maxCost: 250n, ttlSeconds: 60,
    });
    assert.equal(out.ok, true);
    assert.equal(r.totalLocked(7n), 250n);
  });

  test("覆写 + 余额校验:新 cost 算 total 时应减掉旧的", async () => {
    const r = new InMemoryPreCheckRedis();
    // 余额 200,先扣 100
    await r.atomicReserve({
      userId: 8n, requestId: "req-i", balance: 200n, maxCost: 100n, ttlSeconds: 60,
    });
    // 再扣 150(同 reqId)— 应当通过(覆写,total=150 ≤ 200)而不是 250
    const out = await r.atomicReserve({
      userId: 8n, requestId: "req-i", balance: 200n, maxCost: 150n, ttlSeconds: 60,
    });
    assert.equal(out.ok, true);
    assert.equal(out.needed, 150n);
    assert.equal(r.totalLocked(8n), 150n);
  });
});

describe("InMemoryPreCheckRedis.atomicReserve — 并发原子性", () => {
  test("同 user 并发 N 路:总通过额度 ≤ balance(无超额)", async () => {
    const r = new InMemoryPreCheckRedis();
    const balance = 1000n;
    const cost = 100n;
    // 11 路并发(理论容许 10 路,1 路必须被拒)
    const promises = Array.from({ length: 11 }, (_, i) =>
      r.atomicReserve({
        userId: 42n, requestId: `req-${i}`, balance, maxCost: cost, ttlSeconds: 60,
      }),
    );
    const results = await Promise.all(promises);
    const passed = results.filter((x) => x.ok).length;
    const rejected = results.length - passed;
    assert.equal(passed, 10);
    assert.equal(rejected, 1);
    assert.equal(r.totalLocked(42n), 1000n);
  });

  test("不同 user 互不干扰", async () => {
    const r = new InMemoryPreCheckRedis();
    const out1 = await r.atomicReserve({
      userId: 1n, requestId: "req-a", balance: 100n, maxCost: 100n, ttlSeconds: 60,
    });
    const out2 = await r.atomicReserve({
      userId: 2n, requestId: "req-a", balance: 100n, maxCost: 100n, ttlSeconds: 60,
    });
    assert.equal(out1.ok, true);
    assert.equal(out2.ok, true);
    assert.equal(r.totalLocked(1n), 100n);
    assert.equal(r.totalLocked(2n), 100n);
  });
});

describe("InMemoryPreCheckRedis.releaseReservation", () => {
  test("释放成功后 totalLocked 减少", async () => {
    const r = new InMemoryPreCheckRedis();
    await r.atomicReserve({
      userId: 3n, requestId: "req-r", balance: 1000n, maxCost: 200n, ttlSeconds: 60,
    });
    assert.equal(r.totalLocked(3n), 200n);
    const ok = await r.releaseReservation({ userId: 3n, requestId: "req-r" });
    assert.equal(ok, true);
    assert.equal(r.totalLocked(3n), 0n);
  });

  test("释放不存在的 reqId 返回 false", async () => {
    const r = new InMemoryPreCheckRedis();
    const ok = await r.releaseReservation({ userId: 99n, requestId: "ghost" });
    assert.equal(ok, false);
  });

  test("二次释放返回 false", async () => {
    const r = new InMemoryPreCheckRedis();
    await r.atomicReserve({
      userId: 4n, requestId: "req-r", balance: 1000n, maxCost: 100n, ttlSeconds: 60,
    });
    assert.equal(await r.releaseReservation({ userId: 4n, requestId: "req-r" }), true);
    assert.equal(await r.releaseReservation({ userId: 4n, requestId: "req-r" }), false);
  });

  test("释放后该额度可被新预扣使用", async () => {
    const r = new InMemoryPreCheckRedis();
    // 余额 100 全锁住
    await r.atomicReserve({
      userId: 5n, requestId: "req-a", balance: 100n, maxCost: 100n, ttlSeconds: 60,
    });
    // 第二个被拒
    const out1 = await r.atomicReserve({
      userId: 5n, requestId: "req-b", balance: 100n, maxCost: 50n, ttlSeconds: 60,
    });
    assert.equal(out1.ok, false);
    // 释放第一个
    await r.releaseReservation({ userId: 5n, requestId: "req-a" });
    // 第三个可以通过
    const out2 = await r.atomicReserve({
      userId: 5n, requestId: "req-b", balance: 100n, maxCost: 50n, ttlSeconds: 60,
    });
    assert.equal(out2.ok, true);
  });
});

describe("InMemoryPreCheckRedis — 过期 sweep", () => {
  test("到期 lock 不参与下次 reserve 求和", async () => {
    const r = new InMemoryPreCheckRedis();
    let t = 1_000_000;
    r.setNowFn(() => t);
    await r.atomicReserve({
      userId: 6n, requestId: "req-old", balance: 1000n, maxCost: 800n, ttlSeconds: 1,
    });
    assert.equal(r.totalLocked(6n), 800n);
    t += 2_000;
    // 过期后再来 800,只 200 余额预扣应当通过(因为旧的不算)
    const out = await r.atomicReserve({
      userId: 6n, requestId: "req-new", balance: 1000n, maxCost: 800n, ttlSeconds: 60,
    });
    assert.equal(out.ok, true);
    assert.equal(r.totalLocked(6n), 800n);
  });

  test("到期 lock 释放也返回 false(已被自动清)", async () => {
    const r = new InMemoryPreCheckRedis();
    let t = 1_000_000;
    r.setNowFn(() => t);
    await r.atomicReserve({
      userId: 11n, requestId: "req-x", balance: 100n, maxCost: 50n, ttlSeconds: 1,
    });
    t += 2_000;
    const ok = await r.releaseReservation({ userId: 11n, requestId: "req-x" });
    assert.equal(ok, false);
  });
});

describe("InMemoryPreCheckRedis — 输入校验", () => {
  test("requestId 空 / 太长 → TypeError", async () => {
    const r = new InMemoryPreCheckRedis();
    await assert.rejects(
      r.atomicReserve({
        userId: 1n, requestId: "", balance: 1n, maxCost: 0n, ttlSeconds: 60,
      }),
      TypeError,
    );
    await assert.rejects(
      r.atomicReserve({
        userId: 1n, requestId: "x".repeat(129), balance: 1n, maxCost: 0n, ttlSeconds: 60,
      }),
      TypeError,
    );
  });

  test("ttlSeconds 越界 → TypeError", async () => {
    const r = new InMemoryPreCheckRedis();
    await assert.rejects(
      r.atomicReserve({
        userId: 1n, requestId: "req", balance: 1n, maxCost: 0n, ttlSeconds: 0,
      }),
      TypeError,
    );
    await assert.rejects(
      r.atomicReserve({
        userId: 1n, requestId: "req", balance: 1n, maxCost: 0n, ttlSeconds: 3601,
      }),
      TypeError,
    );
  });

  test("balance / maxCost 超 2^53-1 → TypeError(Lua double 精度)", async () => {
    const r = new InMemoryPreCheckRedis();
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await assert.rejects(
      r.atomicReserve({
        userId: 1n, requestId: "req", balance: tooBig, maxCost: 0n, ttlSeconds: 60,
      }),
      TypeError,
    );
    await assert.rejects(
      r.atomicReserve({
        userId: 1n, requestId: "req", balance: 1n, maxCost: tooBig, ttlSeconds: 60,
      }),
      TypeError,
    );
  });

  test("balance / maxCost 负数 → TypeError", async () => {
    const r = new InMemoryPreCheckRedis();
    await assert.rejects(
      r.atomicReserve({
        userId: 1n, requestId: "req", balance: -1n, maxCost: 0n, ttlSeconds: 60,
      }),
      TypeError,
    );
    await assert.rejects(
      r.atomicReserve({
        userId: 1n, requestId: "req", balance: 1n, maxCost: -1n, ttlSeconds: 60,
      }),
      TypeError,
    );
  });
});
