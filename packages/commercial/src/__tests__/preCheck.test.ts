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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Pool } from "pg";
import {
  estimateMaxCost,
  preCheck,
  InMemoryPreCheckRedis,
} from "../billing/preCheck.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import { setPoolOverride, closePool } from "../db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  extra_system_prompt: null,
  default_effort: null,
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

/**
 * BINV-5 — preCheck 不查 agent_cost_overrides。
 *
 * 锁的不变量(`PHASE1-TEST-COVERAGE-PLAN.md` Audit 表 BINV-5 行):
 *   cost multiplier 只在 finalize 阶段(`settleUsageAndLedger` 之前的
 *   `calculateActualCost`)应用,**preCheck 路径不查** `agent_cost_overrides`。
 *
 * 为什么重要:历史 (2026-05-06) preCheck 曾在估算阶段考虑 multiplier,叠加
 * `estimateMaxCost` 的双侧 ceiling 把 ¥12 余额用户的 Opus 4.7 + 附件直接卡到
 * 拒绝。boss 决策(v1.0.89)拆掉 multiplier 估算与 ceiling,统一只在 finalize 走
 * clamp 路径。本不变量防止任何"顺便加点多 multiplier 路径"的回归。
 *
 * 双重锁(**行为层是权威**,结构层只是零成本兜底):
 *   1. **行为层(spy pool)** — 用注入的假 Pool 真跑一次 preCheck,把它实际发出的
 *      每条 SQL 里出现的表名收集起来,断言集合 ⊆ {users, user_subscriptions}。
 *      这是白名单而非黑名单:换个变量名/换张新的 multiplier 表照样红。
 *      pool 注入走 `setPoolOverride()` test seam(`db/index.ts`)。
 *   2. **结构层(静态)** — preCheck.ts 与其唯一 PG 依赖 ledger.ts 源码中不允许出现
 *      `agent_cost_overrides` / `agentMultiplier` 字面量。只能挡"原样写回来"的回归,
 *      改个名就绕过 —— 保留是因为它零成本且能覆盖到未被行为层走到的分支。
 *
 * 2026-07-26 修复:行为层假 pool 一直返 `{credits}` 单列,而 getBalanceBreakdown
 * 双钱包改造后读的是 `{wallet, period}` → `BigInt(undefined)` 抛,子测长期 not ok
 * 并被 known-failures 顶层豁免吸收。假 query 现按 SQL 形状返列。
 */

describe("preCheck — BINV-5: cost multiplier 不进 preCheck 路径", () => {
  test("结构层: preCheck.ts + ledger.ts 源码不含 agent_cost_overrides / agentMultiplier", () => {
    const preCheckSrc = readFileSync(
      resolve(__dirname, "../billing/preCheck.ts"),
      "utf8",
    );
    const ledgerSrc = readFileSync(
      resolve(__dirname, "../billing/ledger.ts"),
      "utf8",
    );
    // 注:用 includes 而非 regex 是有意 — 任何形式的 import / 字符串拼 SQL 都
    // 会触发该字符串出现,误判风险极低。
    assert.ok(
      !preCheckSrc.includes("agent_cost_overrides"),
      "preCheck.ts 不应引用 agent_cost_overrides",
    );
    assert.ok(
      !preCheckSrc.includes("agentMultiplier"),
      "preCheck.ts 不应引用 agentMultiplier",
    );
    assert.ok(
      !ledgerSrc.includes("agent_cost_overrides"),
      "ledger.ts(preCheck 唯一 PG 依赖)不应引用 agent_cost_overrides",
    );
    assert.ok(
      !ledgerSrc.includes("agentMultiplier"),
      "ledger.ts 不应引用 agentMultiplier",
    );
  });

  test("行为层: preCheck 只读余额相关表(个人钱包 + 企业桶),不触任何 multiplier 表", async () => {
    // duck-type fake Pool — preCheck 路径只走 getBalanceBreakdown → query → pool.query。
    // 我们记录 query 字面量,事后对"实际访问到的表名集合"做白名单断言。
    const sqls: string[] = [];
    const fakePool = {
      async query(text: unknown, _params?: unknown) {
        const sqlText = typeof text === "string" ? text : (text as { text: string }).text;
        sqls.push(sqlText);
        // 按 SQL 形状返列:getBalanceBreakdown(spend.ts)读的是 wallet/period 两列,
        // 双钱包改造前是单列 credits —— 假 pool 必须跟着产品的列集走,否则
        // BigInt(undefined) 会把行为层直接打成 not ok(2026-07 前的既有状态)。
        if (/\bwallet\b/i.test(sqlText) && /\bperiod\b/i.test(sqlText)) {
          return {
            rows: [{ wallet: "1000", period: "0" }],
            rowCount: 1,
            command: "SELECT",
            oid: 0,
            fields: [],
          };
        }
        // 兜底:任何其它 SQL 都不该出现在 preCheck 路径上;返空行让调用方自曝,
        // 同时该 SQL 已被记进 sqls,由下面的表名白名单断言拦住。
        return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
      async connect() {
        throw new Error("fakePool.connect() should not be called in preCheck path");
      },
      async end() {},
      on() {},
    } as unknown as Pool;

    // 注:setPoolOverride 要求 pool 未初始化或同实例;test 文件首批运行无需 closePool。
    // 若上面 describe block 已意外开了 pool(本文件并无),fallback closePool 再 set。
    try {
      setPoolOverride(fakePool);
    } catch {
      await closePool();
      setPoolOverride(fakePool);
    }
    try {
      // 仅注入 PricingCache.get(),preCheck 路径只调它(见 preCheck.ts:236)
      const pricing = {
        get(_modelId: string): ModelPricing | null {
          return {
            model_id: "test-model",
            display_name: "Test",
            input_per_mtok: 100n,
            output_per_mtok: 200n,
            cache_read_per_mtok: 10n,
            cache_write_per_mtok: 25n,
            multiplier: "1.000",
            enabled: true,
            sort_order: 1,
            visibility: "public",
            extra_system_prompt: null,
            default_effort: null,
            updated_at: new Date(0),
          };
        },
      } as unknown as PricingCache;

      const redis = new InMemoryPreCheckRedis();
      const result = await preCheck(redis, {
        userId: 7n,
        requestId: "req-binv5",
        model: "test-model",
        maxTokens: 1_000,
        pricing,
      });
      assert.ok(result.balance === 1000n);
    } finally {
      await closePool();
    }

    // ── 白名单断言(本用例的真正价值所在)────────────────────────────────
    // 从实际发出的 SQL 里抽出所有 FROM / JOIN 后的表名,断言 ⊆ 余额相关表。
    // 黑名单("不含 agent_cost_overrides")挡不住"改个表名的新 multiplier 源";
    // 白名单能:preCheck 一旦多读任何一张表,这里立刻红。
    //
    // 白名单为什么是这五张:preCheck 读的是"总可用额度",= 个人钱包
    // (users.credits + 当期 user_subscriptions.period_credits,spend.ts
    // getBalanceBreakdown)+ 企业桶(org_memberships → orgs → 当期
    // org_subscriptions,orgBilling)。后三张是本次补行为层断言时实测发现的
    // ——原用例名写的"只 SELECT credits FROM users"其实已经不准了。
    const ALLOWED_TABLES = new Set([
      "users",
      "user_subscriptions",
      "org_memberships",
      "orgs",
      "org_subscriptions",
    ]);
    const touched = new Set<string>();
    for (const sql of sqls) {
      for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)) {
        touched.add(m[1]!.toLowerCase());
      }
    }
    assert.ok(sqls.length > 0, "preCheck 必须真的读一次余额(SQL 数为 0 说明假 pool 没被走到)");
    assert.deepEqual(
      [...touched].filter((t) => !ALLOWED_TABLES.has(t)),
      [],
      `preCheck 只允许读 ${[...ALLOWED_TABLES].join("/")};实际 SQL=${JSON.stringify(sqls)}`,
    );
    assert.ok(touched.has("users"), "preCheck 必须读 users 余额");
  });
});
