import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import { startTapeJobScheduler } from "../db/tapeJobScheduler.js";
import { jobBackoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../db/turnTapeJobs.js";

describe("jobBackoffMs", () => {
  test("starts at 5s and caps at 5min", () => {
    assert.equal(jobBackoffMs(1), BACKOFF_BASE_MS);
    assert.equal(jobBackoffMs(20), BACKOFF_MAX_MS);
  });
});

describe("tapeJobScheduler stop waits in-flight tick (rev2 B6)", () => {
  test("stop does not resolve until the current claim finishes", async () => {
    let tickEntered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = {
      async query(sql: string) {
        const s = sql.replace(/\s+/g, " ");
        if (s.includes("FROM turn_tape_materialization_jobs") && s.includes("FOR UPDATE SKIP LOCKED")) {
          tickEntered = true;
          await gate;
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const handle = startTapeJobScheduler({
      pool: pool as unknown as Pool,
      intervalMs: 60_000,
      runOnStart: true,
    });
    const started = Date.now();
    while (!tickEntered && Date.now() - started < 2_000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(tickEntered, true, "runOnStart should claim immediately");
    let stopped = false;
    const stopP = handle.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stopped, false, "stop must wait for in-flight tick");
    release();
    await stopP;
    assert.equal(stopped, true);
  });
});
