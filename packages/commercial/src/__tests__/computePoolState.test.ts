/**
 * 0042 — compute-pool/poolState.ts 单测。
 *
 * 用 mock pg client 验证:
 *   - getPoolState parses BIGINT master_epoch 为 bigint
 *   - getPoolState row missing → 抛 explicit "migration 0042 not applied" 错
 *   - setDesiredImage SQL 发出 + 解析 changed=true 路径
 *   - setDesiredImage no-change 路径 changed=false,epoch 保持
 *
 * 不直连 PG;CTE/CASE 行为归 integ。
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { getPoolState, setDesiredImage } from "../compute-pool/poolState.js";
import { setPoolOverride, resetPool } from "../db/index.js";

class FakePool {
  // 测试设置:模拟 SELECT 与 UPDATE+SELECT(CTE)。
  rows: Array<Record<string, unknown>> = [];
  // setDesiredImage 触发的下一次 query 返回值,由 test 设置
  nextSelectResp: { rows: Array<Record<string, unknown>>; rowCount: number } = {
    rows: [],
    rowCount: 0,
  };
  nextCtereSelectResp: { rows: Array<Record<string, unknown>>; rowCount: number } = {
    rows: [],
    rowCount: 0,
  };
  // 用 toggle 区分两种调用(getPoolState 走 nextSelectResp,setDesiredImage CTE 走 nextCtereSelectResp)
  recorded: Array<{ sql: string; params: unknown[] }> = [];
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    this.recorded.push({ sql, params });
    if (/WITH prev AS/.test(sql)) {
      return this.nextCtereSelectResp;
    }
    return this.nextSelectResp;
  }
  async end(): Promise<void> {
    /* noop */
  }
}

let fp: FakePool;
beforeEach(() => {
  fp = new FakePool();
  setPoolOverride(fp as unknown as Pool);
});
afterEach(async () => {
  await resetPool();
});

describe("getPoolState", () => {
  test("正常解析:master_epoch 字符串 → bigint", async () => {
    fp.nextSelectResp = {
      rows: [
        {
          desired_image_id: "sha256:aaa",
          desired_image_tag: "openclaude-runtime:v3.0.42",
          master_epoch: "7",
          updated_at: new Date("2026-04-25T10:00:00Z"),
        },
      ],
      rowCount: 1,
    };
    const r = await getPoolState();
    assert.equal(r.desiredImageId, "sha256:aaa");
    assert.equal(r.desiredImageTag, "openclaude-runtime:v3.0.42");
    assert.equal(typeof r.masterEpoch, "bigint");
    assert.equal(r.masterEpoch, 7n);
    // SELECT 必须 WHERE singleton='singleton'
    assert.match(fp.recorded[0]!.sql, /singleton/);
  });

  test("row 不存在 → 显式抛 migration 提示", async () => {
    fp.nextSelectResp = { rows: [], rowCount: 0 };
    await assert.rejects(getPoolState(), /migration 0042 not applied/);
  });

  test("desired_image_id null 也合法(初始空状态)", async () => {
    fp.nextSelectResp = {
      rows: [
        {
          desired_image_id: null,
          desired_image_tag: null,
          master_epoch: "0",
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    };
    const r = await getPoolState();
    assert.equal(r.desiredImageId, null);
    assert.equal(r.desiredImageTag, null);
    assert.equal(r.masterEpoch, 0n);
  });
});

describe("setDesiredImage", () => {
  test("changed=true 路径:返回 newEpoch = previousEpoch + 1", async () => {
    fp.nextCtereSelectResp = {
      rows: [
        {
          prev_image_id: "sha256:old",
          prev_image_tag: "openclaude-runtime:v3.0.41",
          prev_epoch: "5",
          new_epoch: "6",
          changed: true,
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    };
    const r = await setDesiredImage("sha256:new", "openclaude-runtime:v3.0.42");
    assert.equal(r.changed, true);
    assert.equal(r.previousEpoch, 5n);
    assert.equal(r.newEpoch, 6n);
    assert.equal(r.previous.desiredImageId, "sha256:old");
    // SQL 必须含 IS DISTINCT FROM 才能正确 detect 变化
    assert.match(fp.recorded[0]!.sql, /IS DISTINCT FROM/);
    // params 顺序:$1=imageId,$2=imageTag
    assert.deepEqual(fp.recorded[0]!.params, ["sha256:new", "openclaude-runtime:v3.0.42"]);
  });

  test("changed=false 路径:newEpoch 保持不变", async () => {
    fp.nextCtereSelectResp = {
      rows: [
        {
          prev_image_id: "sha256:same",
          prev_image_tag: "openclaude-runtime:v3.0.42",
          prev_epoch: "5",
          new_epoch: "5",
          changed: false,
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    };
    const r = await setDesiredImage("sha256:same", "openclaude-runtime:v3.0.42");
    assert.equal(r.changed, false);
    assert.equal(r.previousEpoch, 5n);
    assert.equal(r.newEpoch, 5n);
  });

  test("singleton row 缺失 → 抛错", async () => {
    fp.nextCtereSelectResp = { rows: [], rowCount: 0 };
    await assert.rejects(
      setDesiredImage("sha256:x", "x"),
      /singleton missing during setDesiredImage/,
    );
  });
});
