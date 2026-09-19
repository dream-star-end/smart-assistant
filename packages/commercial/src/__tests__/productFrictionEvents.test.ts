import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { QueryRunner } from "../db/queries.js";
import { recordProductFrictionEvent } from "../productFriction/events.js";

function captureRunner(): { runner: QueryRunner; sql: string; params: unknown[] } {
  const captured = { sql: "", params: [] as unknown[] };
  const runner: QueryRunner = {
    async query(sql, params) {
      captured.sql = sql;
      captured.params = [...(params ?? [])];
      return { rows: [], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
    },
  };
  return { runner, ...captured, get sql() { return captured.sql; }, get params() { return captured.params; } };
}

const base = {
  correlation: "sess:cmid",
  surface: "chat",
  stage: "problem_card",
  code: "upstream_failed",
} as const;

describe("recordProductFrictionEvent 0278 dimensions", () => {
  test("upsert SQL adopts presentation/path/reason only under the same outcome CASE", async () => {
    const cap = captureRunner();
    await recordProductFrictionEvent({
      ...base,
      outcome: "failed",
      path: "decision_timeout",
      reason: "not_recoverable",
      presentation: "red",
    }, cap.runner);
    assert.match(cap.sql, /presentation, path, reason, recovered_at/);
    const adopt =
      /\(product_friction_events\.outcome NOT IN \('recovered','succeeded','abandoned','cancelled'\) AND \(product_friction_events\.outcome='pending' OR \(product_friction_events\.outcome='failed' AND EXCLUDED\.outcome IN \('recovered','succeeded','abandoned','cancelled'\)\)\)\)/;
    assert.match(cap.sql, adopt);
    assert.match(
      cap.sql,
      /path = CASE WHEN \(product_friction_events\.outcome NOT IN/,
    );
    assert.match(
      cap.sql,
      /THEN COALESCE\(EXCLUDED\.path, product_friction_events\.path\) ELSE product_friction_events\.path END/,
    );
    assert.match(
      cap.sql,
      /THEN COALESCE\(EXCLUDED\.presentation, product_friction_events\.presentation\) ELSE product_friction_events\.presentation END/,
    );
    assert.match(
      cap.sql,
      /THEN COALESCE\(EXCLUDED\.reason, product_friction_events\.reason\) ELSE product_friction_events\.reason END/,
    );
    // Outcome CASE itself is unchanged (terminal freeze + pending/failed recovery).
    assert.match(
      cap.sql,
      /WHEN product_friction_events\.outcome IN \('recovered','succeeded','abandoned','cancelled'\)\s+THEN product_friction_events\.outcome/,
    );
  });

  test("pending→failed(path=decision_timeout) binds the new path", async () => {
    const cap = captureRunner();
    await recordProductFrictionEvent({
      ...base,
      outcome: "failed",
      path: "decision_timeout",
    }, cap.runner);
    assert.equal(cap.params[5], "failed");
    assert.equal(cap.params[22], "decision_timeout");
  });

  test("illegal path/reason/presentation are stored as NULL rather than throwing", async () => {
    const cap = captureRunner();
    await recordProductFrictionEvent({
      ...base,
      outcome: "failed",
      path: "Decision-Timeout",
      reason: "has spaces / url",
      presentation: "purple" as never,
    }, cap.runner);
    assert.equal(cap.params[21], null, "illegal presentation → NULL");
    assert.equal(cap.params[22], null, "illegal path → NULL");
    assert.equal(cap.params[23], null, "illegal reason → NULL");
  });

  test("valid presentation/path/reason survive sanitizer", async () => {
    const cap = captureRunner();
    await recordProductFrictionEvent({
      ...base,
      outcome: "pending",
      presentation: "soft",
      path: "deferred",
      reason: "silent_no_progress",
    }, cap.runner);
    assert.equal(cap.params[21], "soft");
    assert.equal(cap.params[22], "deferred");
    assert.equal(cap.params[23], "silent_no_progress");
  });
});
