/** Real PG CAS against connection-local TEMP shadow; no migration or live rows. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import type { BoxPrelaunchReceipt } from "./boxPrelaunchControl.js";

const url = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
test("prelaunch cleanup CAS cannot cross a durable launch permit", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL,
      state text NOT NULL, ctx jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now())`);
    const same = { connect: async () => ({ query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as never;
    const journal = new BoxDurableJournal(same);
    const suffix = randomBytes(6).toString("hex");
    const basis = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5",
        displayName: "Opus", inputPerMtok: "1", outputPerMtok: "1",
        cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" },
      boxBillingContext: { v: 1, sessionId: `session-${suffix}`, mode: "chat",
        parentSessionId: null, delegateAgentId: null, turnKey: "a".repeat(64),
        parentTurnKey: null, authority: null, dispatchId: null, attemptNo: null,
        verificationSponsorship: null, apiKeyId: null } };
    const make = async (requestId: string, accountId: bigint, nonce: string,
      replayFingerprint: string) => {
      const sessionId = `session-${suffix}-${accountId}`;
      await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
        VALUES ($1,3,'inflight',$2::jsonb)`, [requestId, JSON.stringify({ ...basis,
          boxBillingContext: { ...basis.boxBillingContext, sessionId } })]);
      const identity = { requestId, uid: 3n, accountId,
        model: basis.model, fingerprint: { turnKey: "a".repeat(64),
          sessionId, requestHash: randomBytes(32).toString("hex"),
          replayFingerprint }, runNonce: nonce, leaseEpoch: randomBytes(16).toString("hex"),
        invocationMode: "detached_tool" as const, contextHash: "f".repeat(64) };
      await journal.admit(identity);
      const manifest = { accountId: accountId.toString(), controlDev: "2049",
        controlId: randomBytes(16).toString("hex"), controlIno: "9001",
        leaseEpoch: identity.leaseEpoch, lockDev: "2049", lockIno: "9002",
        runNonce: nonce, version: 2 as const };
      const receipt: BoxPrelaunchReceipt = { ...manifest,
        identityHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
      await journal.recordPrelaunchControl({ ...identity, receipt });
      return { identity, receipt };
    };
    const first = await make(`box-pre-a-${suffix}`, 20n,
      randomBytes(12).toString("hex"), randomBytes(32).toString("hex"));
    await assert.rejects(() => journal.markRunning(first.identity),
      (e: unknown) => e instanceof BoxDurableJournalError
        && e.code === "BOX_JOURNAL_START_FENCE_LOST");
    await assert.rejects(() => journal.markPrestartStopped(first.identity),
      (e: unknown) => e instanceof BoxDurableJournalError
        && e.code === "BOX_JOURNAL_PRESTART_FENCE_LOST");
    await journal.armGuardedLaunch({ ...first.identity, receipt: first.receipt });
    assert.equal(await journal.prelaunchCleanupDoneByRunIdentity(first.identity), false);
    await assert.rejects(() => journal.markGuardedPrestartStopped({ ...first.identity,
      receipt: first.receipt, cleanedReceipt: `cleaned:${first.receipt.identityHash}` }),
      (e: unknown) => e instanceof BoxDurableJournalError
        && e.code === "BOX_PRELAUNCH_STOP_FENCE_LOST");
    const second = await make(`box-pre-b-${suffix}`, 21n,
      randomBytes(12).toString("hex"), randomBytes(32).toString("hex"));
    await journal.markUnknown({ ...second.identity, phase: "stage_transport_unknown:input_0" });
    const pending = await journal.listPrelaunchRecoveryCandidates();
    assert.deepEqual(pending.map((item) => item.requestId), [second.identity.requestId],
      "armed first row must not be taken as prelaunch cleanup");
    assert.equal(await journal.claimPrelaunchRecovery(pending[0]!), true);
    assert.equal(await journal.claimPrelaunchRecovery(pending[0]!), false,
      "second worker must not duplicate a claimed cleanup");
    await assert.rejects(() => journal.markGuardedPrestartStopped({ ...second.identity,
      receipt: second.receipt, cleanedReceipt: "cleaned:" + "0".repeat(64) }),
      (e: unknown) => e instanceof BoxDurableJournalError
        && e.code === "BOX_PRELAUNCH_CLEAN_EVIDENCE_INVALID");
    await journal.markGuardedPrestartStopped({ ...second.identity,
      receipt: second.receipt, cleanedReceipt: `cleaned:${second.receipt.identityHash}` });
    const rows = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [second.identity.requestId]);
    assert.equal(rows.rows[0]?.ctx.boxState, "prestart_stopped");
    assert.deepEqual(rows.rows[0]?.ctx.boxPrelaunchCleanup,
      { v: 1, receipt: `cleaned:${second.receipt.identityHash}` });
    assert.equal(await journal.prelaunchCleanupDoneByRunIdentity(second.identity), true);
    assert.deepEqual(await journal.listPrelaunchRecoveryCandidates(), []);
    const third = await make(`box-pre-c-${suffix}`, 22n,
      randomBytes(12).toString("hex"), randomBytes(32).toString("hex"));
    await client.query(`UPDATE request_finalize_journal
      SET updated_at=NOW()-INTERVAL '17 minutes' WHERE request_id=$1`,
      [third.identity.requestId]);
    const stale = await journal.listPrelaunchRecoveryCandidates();
    assert.deepEqual(stale.map((item) => item.requestId), [third.identity.requestId]);
    assert.equal(await journal.claimPrelaunchRecovery(stale[0]!), true);
    const taken = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [third.identity.requestId]);
    assert.equal(taken.rows[0]?.ctx.boxState, "unknown");
    const fourth = await make(`box-pre-d-${suffix}`, 23n,
      randomBytes(12).toString("hex"), randomBytes(32).toString("hex"));
    await journal.markUnknown({ ...fourth.identity, phase: "stage_transport_unknown:input_0" });
    for (let i = 0; i < 10; i++) {
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,updated_at)
        VALUES ($1,3,'inflight',$2::jsonb,NOW()-INTERVAL '20 minutes')`,
      [`box-malformed-${suffix}-${i}`, JSON.stringify({
        boxInvocationMode: "detached_tool", boxState: "unknown",
        boxAccountId: "021", boxRunNonce: second.identity.runNonce,
        boxLeaseEpoch: second.identity.leaseEpoch,
        boxPrelaunchControl: second.receipt })]);
    }
    assert.deepEqual(await journal.listPrelaunchRecoveryCandidates(10), [],
      "first batch quarantines malformed identities instead of dispatching cleanup");
    const afterQuarantine = await journal.listPrelaunchRecoveryCandidates(10);
    assert.deepEqual(afterQuarantine.map((item) => item.requestId),
      [fourth.identity.requestId], "healthy row must not starve behind malformed rows");
  } finally { client.release(); await pool.end(); }
});
