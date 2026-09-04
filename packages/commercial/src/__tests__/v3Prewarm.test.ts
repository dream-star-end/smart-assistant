/**
 * agent-sandbox/v3prewarm.ts 单测。
 *
 * 覆盖的关键不变量(handler 层 fire-and-forget 调用的安全前提):
 *   1) success path:ensureRunning resolve 时不 log warn,prewarm 同步 return
 *   2) reject path:ensureRunning 两次都 reject 时被接住,warn 写一行,
 *      调用方拿到的仍是 void,不 throw,不产生 unhandledRejection
 *   3) 首次失败 + 重试成功:不 log,不记 friction
 *   4) 多次调用独立:同一 prewarm 函数能被反复调用,每次 reject 各自 log
 *
 * 这条单测的存在动机:防止有人后续把
 *   `void ensureRunning(uid).catch(...)` 误改为
 *   `try { ensureRunning(uid); } catch (...) { ... }` —— 后者接不住 async
 *   rejection,gateway 会因 unhandledRejection crash(strict process 配置)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { makePrewarmContainer, PREWARM_RETRY_DELAY_MS } from "../agent-sandbox/v3prewarm.js";

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

async function flush(): Promise<void> {
  // retryDelayMs=0 still hops a macrotask; wait long enough for first fail + retry.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe("makePrewarmContainer", () => {
  test("default retry delay is 5s", () => {
    assert.equal(PREWARM_RETRY_DELAY_MS, 5_000);
  });

  test("success: resolve 时不 log,同步 return void", async () => {
    const spy = makeWarnSpy();
    const ensureRunning = async (_uid: bigint): Promise<{ ok: true }> => ({ ok: true });

    const prewarm = makePrewarmContainer(ensureRunning, spy.log, undefined, { retryDelayMs: 0 });
    const ret = prewarm(123n);
    assert.equal(ret, undefined, "prewarm 同步必须 return void");

    await flush();
    assert.equal(spy.calls.length, 0, "resolve 路径不应 log warn");
  });

  test("reject then retry success: 不 warn、不记 friction", async () => {
    const spy = makeWarnSpy();
    let n = 0;
    const ensureRunning = async (_uid: bigint): Promise<{ ok: true }> => {
      n += 1;
      if (n === 1) throw new Error("docker daemon unreachable");
      return { ok: true };
    };
    const failures: Array<{ userId: bigint; correlation: string; latencyMs: number }> = [];
    const prewarm = makePrewarmContainer(ensureRunning, spy.log, (input) => failures.push(input), {
      retryDelayMs: 0,
    });
    assert.doesNotThrow(() => prewarm(456n));
    await flush();
    assert.equal(n, 2, "失败后应再试 1 次");
    assert.equal(spy.calls.length, 0, "重试成功不写 warn");
    assert.equal(failures.length, 0, "重试成功不记 friction");
  });

  test("reject twice: async rejection 被接住,写一行 warn,记 friction,不抛", async () => {
    const spy = makeWarnSpy();
    const boom = new Error("docker daemon unreachable");
    const ensureRunning = async (_uid: bigint): Promise<never> => { throw boom; };
    const failures: Array<{ userId: bigint; correlation: string; latencyMs: number }> = [];

    const prewarm = makePrewarmContainer(ensureRunning, spy.log, (input) => failures.push(input), {
      retryDelayMs: 0,
    });

    assert.doesNotThrow(() => prewarm(456n));
    await flush();

    assert.equal(spy.calls.length, 1, "两次都失败才写 1 行 warn");
    assert.equal(spy.calls[0]!.msg, "prewarm failed");
    assert.equal(spy.calls[0]!.fields?.uid, "456");
    assert.equal(spy.calls[0]!.fields?.errorClass, "Error");
    assert.equal(spy.calls[0]!.fields?.error, undefined, "原始异常文本不得进入日志");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.userId, 456n);
    assert.match(failures[0]!.correlation, /^456:\d+$/);
    assert.ok(failures[0]!.latencyMs >= 0);
  });

  test("reject: 非 Error 抛出值也能转 string,不二次抛", async () => {
    const spy = makeWarnSpy();
    const ensureRunning = async (_uid: bigint): Promise<never> => { throw "string error"; };

    const prewarm = makePrewarmContainer(ensureRunning, spy.log, undefined, { retryDelayMs: 0 });
    assert.doesNotThrow(() => prewarm(789n));

    await flush();
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]!.fields?.errorClass, "string");
    assert.equal(spy.calls[0]!.fields?.error, undefined);
  });

  test("多次调用独立 reject,各自 log,前后互不污染", async () => {
    const spy = makeWarnSpy();
    let n = 0;
    const ensureRunning = async (uid: bigint): Promise<unknown> => {
      n += 1;
      if (uid % 2n === 0n) return { ok: true };
      throw new Error(`fail-${uid}`);
    };

    const prewarm = makePrewarmContainer(ensureRunning, spy.log, undefined, { retryDelayMs: 0 });
    prewarm(1n);
    prewarm(2n);
    prewarm(3n);

    const deadline = Date.now() + 200;
    while (Date.now() < deadline && n < 5) {
      await flush();
    }

    // odd uids fail twice (retry), even uid succeeds once
    assert.equal(n, 5, "奇数 uid 各 2 次 + 偶数 uid 1 次");
    assert.equal(spy.calls.length, 2, "仅奇数 uid 的 2 次终态失败写 warn");
    const uids = spy.calls.map((c) => c.fields?.uid).sort();
    assert.deepEqual(uids, ["1", "3"]);
  });
});
