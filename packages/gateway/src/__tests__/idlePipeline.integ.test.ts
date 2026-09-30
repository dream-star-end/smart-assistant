/**
 * OCV5-296 idle chain, five cases. grow2 and seam live in their own files
 * so a shard can run this file without the long live chains. Assertions
 * stay in the shared fixture. This file registers no extra cases.
 */
import test from "node:test";

import { runIdleCase } from "./fixtures/idlePipelineFixture.js";

let idleQueue: Promise<void> = Promise.resolve();
function queueIdle(name: string, timeout: number, mode: "short" | "fresh"): void {
  const previous = idleQueue;
  let release = (): void => {};
  idleQueue = new Promise<void>((resolve) => { release = resolve; });
  test(name, { timeout }, async () => {
    await previous;
    try { await runIdleCase(mode); }
    finally { release(); }
  });
}

queueIdle("real submit reaches a short idle no-op without a summary HTTP", 300_000, "short");
queueIdle("fresh stock summary and business roots short-close through terminal_set", 900_000, "fresh");
test("live tool continuation keeps the persisted deferred-tools announcement", { timeout: 300_000 }, () => runIdleCase("live2"));
test("local catalog fixture accepts a dedicated idle request and rejects drift", { timeout: 600_000 }, () => runIdleCase("localAuth"));
test("source and summary COMMIT barriers reach apply and next user", { timeout: 900_000 }, () => runIdleCase("barriers"));
