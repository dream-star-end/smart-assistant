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

// OCV5-663: use the real scheduler/store functions with a stateful DB boundary.
function alertFixture() {
  let clock = Date.parse("2026-10-30T12:00:00Z");
  let jobs: "materialization" | "settlement" | null = null;
  let failed = false;
  let failAlerts = false;
  const events: import("../admin/alertOutbox.js").AlertEventInput[] = [];
  const errors: unknown[] = [];
  const completed: string[] = [];
  let scans = 0;
  const row = {
    job_id: "10000000-0000-0000-0000-000000000001", session_id: "session-1", user_id: "c:1",
    tape_id: "a".repeat(64), dispatch_id: null, attempt: 8, lease_epoch: "1",
    kind: "billing", payload: { secret: "PRIVATE PAYLOAD" }, billing_anchor_id: null,
    request_id: null, status: "leased",
  };
  let errorClass = "materialization_failed";
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("AS error_class")) {
        scans++;
        return { rows: failed ? [{
          job_id: row.job_id, session_id: row.session_id, tape_id: row.tape_id,
          attempt: row.attempt, error_class: errorClass,
        }] : [] };
      }
      if (sql.includes("WITH due")) {
        const kind = sql.includes("FROM turn_tape_materialization_jobs") ? "materialization" : "settlement";
        if (jobs !== kind) return { rows: [] };
        jobs = null;
        row.attempt = kind === "materialization" ? 8 : 30;
        errorClass = `${kind}_failed`;
        return { rows: [row] };
      }
      if (sql.includes("SET status='failed'") || (sql.includes("SET status=CASE") && values?.[5] === true)) failed = true;
      if (sql.includes("SET status='complete'")) completed.push(String(values?.[0]));
      return { rowCount: 1, rows: [] };
    },
  };
  const deps = {
    pool: pool as unknown as Pool,
    intervalMs: 60_000,
    onError: (err: unknown) => { errors.push(err); },
    _deps: {
      now: () => clock,
      enqueueAlert: (async (event) => {
        if (failAlerts) throw new Error("alert unavailable");
        events.push(event);
        return { enqueued: 1, suppressed: 0, deduped: 0, skipped_no_channels: false, silenceReason: null, inbox_fallback: false, inbox_mirror: false };
      }) as typeof import("../admin/alertOutbox.js").enqueueAlert,
    },
  };
  return {
    deps, events, errors, completed,
    failNext: (kind: "materialization" | "settlement") => { jobs = kind; },
    advance: (ms: number) => { clock += ms; },
    historicalFailure: () => { failed = true; },
    setErrorClass: (value: string) => { errorClass = value; },
    setAlertFailure: (value: boolean) => { failAlerts = value; },
    scans: () => scans,
  };
}

describe("tape job alerts (OCV5-663)", () => {
  for (const kind of ["materialization", "settlement"] as const) {
    for (const hook of ["missing", "throwing"] as const) {
      test(`${kind} ${hook} hook alerts on first terminal failure even inside scan cooldown`, async () => {
        const f = alertFixture();
        const fail = async () => { throw new Error("SECRET raw failure"); };
        const h = startTapeJobScheduler({ ...f.deps, ...(hook === "throwing" ? {
          materializeTape: fail, settleJob: fail,
        } : {}) });
        try {
          await h.runNow();
          assert.equal(f.scans(), 1);
          f.failNext(kind);
          await h.runNow();
          assert.equal(f.scans(), 2, "terminal transition bypasses scan cooldown");
          assert.equal(f.events.length, 1);
          assert.equal(f.events[0]!.event_type, "ops.tape_job_stuck");
          assert.equal(f.events[0]!.dedupe_all_statuses, true);
          assert.equal(f.events[0]!.body, `session=session-1 tape=aaaaaaaaaaaa attempt=${kind === "materialization" ? 8 : 30} error_class=${kind}_failed`);
          assert.equal(JSON.stringify(f.events).includes("SECRET"), false);
          assert.equal(JSON.stringify(f.events).includes("PRIVATE"), false);
          assert.equal(f.events[0]!.payload, undefined);
        } finally { await h.stop(); }
      });
    }
  }

  test("daily keys survive scans, reason changes and restart, and roll at UTC midnight", async () => {
    const f = alertFixture();
    f.historicalFailure();
    const h = startTapeJobScheduler(f.deps);
    try {
      await h.runNow();
      await h.runNow();
      assert.equal(f.events.length, 1, "regular scans are throttled");
      f.advance(60_000);
      f.setErrorClass("awaiting_materialization");
      await h.runNow();
      assert.equal(f.events.length, 2);
      assert.equal(f.events[0]!.dedupe_key, f.events[1]!.dedupe_key);
      assert.equal(f.events[0]!.dedupe_key, "ops.tape_job_stuck:10000000-0000-0000-0000-000000000001:2026-10-30");
      const restarted = startTapeJobScheduler(f.deps);
      try { await restarted.runNow(); } finally { await restarted.stop(); }
      assert.equal(f.events[2]!.dedupe_key, f.events[0]!.dedupe_key);
      f.advance(24 * 60 * 60_000);
      await h.runNow();
      assert.equal(f.events[3]!.dedupe_key, "ops.tape_job_stuck:10000000-0000-0000-0000-000000000001:2026-10-31");
    } finally { await h.stop(); }
  });

  test("alert errors do not block normal settlement or disable future scans", async () => {
    const f = alertFixture();
    f.historicalFailure();
    f.failNext("settlement");
    f.setAlertFailure(true);
    const h = startTapeJobScheduler({ ...f.deps, settleJob: async () => {} });
    try {
      await h.runNow();
      assert.equal(f.completed.length, 1);
      assert.equal(f.errors.length, 1);
      f.setAlertFailure(false);
      f.advance(60_000);
      await h.runNow();
      assert.equal(f.events.length, 1);
    } finally { await h.stop(); }
  });
});
