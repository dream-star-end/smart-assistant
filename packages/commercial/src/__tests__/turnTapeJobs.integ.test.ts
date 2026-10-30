import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { Pool } from "pg";
import {
  claimDueMaterializationJobs,
  claimDueSettlementJobs,
  failOrRequeueMaterializationJob,
  failOrRequeueSettlementJob,
  listTapeJobAlertCandidates,
  enqueueSettlementJob,
  releaseSettlementJobsAfterVerify,
  enqueueMaterializationJob,
  renewMaterializationLease,
} from "../db/turnTapeJobs.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const SCHEMA = "oc_tape_mat_self_evict_test";

let pool: Pool;
let pgAvailable = false;

async function probeAvailability(): Promise<boolean> {
  const p = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try {
      await p.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

const maybe = (name: string, fn: () => Promise<void> | void) =>
  test(name, async (t) => {
    if (!pgAvailable) {
      t.skip("PG 不可用");
      return;
    }
    await fn();
  });

before(async () => {
  assert.match(new URL(TEST_DB_URL).pathname, /_test$/, "test database required");
  pgAvailable = await probeAvailability();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("REQUIRE_TEST_DB=1 但 PG 不可用");
    return;
  }
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 4,
    options: `-c search_path=${SCHEMA}`,
  });
  await pool.query(`
    CREATE TABLE client_session_turn_tapes (
      session_id text NOT NULL, user_id text NOT NULL, tape_id text NOT NULL,
      materialization_status text NOT NULL DEFAULT 'pending',
      materialization_attempts integer NOT NULL DEFAULT 0,
      materialization_error text,
      settlement_verified_at timestamptz, finalized_at bigint,
      PRIMARY KEY (session_id, user_id, tape_id)
    )
  `);
  const migration = readFileSync(new URL("../db/migrations/0228_turn_visible_finalize.sql", import.meta.url), "utf8");
  await pool.query(migration.slice(
    migration.indexOf("CREATE TABLE IF NOT EXISTS turn_tape_materialization_jobs"),
    migration.indexOf("-- Blocker 2:"),
  ));
  await pool.query(`ALTER TABLE turn_tape_settlement_jobs
    ADD COLUMN settlement_hash text, ADD COLUMN cold_attempts integer NOT NULL DEFAULT 0`);
});

after(async () => {
  if (!pgAvailable) return;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
  await pool.end();
});

beforeEach(async () => {
  if (pgAvailable) await pool.query("TRUNCATE turn_tape_materialization_jobs, turn_tape_settlement_jobs, client_session_turn_tapes");
});

async function jobRow(sessionId: string, tapeId: string) {
  const row = (
    await pool.query<{
      job_id: string;
      status: string;
      lease_owner: string | null;
      lease_epoch: string;
      next_attempt_at: Date;
      lease_until: Date | null;
    }>(
      `SELECT job_id, status, lease_owner, lease_epoch::text, next_attempt_at, lease_until
         FROM turn_tape_materialization_jobs
        WHERE session_id=$1 AND tape_id=$2`,
      [sessionId, tapeId],
    )
  ).rows[0];
  assert.ok(row);
  return row;
}

describe("turn tape materialization job lease fencing", () => {
  maybe("claim then re-enqueue must not evict the live lease; renew CAS still succeeds", async () => {
    const sessionId = "s-self-evict";
    const userId = "c:1";
    const tapeId = "a".repeat(64);
    await enqueueMaterializationJob(pool, { sessionId, userId, tapeId });
    const claimed = await claimDueMaterializationJobs(pool, {
      ownerId: "worker-a",
      leaseMs: 60_000,
    });
    assert.equal(claimed.length, 1);
    const job = claimed[0]!;
    const before = await jobRow(sessionId, tapeId);
    assert.equal(before.status, "leased");

    await enqueueMaterializationJob(pool, { sessionId, userId, tapeId });
    const after = await jobRow(sessionId, tapeId);
    assert.equal(after.status, "leased", "re-enqueue must not stomp in-flight leased → queued");
    assert.equal(after.lease_owner, "worker-a");
    assert.equal(after.lease_epoch, before.lease_epoch);
    assert.equal(after.next_attempt_at.getTime(), before.next_attempt_at.getTime());

    const stolen = await claimDueMaterializationJobs(pool, {
      ownerId: "worker-b",
      leaseMs: 60_000,
    });
    assert.equal(stolen.length, 0, "a live leased row must not be stealable after re-enqueue");

    const held = await renewMaterializationLease(pool, job);
    assert.equal(held, true, "renew CAS requires status='leased'; this failed before the fix");
  });

  maybe("expired leased row is still claimable after a worker crash", async () => {
    const sessionId = "s-crash-recover";
    const userId = "c:1";
    const tapeId = "b".repeat(64);
    await enqueueMaterializationJob(pool, { sessionId, userId, tapeId });
    const claimed = await claimDueMaterializationJobs(pool, {
      ownerId: "worker-dead",
      leaseMs: 60_000,
    });
    assert.equal(claimed.length, 1);
    const job = claimed[0]!;
    await enqueueMaterializationJob(pool, { sessionId, userId, tapeId });
    await pool.query(
      `UPDATE turn_tape_materialization_jobs
          SET lease_until = NOW() - INTERVAL '1 second'
        WHERE job_id=$1`,
      [job.jobId],
    );
    const recovered = await claimDueMaterializationJobs(pool, {
      ownerId: "worker-alive",
      leaseMs: 60_000,
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.jobId, job.jobId);
    assert.equal(recovered[0]!.leaseOwner, "worker-alive");
    assert.ok(recovered[0]!.leaseEpoch > job.leaseEpoch);
  });

  maybe("complete and failed rows stay terminal on re-enqueue", async () => {
    for (const status of ["complete", "failed"] as const) {
      const sessionId = `s-keep-${status}`;
      const tapeId = status === "complete" ? "c".repeat(64) : "d".repeat(64);
      await enqueueMaterializationJob(pool, { sessionId, userId: "c:1", tapeId });
      await pool.query(
        `UPDATE turn_tape_materialization_jobs
            SET status=$3, next_attempt_at=NOW() + INTERVAL '1 hour'
          WHERE session_id=$1 AND tape_id=$2`,
        [sessionId, tapeId, status],
      );
      const before = await jobRow(sessionId, tapeId);
      await enqueueMaterializationJob(pool, { sessionId, userId: "c:1", tapeId });
      const after = await jobRow(sessionId, tapeId);
      assert.equal(after.status, status);
      assert.equal(after.next_attempt_at.getTime(), before.next_attempt_at.getTime());
    }
  });
});


describe("turn tape terminal retry bounds (OCV5-663)", () => {
  maybe("materialization stops at eight attempts and old failed jobs are never reclaimed", async () => {
    await pool.query(`INSERT INTO client_session_turn_tapes(session_id,user_id,tape_id) VALUES ('s-bound','c:1','t')`);
    await pool.query(`INSERT INTO turn_tape_materialization_jobs
      (session_id,user_id,tape_id,attempt,next_attempt_at) VALUES ('s-bound','c:1','t',6,NOW()-INTERVAL '2 hours')`);
    const [retry] = await claimDueMaterializationJobs(pool, { ownerId: "worker" });
    assert.equal(retry!.attempt, 7);
    assert.equal(await failOrRequeueMaterializationJob(pool, retry!, "temporary"), "requeued");
    assert.equal((await jobRow("s-bound", "t")).status, "queued");
    await pool.query(`UPDATE turn_tape_materialization_jobs SET next_attempt_at=NOW()-INTERVAL '2 hours'`);
    const [last] = await claimDueMaterializationJobs(pool, { ownerId: "worker" });
    assert.equal(last!.attempt, 8);
    const before = await jobRow("s-bound", "t");
    assert.equal(await failOrRequeueMaterializationJob(pool, { ...last!, leaseEpoch: 0 }, "stale"), "lost");
    assert.equal(await failOrRequeueMaterializationJob(pool, last!, "invalid parent locator"), "failed");
    const terminal = await jobRow("s-bound", "t");
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.lease_owner, null);
    assert.equal(terminal.lease_until, null);
    assert.equal(terminal.next_attempt_at.getTime(), before.next_attempt_at.getTime());
    assert.equal((await pool.query("SELECT materialization_status FROM client_session_turn_tapes")).rows[0].materialization_status, "failed");
    await pool.query(`INSERT INTO turn_tape_materialization_jobs
      (session_id,user_id,tape_id,status,attempt,next_attempt_at)
      VALUES ('old','c:1','old','failed',1355,NOW()-INTERVAL '1 day')`);
    assert.deepEqual(await claimDueMaterializationJobs(pool, { ownerId: "next-worker" }), []);
  });

  maybe("settlement stops at thirty attempts while preserving verification and lease fencing", async () => {
    await pool.query(`INSERT INTO client_session_turn_tapes(session_id,user_id,tape_id,materialization_status)
      VALUES ('s-settle','c:1','t','complete'), ('unverified','c:1','u','pending')`);
    await pool.query(`INSERT INTO turn_tape_settlement_jobs
      (session_id,user_id,tape_id,kind,status,attempt,next_attempt_at)
      VALUES ('s-settle','c:1','t','billing','queued',28,NOW()-INTERVAL '2 hours'),
             ('unverified','c:1','u','billing','queued',0,NOW()-INTERVAL '2 hours')`);
    const [retry] = await claimDueSettlementJobs(pool, { ownerId: "worker" });
    assert.equal(retry!.attempt, 29);
    assert.equal(await failOrRequeueSettlementJob(pool, retry!, "temporary"), "requeued");
    await pool.query(`UPDATE turn_tape_settlement_jobs SET next_attempt_at=NOW()-INTERVAL '2 hours' WHERE session_id='s-settle'`);
    const [last] = await claimDueSettlementJobs(pool, { ownerId: "worker" });
    assert.equal(last!.attempt, 30);
    const before = (await pool.query("SELECT next_attempt_at FROM turn_tape_settlement_jobs WHERE job_id=$1", [last!.jobId])).rows[0];
    assert.equal(await failOrRequeueSettlementJob(pool, { ...last!, leaseOwner: "stale" }, "stale"), "lost");
    assert.equal(await failOrRequeueSettlementJob(pool, last!, "permanent"), "failed");
    const row = (await pool.query("SELECT * FROM turn_tape_settlement_jobs WHERE job_id=$1", [last!.jobId])).rows[0];
    assert.equal(row.status, "failed");
    assert.equal(row.cold_attempts, 0);
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_until, null);
    assert.equal(row.next_attempt_at.getTime(), before.next_attempt_at.getTime());
    await enqueueSettlementJob(pool, { sessionId: "s-settle", userId: "c:1", tapeId: "t", kind: "billing", payload: {} });
    assert.deepEqual(await claimDueSettlementJobs(pool, { ownerId: "next-worker" }), []);

    await pool.query(`INSERT INTO turn_tape_settlement_jobs
      (session_id,user_id,tape_id,kind,status,lease_until)
      VALUES ('s-settle','c:1','t','waiver','leased',NOW()-INTERVAL '1 second')`);
    const [recovered] = await claimDueSettlementJobs(pool, { ownerId: "recovery" });
    assert.equal(recovered!.kind, "waiver");
    assert.equal(recovered!.leaseEpoch, 1);
    assert.deepEqual(await claimDueSettlementJobs(pool, { ownerId: "thief" }), []);
  });

  maybe("alert candidates include failed and only held jobs past their reason-specific timeout", async () => {
    // Freeze NOW() in one transaction to prove exact 1h/24h boundaries.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO turn_tape_materialization_jobs
        (session_id,user_id,tape_id,status,attempt,last_error)
        VALUES ('failed-mat','c:1','a','failed',1355,'SECRET payload')`);
      await client.query(`INSERT INTO turn_tape_settlement_jobs
        (session_id,user_id,tape_id,kind,status,last_error,created_at,updated_at)
        VALUES
        ('failed-settle','c:1','a','billing','failed','SECRET payload',NOW(),NOW()),
        ('await-old','c:1','b','billing','held','awaiting_materialization',NOW()-INTERVAL '1 hour 1 second',NOW()),
        ('await-edge','c:1','c','billing','held','awaiting_materialization',NOW()-INTERVAL '1 hour',NOW()),
        ('late-old','c:1','d','billing','held','late_tape_after_fence',NOW()-INTERVAL '24 hours 1 second',NOW()),
        ('late-edge','c:1','e','billing','held','late_tape_after_fence',NOW()-INTERVAL '24 hours',NOW()),
        ('other','c:1','f','billing','held','SECRET unknown',NOW()-INTERVAL '3 days',NOW()),
        ('complete','c:1','g','billing','complete',NULL,NOW()-INTERVAL '3 days',NOW())`);
      const candidates = await listTapeJobAlertCandidates(client);
      assert.deepEqual(candidates.map((j) => j.session_id).sort(), ["await-old", "failed-mat", "failed-settle", "late-old"]);
      assert.equal(JSON.stringify(candidates).includes("SECRET"), false);
      assert.deepEqual(candidates.map((j) => j.error_class).sort(), ["awaiting_materialization", "late_tape_after_fence", "materialization_failed", "settlement_failed"]);
      await releaseSettlementJobsAfterVerify(client, { sessionId: "late-old", userId: "c:1", tapeId: "d" });
      assert.equal((await client.query(`SELECT status FROM turn_tape_settlement_jobs WHERE session_id='late-old'`)).rows[0].status, "held");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
