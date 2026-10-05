/** Real PostgreSQL test of the journal's model fences for every listed Box
 * model, against a session-local TEMP shadow table (same technique as
 * boxDurableJournal.integ.test.ts). No live table is touched. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BOX_API_MODELS } from "@openclaude/protocol";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { deriveBoxCallFingerprint } from "./boxCallFingerprint.js";
import type { ProxyBody } from "./shared.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;
const coded = (code: string) => (error: unknown) =>
  error instanceof BoxDurableJournalError && error.code === code;

test("the detached text lane runs each listed Box model under its own upstream id",
  { skip: !testDatabaseUrl }, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL,
      container_id bigint, state text NOT NULL,
      ctx jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query(`CREATE TEMP TABLE usage_records (
      request_id text NOT NULL, user_id bigint NOT NULL)`);
    const query = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const journal = new BoxDurableJournal({ connect: async () => ({
      query, release: () => {} }), query } as never);
    const suffix = randomBytes(6).toString("hex");
    const runnerHash = "5".repeat(64);
    let n = 0;
    for (const listed of BOX_API_MODELS) {
      n += 1;
      const other = BOX_API_MODELS[n % BOX_API_MODELS.length]!;
      const requestId = `box-set-${n}-${suffix}`;
      const sessionId = `session-set-${n}-${suffix}`;
      const turnKey = String(n).repeat(64);
      const runNonce = String(n).repeat(24), leaseEpoch = String(n).repeat(32);
      const accountId = BigInt(40 + n);
      const body = { model: listed.id, stream: true, max_tokens: 128,
        messages: [{ role: "user", content: `synthetic ${listed.id}` }],
        metadata: { user_id: JSON.stringify({ session_id: sessionId,
          oc_turn_key: turnKey }) } } as ProxyBody;
      await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
        VALUES ($1,3,'inflight',$2::jsonb)`, [requestId, JSON.stringify({
        model: listed.id, boxInvocationRecovery: "v1",
        billingPricing: { v: 1, modelId: listed.id, displayName: "Synthetic",
          inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1",
          cacheWritePerMtok: "1", multiplier: "1" },
        boxBillingContext: { v: 1, sessionId, mode: "chat", parentSessionId: null,
          delegateAgentId: null, turnKey, parentTurnKey: null, authority: null,
          dispatchId: null, attemptNo: null, verificationSponsorship: null,
          apiKeyId: null } })]);
      const admission = { requestId, uid: 3n, accountId, model: listed.id,
        canonicalBody: body, fingerprint: deriveBoxCallFingerprint(3n, body),
        runNonce, leaseEpoch, replayRequired: true, detachedRunnerHash: runnerHash };
      // Another listed model's upstream id is not this model's.
      await assert.rejects(() => journal.admit({ ...admission,
        upstreamModel: other.upstreamModel }), coded("BOX_TEXT_DETACHED_BINDING_INVALID"),
      `${listed.id} with ${other.upstreamModel}`);
      await assert.rejects(() => journal.admit({ ...admission,
        upstreamModel: listed.id }), coded("BOX_TEXT_DETACHED_BINDING_INVALID"));
      await journal.admit({ ...admission, upstreamModel: listed.upstreamModel });
      const launch = { requestId, uid: 3n, accountId, runNonce, leaseEpoch,
        detachedRunnerHash: runnerHash };
      await assert.rejects(() => journal.armTextLaunch({ ...launch,
        upstreamModel: other.upstreamModel }), coded("BOX_TEXT_LAUNCH_FENCE_LOST"));
      await assert.rejects(() => journal.armTextLaunch({ ...launch,
        upstreamModel: "claude-opus-5" }), coded("BOX_TEXT_LAUNCH_IDENTITY_INVALID"));
      await journal.armTextLaunch({ ...launch, upstreamModel: listed.upstreamModel });
      const identity = await journal.findReplayIdentity({ uid: 3n,
        canonicalModel: listed.id, canonicalBody: body });
      assert.equal(identity?.rootLaunchPermit, true);
      assert.equal(identity?.upstreamModel, listed.upstreamModel);
      await client.query(`UPDATE request_finalize_journal SET container_id=500
        WHERE request_id=$1`, [requestId]);
      const cancelable = await journal.findCancelableRun({ uid: 3n,
        containerId: 500n, sessionId, turnKey });
      assert.equal(cancelable.requestId, requestId);
      // The stop fence reads the stored pair: a row whose upstream id is not
      // its own model's is not a stoppable run, nor one outside the table.
      for (const patch of [{ boxUpstreamModel: other.upstreamModel },
        { model: "box-api-claude-opus-5" }]) {
        const kept = (await client.query(`SELECT ctx FROM request_finalize_journal
          WHERE request_id=$1`, [requestId])).rows[0]!.ctx;
        await client.query(`UPDATE request_finalize_journal SET ctx=ctx || $2::jsonb
          WHERE request_id=$1`, [requestId, JSON.stringify(patch)]);
        await assert.rejects(() => journal.findCancelableRun({ uid: 3n,
          containerId: 500n, sessionId, turnKey }), coded("BOX_CANCEL_RUN_UNKNOWN"),
        JSON.stringify(patch));
        await client.query(`UPDATE request_finalize_journal SET ctx=$2::jsonb
          WHERE request_id=$1`, [requestId, JSON.stringify(kept)]);
      }
      await journal.markUnknown({ requestId, uid: 3n, leaseEpoch,
        phase: "synthetic_detached_transport" });
      const unknown = (await journal.listTextUnknownCandidates(20))
        .find((item) => item.requestId === requestId);
      assert.ok(unknown, `${listed.id} is observable after an unknown transport end`);
      assert.equal(unknown.upstreamModel, listed.upstreamModel);
      assert.equal(unknown.accountId, accountId);
      await client.query(`UPDATE request_finalize_journal
        SET ctx=ctx || $2::jsonb WHERE request_id=$1`,
      [requestId, JSON.stringify({ boxUpstreamModel: other.upstreamModel })]);
      assert.equal((await journal.listTextUnknownCandidates(20))
        .some((item) => item.requestId === requestId), false,
      "a row with another model's upstream id is never observed");
      await client.query(`UPDATE request_finalize_journal
        SET ctx=ctx || $2::jsonb WHERE request_id=$1`,
      [requestId, JSON.stringify({ boxUpstreamModel: listed.upstreamModel })]);
      assert.equal(await journal.claimTextUnknownCandidate(unknown), true);
    }
    assert.equal(n, 3);
  } finally {
    client.release();
    await pool.end();
  }
});
