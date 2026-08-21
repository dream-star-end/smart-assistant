/**
 * turn_traces 登记单元测试:fire-and-forget 语义(成功落行/无 pool 空转/失败只 warn
 * 不抛)。观测面绝不拖垮对话主链路是硬约束。
 *
 * Run: npx tsx --test packages/commercial/src/ws/__tests__/turnTraces.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { recordTurnTrace, updateTurnTraceDispatch } from "../turnTraces.js";

const ROW = {
  traceId: "5abe495ea308943a99e853649297b1b5",
  userId: 1n,
  sessionKey: "agent:main:webchat:dm:webmrels3idbzdqjl",
  agentId: "main",
  model: "gpt-5.6-sol",
};

describe("recordTurnTrace", () => {
  it("有 pool → 以 ON CONFLICT DO NOTHING 形式插入全部字段", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Pool;
    recordTurnTrace(pool, undefined, ROW);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO turn_traces/);
    assert.match(calls[0].sql, /ON CONFLICT \(trace_id\) DO NOTHING/);
    assert.deepEqual(calls[0].params, [
      ROW.traceId,
      "1",
      ROW.sessionKey,
      "main",
      "gpt-5.6-sol",
      // 0170 durable turn dispatch:dispatch_id / request_id 纯展示列;分类阶段登记时未就绪 → NULL
      // (受理成功后由 updateTurnTraceDispatch fire-and-forget 回填)。
      null,
      null,
      null, // control-plane release absent in unit-test cwd
      null, // control-plane commit absent in unit-test cwd
      null, // bundle rev
      null, // client build
    ]);
  });

  it("无 pool → 空转不抛(生产未注 pgPool 的形态)", () => {
    assert.doesNotThrow(() => recordTurnTrace(undefined, undefined, ROW));
  });

  it("insert 失败 → 只 warn 不抛(观测面不拖垮对话面)", async () => {
    const warns: string[] = [];
    const pool = {
      query: () => Promise.reject(new Error("pg down")),
    } as unknown as Pool;
    recordTurnTrace(pool, (msg) => warns.push(msg), ROW);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(warns, ["turn-trace record failed"]);
  });

  it("agentId/model 缺省 → 落 NULL", async () => {
    const calls: Array<{ params: unknown[] }> = [];
    const pool = {
      query: (_sql: string, params: unknown[]) => {
        calls.push({ params });
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Pool;
    recordTurnTrace(pool, undefined, { traceId: "t", userId: 2n, sessionKey: "k" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls[0].params, ["t", "2", "k", null, null, null, null, null, null, null, null]);
  });

  it("updateTurnTraceDispatch → COALESCE 回填 dispatch_id/request_id(纯展示,不动主链)", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rowCount: 1 });
      },
    } as unknown as Pool;
    updateTurnTraceDispatch(pool, undefined, {
      traceId: "tr-1",
      dispatchId: "11111111-1111-4111-8111-111111111111",
      requestId: "br-1",
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /UPDATE turn_traces/);
    assert.match(calls[0].sql, /COALESCE\(dispatch_id, \$2\)/);
    assert.match(calls[0].sql, /COALESCE\(request_id, \$3\)/);
    assert.deepEqual(calls[0].params, ["tr-1", "11111111-1111-4111-8111-111111111111", "br-1"]);
  });

  it("updateTurnTraceDispatch 无 pool → 空转不抛", () => {
    assert.doesNotThrow(() =>
      updateTurnTraceDispatch(undefined, undefined, { traceId: "t", dispatchId: "d", requestId: "r" }),
    );
  });
});
