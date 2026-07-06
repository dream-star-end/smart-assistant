/**
 * commercial/db createPool — checked-out client 'error' 兜底(2026-07-06 事故根治)。
 *
 * 事故根因:provision 事务在 BEGIN 后跨 docker create+start 全程持连(checked-out +
 * idle-in-transaction),PG `idle_in_transaction_session_timeout` 到期强断连 → pg 在
 * CLIENT 对象 emit 'error'。`Pool#error` 只覆盖 pool 内 idle client,覆盖不到
 * checked-out client;无监听的 EventEmitter 'error' → 进程级 uncaughtException →
 * gateway 紧急关停。
 *
 * 修复:createPool 用 `Pool#connect` 给每个新 client 挂贯穿生命周期的 no-op 'error'
 * 监听(结构化日志,不退出)。
 *
 * 本单测不连真 PG:createPool 传显式 connectionString(new Pool 惰性,不建连),
 * 手动在 pool 上 emit 'connect'(触发 createPool 注册的 connect 监听 → 给 fake client
 * 挂 'error' 监听),再在 fake client 上 emit 'error' 验证**不冒 uncaughtException**。
 */

import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { createPool } from "../db/index.js";

const DUMMY_CONN = "postgres://u:p@127.0.0.1:5432/does_not_connect";

describe("createPool — checked-out client 'error' 兜底(不崩进程)", () => {
  test("控制组:裸 EventEmitter 无 'error' 监听 → emit('error') 抛出(证明机制真实)", () => {
    const bare = new EventEmitter();
    assert.throws(() => bare.emit("error", new Error("boom")));
  });

  test("Pool#connect 给每个 client 挂 'error' 监听 → server-terminated 不冒 uncaughtException", async () => {
    const errSpy = mock.method(console, "error", () => {});
    const pool = createPool({ connectionString: DUMMY_CONN }) as unknown as Pool & EventEmitter;
    try {
      // 模拟 pg 新建连接:pool emit 'connect' → createPool 注册的 connect 监听给 client
      // 挂上贯穿生命周期的 'error' 监听。
      const fakeClient = new EventEmitter();
      (pool as unknown as EventEmitter).emit("connect", fakeClient);

      // 该 client 现在处于 checked-out + idle-in-transaction 被 PG 强断的等价场景:
      // 在其上 emit 'error'。若无监听会同步抛(见控制组);有监听则被吞成日志。
      assert.equal(fakeClient.listenerCount("error"), 1, "connect 后 client 必须有恰一个 'error' 监听");
      assert.doesNotThrow(() =>
        fakeClient.emit(
          "error",
          new Error("terminating connection due to idle-in-transaction timeout"),
        ),
      );
      // 结构化日志被调用一次(不退出)。
      assert.ok(
        errSpy.mock.calls.some((c) =>
          String(c.arguments[0] ?? "").includes("client error"),
        ),
        "应落一条 client error 结构化日志",
      );
    } finally {
      errSpy.mock.restore();
      await pool.end();
    }
  });

  test("Pool 本身仍保留 idle client 'error' 监听(既有兜底不回归)", async () => {
    const pool = createPool({ connectionString: DUMMY_CONN }) as unknown as Pool & EventEmitter;
    try {
      assert.ok(
        (pool as unknown as EventEmitter).listenerCount("error") >= 1,
        "pool 级 'error' 监听必须在位",
      );
    } finally {
      await pool.end();
    }
  });
});
