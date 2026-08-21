/**
 * liveFrameMaintenanceScheduler 调度行为(不依赖 PG)。
 *
 * 维护 SQL 本身由 liveTurnFrames 既有测试覆盖;这里只测接线层:
 * 会调用 prune/retire、重叠 tick 跳过、单次失败不停摆、disabled 开关。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_PRUNE_MAX_BATCHES,
  DEFAULT_RETIRE_MIN_AGE_MS,
  MAX_PRUNE_MAX_BATCHES,
  MIN_INTERVAL_MS,
  resolveLiveFrameMaintenanceDisabled,
  resolveLiveFrameMaintenanceIntervalMs,
  resolvePruneMaxBatches,
  resolveRetireMinAgeMs,
  startLiveFrameMaintenanceScheduler,
} from "../db/liveFrameMaintenanceScheduler.js";

const fakePool = {} as Pool;

describe("resolveLiveFrameMaintenanceDisabled", () => {
  test("仅 '1' 关闭,缺省/其它值保持开启", () => {
    assert.equal(resolveLiveFrameMaintenanceDisabled("1"), true);
    assert.equal(resolveLiveFrameMaintenanceDisabled("0"), false);
    assert.equal(resolveLiveFrameMaintenanceDisabled(undefined), false);
    assert.equal(resolveLiveFrameMaintenanceDisabled("true"), false);
  });
});

describe("resolveLiveFrameMaintenanceIntervalMs", () => {
  test("缺省/过小/非法 → 1h 默认", () => {
    assert.equal(resolveLiveFrameMaintenanceIntervalMs(undefined), DEFAULT_INTERVAL_MS);
    assert.equal(resolveLiveFrameMaintenanceIntervalMs(1_000), DEFAULT_INTERVAL_MS);
    assert.equal(resolveLiveFrameMaintenanceIntervalMs("abc"), DEFAULT_INTERVAL_MS);
    assert.equal(resolveLiveFrameMaintenanceIntervalMs(1e100), DEFAULT_INTERVAL_MS);
  });
  test("合法 env 采用,且不低于 1min", () => {
    assert.equal(resolveLiveFrameMaintenanceIntervalMs(MIN_INTERVAL_MS), MIN_INTERVAL_MS);
    assert.equal(resolveLiveFrameMaintenanceIntervalMs(2 * 3_600_000), 2 * 3_600_000);
  });
});

describe("resolvePruneMaxBatches / resolveRetireMinAgeMs", () => {
  test("maxBatches 缺省/非法 → 20,封到 200", () => {
    assert.equal(resolvePruneMaxBatches(undefined), DEFAULT_PRUNE_MAX_BATCHES);
    assert.equal(resolvePruneMaxBatches(0), DEFAULT_PRUNE_MAX_BATCHES);
    assert.equal(resolvePruneMaxBatches("abc"), DEFAULT_PRUNE_MAX_BATCHES);
    assert.equal(resolvePruneMaxBatches(1e100), DEFAULT_PRUNE_MAX_BATCHES);
    assert.equal(resolvePruneMaxBatches(7), 7);
    assert.equal(resolvePruneMaxBatches(MAX_PRUNE_MAX_BATCHES * 10), MAX_PRUNE_MAX_BATCHES);
  });
  test("retire minAge 只允许 ≥2h,非法回落 2h", () => {
    assert.equal(resolveRetireMinAgeMs(undefined), DEFAULT_RETIRE_MIN_AGE_MS);
    assert.equal(resolveRetireMinAgeMs(1_000), DEFAULT_RETIRE_MIN_AGE_MS);
    assert.equal(resolveRetireMinAgeMs("abc"), DEFAULT_RETIRE_MIN_AGE_MS);
    assert.equal(resolveRetireMinAgeMs(3 * 60 * 60 * 1000), 3 * 60 * 60 * 1000);
  });
});

describe("startLiveFrameMaintenanceScheduler", () => {
  test("runOnStart 默认 true,boot 立即调用 prune 与 retire", async () => {
    const calls: string[] = [];
    let pruneOpts: { batchSize?: number; maxBatches?: number } | undefined;
    let retireOpts: { minAgeMs?: number } | undefined;
    const h = startLiveFrameMaintenanceScheduler({
      pool: fakePool,
      intervalMs: 60_000,
      pruneFn: async (_pool, options) => {
        calls.push("prune");
        pruneOpts = options;
        return { deletedFrames: 4, prunedStreams: 2 };
      },
      retireFn: async (_pool, options) => {
        calls.push("retire");
        retireOpts = options;
        return { retired: 1 };
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls, ["prune", "retire"]);
    assert.equal(pruneOpts?.maxBatches, DEFAULT_PRUNE_MAX_BATCHES);
    assert.equal(pruneOpts?.batchSize, 5000);
    assert.equal(retireOpts?.minAgeMs, DEFAULT_RETIRE_MIN_AGE_MS);
    h.stop();
  });

  test("runNow 调用这两个函数并返回计数", async () => {
    const calls: string[] = [];
    const h = startLiveFrameMaintenanceScheduler({
      pool: fakePool,
      runOnStart: false,
      pruneMaxBatches: 11,
      pruneFn: async (_pool, options) => {
        calls.push("prune");
        assert.equal(options?.maxBatches, 11);
        return { deletedFrames: 3, prunedStreams: 1 };
      },
      retireFn: async () => {
        calls.push("retire");
        return { retired: 2 };
      },
    });
    const out = await h.runNow();
    assert.deepEqual(calls, ["prune", "retire"]);
    assert.deepEqual(out, { deletedFrames: 3, prunedStreams: 1, retired: 2 });
    h.stop();
  });

  test("running 守卫:上一轮未结束时跳过重叠 tick", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = startLiveFrameMaintenanceScheduler({
      pool: fakePool,
      intervalMs: 60_000,
      runOnStart: false,
      pruneFn: async () => {
        calls += 1;
        await gate;
        return { deletedFrames: 0, prunedStreams: 0 };
      },
      retireFn: async () => ({ retired: 0 }),
    });
    const p1 = h.runNow();
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await h.runNow();
    assert.deepEqual(r2, { deletedFrames: 0, prunedStreams: 0, retired: 0 });
    assert.equal(calls, 1, "重叠 tick 不应二次调用 prune");
    release();
    await p1;
    h.stop();
  });

  test("prune 抛错走 onError,retire 仍跑,下一轮不停摆", async () => {
    const errs: unknown[] = [];
    let pruneCalls = 0;
    let retireCalls = 0;
    const h = startLiveFrameMaintenanceScheduler({
      pool: fakePool,
      runOnStart: false,
      pruneFn: async () => {
        pruneCalls += 1;
        if (pruneCalls === 1) throw new Error("prune-boom");
        return { deletedFrames: 0, prunedStreams: 0 };
      },
      retireFn: async () => {
        retireCalls += 1;
        return { retired: 0 };
      },
      onError: (e) => errs.push(e),
    });
    await h.runNow();
    assert.equal(errs.length, 1);
    assert.equal((errs[0] as Error).message, "prune-boom");
    assert.equal(retireCalls, 1, "prune 失败不应阻断 retire");
    await h.runNow();
    assert.equal(pruneCalls, 2);
    assert.equal(retireCalls, 2, "失败后循环必须继续");
    h.stop();
  });

  test("retire 抛错走 onError,循环不挂", async () => {
    const errs: unknown[] = [];
    let pruneCalls = 0;
    const h = startLiveFrameMaintenanceScheduler({
      pool: fakePool,
      runOnStart: false,
      pruneFn: async () => {
        pruneCalls += 1;
        return { deletedFrames: 1, prunedStreams: 1 };
      },
      retireFn: async () => {
        throw new Error("retire-boom");
      },
      onError: (e) => errs.push(e),
    });
    const out = await h.runNow();
    assert.equal(out.deletedFrames, 1);
    assert.equal(out.retired, 0);
    assert.equal(errs.length, 1);
    assert.equal((errs[0] as Error).message, "retire-boom");
    await h.runNow();
    assert.equal(pruneCalls, 2);
    h.stop();
  });

  test("disabled:true → 不建 timer、不跑 prune/retire", async () => {
    let n = 0;
    const h = startLiveFrameMaintenanceScheduler({
      pool: fakePool,
      disabled: true,
      intervalMs: 60_000,
      pruneFn: async () => {
        n += 1;
        return { deletedFrames: 0, prunedStreams: 0 };
      },
      retireFn: async () => {
        n += 1;
        return { retired: 0 };
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const out = await h.runNow();
    assert.equal(n, 0);
    assert.deepEqual(out, { deletedFrames: 0, prunedStreams: 0, retired: 0 });
    h.stop();
  });

  test("COMMERCIAL_LIVE_FRAME_MAINTENANCE_DISABLED=1 时开关生效", async () => {
    const prev = process.env.COMMERCIAL_LIVE_FRAME_MAINTENANCE_DISABLED;
    process.env.COMMERCIAL_LIVE_FRAME_MAINTENANCE_DISABLED = "1";
    try {
      let n = 0;
      const h = startLiveFrameMaintenanceScheduler({
        pool: fakePool,
        pruneFn: async () => {
          n += 1;
          return { deletedFrames: 0, prunedStreams: 0 };
        },
        retireFn: async () => {
          n += 1;
          return { retired: 0 };
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(n, 0);
      h.stop();
    } finally {
      if (prev === undefined) delete process.env.COMMERCIAL_LIVE_FRAME_MAINTENANCE_DISABLED;
      else process.env.COMMERCIAL_LIVE_FRAME_MAINTENANCE_DISABLED = prev;
    }
  });
});
