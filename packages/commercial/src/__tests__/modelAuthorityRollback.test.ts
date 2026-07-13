import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  runModelAuthorityContainerRollback,
  type ModelAuthorityRollbackState,
  type ModelAuthorityRollbackTarget,
} from "../agent-sandbox/modelAuthorityRollback.js";

interface HarnessOptions {
  scans: Array<ModelAuthorityRollbackState[] | Error>;
  drains?: Array<"accepted" | "busy" | "failed">;
  cleanupFails?: Set<number | string>;
}

function harness(options: HarnessOptions) {
  let now = 0;
  let scanIndex = 0;
  let drainIndex = 0;
  const drained: Array<number | string> = [];
  const cleaned: Array<number | string> = [];
  const scanCalls: number[] = [];
  const targets = (states: ModelAuthorityRollbackState[]): ModelAuthorityRollbackTarget[] =>
    states.map((state, index) => ({ id: index + 1, state }));

  return {
    drained,
    cleaned,
    scanCalls,
    deps: {
      async scan() {
        scanCalls.push(now);
        const value = options.scans[Math.min(scanIndex, options.scans.length - 1)]!;
        scanIndex += 1;
        if (value instanceof Error) throw value;
        return targets(value);
      },
      async drain(target: ModelAuthorityRollbackTarget) {
        drained.push(target.id);
        const result = options.drains?.[Math.min(drainIndex, (options.drains?.length ?? 1) - 1)]
          ?? "accepted";
        drainIndex += 1;
        return result;
      },
      async cleanup(target: ModelAuthorityRollbackTarget) {
        cleaned.push(target.id);
        if (options.cleanupFails?.has(target.id)) throw new Error("cleanup failed");
      },
      now: () => now,
      async sleep(ms: number) {
        now += ms;
      },
    },
  };
}

describe("model authority container rollback", () => {
  test("instant empty census still requires a real 20s quiet window", async () => {
    const h = harness({ scans: [[]] });
    const result = await runModelAuthorityContainerRollback(h.deps, {
      timeoutMs: 30_000,
      quietMs: 20_000,
      pollMs: 1_000,
    });
    assert.ok(result.elapsedMs >= 20_000);
    assert.ok(h.scanCalls.length >= 21);
  });

  test("a late flagged tail resets quiet and only accepted drain permits cleanup", async () => {
    const h = harness({
      scans: [
        [], [], [], [], [],
        ["flagged_running"],
        ["flagged_running"],
        [],
      ],
      drains: ["busy", "accepted"],
    });
    const result = await runModelAuthorityContainerRollback(h.deps, {
      timeoutMs: 35_000,
      quietMs: 15_000,
      pollMs: 1_000,
    });
    assert.deepEqual(h.drained, [1, 1]);
    assert.deepEqual(h.cleaned, [1]);
    assert.ok(result.elapsedMs >= 22_000, "late tail must restart the 15s quiet window");
  });

  test("provisioning and unknown are never drained or deleted and prevent success", async () => {
    for (const state of ["provisioning", "unknown"] as const) {
      const h = harness({ scans: [[state]] });
      await assert.rejects(
        runModelAuthorityContainerRollback(h.deps, {
          timeoutMs: 5_000,
          quietMs: 2_000,
          pollMs: 1_000,
        }),
        /timed out/,
      );
      assert.deepEqual(h.drained, []);
      assert.deepEqual(h.cleaned, []);
    }
  });

  test("stopped/missing clean directly; scan errors reset quiet without deletion", async () => {
    const h = harness({
      scans: [
        ["flagged_stopped", "missing"],
        [],
        new Error("docker unavailable"),
        [],
      ],
    });
    const result = await runModelAuthorityContainerRollback(h.deps, {
      timeoutMs: 20_000,
      quietMs: 5_000,
      pollMs: 1_000,
    });
    assert.deepEqual(h.drained, []);
    assert.deepEqual(h.cleaned, [1, 2]);
    assert.ok(result.elapsedMs >= 8_000, "scan error must reset the prior quiet window");
  });

  test("busy/failed running container times out without cleanup", async () => {
    const h = harness({ scans: [["flagged_running"]], drains: ["failed"] });
    await assert.rejects(
      runModelAuthorityContainerRollback(h.deps, {
        timeoutMs: 4_000,
        quietMs: 2_000,
        pollMs: 1_000,
      }),
      /timed out/,
    );
    assert.ok(h.drained.length > 0);
    assert.deepEqual(h.cleaned, []);
  });

  test("work crossing the hard deadline can never return quiet success", async () => {
    let now = 0;
    let scans = 0;
    await assert.rejects(
      runModelAuthorityContainerRollback(
        {
          async scan() {
            scans += 1;
            if (scans === 2) now += 10_000;
            return [];
          },
          async drain() { return "accepted"; },
          async cleanup() {},
          now: () => now,
          async sleep(ms: number) { now += ms; },
        },
        { timeoutMs: 5_000, quietMs: 2_000, pollMs: 1_000 },
      ),
      /timed out/,
    );
    assert.equal(scans, 2);
  });
});
