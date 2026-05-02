/**
 * PR2 v1.0.66 — agentMultiplier.ts 单元测试。
 *
 * 覆盖:
 *   - composeMultiplier 边界(恒等元 / 各种倍率组合 / 截断行为 / 精度极限)
 *   - 异常输入 throw
 *   - getAgentCostMultiplier 命中 / miss(返回 "1.000")/ cache TTL / 不同 agentId 不串
 *
 * DB 交互通过 mockPool(轻量替身),不依赖真 PG。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  composeMultiplier,
  getAgentCostMultiplier,
  _resetAgentMultiplierCacheForTests,
} from "../billing/agentMultiplier.js";
import type { Pool } from "pg";

describe("composeMultiplier", () => {
  test("恒等元:×1.000 不变", () => {
    assert.equal(composeMultiplier("1.000", "1.000"), "1.000");
    assert.equal(composeMultiplier("2.500", "1.000"), "2.500");
    assert.equal(composeMultiplier("1.000", "0.500"), "0.500");
  });

  test("常见组合", () => {
    assert.equal(composeMultiplier("2.000", "1.500"), "3.000");
    assert.equal(composeMultiplier("2.000", "0.500"), "1.000");
    assert.equal(composeMultiplier("3.000", "2.000"), "6.000");
  });

  test("向下截断(对客户有利)", () => {
    // real = 1.522756 → 截到 1.522
    assert.equal(composeMultiplier("1.234", "1.234"), "1.522");
    // real = 0.5005 → 截到 0.500
    assert.equal(composeMultiplier("1.001", "0.500"), "0.500");
    // real = 9.999 × 1.001 = 10.008999 → 截到 10.008
    // 注意:result < 10.001 不会触碰 CHECK 上限,但生产中要控制 model_mul × agent_mul ≤ 10
    assert.equal(composeMultiplier("9.999", "1.001"), "10.008");
  });

  test("精度极限 0.001 — 正×正 clamp 到 0.001 防漏扣", () => {
    // 1 × 1 / 1000 = 0(本应),clamp 到 1n → "0.001",不许正价变免费
    assert.equal(composeMultiplier("0.001", "0.001"), "0.001");
    // 1000 × 1 / 1000 = 1 → "0.001"
    assert.equal(composeMultiplier("1.000", "0.001"), "0.001");
    // 10000 × 1 / 1000 = 10 → "0.010"
    assert.equal(composeMultiplier("10.000", "0.001"), "0.010");
    // 一般小数组合精度损失但不归零:0.5 × 0.001 = 0.0005 → 截断 0.000 → clamp 0.001
    assert.equal(composeMultiplier("0.500", "0.001"), "0.001");
    // 0.499 × 0.001 = 0.000499 → 截 0.000 → clamp 0.001(同样的不归零保护)
    assert.equal(composeMultiplier("0.499", "0.001"), "0.001");
  });

  test("零值不 clamp(0 表示禁用计费)", () => {
    assert.equal(composeMultiplier("0.000", "1.000"), "0.000");
    assert.equal(composeMultiplier("0.000", "0.000"), "0.000");
    assert.equal(composeMultiplier("1.000", "0.000"), "0.000");
    // 任何一边为 0,composed=0,但因 m=0 || a=0,clamp 不触发
    assert.equal(composeMultiplier("0.000", "0.001"), "0.000");
  });

  test("不规范字符串容忍 — 短于 3 位小数 padEnd 0", () => {
    // padEnd 行为:"1.5" → "1.500"(scaled=1500),"2" → "2.000"(scaled=2000)
    assert.equal(composeMultiplier("1.5", "2"), "3.000");
    assert.equal(composeMultiplier("0.5", "0.5"), "0.250");
  });

  test("超过 3 位小数被 slice 截断(对齐 calculator.ts 行为)", () => {
    // "1.9999" → padEnd 已 4 位,slice(0,3) = "999" → scaled=1999
    // 1999 × 1000 / 1000 = 1999 → "1.999"(第 4 位被吃掉)
    assert.equal(composeMultiplier("1.9999", "1.000"), "1.999");
  });

  test("负 multiplier throw", () => {
    assert.throws(() => composeMultiplier("-1.000", "1.000"), TypeError);
    assert.throws(() => composeMultiplier("1.000", "-0.500"), TypeError);
  });

  test("malformed multiplier throw", () => {
    assert.throws(() => composeMultiplier("", "1.000"), TypeError);
    assert.throws(() => composeMultiplier("1.000", ""), TypeError);
    assert.throws(() => composeMultiplier("1.2.3", "1.000"), TypeError);
    assert.throws(() => composeMultiplier("abc", "1.000"), TypeError);
    assert.throws(() => composeMultiplier("1.0e2", "1.000"), TypeError);
    assert.throws(() => composeMultiplier(" 1.0 ", "1.000"), TypeError);  // 含空白
  });
});

describe("getAgentCostMultiplier", () => {
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
  });

  /** 极轻量 Pool 替身,只实现 query。 */
  function mockPool(rows: Array<{ cost_multiplier: string }>): {
    pool: Pool;
    queryCount: () => number;
    lastArgs: () => unknown[];
  } {
    let count = 0;
    let last: unknown[] = [];
    const pool = {
      query: async (text: string, params: unknown[]) => {
        count++;
        last = [text, params];
        return { rows, rowCount: rows.length };
      },
    } as unknown as Pool;
    return { pool, queryCount: () => count, lastArgs: () => last };
  }

  test("命中 DB → 返回 cost_multiplier 字符串", async () => {
    const { pool, queryCount } = mockPool([{ cost_multiplier: "1.500" }]);
    const result = await getAgentCostMultiplier(pool, "codex");
    assert.equal(result, "1.500");
    assert.equal(queryCount(), 1);
  });

  test("miss → 返回 \"1.000\"", async () => {
    const { pool, queryCount } = mockPool([]);
    const result = await getAgentCostMultiplier(pool, "unknown-agent");
    assert.equal(result, "1.000");
    assert.equal(queryCount(), 1);
  });

  test("cache 命中:同 agentId 第二次不查 DB", async () => {
    const { pool, queryCount } = mockPool([{ cost_multiplier: "1.500" }]);
    await getAgentCostMultiplier(pool, "codex");
    await getAgentCostMultiplier(pool, "codex");
    await getAgentCostMultiplier(pool, "codex");
    assert.equal(queryCount(), 1, "cache 命中后不应再查 DB");
  });

  test("不同 agentId 各自查一次,不串", async () => {
    // 同一个 mockPool 模拟两次返回不同值是不容易的,改用计数 fallback
    let calls = 0;
    const pool = {
      query: async (_text: string, params: unknown[]) => {
        calls++;
        const agentId = (params as string[])[0];
        if (agentId === "codex") return { rows: [{ cost_multiplier: "1.500" }], rowCount: 1 };
        if (agentId === "codex-gpt6") return { rows: [{ cost_multiplier: "2.000" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const a = await getAgentCostMultiplier(pool, "codex");
    const b = await getAgentCostMultiplier(pool, "codex-gpt6");
    const c = await getAgentCostMultiplier(pool, "claude");
    assert.equal(a, "1.500");
    assert.equal(b, "2.000");
    assert.equal(c, "1.000");
    assert.equal(calls, 3);
    // cache 命中
    assert.equal(await getAgentCostMultiplier(pool, "codex"), "1.500");
    assert.equal(calls, 3);
  });

  test("DB 异常 throw,不静默 fallback 到 1.000", async () => {
    const pool = {
      query: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Pool;
    await assert.rejects(() => getAgentCostMultiplier(pool, "codex"), /connection refused/);
  });

  test("SQL 参数化:agentId 走 $1 占位符", async () => {
    const { pool, lastArgs } = mockPool([{ cost_multiplier: "1.500" }]);
    await getAgentCostMultiplier(pool, "codex'; DROP TABLE users; --");
    const [text, params] = lastArgs();
    assert.match(text as string, /\$1/);
    assert.deepEqual(params, ["codex'; DROP TABLE users; --"]);
  });
});
