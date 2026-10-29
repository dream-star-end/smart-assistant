// OCV5-663: the existing release proof's pinned test client owns all TEMP tables.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AlertEventInput } from "../../packages/commercial/src/admin/alertOutbox.js";

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export async function proveTapeJobTerminals(candidate: string, db: Db): Promise<string> {
  const jobs = await import(pathToFileURL(join(candidate, "packages/commercial/src/db/turnTapeJobs.ts")).href);
  const scheduler = await import(pathToFileURL(join(candidate, "packages/commercial/src/db/tapeJobScheduler.ts")).href);
  await db.query(`CREATE TEMP TABLE client_session_turn_tapes (
    session_id text, user_id text, tape_id text,
    materialization_status text DEFAULT 'complete', materialization_attempts integer DEFAULT 0,
    materialization_error text, finalized_at bigint,
    PRIMARY KEY(session_id,user_id,tape_id))`);
  const migration = readFileSync(join(candidate, "packages/commercial/src/db/migrations/0228_turn_visible_finalize.sql"), "utf8");
  await db.query(migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS turn_tape_materialization_jobs"),
    migration.indexOf("-- Blocker 2:")).replaceAll("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE"));
  await db.query(readFileSync(join(candidate, "packages/commercial/src/db/migrations/0229_turn_finalize_integrity.sql"), "utf8"));
  const shadow = await db.query(`SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid=ANY(ARRAY[to_regclass('client_session_turn_tapes'),to_regclass('turn_tape_materialization_jobs'),
      to_regclass('turn_tape_settlement_jobs')])`);
  assert.equal(shadow.rows.length, 3);
  assert.ok(shadow.rows.every((r) => /^pg_temp(?:_\d+)?$/.test(String(r.schema))));
  await db.query(`INSERT INTO client_session_turn_tapes(session_id,user_id,tape_id)
    SELECT s,'c:1',repeat('a',64) FROM unnest(ARRAY['mat','old','settle','await','late']) AS s`);
  await db.query(`INSERT INTO turn_tape_materialization_jobs(session_id,user_id,tape_id,status,attempt,next_attempt_at)
    VALUES ('mat','c:1',repeat('a',64),'queued',7,NOW()-INTERVAL '2 hours'),
           ('old','c:1',repeat('a',64),'failed',1355,NOW()-INTERVAL '2 hours')`);
  await db.query(`INSERT INTO turn_tape_settlement_jobs
    (session_id,user_id,tape_id,kind,status,attempt,last_error,created_at,next_attempt_at)
    VALUES ('settle','c:1',repeat('a',64),'billing','queued',29,NULL,NOW(),NOW()-INTERVAL '2 hours'),
           ('await','c:1',repeat('a',64),'billing','held',0,'awaiting_materialization',NOW()-INTERVAL '2 hours',NOW()),
           ('late','c:1',repeat('a',64),'waiver','held',0,'late_tape_after_fence',NOW()-INTERVAL '25 hours',NOW())`);
  let now = Date.parse("2026-10-30T12:00:00Z");
  const alerts: AlertEventInput[] = [];
  const handle = scheduler.startTapeJobScheduler({ pool: db, intervalMs: 60_000,
    _deps: { now: () => now, enqueueAlert: async (event: AlertEventInput) => { alerts.push(event); } } });
  try {
    // Missing hooks take the same fenced failure path as a rejected payload/handoff.
    await handle.runNow();
    const mat = (await db.query("SELECT * FROM turn_tape_materialization_jobs WHERE session_id='mat'")).rows[0]!;
    const settle = (await db.query("SELECT * FROM turn_tape_settlement_jobs WHERE session_id='settle'")).rows[0]!;
    assert.equal(mat.status, "failed"); assert.equal(mat.attempt, 8);
    assert.equal(settle.status, "failed"); assert.equal(settle.attempt, 30);
    for (const row of [mat, settle]) {
      assert.equal(row.lease_owner, null); assert.equal(row.lease_until, null);
      assert.ok(new Date(String(row.next_attempt_at)).getTime() < Date.now() - 60_000);
    }
    assert.deepEqual(await jobs.claimDueMaterializationJobs(db, { ownerId: "next" }), []);
    assert.deepEqual(await jobs.claimDueSettlementJobs(db, { ownerId: "next" }), []);
    const old = (await db.query("SELECT status,attempt FROM turn_tape_materialization_jobs WHERE session_id='old'")).rows[0]!;
    assert.deepEqual(old, { status: "failed", attempt: 1355 });
    assert.equal(alerts.length, 5);
    assert.ok(alerts.every((ev) => ev.dedupe_all_statuses === true && ev.payload === undefined));
    assert.ok(alerts.every((ev) => !ev.body.includes("hook missing") && !ev.body.includes("a".repeat(64))));
    const keys = alerts.map((ev) => ev.dedupe_key).sort();
    assert.equal(new Set(keys).size, 5);
    now += 60_000;
    await handle.runNow();
    assert.deepEqual(alerts.slice(5).map((ev) => ev.dedupe_key).sort(), keys);
    const held = await db.query("SELECT status,attempt FROM turn_tape_settlement_jobs WHERE session_id IN ('await','late')");
    assert.ok(held.rows.every((row) => row.status === "held" && row.attempt === 0));
    return "[ocv5-663-tape-job-terminals] PASS — failed tape jobs stop at 8/30, held jobs stay fenced and alerts share one daily job key";
  } finally {
    await handle.stop();
    await db.query("DROP TABLE pg_temp.turn_tape_settlement_jobs, pg_temp.turn_tape_materialization_jobs, pg_temp.client_session_turn_tapes");
  }
}
