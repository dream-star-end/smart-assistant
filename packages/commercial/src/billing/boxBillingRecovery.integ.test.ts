/** Real SQL outcome in one PG connection with TEMP shadow tables only.
 * No migration, persistent financial write, or Box model invocation. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { recoverBoxBillingRequest } from "./boxBillingRecovery.js";
import { hashBoxToolInput } from "../http/proxy/boxToolInputHash.js";

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
    // Every spend/organization relation is shadowed on the pinned connection.
    // A coincidentally existing real subscription or org membership for this
    // uid must never be read and, especially, never be UPDATEd by this test.
    await client.query("CREATE TEMP TABLE user_subscriptions (LIKE public.user_subscriptions INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE org_memberships (LIKE public.org_memberships INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE orgs (LIKE public.orgs INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE org_subscriptions (LIKE public.org_subscriptions INCLUDING ALL)");
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
    const shadow = await client.query<{ only_temp: boolean }>(
      `SELECT 'user_subscriptions'::regclass = 'pg_temp.user_subscriptions'::regclass
        AND 'org_memberships'::regclass = 'pg_temp.org_memberships'::regclass
        AND 'orgs'::regclass = 'pg_temp.orgs'::regclass
        AND 'org_subscriptions'::regclass = 'pg_temp.org_subscriptions'::regclass
        AS only_temp`);
    assert.equal(shadow.rows[0]?.only_temp, true);
    // Same uid has an active subscription. The real spend path must debit only
    // this TEMP row, not a coincidentally matching persistent subscription.
    await client.query(`INSERT INTO user_subscriptions
      (id,user_id,plan_code,period_end,period_credits)
      VALUES (1,$1,'plus',NOW()+INTERVAL '1 day',1000)`, [userId.toString()]);
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
    assert.equal(balance, 1000n, "active TEMP period bucket is spent before wallet");
    const period = await client.query<{ period_credits: string }>(
      "SELECT period_credits::text FROM user_subscriptions WHERE user_id=$1", [userId.toString()]);
    const periodAfter = BigInt(period.rows[0]?.period_credits ?? "0");
    assert.ok(periodAfter < 1000n && periodAfter >= 0n);
    const ledger = await client.query<{ delta: string }>(
      "SELECT delta::text FROM credit_ledger WHERE user_id=$1", [userId.toString()]);
    assert.equal(ledger.rows.length, 1);
    assert.equal(BigInt(ledger.rows[0]!.delta), periodAfter - 1000n);
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
    const afterPeriod = await client.query<{ period_credits: string }>(
      "SELECT period_credits::text FROM user_subscriptions WHERE user_id=$1", [userId.toString()]);
    assert.equal(BigInt(afterPeriod.rows[0]!.period_credits), periodAfter);

    // Same-UID org membership negative control: an active org subscription
    // may exist outside this test, but all reads and debits resolve to TEMP.
    const orgUser = 900_000_001n, orgRequest = `${requestId}-org`;
    await client.query(`INSERT INTO users(id,email,password_hash,credits)
      VALUES ($1,$2,'test-only-hash',1000)`, [orgUser.toString(), `${orgRequest}@example.invalid`]);
    await client.query("INSERT INTO orgs(id,name,credits) VALUES (1,'temp-only-org',1000)");
    await client.query(`INSERT INTO org_memberships(org_id,user_id,billing_enabled)
      VALUES (1,$1,true)`, [orgUser.toString()]);
    await client.query(`INSERT INTO org_subscriptions
      (id,org_id,plan_code,seats,period_end,period_credits)
      VALUES (1,1,'team',1,NOW()+INTERVAL '1 day',1000)`);
    const orgTurnKey = "e".repeat(64);
    const orgCtx = { ...ctx, boxReplayFingerprint: "f".repeat(64),
      boxTurnKey: orgTurnKey,
      boxBillingContext: { ...ctx.boxBillingContext, sessionId: "web-org-recovery",
        turnKey: orgTurnKey } };
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx,precheck_credits,updated_at)
      VALUES ($1,$2,'inflight',$3::jsonb,0,NOW()-INTERVAL '10 minutes')`,
    [orgRequest, orgUser.toString(), JSON.stringify(orgCtx)]);
    assert.equal(await recoverBoxBillingRequest(sameConnection, orgRequest, orgUser), "settled");
    const orgPeriod = await client.query<{ period_credits: string }>(
      "SELECT period_credits::text FROM org_subscriptions WHERE org_id=1");
    const orgAfter = BigInt(orgPeriod.rows[0]?.period_credits ?? "0");
    assert.ok(orgAfter < 1000n && orgAfter >= 0n);
    const orgWallet = await client.query<{ credits: string }>(
      "SELECT credits::text FROM orgs WHERE id=1");
    assert.equal(orgWallet.rows[0]?.credits, "1000");
    assert.equal(await recoverBoxBillingRequest(sameConnection, orgRequest, orgUser),
      "already_committed");
    const orgPeriodAgain = await client.query<{ period_credits: string }>(
      "SELECT period_credits::text FROM org_subscriptions WHERE org_id=1");
    assert.equal(BigInt(orgPeriodAgain.rows[0]!.period_credits), orgAfter);

    // A completed model tool message is billable even while the remote CLI
    // remains alive for OpenClaude-local tool results. It must use this round's
    // usage, never a later cumulative CLI terminal snapshot.
    const toolUser = 900_000_002n, toolRequest = `${requestId}-tool`;
    await client.query(`INSERT INTO users(id,email,password_hash,credits)
      VALUES ($1,$2,'test-only-hash',1000)`,
    [toolUser.toString(), `${toolRequest}@example.invalid`]);
    const toolTurnKey = "5".repeat(64);
    const toolCtx = { ...ctx, boxState: "handoff",
      boxReplayFingerprint: "6".repeat(64), boxTurnKey: toolTurnKey,
      boxTerminalProof: undefined, boxUsage: undefined,
      boxHandoffRevision: "123e4567-e89b-42d3-a456-426614174000",
      boxToolHandoff: { version: 1, roundNo: 1, messageId: "msg_tool", spoolOffset: 1234,
        detachedRunnerHash: "f".repeat(64),
        toolUses: [{ id: "toolu_one", boxName: "mcp__ocbridge__t0",
          clientName: "local_echo", inputHash: hashBoxToolInput({ value: "ping" }) }],
        verifiedPendingToolUseIds: ["toolu_one"],
        usage: { inputTokens: 2, outputTokens: 3,
          cacheReadTokens: 0, cacheWriteTokens: 0 } },
      boxBillingContext: { ...ctx.boxBillingContext, sessionId: "web-tool-recovery",
        turnKey: toolTurnKey } };
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx,precheck_credits,updated_at)
      VALUES ($1,$2,'inflight',$3::jsonb,0,NOW()-INTERVAL '10 minutes')`,
    [toolRequest, toolUser.toString(), JSON.stringify(toolCtx)]);
    assert.equal(await recoverBoxBillingRequest(sameConnection, toolRequest, toolUser), "settled");
    const toolUsage = await client.query<{ cost_credits: string }>(
      "SELECT cost_credits::text FROM usage_records WHERE request_id=$1", [toolRequest]);
    assert.equal(toolUsage.rows.length, 1);
    assert.ok(BigInt(toolUsage.rows[0]!.cost_credits) > 0n);
    const toolBalance = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [toolUser.toString()]);
    assert.ok(BigInt(toolBalance.rows[0]!.credits) < 1000n);
    const toolState = await client.query<{ box_state: string }>(
      "SELECT ctx->>'boxState' AS box_state FROM request_finalize_journal WHERE request_id=$1",
      [toolRequest]);
    assert.equal(toolState.rows[0]?.box_state, "handoff",
      "billing settlement must not release the live Box process/account fence");
  } finally {
    client.release();
    await pool.end(); // TEMP tables and sequence vanish with this connection.
  }
});
