/**
 * OCV5-57: first_visible UPDATE stamps dispatch_id; exception path retries;
 * bridge gate only marks a trace persisted after success.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import {
  FIRST_VISIBLE_PERSIST_MAX_ROUNDS,
  FirstVisiblePersistGate,
  recordTurnFirstVisible,
  TURN_FIRST_VISIBLE_RETRY_DELAYS_MS,
} from "../ws/turnPerformance.js";

describe("recordTurnFirstVisible", () => {
  test("writes dispatch_id in the same UPDATE when provided", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rowCount: 1 });
      },
    } as unknown as Pool;
    recordTurnFirstVisible(pool, undefined, {
      traceId: "a".repeat(32),
      kind: "thinking",
      dispatchId: "89f18ffe-c2a8-4412-9ce8-97c69f17ef22",
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /dispatch_id=COALESCE\(dispatch_id,\$3::uuid\)/);
    assert.equal(calls[0].params[2], "89f18ffe-c2a8-4412-9ce8-97c69f17ef22");
  });

  test("omits dispatch_id bind when unknown", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve({ rowCount: 1 });
      },
    } as unknown as Pool;
    recordTurnFirstVisible(pool, undefined, {
      traceId: "b".repeat(32),
      kind: "text",
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sql.includes("dispatch_id=COALESCE"), false);
    assert.equal(calls[0].params.length, 2);
  });

  test("first reject then success writes first_visible and onSettled(true)", async () => {
    let n = 0;
    const settled: boolean[] = [];
    const warns: string[] = [];
    const pool = {
      query: () => {
        n += 1;
        if (n === 1) return Promise.reject(new Error("pg blip"));
        return Promise.resolve({ rowCount: 1 });
      },
    } as unknown as Pool;
    recordTurnFirstVisible(
      pool,
      (msg) => warns.push(msg),
      { traceId: "c".repeat(32), kind: "text" },
      (ok) => settled.push(ok),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(n, 2);
    assert.deepEqual(settled, [true]);
    assert.deepEqual(warns, []);
  });

  test("continuous failure is bounded to 3 attempts and onSettled(false)", async () => {
    let n = 0;
    const settled: boolean[] = [];
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const pool = {
      query: () => {
        n += 1;
        return Promise.reject(new Error("pg down"));
      },
    } as unknown as Pool;
    recordTurnFirstVisible(
      pool,
      (msg, fields) => warns.push({ msg, fields }),
      { traceId: "d".repeat(32), kind: "thinking" },
      (ok) => settled.push(ok),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(n, TURN_FIRST_VISIBLE_RETRY_DELAYS_MS.length);
    assert.deepEqual(settled, [false]);
    assert.equal(warns.length, 1);
    assert.equal(warns[0].msg, "turn first-visible record failed");
    assert.equal(warns[0].fields?.attempts, 3);
  });
});

describe("FirstVisiblePersistGate (OCV5-57 r3)", () => {
  test("does not permanently suppress until persist succeeds", () => {
    const gate = new FirstVisiblePersistGate();
    const id = "e".repeat(32);
    assert.equal(gate.begin(id), true, "first frame starts a round");
    assert.equal(gate.begin(id), false, "inflight coalesces later frames");
    gate.settle(id, false);
    assert.equal(gate.begin(id), true, "failed round unblocks a later visible frame");
    gate.settle(id, true);
    assert.equal(gate.begin(id), false, "success permanently suppresses");
  });

  test("continuous failure is bounded and does not retry forever", () => {
    const gate = new FirstVisiblePersistGate();
    const id = "f".repeat(32);
    let starts = 0;
    for (let i = 0; i < 20; i++) {
      if (!gate.begin(id)) continue;
      starts += 1;
      gate.settle(id, false);
    }
    assert.equal(starts, FIRST_VISIBLE_PERSIST_MAX_ROUNDS);
    assert.equal(gate.begin(id), false);
  });
});
