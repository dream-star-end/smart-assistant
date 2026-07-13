// 单元:LeaderBundle 幂等 start / 有界 stopAndDrain / start-then-fence 串行不漏 stop(RFC D4)。

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createLeaderBundle,
  LeaderBundleRollbackIncompleteError,
} from "../deploy/leaderBundle.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("LeaderBundle", () => {
  test("start 幂等:重复 start 每个成员只启动一次", async () => {
    const starts: string[] = [];
    const bundle = createLeaderBundle();
    bundle.add({ name: "a", domain: "shared", start: () => { starts.push("a"); return { stop: () => {} }; } });
    bundle.add({ name: "b", domain: "v5-owned", start: () => { starts.push("b"); return { stop: () => {} }; } });
    await bundle.start();
    await bundle.start();
    await bundle.start();
    assert.deepEqual(starts.sort(), ["a", "b"]);
    assert.equal(bundle.isRunning(), true);
    assert.deepEqual(bundle.runningNames().sort(), ["a", "b"]);
  });

  test("stopAndDrain 逐个 stop 并经 onMemberStopped 摘除;runningNames 清空;返回 drained:true", async () => {
    const stops: string[] = [];
    const removed: string[] = [];
    const bundle = createLeaderBundle({ onMemberStopped: (n) => removed.push(n) });
    bundle.add({ name: "a", domain: "shared", start: () => ({ stop: () => { stops.push("a"); } }) });
    bundle.add({ name: "b", domain: "shared", start: () => ({ stop: async () => { stops.push("b"); } }) });
    await bundle.start();
    const res = await bundle.stopAndDrain();
    assert.deepEqual(stops.sort(), ["a", "b"]);
    assert.deepEqual(removed.sort(), ["a", "b"]);
    assert.deepEqual(res, { drained: true, stuck: [] });
    assert.equal(bundle.isRunning(), false);
    assert.deepEqual(bundle.runningNames(), []);
  });

  test("重名 add 抛错(防同一调度器被登记两次)", () => {
    const bundle = createLeaderBundle();
    bundle.add({ name: "dup", domain: "shared", start: () => ({ stop: () => {} }) });
    assert.throws(() => bundle.add({ name: "dup", domain: "shared", start: () => ({ stop: () => {} }) }), /duplicate/);
  });

  test("有界 stopAndDrain 超时:返回 {drained:false, stuck}(BLOCKER 1:不谎报让位,leaseController 据此 fail-stop)", async () => {
    let stopStarted = false;
    const slowStop = new Promise<void>((res) => {
      // 慢 stop(400ms,ref timer):stopAndDrain 预算 100ms 应先返回,不等它完成。
      setTimeout(() => res(), 400);
    });
    const removed: string[] = [];
    const bundle = createLeaderBundle({ onMemberStopped: (n) => removed.push(n) });
    bundle.add({
      name: "slow",
      domain: "shared",
      start: () => ({ stop: () => { stopStarted = true; return slowStop; } }),
    });
    await bundle.start();
    const t0 = Date.now();
    const res = await bundle.stopAndDrain(100); // 100ms 预算 < 400ms stop
    const elapsed = Date.now() - t0;
    assert.equal(stopStarted, true);
    assert.ok(elapsed < 350, `stopAndDrain 应在预算附近返回(不等 stop 完成),实际 ${elapsed}ms`);
    // 核心断言(锁定 BLOCKER 1 修复的行为):超时 → drained:false + stuck=["slow"],**不摘除** stuck 成员。
    assert.equal(res.drained, false);
    assert.deepEqual(res.stuck, ["slow"]);
    assert.deepEqual(removed, [], "stuck 成员绝不 onMemberStopped 摘除(它可能仍在写共享状态)");
    assert.deepEqual(bundle.runningNames(), ["slow"], "stuck 成员保留在 running(不谎报已停)");
    assert.equal(bundle.isRunning(), false);
    await slowStop; // 等慢 stop 的 timer 结算,清理事件循环(避免 pending-promise 泄漏)
  });

  test("start 进行中被 stopAndDrain 抢占:串行屏障保证已起成员被 stop,不留孤儿", async () => {
    const gate = deferred<void>();
    const stops: string[] = [];
    let started = false;
    const bundle = createLeaderBundle();
    bundle.add({
      name: "slow",
      domain: "shared",
      start: async () => {
        await gate.promise; // 卡住 start
        started = true;
        return { stop: () => { stops.push("slow"); } };
      },
    });
    const startP = bundle.start();
    // 在 start 未完成时请求 stopAndDrain(串行:会排在 start 之后执行)。
    const stopP = bundle.stopAndDrain();
    gate.resolve(); // 放行 start
    await Promise.all([startP, stopP]);
    // slow 成员被 start 起来后,紧接的 stopAndDrain 必须把它 stop(零孤儿)。
    assert.equal(started, true);
    assert.deepEqual(stops, ["slow"]);
    assert.equal(bundle.isRunning(), false);
    assert.deepEqual(bundle.runningNames(), []);
  });

  test("required 成员 start 抛错 → 回滚已启动成员 + start reject(BLOCKER 1:start-all-or-fail)", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const removed: string[] = [];
    const bundle = createLeaderBundle({ onMemberStopped: (n) => removed.push(n) });
    bundle.add({ name: "ok1", domain: "shared", start: () => { starts.push("ok1"); return { stop: () => { stops.push("ok1"); } }; } });
    bundle.add({ name: "boom", domain: "shared", start: () => { throw new Error("boom"); } }); // required 默认 true
    bundle.add({ name: "ok2", domain: "shared", start: () => { starts.push("ok2"); return { stop: () => { stops.push("ok2"); } }; } });
    // required 成员起不来 → 整 bundle 回滚 + 抛(leaseController 据此 fail-stop,绝不带半启动 leader 运行)。
    await assert.rejects(() => bundle.start(), /boom/);
    assert.deepEqual(starts, ["ok1"], "boom 之后的 ok2 不再启动");
    assert.deepEqual(stops, ["ok1"], "已起的 ok1 被回滚 stop");
    assert.deepEqual(removed, ["ok1"]);
    assert.equal(bundle.isRunning(), false);
    assert.deepEqual(bundle.runningNames(), []);
  });

  test("required start 失败且回滚 stop 超时 → 保留 stuck 并抛 unsafe 错误供 lease fail-stop", async () => {
    const stopGate = deferred<void>();
    const removed: string[] = [];
    const bundle = createLeaderBundle({
      startupRollbackMs: 20,
      onMemberStopped: (n) => removed.push(n),
    });
    bundle.add({
      name: "started",
      domain: "shared",
      start: () => ({ stop: () => stopGate.promise }),
    });
    bundle.add({
      name: "boom",
      domain: "shared",
      start: () => { throw new Error("boom"); },
    });

    const keepAlive = setTimeout(() => {}, 100);
    try {
      await assert.rejects(
        () => bundle.start(),
        (err: unknown) => {
          assert.ok(err instanceof LeaderBundleRollbackIncompleteError);
          assert.deepEqual(err.stuck, ["started"]);
          return true;
        },
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.deepEqual(removed, [], "未确认 stop 成功时不得从 schedulerRegistry 摘除");
    assert.deepEqual(bundle.runningNames(), ["started"], "超时成员仍按可能在跑处理");

    stopGate.resolve();
    await bundle.stopAndDrain(100);
  });

  test("best-effort 成员(required:false)start 抛错不阻断其余(保留旧 eager 语义)", async () => {
    const starts: string[] = [];
    const bundle = createLeaderBundle();
    bundle.add({ name: "ok1", domain: "shared", start: () => { starts.push("ok1"); return { stop: () => {} }; } });
    bundle.add({ name: "boom", domain: "shared", required: false, start: () => { throw new Error("boom"); } });
    bundle.add({ name: "ok2", domain: "shared", start: () => { starts.push("ok2"); return { stop: () => {} }; } });
    await bundle.start();
    assert.deepEqual(starts.sort(), ["ok1", "ok2"]);
    assert.deepEqual(bundle.runningNames().sort(), ["ok1", "ok2"]); // boom 不在册
  });
});
