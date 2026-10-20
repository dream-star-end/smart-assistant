/**
 * ROB-8:短连接 ACK 有界重试。一次 PG 连接重置不该让 leader fail-stop;全部失败才交给调用方 fail-stop。
 * 只测重试 helper(controller 的 integ 测试需要真实 PG,见 leaderLease.integ.test.ts)。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACK_SHORT_CONN_RETRY_DELAYS_MS, writeAckShortConnWithRetry } from "../deploy/leaderLease.js";

function harness(results: boolean[]) {
  const sleeps: number[] = [];
  const warns: unknown[] = [];
  let calls = 0;
  const run = () =>
    writeAckShortConnWithRetry(
      async () => results[calls++] ?? false,
      ACK_SHORT_CONN_RETRY_DELAYS_MS,
      { warn: (_m, meta) => warns.push(meta) },
      async (ms) => {
        sleeps.push(ms);
      },
    );
  return { run, sleeps, warns, calls: () => calls };
}

describe("ROB-8 leader ACK 短连接重试", () => {
  test("默认 3 次尝试,间隔 250ms / 1s,总等待远小于 45s liveness", () => {
    assert.deepEqual([...ACK_SHORT_CONN_RETRY_DELAYS_MS], [250, 1_000]);
    assert.ok(ACK_SHORT_CONN_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) < 45_000);
  });
  test("首次成功:不重试", async () => {
    const h = harness([true]);
    assert.equal(await h.run(), true);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.sleeps, []);
  });
  test("一次连接重置后成功:不 fail-stop", async () => {
    const h = harness([false, true]);
    assert.equal(await h.run(), true);
    assert.equal(h.calls(), 2);
    assert.deepEqual(h.sleeps, [250]);
    assert.equal(h.warns.length, 1);
  });
  test("三次都失败:返回 false(调用方 fail-stop),不无限重试", async () => {
    const h = harness([false, false, false, true]);
    assert.equal(await h.run(), false);
    assert.equal(h.calls(), 3);
    assert.deepEqual(h.sleeps, [250, 1_000]);
  });
});
