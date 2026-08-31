/**
 * OCV5-57 audit r2: first_visible UPDATE also stamps dispatch_id when known.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import { recordTurnFirstVisible } from "../ws/turnPerformance.js";

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
});
