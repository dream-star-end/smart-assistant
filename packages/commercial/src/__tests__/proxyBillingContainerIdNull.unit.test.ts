/**
 * V3 CC 外接 plan Phase 0 — `FinalizeContext.containerId: bigint | null` 基线测试。
 *
 * 跑法: npx tsx --test src/__tests__/proxyBillingContainerIdNull.unit.test.ts
 *
 * 目的:锁住 type 放宽后 `startInflightJournal` 的 SQL bind 行为,作为后续
 * ApiKeyIdentityStrategy 接入的回归基线。
 *
 * 覆盖:
 *   - containerId = bigint(容器路径)→ bind[2] = "<id>"(保留既有行为)
 *   - containerId = null(API key 路径)→ bind[2] = null(SQL 写 NULL)
 *   - 两次调用其它 bind 位完全相同,证明仅 container_id 列在 nullable 维度变化
 *
 * 不变量:
 *   - `request_finalize_journal.container_id BIGINT REFERENCES agent_containers(id)
 *     ON DELETE SET NULL`(migration 0015):SQL 层早已允许 NULL,本测试只锁 TS/JS
 *     绑定时正确产出 SQL NULL 而非字符串 "null"。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, QueryResult } from "pg";

import { startInflightJournal } from "../billing/proxyBilling.js";

interface QueryCall {
  text: string;
  values: unknown[];
}

function makeMockPool(): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  // 只 stub `query`,其它字段不被本测试触达;以 unknown 双 cast 满足 TS。
  const pool = {
    query: async (text: string, values: unknown[]): Promise<QueryResult> => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe("startInflightJournal — containerId nullable bind (CC 外接 plan Phase 0)", () => {
  test("containerId = bigint 时 SQL bind[2] = id.toString()(容器路径保留既有行为)", async () => {
    const { pool, calls } = makeMockPool();
    await startInflightJournal(pool, {
      requestId: "req-container-1",
      userId: 100n,
      containerId: 42n,
      model: "claude-sonnet-4-5",
      precheckCredits: 50n,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values[0], "req-container-1");
    assert.equal(calls[0].values[1], "100");
    assert.equal(calls[0].values[2], "42", "container_id bind 应为字符串 '42'");
    assert.equal(calls[0].values[4], "50");
  });

  test("containerId = null 时 SQL bind[2] = null(API key 路径写 SQL NULL)", async () => {
    const { pool, calls } = makeMockPool();
    await startInflightJournal(pool, {
      requestId: "req-apikey-1",
      userId: 100n,
      containerId: null,
      model: "claude-sonnet-4-5",
      precheckCredits: 50n,
    });
    assert.equal(calls.length, 1);
    // 关键:必须是 JS null,不能是字符串 "null" / "0" 等假阳性
    assert.strictEqual(calls[0].values[2], null, "container_id bind 必须为 JS null,pg 驱动会发出 SQL NULL");
    // 其它 bind 位与 bigint 路径一致
    assert.equal(calls[0].values[0], "req-apikey-1");
    assert.equal(calls[0].values[1], "100");
    assert.equal(calls[0].values[4], "50");
  });

  test("containerId = 0n 时 SQL bind[2] = '0'(防 truthy/falsy 分支误写)", async () => {
    // NIT 钉子:确保实现走的是 `=== null` 判定,不是 truthy/falsy。
    // 0n 是合法 BIGINT 值(虽然实际 agent_containers.id 不会是 0),
    // 一旦未来有人手滑改成 `ctx.containerId ? .toString() : null`,这条会立刻爆。
    const { pool, calls } = makeMockPool();
    await startInflightJournal(pool, {
      requestId: "req-zero",
      userId: 100n,
      containerId: 0n,
      model: "claude-sonnet-4-5",
      precheckCredits: 50n,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values[2], "0", "container_id = 0n 必须 bind 为字符串 '0',不能被当 null 处理");
  });

  test("两路径只在 container_id 维度不同,其它 bind 完全对齐", async () => {
    const { pool: poolA, calls: callsA } = makeMockPool();
    const { pool: poolB, calls: callsB } = makeMockPool();
    const sharedCtx = {
      requestId: "req-shared",
      userId: 200n,
      model: "claude-opus-4-7",
      precheckCredits: 123n,
    };
    await startInflightJournal(poolA, { ...sharedCtx, containerId: 7n });
    await startInflightJournal(poolB, { ...sharedCtx, containerId: null });
    // SQL text 相同
    assert.equal(callsA[0].text, callsB[0].text);
    // values 长度相同
    assert.equal(callsA[0].values.length, callsB[0].values.length);
    // 除了 [2](container_id)之外,其它位完全一致
    for (let i = 0; i < callsA[0].values.length; i++) {
      if (i === 2) continue;
      assert.deepStrictEqual(
        callsA[0].values[i],
        callsB[0].values[i],
        `bind 位 [${i}] 不应受 containerId nullable 影响`,
      );
    }
    assert.equal(callsA[0].values[2], "7");
    assert.strictEqual(callsB[0].values[2], null);
  });
});
