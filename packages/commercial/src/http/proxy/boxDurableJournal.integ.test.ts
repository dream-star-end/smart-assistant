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
    const privateMarker = "synthetic-private-marker";
    const guardedQuery = async (sql: string, params: unknown[] = []) => {
      assert.ok(!JSON.stringify(params).includes(privateMarker),
        "raw tool arguments must never enter a PostgreSQL query parameter");
      return client.query(sql, params);
    };
    const sameConnection = { connect: async () => ({
      query: guardedQuery, release: () => {} }), query: guardedQuery } as never;
    const journal = new BoxDurableJournal(sameConnection);
    const suffix = randomBytes(6).toString("hex");
    const fingerprint = { turnKey: "a".repeat(64), sessionId: `session-${suffix}`,
      requestHash: "b".repeat(64), replayFingerprint: "c".repeat(64) };
    const basis = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5",
        displayName: "Opus", inputPerMtok: "1", outputPerMtok: "1",
        cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" },
      boxBillingContext: { v: 1, sessionId: `session-${suffix}`, mode: "chat",
        parentSessionId: null, delegateAgentId: null, turnKey: "a".repeat(64),
        parentTurnKey: null, authority: null, dispatchId: null, attemptNo: null,
        verificationSponsorship: null, apiKeyId: null } };
    const put = async (id: string) => client.query(
      `INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
       VALUES ($1,3,'inflight',$2::jsonb)`, [id, JSON.stringify(basis)]);
    await put(`box-a-${suffix}`);
    await put(`box-b-${suffix}`);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [`box-no-price-${suffix}`,
      JSON.stringify({ model: basis.model, boxInvocationRecovery: "v1" })]);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [`box-wrong-turn-${suffix}`,
      JSON.stringify({ ...basis, boxBillingContext: {
        ...basis.boxBillingContext, turnKey: "b".repeat(64) } })]);
    const input = { requestId: `box-a-${suffix}`, uid: 3n, accountId: 20n,
      model: basis.model, fingerprint, runNonce: "d".repeat(24), leaseEpoch: "e".repeat(32) };
    await assert.rejects(() => journal.admit({ ...input,
      requestId: `box-no-price-${suffix}` }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_JOURNAL_NOT_INFLIGHT");
    await assert.rejects(() => journal.admit({ ...input,
      requestId: `box-wrong-turn-${suffix}` }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_JOURNAL_BASIS_INVALID");
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

    // First completed model tool message is durable before terminal SSE.
    await put(`box-c-${suffix}`);
    const toolCall = { ...input, requestId: `box-c-${suffix}`,
      fingerprint: { ...fingerprint, replayFingerprint: "9".repeat(64) },
      runNonce: "3".repeat(24), leaseEpoch: "4".repeat(32) };
    await journal.admit(toolCall);
    await journal.markRunning(toolCall);
    const candidate = { messageId: "msg_box_tool_1", toolUses: [
      { id: "toolu_A", boxName: "mcp__ocbridge__t0",
        clientName: "local_echo", input: { value: privateMarker } },
      { id: "toolu_B", boxName: "mcp__ocbridge__t0",
        clientName: "local_echo", input: { value: privateMarker } },
    ], inputTokens: 7, outputTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 0 };
    const receipt = await journal.recordToolHandoff({ ...toolCall, candidate,
      verifiedPendingToolUseIds: ["toolu_A"] });
    assert.deepEqual(receipt.journaledToolUseIds, ["toolu_A", "toolu_B"]);
    assert.deepEqual(receipt.verifiedPendingToolUseIds, ["toolu_A"]);
    const handoff = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [toolCall.requestId]);
    assert.equal(handoff.rows[0]?.ctx.boxState, "handoff");
    assert.ok(!JSON.stringify(handoff.rows[0]?.ctx).includes(privateMarker));
    const persistedUses = (handoff.rows[0]?.ctx.boxToolHandoff as {
      toolUses: Array<Record<string, unknown>> }).toolUses;
    assert.ok(persistedUses.every((use) => /^[a-f0-9]{64}$/.test(String(use.inputHash))
      && !Object.hasOwn(use, "input")));
    assert.deepEqual((handoff.rows[0]?.ctx.boxToolHandoff as Record<string, unknown>).usage,
      { inputTokens: 7, outputTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 0 });
    await assert.rejects(() => journal.recordToolHandoff({ ...toolCall, candidate,
      verifiedPendingToolUseIds: ["toolu_not_in_model"] }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_HANDOFF_EVIDENCE_INVALID");
    await assert.rejects(() => journal.recordToolHandoff({ ...toolCall, candidate,
      verifiedPendingToolUseIds: ["toolu_A"] }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_HANDOFF_FENCE_LOST");

    await put(`box-d-${suffix}`);
    const resumeBody = { model: basis.model, max_tokens: 128,
      metadata: { user_id: JSON.stringify({ oc_turn_key: "a".repeat(64),
        session_id: `session-${suffix}` }) },
      messages: [
        { role: "assistant", content: candidate.toolUses.map((use) => ({
          type: "tool_use", id: use.id, name: use.clientName, input: use.input })) },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_B", content: "second" },
          { type: "tool_result", tool_use_id: "toolu_A", content: "first" },
        ] },
      ] };
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model,
      canonicalBody: { ...resumeBody, messages: [resumeBody.messages[0]!,
        { role: "user", content: [resumeBody.messages[1]!.content[0]!] }] } }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_RESULT_MISMATCH");
    const resumed = await journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: resumeBody });
    assert.equal(resumed.ownerRequestId, toolCall.requestId);
    assert.equal(resumed.accountId, 20n);
    assert.deepEqual(resumed.results.map((result) => result.modelToolUseId),
      ["toolu_A", "toolu_B"]);
    const linked = await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
      `SELECT request_id,ctx FROM request_finalize_journal
        WHERE request_id IN ($1,$2) ORDER BY request_id`,
      [toolCall.requestId, `box-d-${suffix}`]);
    assert.equal(linked.rows.find((row) => row.request_id === toolCall.requestId)?.ctx.boxState,
      "resuming");
    assert.equal(linked.rows.find((row) => row.request_id === `box-d-${suffix}`)?.ctx.boxState,
      "linked");
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: resumeBody }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_CALL_AMBIGUOUS");
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.request_finalize_journal");
    client.release();
    await pool.end();
  }
});
