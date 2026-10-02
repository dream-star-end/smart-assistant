import test from "node:test";
import assert from "node:assert/strict";
import { waitForBoxReplay } from "./boxReplayWait.js";

type R = { kind: "pending" | "ready" | "missing" };
const clock = () => { let t = 0; return { now: () => t,
  sleep: async (ms: number) => { t += ms; } }; };

test("a still-resolving Box call is awaited until its replay is ready", async () => {
  const c = clock(); const seq: R[] = [{ kind: "pending" }, { kind: "ready" }];
  let lookups = 0;
  const out = await waitForBoxReplay<R>({ kind: "pending" }, async () => { lookups++; return seq.shift()!; },
    { budgetMs: 60_000, intervalMs: 3_000, signal: new AbortController().signal, ...c });
  assert.equal(out.kind, "ready");
  assert.equal(lookups, 2);
});

test("the wait is bounded by its budget and keeps the pending answer", async () => {
  const c = clock(); let lookups = 0;
  const out = await waitForBoxReplay<R>({ kind: "pending" }, async () => { lookups++; return { kind: "pending" }; },
    { budgetMs: 10_000, intervalMs: 3_000, signal: new AbortController().signal, ...c });
  assert.equal(out.kind, "pending");
  assert.equal(lookups, 3);
  assert.ok(c.now() <= 10_000);
});

test("non-pending results and a gone client never wait", async () => {
  let lookups = 0;
  const lookup = async (): Promise<R> => { lookups++; return { kind: "ready" }; };
  assert.equal((await waitForBoxReplay<R>({ kind: "missing" }, lookup,
    { budgetMs: 10_000, intervalMs: 1_000, signal: new AbortController().signal, ...clock() })).kind, "missing");
  const gone = new AbortController(); gone.abort();
  assert.equal((await waitForBoxReplay<R>({ kind: "pending" }, lookup,
    { budgetMs: 10_000, intervalMs: 1_000, signal: gone.signal, ...clock() })).kind, "pending");
  assert.equal(lookups, 0);
});
