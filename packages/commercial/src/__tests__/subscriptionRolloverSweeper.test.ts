import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startSubscriptionRolloverSweeper } from "../billing/subscriptionRolloverSweeper.js";

const emptyDrain = async () => [] as bigint[];
const noLowBalance = async () => 0;

describe("subscription rollover billing-reconciliation cadence", () => {
  test("boot, timer, and runNow overlap share one slow reconciliation", async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = startSubscriptionRolloverSweeper({
      intervalMs: 1_000,
      runOnStart: true,
      rolloverFn: emptyDrain,
      orgRolloverFn: emptyDrain,
      lowBalanceFn: noLowBalance,
      reconcileEveryMs: 60_000,
      reconcileFn: async () => {
        calls += 1;
        await pending;
        return 1;
      },
    });
    try {
      const manual = handle.runNow();
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      assert.equal(calls, 1, "boot/timer/runNow must not start duplicate SQL scans");
      release();
      await manual;
    } finally {
      release();
      handle.stop();
    }
  });

  test("success keeps the daily deadline; failure retries on the next tick cadence", async () => {
    let now = 10_000;
    let calls = 0;
    const errors: unknown[] = [];
    const handle = startSubscriptionRolloverSweeper({
      intervalMs: 1_000,
      runOnStart: false,
      rolloverFn: emptyDrain,
      orgRolloverFn: emptyDrain,
      lowBalanceFn: noLowBalance,
      reconcileEveryMs: 60_000,
      nowFn: () => now,
      onError: (error) => errors.push(error),
      reconcileFn: async () => {
        calls += 1;
        if (calls === 1) throw new Error("read failed");
        return 2;
      },
    });
    try {
      assert.equal(await handle.runNow(), 0);
      assert.equal(calls, 1);
      assert.equal(errors.length, 1);

      now += 999;
      assert.equal(await handle.runNow(), 0);
      assert.equal(calls, 1);
      now += 1;
      assert.equal(await handle.runNow(), 2);
      assert.equal(calls, 2);

      now += 59_999;
      assert.equal(await handle.runNow(), 0);
      assert.equal(calls, 2);
      now += 1;
      assert.equal(await handle.runNow(), 2);
      assert.equal(calls, 3);
    } finally {
      handle.stop();
    }
  });

  test("reconciliation failure does not starve the other three sweep domains", async () => {
    const calls: string[] = [];
    const handle = startSubscriptionRolloverSweeper({
      runOnStart: false,
      rolloverFn: async () => {
        calls.push("personal");
        return [];
      },
      orgRolloverFn: async () => {
        calls.push("org");
        return [];
      },
      lowBalanceFn: async () => {
        calls.push("low");
        return 3;
      },
      reconcileFn: async () => {
        calls.push("reconcile");
        throw new Error("read failed");
      },
      onError: () => {},
    });
    try {
      assert.equal(await handle.runNow(), 3);
      assert.deepEqual(calls, ["personal", "org", "low", "reconcile"]);
    } finally {
      handle.stop();
    }
  });
});
