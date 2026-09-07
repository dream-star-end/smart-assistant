/**
 * 0278 product_friction_events presentation/path/reason.
 *
 * Isolated schema: skip when Postgres is unavailable (CI/REQUIRE_TEST_DB still fail-loud).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import {
  productFrictionEventKey,
  recordProductFrictionEvent,
} from "../productFriction/events.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const SCHEMA = "oc_migration0278_test";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../db/migrations/0278_friction_problem_card_dims.sql");

let pool: Pool;
let pgAvailable = false;

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (!pgAvailable) return;

  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();

  pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` });
  await pool.query(`
    CREATE TABLE product_friction_events (
      event_key      CHAR(64) PRIMARY KEY,
      user_id        BIGINT,
      surface        VARCHAR(48) NOT NULL,
      stage          VARCHAR(48) NOT NULL,
      code           VARCHAR(64) NOT NULL,
      outcome        VARCHAR(16) NOT NULL CHECK (outcome IN (
                       'pending', 'failed', 'recovered', 'succeeded', 'abandoned', 'cancelled'
                     )),
      attempts       SMALLINT NOT NULL DEFAULT 1,
      latency_ms     INTEGER,
      model          VARCHAR(128),
      provider       VARCHAR(32),
      client_build   VARCHAR(64),
      browser_family VARCHAR(24),
      device_class   VARCHAR(16),
      trace_id       VARCHAR(96),
      session_id     VARCHAR(96),
      entity_slug    VARCHAR(128),
      error_name     VARCHAR(64),
      script_ref     VARCHAR(120),
      line_no        INTEGER,
      col_no         INTEGER,
      error_fingerprint VARCHAR(16),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recovered_at   TIMESTAMPTZ
    );
  `);
  const sql = await readFile(MIGRATION, "utf8");
  await pool.query(sql);
  await pool.query(sql);
});

after(async () => {
  if (!pgAvailable) return;
  await pool.end();
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

function maybe(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!pgAvailable) return t.skip("Postgres unavailable");
    await fn();
  });
}

const runner = {
  query: (sql: string, params?: unknown[]) => pool.query(sql, params as never[]),
};

async function loadRow(correlation: string): Promise<{
  outcome: string;
  path: string | null;
  reason: string | null;
  presentation: string | null;
}> {
  const key = productFrictionEventKey({
    correlation,
    surface: "chat",
    stage: "problem_card",
  });
  const row = await pool.query<{
    outcome: string;
    path: string | null;
    reason: string | null;
    presentation: string | null;
  }>(
    `SELECT outcome, path, reason, presentation FROM product_friction_events WHERE event_key=$1`,
    [key],
  );
  assert.equal(row.rows.length, 1, `expected one row for ${correlation}`);
  return row.rows[0]!;
}

describe("0278_friction_problem_card_dims", () => {
  maybe("SQL documents 0151 privacy invariant and bounded enums", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    assert.match(sql, /0151 privacy invariant/);
    assert.match(sql, /order-dependency:\s*0277_api_key_usage_and_controls/);
    assert.match(sql, /presentation IN \('red','yellow','soft','banner','placeholder'\)/);
    assert.match(sql, /path ~ '\^\[a-z0-9_\]\{1,32\}\$'/);
    assert.match(sql, /reason ~ '\^\[a-z0-9_\]\{1,48\}\$'/);
    assert.match(sql, /'recovery_job'/);
  });

  maybe("CHECK accepts bounded tokens and rejects illegal path/reason/presentation", async () => {
    await pool.query(
      `INSERT INTO product_friction_events
         (event_key, surface, stage, code, outcome, presentation, path, reason)
       VALUES ($1, 'chat', 'problem_card', 'upstream_failed', 'pending',
               'soft', 'deferred', 'not_recoverable')`,
      ["a".repeat(64)],
    );
    await assert.rejects(
      () => pool.query(
        `INSERT INTO product_friction_events
           (event_key, surface, stage, code, outcome, path)
         VALUES ($1, 'chat', 'problem_card', 'upstream_failed', 'failed', 'Decision-Timeout')`,
        ["b".repeat(64)],
      ),
      (err: unknown) => (err as { code?: string }).code === "23514",
    );
    await assert.rejects(
      () => pool.query(
        `INSERT INTO product_friction_events
           (event_key, surface, stage, code, outcome, reason)
         VALUES ($1, 'chat', 'problem_card', 'upstream_failed', 'failed', 'has spaces')`,
        ["c".repeat(64)],
      ),
      (err: unknown) => (err as { code?: string }).code === "23514",
    );
    await assert.rejects(
      () => pool.query(
        `INSERT INTO product_friction_events
           (event_key, surface, stage, code, outcome, presentation)
         VALUES ($1, 'chat', 'problem_card', 'upstream_failed', 'failed', 'purple')`,
        ["d".repeat(64)],
      ),
      (err: unknown) => (err as { code?: string }).code === "23514",
    );
  });

  maybe("pending→failed(path=decision_timeout): outcome=failed and path updates", async () => {
    const correlation = "integ-pending-failed";
    await recordProductFrictionEvent({
      correlation, surface: "chat", stage: "problem_card", code: "upstream_failed",
      outcome: "pending", path: "deferred", presentation: "soft",
    }, runner);
    await recordProductFrictionEvent({
      correlation, surface: "chat", stage: "problem_card", code: "upstream_failed",
      outcome: "failed", path: "decision_timeout", presentation: "red",
    }, runner);
    const row = await loadRow(correlation);
    assert.equal(row.outcome, "failed");
    assert.equal(row.path, "decision_timeout");
    assert.equal(row.presentation, "red");
  });

  maybe("recovered first, late failed(decision_timeout) freezes outcome and path", async () => {
    const correlation = "integ-recovered-then-failed";
    await recordProductFrictionEvent({
      correlation, surface: "chat", stage: "problem_card", code: "upstream_failed",
      outcome: "recovered", path: "recovery_adopted",
    }, runner);
    await recordProductFrictionEvent({
      correlation, surface: "chat", stage: "problem_card", code: "upstream_failed",
      outcome: "failed", path: "decision_timeout",
    }, runner);
    const row = await loadRow(correlation);
    assert.equal(row.outcome, "recovered");
    assert.equal(row.path, "recovery_adopted");
  });

  maybe("cancelled then late failed leaves the row unchanged", async () => {
    const correlation = "integ-cancelled-then-failed";
    await recordProductFrictionEvent({
      correlation, surface: "chat", stage: "problem_card", code: "upstream_failed",
      outcome: "cancelled", path: "stop_fenced",
    }, runner);
    await recordProductFrictionEvent({
      correlation, surface: "chat", stage: "problem_card", code: "upstream_failed",
      outcome: "failed", path: "decision_timeout",
    }, runner);
    const row = await loadRow(correlation);
    assert.equal(row.outcome, "cancelled");
    assert.equal(row.path, "stop_fenced");
  });

  maybe("failed→recovered adopts outcome and new path", async () => {
    const correlation = "integ-failed-then-recovered";
    await recordProductFrictionEvent({
      correlation, surface: "chat", stage: "problem_card", code: "upstream_failed",
      outcome: "failed", path: "decision_timeout",
    }, runner);
    await recordProductFrictionEvent({
      correlation, surface: "chat", stage: "problem_card", code: "upstream_failed",
      outcome: "recovered", path: "recovery_adopted",
    }, runner);
    const row = await loadRow(correlation);
    assert.equal(row.outcome, "recovered");
    assert.equal(row.path, "recovery_adopted");
  });

  maybe("writer sanitizes illegal path so CHECK does not reject the row", async () => {
    const correlation = "integ-illegal-path";
    await recordProductFrictionEvent({
      correlation,
      surface: "chat",
      stage: "problem_card",
      code: "upstream_failed",
      outcome: "failed",
      path: "NOT VALID",
      reason: "also invalid!!",
    }, runner);
    const row = await loadRow(correlation);
    assert.equal(row.outcome, "failed");
    assert.equal(row.path, null);
    assert.equal(row.reason, null);
  });
});
