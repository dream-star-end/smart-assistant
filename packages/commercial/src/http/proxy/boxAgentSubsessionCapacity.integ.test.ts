/**
 * Parent Box handoff keeps its session slot.
 * Same session id -> BOX_CAPACITY_HELD.
 * A different sub-session id is admitted at the production caps 6/3,
 * and the parent handoff row stays held. The numeric caps stay: the
 * fourth user run and a 1/1 second run are still held.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";
import type { BoxRunCapacity } from "./boxCapacityPolicy.js";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";

const databaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const MODEL = "box-api-claude-opus-5-5";
const schema = `ocv5_409_${randomBytes(4).toString("hex")}`;

async function reachable(): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
  try { await client.connect(); await client.query("SELECT 1"); return true; }
  catch { return false; } finally { await client.end().catch(() => {}); }
}
const available = await reachable();
if (!available && (process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1")) {
  throw new Error("test database required but unreachable");
}

let pool: Pool;
test.before(async () => {
  if (!available) return;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE TABLE ${schema}.request_finalize_journal (
    request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
    state text NOT NULL, ctx jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), error_msg text,
    failure_code text, final_credits bigint)`);
  await admin.end();
  pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
});
test.after(async () => {
  if (!available) return;
  await pool.end();
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const held = (error: unknown) =>
  error instanceof BoxDurableJournalError && error.code === "BOX_CAPACITY_HELD";
let seq = 0;
function hex(n: number, len: number): string {
  return n.toString(16).padStart(len, "0").slice(-len);
}

async function candidate(uid: bigint, accountId: bigint, sessionId: string) {
  seq += 1;
  const tag = randomBytes(8).toString("hex") + hex(seq, 8);
  const input = {
    requestId: `sub-${tag}`, uid, accountId, model: MODEL,
    runNonce: hex(seq, 8) + randomBytes(8).toString("hex"),
    leaseEpoch: hex(seq, 8) + randomBytes(12).toString("hex"),
    fingerprint: {
      sessionId,
      turnKey: tag.padEnd(64, "a"),
      requestHash: tag.padEnd(64, "b"),
      replayFingerprint: tag.padEnd(64, "c"),
    },
  };
  await pool.query(
    `INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
     VALUES ($1,$2,'inflight',$3::jsonb)`,
    [input.requestId, uid.toString(), JSON.stringify({
      model: MODEL, boxInvocationRecovery: "v1",
      billingPricing: {
        v: 1, modelId: MODEL, displayName: "Opus", inputPerMtok: "1", outputPerMtok: "1",
        cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1",
      },
      boxBillingContext: {
        v: 1, sessionId, mode: "chat", parentSessionId: null, delegateAgentId: null,
        turnKey: input.fingerprint.turnKey, parentTurnKey: null, authority: null, dispatchId: null,
        attemptNo: null, verificationSponsorship: null, apiKeyId: null,
      },
    })],
  );
  return input;
}

function journal(caps: BoxRunCapacity): BoxDurableJournal {
  return new BoxDurableJournal(pool, () => caps);
}

async function markHandoff(requestId: string): Promise<void> {
  const updated = await pool.query(
    `UPDATE request_finalize_journal
        SET ctx = jsonb_set(ctx, '{boxState}', '"handoff"')
      WHERE request_id = $1 AND ctx->>'boxState' = 'reserved'`,
    [requestId],
  );
  assert.equal(updated.rowCount, 1);
}

test("parent handoff with the same session id is held, a sub-session admits under 6/3",
  { skip: !available }, async () => {
    const uid = 409n;
    const accountId = 4090n;
    const parentSession = "parent-session-409";
    const caps = { maxRunsPerAccount: 6, maxRunsPerUser: 3 };
    const j = journal(caps);
    const parent = await candidate(uid, accountId, parentSession);
    await j.admit(parent);
    await markHandoff(parent.requestId);

    await assert.rejects(
      async () => j.admit(await candidate(uid, accountId, parentSession)),
      held,
    );

    const childA = await candidate(uid, accountId, `agent-${"a".repeat(32)}`);
    const childB = await candidate(uid, accountId, `agent-${"b".repeat(32)}`);
    await j.admit(childA);
    await j.admit(childB);

    await assert.rejects(
      async () => j.admit(await candidate(uid, accountId, `agent-${"c".repeat(32)}`)),
      held,
      "the fourth user run is still held at 3",
    );
    await assert.rejects(
      async () => j.admit(await candidate(uid, accountId, parentSession)),
      held,
      "the parent session stays held after the sub-sessions are admitted",
    );

    const parentRow = await pool.query<{ state: string; session_id: string }>(
      `SELECT ctx->>'boxState' AS state, ctx->>'boxSessionId' AS session_id
         FROM request_finalize_journal WHERE request_id = $1`,
      [parent.requestId],
    );
    assert.equal(parentRow.rows[0]?.state, "handoff");
    assert.equal(parentRow.rows[0]?.session_id, parentSession);
    const childRow = await pool.query<{ session_id: string }>(
      `SELECT ctx->>'boxSessionId' AS session_id
         FROM request_finalize_journal WHERE request_id = $1`,
      [childA.requestId],
    );
    assert.equal(childRow.rows[0]?.session_id, childA.fingerprint.sessionId);
    assert.notEqual(childRow.rows[0]?.session_id, parentSession);
  });

test("a second run on another session is still held at the default 1/1 cap",
  { skip: !available }, async () => {
    const j = journal({ maxRunsPerAccount: 1, maxRunsPerUser: 1 });
    await j.admit(await candidate(410n, 4100n, "only-session"));
    await assert.rejects(
      async () => j.admit(await candidate(410n, 4100n, "other-session")),
      held,
    );
  });

test("the sixth account run is admitted and the seventh is held",
  { skip: !available }, async () => {
    const uid = 411n;
    const accountId = 4110n;
    const j = journal({ maxRunsPerAccount: 6, maxRunsPerUser: 16 });
    for (let i = 0; i < 6; i++) {
      await j.admit(await candidate(uid, accountId, `acct-${i}`));
    }
    await assert.rejects(
      async () => j.admit(await candidate(uid, accountId, "acct-6")),
      held,
    );
  });
