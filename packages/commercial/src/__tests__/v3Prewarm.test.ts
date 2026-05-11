/**
 * agent-sandbox/v3prewarm.ts 单测。
 *
 * 覆盖的关键不变量(handler 层 fire-and-forget 调用的安全前提):
 *   1) success path:ensureRunning resolve 时不 log warn,prewarm 同步 return
 *   2) reject path:ensureRunning reject 时被 .catch 接住,warn 写一行,
 *      调用方拿到的仍是 void,不 throw,不产生 unhandledRejection
 *   3) 多次调用独立:同一 prewarm 函数能被反复调用,每次 reject 各自 log
 *
 * 这条单测的存在动机:防止有人后续把
 *   `void ensureRunning(uid).catch(...)` 误改为
 *   `try { ensureRunning(uid); } catch (...) { ... }` —— 后者接不住 async
 *   rejection,gateway 会因 unhandledRejection crash(strict process 配置)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { makePrewarmContainer } from "../agent-sandbox/v3prewarm.js";

interface WarnCall {
  msg: string;
  fields?: Record<string, unknown>;
}

function makeWarnSpy(): { calls: WarnCall[]; log: { warn: (msg: string, fields?: Record<string, unknown>) => void } } {
  const calls: WarnCall[] = [];
  return {
    calls,
    log: { warn: (msg, fields) => { calls.push({ msg, fields }); } },
  };
}

describe("makePrewarmContainer", () => {
  test("success: resolve 时不 log,同步 return void", async () => {
    const spy = makeWarnSpy();
    const ensureRunning = async (_uid: bigint): Promise<{ ok: true }> => ({ ok: true });

    const prewarm = makePrewarmContainer(ensureRunning, spy.log);
    const ret = prewarm(123n);
    assert.equal(ret, undefined, "prewarm 同步必须 return void");

    // 让 microtask + macrotask queue 都跑完
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spy.calls.length, 0, "resolve 路径不应 log warn");
  });

  test("reject: async rejection 被 .catch 接住,写一行 warn,不抛", async () => {
    const spy = makeWarnSpy();
    const boom = new Error("docker daemon unreachable");
    const ensureRunning = async (_uid: bigint): Promise<never> => { throw boom; };

    const prewarm = makePrewarmContainer(ensureRunning, spy.log);

    // 关键不变量:同步调用不抛(即使 ensureRunning 内会 reject)
    assert.doesNotThrow(() => prewarm(456n));

    // 等 rejection microtask 流转到 .catch
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(spy.calls.length, 1, "reject 应触发恰好 1 行 warn");
    assert.equal(spy.calls[0]!.msg, "prewarm failed");
    assert.equal(spy.calls[0]!.fields?.uid, "456");
    assert.equal(spy.calls[0]!.fields?.error, "docker daemon unreachable");
  });

  test("reject: 非 Error 抛出值也能转 string,不二次抛", async () => {
    const spy = makeWarnSpy();
    // 故意抛非 Error(实战中 rare,但 ts 类型允许)
    const ensureRunning = async (_uid: bigint): Promise<never> => { throw "string error"; };

    const prewarm = makePrewarmContainer(ensureRunning, spy.log);
    assert.doesNotThrow(() => prewarm(789n));

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]!.fields?.error, "string error");
  });

  test("多次调用独立 reject,各自 log,前后互不污染", async () => {
    const spy = makeWarnSpy();
    let n = 0;
    const ensureRunning = async (uid: bigint): Promise<unknown> => {
      n += 1;
      // 偶数 uid resolve,奇数 reject
      if (uid % 2n === 0n) return { ok: true };
      throw new Error(`fail-${uid}`);
    };

    const prewarm = makePrewarmContainer(ensureRunning, spy.log);
    prewarm(1n);
    prewarm(2n);
    prewarm(3n);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(n, 3, "ensureRunning 应被调用 3 次");
    assert.equal(spy.calls.length, 2, "仅奇数 uid 的 2 次 reject 写 warn");
    const uids = spy.calls.map((c) => c.fields?.uid).sort();
    assert.deepEqual(uids, ["1", "3"]);
  });
});
