import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Pool } from "pg";
import {
  claimDueMaterializationJobs,
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
    CREATE TABLE turn_tape_materialization_jobs (
      job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id text NOT NULL,
      user_id text NOT NULL,
      tape_id text NOT NULL,
      dispatch_id uuid,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status = ANY (ARRAY['queued','leased','complete','failed'])),
      attempt integer NOT NULL DEFAULT 0,
      lease_owner text,
      lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
      lease_until timestamptz,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (session_id, user_id, tape_id)
    )
  `);
});

after(async () => {
  if (!pgAvailable) return;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
  await pool.end();
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
