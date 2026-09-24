/** Real PostgreSQL transaction test against a session-local TEMP shadow table.
 * No migration and no writes to the live request_finalize_journal. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { abortInflightJournal } from "../../billing/proxyBilling.js";

test("Box journal fences replay/account capacity and persists proof plus exact usage",
  { skip: !process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL,
    max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, state text NOT NULL,
      ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    // Pin all journal operations to this one connection, whose temp table
    // shadows the real table. No shared schema or persistent row is touched.
    const sameConnection = { connect: async () => ({
      query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as never;
    const journal = new BoxDurableJournal(sameConnection);
    const suffix = randomBytes(6).toString("hex");
    const fingerprint = { turnKey: "a".repeat(64), sessionId: `session-${suffix}`,
      requestHash: "b".repeat(64), replayFingerprint: "c".repeat(64) };
    const basis = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5",
        displayName: "Opus", inputPerMtok: "1", outputPerMtok: "1",
        cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" } };
    const put = async (id: string) => client.query(
      `INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
       VALUES ($1,3,'inflight',$2::jsonb)`, [id, JSON.stringify(basis)]);
    await put(`box-a-${suffix}`);
    await put(`box-b-${suffix}`);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [`box-no-price-${suffix}`,
      JSON.stringify({ model: basis.model, boxInvocationRecovery: "v1" })]);
    const input = { requestId: `box-a-${suffix}`, uid: 3n, accountId: 20n,
      model: basis.model, fingerprint, runNonce: "d".repeat(24), leaseEpoch: "e".repeat(32) };
    await assert.rejects(() => journal.admit({ ...input,
      requestId: `box-no-price-${suffix}` }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_JOURNAL_NOT_INFLIGHT");
    await journal.admit(input);
    assert.equal(await abortInflightJournal(sameConnection, input.requestId,
      "client disconnected"), false, "reserved Box call cannot be legacy-aborted");
    await assert.rejects(() => journal.admit({ ...input, requestId: `box-b-${suffix}` }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_CALL_AMBIGUOUS");
    await assert.rejects(() => journal.admit({ ...input, requestId: `box-b-${suffix}`,
      fingerprint: { ...fingerprint, replayFingerprint: "f".repeat(64) } }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_CAPACITY_HELD");
    await journal.markRunning(input);
    await journal.markUnknown({ ...input, phase: "model_transport_unknown" });
    const proof = { runNonce: input.runNonce, leaseEpoch: input.leaseEpoch,
      keeperPid: 101, cliPid: 102, reason: "worker_complete" as const, revision: 1 as const };
    const usage = { inputTokens: 51, outputTokens: 7,
      cacheReadTokens: 9, cacheWriteTokens: 3 };
    await journal.complete({ ...input, proof, usage });
    assert.equal(await abortInflightJournal(sameConnection, input.requestId,
      "late client disconnect"), false);
    const row = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [input.requestId]);
    assert.equal(row.rows[0]?.ctx.boxState, "terminal");
    assert.deepEqual(row.rows[0]?.ctx.boxUsage, usage);
    assert.deepEqual(row.rows[0]?.ctx.boxTerminalProof, proof);
    await assert.rejects(() => journal.admit({ ...input, requestId: `box-b-${suffix}` }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_CALL_AMBIGUOUS");
    await journal.admit({ ...input, requestId: `box-b-${suffix}`,
      fingerprint: { ...fingerprint, replayFingerprint: "f".repeat(64) },
      runNonce: "1".repeat(24), leaseEpoch: "2".repeat(32) });
    await journal.markPrestartStopped({ requestId: `box-b-${suffix}`,
      uid: 3n, leaseEpoch: "2".repeat(32) });
    const prestart = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [`box-b-${suffix}`]);
    assert.equal(prestart.rows[0]?.ctx.boxState, "prestart_stopped");
    assert.equal(await abortInflightJournal(sameConnection, `box-b-${suffix}`,
      "no model started"), true, "proven prestart failure may release generic journal");
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.request_finalize_journal");
    client.release();
    await pool.end();
  }
});
