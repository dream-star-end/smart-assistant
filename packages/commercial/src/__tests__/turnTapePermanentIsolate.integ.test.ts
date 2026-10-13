/**
 * OCV5-396 — parent-locator failures isolate after one real claim.
 * Uses the dedicated test database only. Skip is a failure.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Pool } from "pg";
import { parseLosslessTurnPayload } from "../http/losslessTurnTape.js";
import {
  claimDueMaterializationJobs,
  completeMaterializationJob,
  enqueueMaterializationJob,
  isolateLeasedMaterializationJob,
  isPermanentTapeInputError,
  PERMANENT_TAPE_INPUT_PREFIX,
  releaseParkedMaterializationJob,
} from "../db/turnTapeJobs.js";
import { startTapeJobScheduler } from "../db/tapeJobScheduler.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const APP_NAME = "ocv5_396_isolate";
const SCHEMA = "oc_ocv5_396_tape_isolate";
const HISTORICAL_LOCATOR =
  "turn tape payload.agentGroups[0].engineBillings[0] parent locator is invalid";

if (TEST_DB_URL.includes("openclaude_v5_selfhost")) {
  throw new Error("refusing selfhost database url");
}

const SESSION = "web-tape-396";
const TURN_KEY = "a".repeat(64);
const OTHER_TURN = "b".repeat(64);

function badLocatorPayload() {
  return {
    sessionId: SESSION,
    agentId: "main",
    turnIndex: 3,
    status: "completed" as const,
    turnKey: TURN_KEY,
    text: "kept",
    createdAt: 1_700_000_000_000,
    agentGroups: [{
      engineBillings: [{
        requestId: "d".repeat(32),
        engineSessionId: `oceng-${"e".repeat(48)}`,
        status: "success",
        turnKey: TURN_KEY,
        parentSessionId: SESSION,
        delegateAgentId: "coding-assistant",
      }],
    }],
  };
}

let pool: Pool;
let dbIdentity = "";

async function assertIsolatedDatabase(p: Pool): Promise<void> {
  const info = await p.query<{ dat: string; port: string }>(
    "SELECT current_database() AS dat, inet_server_port()::text AS port",
  );
  const row = info.rows[0];
  if (!row || row.dat !== "openclaude_test" || row.port === "5432") {
    throw new Error(`refusing database ${row?.dat ?? "?"} port ${row?.port ?? "?"}`);
  }
  dbIdentity = `${row.dat}:${row.port}`;
}

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await assertIsolatedDatabase(probe);
  } finally {
    await probe.end();
  }
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 6,
    connectionTimeoutMillis: 2000,
    application_name: APP_NAME,
    options: `-c search_path=${SCHEMA}`,
  });
  await assertIsolatedDatabase(pool);
  console.log(`ocv5-396 isolated-pg ${dbIdentity} schema=${SCHEMA}`);
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
    );
    CREATE TABLE client_session_turn_tapes (
      session_id text NOT NULL,
      user_id text NOT NULL,
      tape_id text NOT NULL,
      materialization_status text NOT NULL DEFAULT 'pending',
      materialization_attempts integer NOT NULL DEFAULT 0,
      materialization_error text,
      settlement_verified_at timestamptz,
      finalized_at timestamptz,
      PRIMARY KEY (session_id, user_id, tape_id)
    );
    CREATE TABLE turn_tape_settlement_jobs (
      job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id text NOT NULL,
      user_id text NOT NULL,
      tape_id text NOT NULL,
      dispatch_id uuid,
      kind text NOT NULL,
      status text NOT NULL,
      attempt integer NOT NULL DEFAULT 0,
      lease_owner text,
      lease_epoch bigint NOT NULL DEFAULT 0,
      lease_until timestamptz,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      billing_anchor_id text,
      request_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE oc_test_control (name text PRIMARY KEY, value text NOT NULL);
    CREATE FUNCTION oc_ocv5_396_header_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = oc_ocv5_396_tape_isolate, public
    AS $fn$
    DECLARE
      pause_s text;
    BEGIN
      IF EXISTS (SELECT 1 FROM oc_test_control WHERE name = 'fail_header' AND value = '1') THEN
        RAISE EXCEPTION 'injected tape header failure';
      END IF;
      SELECT value INTO pause_s FROM oc_test_control WHERE name = 'pause_header';
      IF pause_s IS NOT NULL THEN
        PERFORM pg_sleep(pause_s::double precision);
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER oc_ocv5_396_header_guard
      BEFORE UPDATE ON client_session_turn_tapes
      FOR EACH ROW EXECUTE FUNCTION oc_ocv5_396_header_guard();
  `);
});

after(async () => {
  if (!pool) return;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
  await pool.end();
});

async function shelveExisting(): Promise<void> {
  await pool.query(
    `UPDATE turn_tape_materialization_jobs
        SET next_attempt_at = 'infinity'::timestamptz
      WHERE next_attempt_at < 'infinity'::timestamptz`,
  );
}

async function seedTape(sessionId: string, tapeId: string, userId = "c:396"): Promise<void> {
  await pool.query(
    `INSERT INTO client_session_turn_tapes (session_id, user_id, tape_id)
     VALUES ($1,$2,$3)`,
    [sessionId, userId, tapeId],
  );
}

async function jobOf(sessionId: string, tapeId: string) {
  const row = (await pool.query<{
    job_id: string;
    status: string;
    attempt: number;
    last_error: string | null;
    is_infinity: boolean;
    lease_epoch: string;
    lease_owner: string | null;
  }>(
    `SELECT job_id::text, status, attempt, last_error,
            (next_attempt_at = 'infinity'::timestamptz) AS is_infinity,
            lease_epoch::text, lease_owner
       FROM turn_tape_materialization_jobs
      WHERE session_id=$1 AND tape_id=$2`,
    [sessionId, tapeId],
  )).rows[0];
  assert.ok(row);
  return row;
}

async function headerOf(sessionId: string, tapeId: string) {
  const row = (await pool.query<{
    materialization_status: string;
    materialization_attempts: number;
    materialization_error: string | null;
  }>(
    `SELECT materialization_status, materialization_attempts, materialization_error
       FROM client_session_turn_tapes
      WHERE session_id=$1 AND tape_id=$2`,
    [sessionId, tapeId],
  )).rows[0];
  assert.ok(row);
  return row;
}

describe("parent locator classification", () => {
  test("only the parent-locator validation throw is permanent", () => {
    assert.throws(() => parseLosslessTurnPayload(badLocatorPayload()), (err: unknown) => {
      assert.equal(isPermanentTapeInputError(err), true);
      assert.match((err as Error).message, /parent locator is invalid/);
      return true;
    });
    assert.throws(
      () => parseLosslessTurnPayload({ ...badLocatorPayload(), status: "nope", agentGroups: undefined }),
      (err: unknown) => {
        assert.equal(isPermanentTapeInputError(err), false);
        assert.match((err as Error).message, /status is invalid/);
        return true;
      },
    );
    const otherTurn = parseLosslessTurnPayload({
      ...badLocatorPayload(),
      agentGroups: [{
        engineBillings: [{
          ...badLocatorPayload().agentGroups[0]!.engineBillings[0],
          parentTurnKey: OTHER_TURN,
        }],
      }],
    });
    const billing = (otherTurn.agentGroups?.[0] as { engineBillings: Array<{ parentTurnKey?: string }> })
      .engineBillings[0]!;
    assert.equal(billing.parentTurnKey, OTHER_TURN);
    assert.notEqual(billing.parentTurnKey, otherTurn.turnKey);
  });
});

describe("materialization isolation", { concurrency: false }, () => {
  test("old failed locator is claimed once, then a later tick completes the good job", async () => {
    await shelveExisting();
    const poisonTape = "1".repeat(64);
    const goodTape = "2".repeat(64);
    await seedTape("s-old", poisonTape);
    await seedTape("s-good", goodTape);
    await pool.query(
      `INSERT INTO turn_tape_materialization_jobs
         (session_id, user_id, tape_id, status, attempt, last_error, next_attempt_at, created_at)
       VALUES
         ('s-old','c:396',$1,'failed',957,$2,NOW() - INTERVAL '1 minute', NOW() - INTERVAL '40 days'),
         ('s-good','c:396',$3,'queued',0,NULL,NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute')`,
      [poisonTape, HISTORICAL_LOCATOR, goodTape],
    );
    await pool.query(
      `INSERT INTO turn_tape_settlement_jobs
         (session_id, user_id, tape_id, kind, status, last_error, payload)
       VALUES ('s-old','c:396',$1,'billing','held','awaiting_materialization',$2::jsonb)`,
      [poisonTape, JSON.stringify({ keep: true })],
    );
    const calls: string[] = [];
    const scheduler = startTapeJobScheduler({
      pool,
      ownerId: "worker-old",
      intervalMs: 60_000,
      runOnStart: false,
      onError: () => undefined,
      materializeTape: async (job) => {
        calls.push(job.tapeId);
        if (job.tapeId === poisonTape) parseLosslessTurnPayload(badLocatorPayload());
      },
    });
    await scheduler.runNow();
    const poison = await jobOf("s-old", poisonTape);
    assert.deepEqual(calls, [poisonTape]);
    assert.equal(poison.status, "failed");
    assert.equal(poison.is_infinity, true);
    assert.equal(poison.attempt, 958);
    assert.equal(poison.last_error, `${PERMANENT_TAPE_INPUT_PREFIX}${HISTORICAL_LOCATOR}`);
    const header = await headerOf("s-old", poisonTape);
    assert.equal(header.materialization_status, "failed");
    assert.equal(header.materialization_attempts, 958);
    assert.match(header.materialization_error ?? "", /parent locator is invalid/);
    const settlement = (await pool.query<{ status: string; last_error: string; payload: { keep: boolean } }>(
      `SELECT status, last_error, payload FROM turn_tape_settlement_jobs WHERE tape_id=$1`,
      [poisonTape],
    )).rows[0]!;
    assert.equal(settlement.status, "held");
    assert.equal(settlement.last_error, "awaiting_materialization");
    assert.equal(settlement.payload.keep, true);

    await scheduler.runNow();
    assert.deepEqual(calls, [poisonTape, goodTape]);
    assert.equal((await jobOf("s-good", goodTape)).status, "complete");
    assert.equal((await jobOf("s-old", poisonTape)).is_infinity, true);
    assert.equal((await jobOf("s-old", poisonTape)).attempt, 958);
    await scheduler.stop();
  });

  test("a new queued bad locator isolates on the first failure and is not claimed again", async () => {
    await shelveExisting();
    const tapeId = "3".repeat(64);
    await seedTape("s-new", tapeId);
    await enqueueMaterializationJob(pool, { sessionId: "s-new", userId: "c:396", tapeId });
    let parses = 0;
    const scheduler = startTapeJobScheduler({
      pool,
      ownerId: "worker-new",
      intervalMs: 60_000,
      runOnStart: false,
      onError: () => undefined,
      materializeTape: async () => {
        parses += 1;
        parseLosslessTurnPayload(badLocatorPayload());
      },
    });
    await scheduler.runNow();
    await scheduler.runNow();
    await scheduler.stop();
    const job = await jobOf("s-new", tapeId);
    assert.equal(parses, 1);
    assert.equal(job.status, "failed");
    assert.equal(job.is_infinity, true);
    assert.equal(job.attempt, 1);
    assert.match(job.last_error ?? "", /^oc-tape-permanent:/);
  });

  test("connection and cold failures keep the original retry, and a prefixed due row is still claimable", async () => {
    await shelveExisting();
    const hotTape = "4".repeat(64);
    const coldTape = "5".repeat(64);
    const prefixedTape = "6".repeat(64);
    await seedTape("s-hot", hotTape);
    await seedTape("s-cold", coldTape);
    await seedTape("s-prefix", prefixedTape);
    await enqueueMaterializationJob(pool, { sessionId: "s-hot", userId: "c:396", tapeId: hotTape });
    await enqueueMaterializationJob(pool, { sessionId: "s-cold", userId: "c:396", tapeId: coldTape });
    await pool.query(
      `UPDATE turn_tape_materialization_jobs SET attempt=7 WHERE tape_id=$1`,
      [coldTape],
    );
    await pool.query(
      `INSERT INTO turn_tape_materialization_jobs
         (session_id, user_id, tape_id, status, attempt, last_error, next_attempt_at, created_at)
       VALUES ('s-prefix','c:396',$1,'failed',3,$2,NOW() - INTERVAL '1 minute', NOW() - INTERVAL '2 days')`,
      [prefixedTape, `${PERMANENT_TAPE_INPUT_PREFIX}${HISTORICAL_LOCATOR}`],
    );
    const seen: string[] = [];
    const scheduler = startTapeJobScheduler({
      pool,
      ownerId: "worker-retry",
      intervalMs: 60_000,
      runOnStart: false,
      onError: () => undefined,
      materializeTape: async (job) => {
        seen.push(job.tapeId);
        if (job.tapeId === prefixedTape) return;
        throw new Error(job.tapeId === hotTape ? "connect ECONNRESET" : "connect ETIMEDOUT");
      },
    });
    await scheduler.runNow();
    const first = seen[0];
    assert.equal(first, prefixedTape, "prefix is not a claim filter; the due failed row is oldest");
    await scheduler.runNow();
    await scheduler.runNow();
    await scheduler.stop();
    const hot = await jobOf("s-hot", hotTape);
    const cold = await jobOf("s-cold", coldTape);
    assert.equal(hot.status, "queued");
    assert.equal(hot.is_infinity, false);
    assert.equal(hot.attempt, 1);
    assert.equal(cold.status, "failed");
    assert.equal(cold.is_infinity, false);
    assert.equal(cold.attempt, 8);
    const due = await pool.query<{ next_ms: string }>(
      `SELECT EXTRACT(EPOCH FROM (next_attempt_at - NOW()))::text AS next_ms
         FROM turn_tape_materialization_jobs WHERE tape_id=$1`,
      [coldTape],
    );
    const delta = Number(due.rows[0]!.next_ms);
    assert.ok(delta > 50 * 60 && delta < 70 * 60, `cold backoff ${delta}s`);

    await pool.query(
      `UPDATE turn_tape_materialization_jobs
          SET next_attempt_at = NOW() - INTERVAL '1 second'
        WHERE tape_id=$1`,
      [hotTape],
    );
    const again = await claimDueMaterializationJobs(pool, { ownerId: "worker-hot-2", limit: 1 });
    assert.equal(again[0]?.tapeId, hotTape);
  });

  test("enqueue does not un-isolate, and explicit release keeps the attempt", async () => {
    const tapeId = "7".repeat(64);
    await seedTape("s-rel", tapeId);
    await pool.query(
      `INSERT INTO turn_tape_materialization_jobs
         (session_id, user_id, tape_id, status, attempt, lease_owner, lease_epoch, last_error, next_attempt_at)
       VALUES ('s-rel','c:396',$1,'failed',957,'owner-a',2,$2,'infinity')`,
      [tapeId, `${PERMANENT_TAPE_INPUT_PREFIX}${HISTORICAL_LOCATOR}`],
    );
    await pool.query(
      `UPDATE client_session_turn_tapes
          SET materialization_status='failed', materialization_attempts=957, materialization_error=$2
        WHERE tape_id=$1`,
      [tapeId, HISTORICAL_LOCATOR],
    );
    const before = await jobOf("s-rel", tapeId);
    await enqueueMaterializationJob(pool, { sessionId: "s-rel", userId: "c:396", tapeId });
    const queued = await jobOf("s-rel", tapeId);
    assert.equal(queued.status, "failed");
    assert.equal(queued.is_infinity, true);
    assert.equal(queued.attempt, 957);
    assert.equal(queued.last_error, before.last_error);
    await assert.rejects(
      () => releaseParkedMaterializationJob(pool, { jobId: before.job_id, reason: "  " }),
      /reason/,
    );
    assert.equal((await jobOf("s-rel", tapeId)).status, "failed");
    const released = await releaseParkedMaterializationJob(pool, {
      jobId: before.job_id,
      reason: "locator repaired in a reviewed one-off",
    });
    assert.equal(released, 1);
    const after = await jobOf("s-rel", tapeId);
    assert.equal(after.status, "queued");
    assert.equal(after.is_infinity, false);
    assert.equal(after.attempt, 957);
    assert.equal(after.last_error, before.last_error);
    const cold = await releaseParkedMaterializationJob(pool, {
      jobId: before.job_id,
      reason: "already released",
    });
    assert.equal(cold, 0);
    assert.equal((await jobOf("s-rel", tapeId)).attempt, 957);
  });

  test("a stale lease epoch cannot change the job or the tape header", async () => {
    await shelveExisting();
    const tapeId = "8".repeat(64);
    await seedTape("s-epoch", tapeId);
    await enqueueMaterializationJob(pool, { sessionId: "s-epoch", userId: "c:396", tapeId });
    const claimed = await claimDueMaterializationJobs(pool, { ownerId: "owner-old", limit: 1 });
    const job = claimed[0]!;
    const isolated = await isolateLeasedMaterializationJob(
      pool,
      job,
      HISTORICAL_LOCATOR,
    );
    assert.equal(isolated, "isolated");
    const parked = await jobOf("s-epoch", tapeId);
    assert.equal(await releaseParkedMaterializationJob(pool, {
      jobId: parked.job_id,
      reason: "hand back to a new owner",
    }), 1);
    assert.equal((await jobOf("s-epoch", tapeId)).attempt, job.attempt);
    const next = await claimDueMaterializationJobs(pool, { ownerId: "owner-new", limit: 1 });
    assert.equal(next[0]?.leaseOwner, "owner-new");
    assert.ok((next[0]?.leaseEpoch ?? 0) > job.leaseEpoch);
    assert.equal(await completeMaterializationJob(pool, next[0]!), true);
    await pool.query(
      `UPDATE client_session_turn_tapes
          SET materialization_status='complete', materialization_error='sentinel', materialization_attempts=1
        WHERE tape_id=$1`,
      [tapeId],
    );
    const lost = await isolateLeasedMaterializationJob(pool, job, "stale write");
    assert.equal(lost, "lost");
    assert.equal((await jobOf("s-epoch", tapeId)).status, "complete");
    const header = await headerOf("s-epoch", tapeId);
    assert.equal(header.materialization_status, "complete");
    assert.equal(header.materialization_error, "sentinel");
    assert.equal(header.materialization_attempts, 1);
  });

  test("header update failure rolls the job isolation back", async () => {
    await shelveExisting();
    const tapeId = "9".repeat(64);
    await seedTape("s-fail", tapeId);
    await enqueueMaterializationJob(pool, { sessionId: "s-fail", userId: "c:396", tapeId });
    await pool.query(`INSERT INTO oc_test_control (name, value) VALUES ('fail_header','1')`);
    const scheduler = startTapeJobScheduler({
      pool,
      ownerId: "worker-fail",
      intervalMs: 60_000,
      runOnStart: false,
      onError: () => undefined,
      materializeTape: async () => {
        parseLosslessTurnPayload(badLocatorPayload());
      },
    });
    try {
      await scheduler.runNow();
    } finally {
      await scheduler.stop();
      await pool.query(`DELETE FROM oc_test_control WHERE name='fail_header'`);
    }
    const job = await jobOf("s-fail", tapeId);
    assert.equal(job.status, "leased");
    assert.equal(job.is_infinity, false);
    const header = await headerOf("s-fail", tapeId);
    assert.equal(header.materialization_status, "pending");
    assert.equal(header.materialization_error, null);
  });

  test("an open isolate blocks release and a new claim; after commit the new owner is not overwritten", async () => {
    await shelveExisting();
    const tapeId = "a".repeat(64);
    await seedTape("s-race", tapeId);
    await pool.query(
      `INSERT INTO turn_tape_materialization_jobs
         (session_id, user_id, tape_id, status, attempt, lease_owner, lease_epoch,
          lease_until, next_attempt_at, created_at)
       VALUES ('s-race','c:396',$1,'leased',4,'owner-hold',7,
               NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '3 days')`,
      [tapeId],
    );
    await pool.query(
      `INSERT INTO oc_test_control (name, value) VALUES ('pause_header','3')`,
    );
    const held = await jobOf("s-race", tapeId);
    const isolateP = isolateLeasedMaterializationJob(pool, {
      jobId: held.job_id,
      sessionId: "s-race",
      userId: "c:396",
      tapeId,
      dispatchId: null,
      attempt: 4,
      leaseOwner: "owner-hold",
      leaseEpoch: 7,
    }, HISTORICAL_LOCATOR);
    const sleepSql = `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND application_name = '${APP_NAME}'
          AND wait_event = 'PgSleep'
          AND state = 'active'`;
    const slept = await pool.query<{ n: number }>(sleepSql);
    let seenSleep = slept.rows[0]!.n > 0;
    for (let i = 0; i < 40 && !seenSleep; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const again = await pool.query<{ n: number }>(sleepSql);
      seenSleep = again.rows[0]!.n > 0;
    }
    assert.equal(seenSleep, true, "isolate transaction did not reach the header lock hold");
    const locker = await pool.connect();
    let releaseCode = "";
    try {
      await locker.query("SET lock_timeout = '500ms'");
      await releaseParkedMaterializationJob(locker, {
        jobId: held.job_id,
        reason: "must wait for the open isolate",
      });
    } catch (err) {
      releaseCode = (err as { code?: string }).code ?? "";
    } finally {
      locker.release();
    }
    const claimed = await claimDueMaterializationJobs(pool, { ownerId: "owner-racer", limit: 1 });
    assert.equal(releaseCode, "55P03");
    assert.equal(claimed.length, 0);
    await pool.query(`DELETE FROM oc_test_control WHERE name='pause_header'`);
    assert.equal(await isolateP, "isolated");

    assert.equal((await jobOf("s-race", tapeId)).attempt, 4);
    assert.equal(await releaseParkedMaterializationJob(pool, {
      jobId: held.job_id,
      reason: "open transaction committed",
    }), 1);
    const next = await claimDueMaterializationJobs(pool, { ownerId: "owner-after", limit: 1 });
    assert.equal(next[0]?.leaseOwner, "owner-after");
    assert.equal(await completeMaterializationJob(pool, next[0]!), true);
    await pool.query(
      `UPDATE client_session_turn_tapes
          SET materialization_status='complete', materialization_error='sentinel'
        WHERE tape_id=$1`,
      [tapeId],
    );
    assert.equal(await isolateLeasedMaterializationJob(pool, {
      jobId: held.job_id,
      sessionId: "s-race",
      userId: "c:396",
      tapeId,
      dispatchId: null,
      attempt: 4,
      leaseOwner: "owner-hold",
      leaseEpoch: 7,
    }, "late isolate"), "lost");
    assert.equal((await jobOf("s-race", tapeId)).status, "complete");
    assert.equal((await headerOf("s-race", tapeId)).materialization_error, "sentinel");
  });
});
