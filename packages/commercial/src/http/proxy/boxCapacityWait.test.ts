import test from "node:test";
import assert from "node:assert/strict";
import { waitingForBoxCapacity } from "./boxCapacityWait.js";

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
const held = () => new Error("BOX_CAPACITY_HELD");

test("OCV5-301 a capacity held by a settling turn is waited out, not rejected", async () => {
  const c = clock();
  let calls = 0;
  const value = await waitingForBoxCapacity(async () => {
    if (++calls < 4) throw held();
    return "admitted";
  }, new AbortController().signal, c);
  assert.equal(value, "admitted");
  assert.equal(calls, 4);
  assert.equal(c.now(), 250 + 500 + 1000, "exponential backoff");
});

test("the wait is bounded, abort-aware, and never retries other failures", async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(waitingForBoxCapacity(async () => { calls++; throw held(); },
    new AbortController().signal, { ...c, maxWaitMs: 10_000 }), /BOX_CAPACITY_HELD/);
  assert.ok(c.now() <= 10_000 && calls > 3);
  const aborted = new AbortController(); aborted.abort();
  calls = 0;
  await assert.rejects(waitingForBoxCapacity(async () => { calls++; throw held(); },
    aborted.signal, clock()), /BOX_CAPACITY_HELD/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(waitingForBoxCapacity(async () => { calls++;
    throw new Error("BOX_JOURNAL_BASIS_INVALID"); }, new AbortController().signal, clock()),
  /BASIS_INVALID/);
  assert.equal(calls, 1);
  // synchronous in-memory lease rejections are covered too
  let opens = 0;
  const lease = await waitingForBoxCapacity(() => {
    if (++opens === 1) throw new Error("BOX_SESSION_BUSY");
    return "lease";
  }, new AbortController().signal, clock());
  assert.equal(lease, "lease");
});

test("an abort during the backoff never makes another admission attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(waitingForBoxCapacity(async () => { calls++; throw held(); },
    controller.signal, { now: () => 0, sleep: async () => { controller.abort(); } }),
  /BOX_CAPACITY_HELD/);
  assert.equal(calls, 1);
});
