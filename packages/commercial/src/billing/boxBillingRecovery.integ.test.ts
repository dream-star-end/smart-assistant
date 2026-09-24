/** Real SQL outcome in one PG connection with TEMP shadow tables only.
 * No migration, persistent financial write, or Box model invocation. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { recoverBoxBillingRequest } from "./boxBillingRecovery.js";

test("terminal Box evidence settles once, with durable usage and turn locator",
  { skip: !process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL,
    max: 1 });
  const client = await pool.connect();
  try {
    await client.query("CREATE TEMP SEQUENCE box_recovery_usage_id_seq");
    await client.query("CREATE TEMP TABLE request_finalize_journal (LIKE public.request_finalize_journal INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE usage_records (LIKE public.usage_records INCLUDING ALL)");
    await client.query("ALTER TABLE pg_temp.usage_records ALTER COLUMN id SET DEFAULT nextval('pg_temp.box_recovery_usage_id_seq'::regclass)");
    await client.query("CREATE TEMP TABLE pending_usage_patches (LIKE public.pending_usage_patches INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE users (LIKE public.users INCLUDING ALL)");
    await client.query("CREATE TEMP SEQUENCE box_recovery_ledger_id_seq");
    await client.query("CREATE TEMP TABLE credit_ledger (LIKE public.credit_ledger INCLUDING ALL)");
    await client.query("ALTER TABLE pg_temp.credit_ledger ALTER COLUMN id SET DEFAULT nextval('pg_temp.box_recovery_ledger_id_seq'::regclass)");
    const sameConnection = { connect: async () => ({ query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as unknown as Pool;
    const requestId = `box-recovery-${randomBytes(6).toString("hex")}`;
    const userId = 900_000_000n, turnKey = "a".repeat(64);
    await client.query(`INSERT INTO users(id,email,password_hash,credits)
      VALUES ($1,$2,'test-only-hash',1000)`,
    [userId.toString(), `${requestId}@example.invalid`]);
    const nonce = "b".repeat(24), epoch = "c".repeat(32);
    const ctx = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      boxState: "terminal", boxAccountId: "20", boxReplayFingerprint: "d".repeat(64),
      boxTurnKey: turnKey, boxRunNonce: nonce, boxLeaseEpoch: epoch,
      boxTerminalProof: { runNonce: nonce, leaseEpoch: epoch, keeperPid: 101,
        cliPid: 102, reason: "worker_complete", revision: 1 },
      boxUsage: { inputTokens: 2, outputTokens: 3,
        cacheReadTokens: 0, cacheWriteTokens: 0 },
      billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
        inputPerMtok: "100000000", outputPerMtok: "100000000",
        cacheReadPerMtok: "100000000", cacheWritePerMtok: "100000000",
        multiplier: "1" },
      boxBillingContext: { v: 1, sessionId: "web-box-recovery", mode: "chat",
        parentSessionId: null, delegateAgentId: null, turnKey, parentTurnKey: null,
        authority: null, dispatchId: null, attemptNo: null,
        verificationSponsorship: null, apiKeyId: null } };
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx,precheck_credits,updated_at)
      VALUES ($1,$2,'inflight',$3::jsonb,0,NOW()-INTERVAL '10 minutes')`,
    [requestId, userId.toString(), JSON.stringify(ctx)]);
    assert.equal(await recoverBoxBillingRequest(sameConnection, requestId, userId), "settled");
    const usage = await client.query<{ request_id: string; cost_credits: string }>(
      "SELECT request_id,cost_credits::text FROM usage_records WHERE request_id=$1", [requestId]);
    assert.equal(usage.rows.length, 1);
    assert.ok(BigInt(usage.rows[0]?.cost_credits ?? "0") > 0n);
    const debited = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [userId.toString()]);
    const balance = BigInt(debited.rows[0]?.credits ?? "0");
    assert.ok(balance < 1000n && balance >= 0n);
    const ledger = await client.query<{ delta: string }>(
      "SELECT delta::text FROM credit_ledger WHERE user_id=$1", [userId.toString()]);
    assert.equal(ledger.rows.length, 1);
    assert.equal(BigInt(ledger.rows[0]!.delta), balance - 1000n);
    const locator = await client.query(
      "SELECT request_id FROM pending_usage_patches WHERE request_id=$1", [requestId]);
    assert.equal(locator.rows.length, 1);
    const journal = await client.query<{ state: string }>(
      "SELECT state FROM request_finalize_journal WHERE request_id=$1", [requestId]);
    assert.equal(journal.rows[0]?.state, "committed");
    assert.equal(await recoverBoxBillingRequest(sameConnection, requestId, userId),
      "already_committed");
    // Crash window: usage/ledger COMMIT succeeded, journal terminal CAS did not.
    await client.query(`UPDATE request_finalize_journal SET state='inflight',
      usage_id=NULL, ledger_id=NULL, final_credits=NULL WHERE request_id=$1`, [requestId]);
    assert.equal(await recoverBoxBillingRequest(sameConnection, requestId, userId),
      "already_committed", "permanent usage must repair the lagging journal");
    const after = await client.query(
      "SELECT request_id FROM usage_records WHERE request_id=$1", [requestId]);
    assert.equal(after.rows.length, 1, "retry must not create a second usage record");
    const afterBalance = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [userId.toString()]);
    assert.equal(BigInt(afterBalance.rows[0]!.credits), balance,
      "retry must not debit twice");
  } finally {
    client.release();
    await pool.end(); // TEMP tables and sequence vanish with this connection.
  }
});
