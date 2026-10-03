/**
 * OCV5-297 real PostgreSQL admission under concurrency. Uses a scratch schema
 * with a real table (not TEMP) so several pooled connections race through
 * BoxDurableJournal.admit and its advisory locks at the same time.
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
const schema = `ocv5_297_${randomBytes(4).toString("hex")}`;

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
  pool = new Pool({ connectionString: databaseUrl, max: 16, options: `-c search_path=${schema}` });
});
test.after(async () => {
  if (!available) return;
  await pool.end();
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const held = (error: unknown) => error instanceof BoxDurableJournalError && error.code === "BOX_CAPACITY_HELD";
let seq = 0;
function hex(n: number, len: number): string {
  return n.toString(16).padStart(len, "0").slice(-len);
}

/** A fresh, admittable inflight row (as the proxy writes it before admit). */
async function candidate(uid: bigint, accountId: bigint, sessionId: string) {
  seq += 1;
  const tag = randomBytes(8).toString("hex") + hex(seq, 8);
  const input = {
    requestId: `cap-${tag}`, uid, accountId, model: MODEL,
    runNonce: hex(seq, 8) + randomBytes(8).toString("hex"),
    leaseEpoch: hex(seq, 8) + randomBytes(12).toString("hex"),
    fingerprint: { sessionId, turnKey: tag.padEnd(64, "a"),
      requestHash: tag.padEnd(64, "b"), replayFingerprint: tag.padEnd(64, "c") },
  };
  await pool.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
    VALUES ($1,$2,'inflight',$3::jsonb)`, [input.requestId, uid.toString(), JSON.stringify({
      model: MODEL, boxInvocationRecovery: "v1",
      billingPricing: { v: 1, modelId: MODEL, displayName: "Opus", inputPerMtok: "1", outputPerMtok: "1",
        cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" },
      boxBillingContext: { v: 1, sessionId, mode: "chat", parentSessionId: null, delegateAgentId: null,
        turnKey: input.fingerprint.turnKey, parentTurnKey: null, authority: null, dispatchId: null,
        attemptNo: null, verificationSponsorship: null, apiKeyId: null },
    })]);
  return input;
}

function journal(caps: BoxRunCapacity): BoxDurableJournal {
  return new BoxDurableJournal(pool, () => caps);
}

async function settle(list: Array<Promise<unknown>>): Promise<{ ok: number; held: number; other: unknown[] }> {
  const results = await Promise.allSettled(list);
  const other: unknown[] = [];
  let ok = 0; let heldCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled") ok++;
    else if (held(result.reason)) heldCount++;
    else other.push(result.reason);
  }
  return { ok, held: heldCount, other };
}

test("ten concurrent sessions on one account are admitted and the eleventh is held",
  { skip: !available }, async () => {
    const accountId = 1000n + BigInt(seq);
    const j = journal({ maxRunsPerAccount: 10, maxRunsPerUser: 16 });
    const inputs = await Promise.all(Array.from({ length: 11 }, (_, i) =>
      candidate(3n, accountId, `s10-${i}-${randomBytes(3).toString("hex")}`)));
    const outcome = await settle(inputs.map((input) => j.admit(input)));
    assert.deepEqual(outcome.other, []);
    assert.equal(outcome.ok, 10);
    assert.equal(outcome.held, 1);
  });

test("the per-user cap holds across two accounts admitted at the same time",
  { skip: !available }, async () => {
    const uid = 40n + BigInt(seq);
    const j = journal({ maxRunsPerAccount: 5, maxRunsPerUser: 1 });
    for (let round = 0; round < 5; round++) {
      await pool.query(`UPDATE request_finalize_journal SET ctx=ctx || '{"boxState":"terminal"}'::jsonb
        WHERE user_id=$1`, [uid.toString()]);
      const a = await candidate(uid, 2000n, `u-a-${round}-${randomBytes(3).toString("hex")}`);
      const b = await candidate(uid, 2001n, `u-b-${round}-${randomBytes(3).toString("hex")}`);
      const outcome = await settle([j.admit(a), j.admit(b)]);
      assert.deepEqual(outcome.other, []);
      assert.equal(outcome.ok, 1, `round ${round}: exactly one cross-account admission`);
      assert.equal(outcome.held, 1);
    }
  });

test("malformed active rows occupy one slot each instead of blocking the account",
  { skip: !available }, async () => {
    const accountId = 3000n;
    const j = journal({ maxRunsPerAccount: 3, maxRunsPerUser: 16 });
    // Two malformed rows of the same session and one with no session at all.
    for (const [id, ctx] of [
      ["bad-1", { boxState: "running", boxAccountId: "3000", boxSessionId: "bad", boxRunNonce: "x", boxLeaseEpoch: "y" }],
      ["bad-2", { boxState: "running", boxAccountId: "3000", boxSessionId: "bad", boxRunNonce: "x", boxLeaseEpoch: "y" }],
    ] as const) {
      await pool.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
        VALUES ($1,77,'inflight',$2::jsonb)`, [`${id}-${schema}`, JSON.stringify(ctx)]);
    }
    // bad-1 + bad-2 = 2 slots (never merged by session); one slot is left.
    await j.admit(await candidate(31n, accountId, `m-ok-${randomBytes(3).toString("hex")}`));
    await assert.rejects(async () => j.admit(await candidate(31n, accountId, `m-full-${randomBytes(3).toString("hex")}`)), held);
    // A malformed row with a NULL session still occupies a slot.
    const nullAccount = 3001n;
    await pool.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,78,'inflight',$2::jsonb)`, [`bad-null-${schema}`,
      JSON.stringify({ boxState: "unknown", boxAccountId: "3001" })]);
    const one = journal({ maxRunsPerAccount: 1, maxRunsPerUser: 16 });
    await assert.rejects(async () => one.admit(await candidate(31n, nullAccount, `m-null-${randomBytes(3).toString("hex")}`)), held);
    const two = journal({ maxRunsPerAccount: 2, maxRunsPerUser: 16 });
    await two.admit(await candidate(31n, nullAccount, `m-null2-${randomBytes(3).toString("hex")}`));
  });

test("more than 1024 linked rows of one run are one slot, not a false full account",
  { skip: !available }, async () => {
    const accountId = 4000n;
    const j = journal({ maxRunsPerAccount: 2, maxRunsPerUser: 16 });
    const first = await candidate(32n, accountId, `linked-${randomBytes(3).toString("hex")}`);
    await j.admit(first);
    await pool.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      SELECT 'linked-' || g || '-' || $1, 32, 'inflight', jsonb_build_object('boxState','linked',
        'boxAccountId','4000','boxSessionId',$2::text,'boxRunNonce',$3::text,'boxLeaseEpoch',$4::text)
      FROM generate_series(1,1100) g`,
      [schema, first.fingerprint.sessionId, first.runNonce, first.leaseEpoch]);
    await j.admit(await candidate(32n, accountId, `linked-2-${randomBytes(3).toString("hex")}`));
    await assert.rejects(async () => j.admit(await candidate(32n, accountId, `linked-3-${randomBytes(3).toString("hex")}`)), held);
  });

test("duplicate fingerprint is still rejected for the same user and scoped by user",
  { skip: !available }, async () => {
    const j = journal({ maxRunsPerAccount: 16, maxRunsPerUser: 16 });
    const first = await candidate(33n, 5000n, `dup-${randomBytes(3).toString("hex")}`);
    await j.admit(first);
    const again = await candidate(33n, 5000n, `dup-b-${randomBytes(3).toString("hex")}`);
    again.fingerprint = { ...again.fingerprint, replayFingerprint: first.fingerprint.replayFingerprint };
    await assert.rejects(() => j.admit(again),
      (error: unknown) => error instanceof BoxDurableJournalError && error.code === "BOX_CALL_AMBIGUOUS");
    const otherUser = await candidate(9n, 5000n, `dup-c-${randomBytes(3).toString("hex")}`);
    otherUser.fingerprint = { ...otherUser.fingerprint, replayFingerprint: first.fingerprint.replayFingerprint };
    await j.admit(otherUser);
  });
