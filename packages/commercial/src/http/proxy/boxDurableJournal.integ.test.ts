/** Real PostgreSQL transaction test against a session-local TEMP shadow table.
 * No migration and no writes to the live request_finalize_journal. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxContextHash, hashBoxAssistantContent } from "./boxCallFingerprint.js";
import type { ProxyBody } from "./shared.js";
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
    await client.query(`CREATE TEMP TABLE usage_records (
      request_id text NOT NULL, user_id bigint NOT NULL)`);
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
    await assert.rejects(() => journal.complete({ ...input, proof,
      usage: { "cacheReadTokens,cacheWriteTokens,inputTokens,outputTokens": 1 } as never }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_JOURNAL_EVIDENCE_INVALID");
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
    const toolDeclarations = [{ name: "local_echo", description: "local-only",
      input_schema: { type: "object", properties: { value: { type: "string" } } } }];
    const firstBody: ProxyBody = { model: basis.model, max_tokens: 128,
      tools: toolDeclarations,
      metadata: { user_id: JSON.stringify({ oc_turn_key: "a".repeat(64),
        session_id: `session-${suffix}` }) },
      messages: [{ role: "user", content: "synthetic first prompt" }] };
    const toolCall = { ...input, requestId: `box-c-${suffix}`,
      invocationMode: "detached_tool" as const,
      contextHash: deriveBoxContextHash(firstBody),
      fingerprint: { ...fingerprint, replayFingerprint: "9".repeat(64) },
      runNonce: "3".repeat(24), leaseEpoch: "4".repeat(32) };
    await journal.admit(toolCall);
    await journal.markRunning(toolCall);
    const firstToolUses = [
      { id: "toolu_A", boxName: "mcp__ocbridge__t0",
        clientName: "local_echo", input: { value: privateMarker } },
      { id: "toolu_B", boxName: "mcp__ocbridge__t0",
        clientName: "local_echo", input: { value: privateMarker } },
    ];
    const firstAssistantContent = [
      { type: "text", text: "Box said A before calling tools" },
      ...firstToolUses.map((use) => ({ type: "tool_use", id: use.id,
        name: use.clientName, input: use.input })),
    ];
    const candidate = { messageId: "msg_box_tool_1", toolUses: firstToolUses,
      assistantContentHash: hashBoxAssistantContent(firstAssistantContent),
      inputTokens: 7, outputTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 0 };
    const catalogHash = compileBoxToolCatalog(toolDeclarations).bindingSha256;
    const receipt = await journal.recordToolHandoff({ ...toolCall, candidate,
      spoolOffset: 1234,
      detachedRunnerHash: "f".repeat(64),
      catalogHash,
      verifiedPendingToolUseIds: ["toolu_A"] });
    assert.deepEqual(receipt.journaledToolUseIds, ["toolu_A", "toolu_B"]);
    assert.deepEqual(receipt.verifiedPendingToolUseIds, ["toolu_A"]);
    const handoff = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [toolCall.requestId]);
    assert.equal(handoff.rows[0]?.ctx.boxState, "handoff");
    assert.equal((handoff.rows[0]?.ctx.boxToolHandoff as { spoolOffset: number }).spoolOffset, 1234);
    assert.equal((handoff.rows[0]?.ctx.boxToolHandoff as { detachedRunnerHash: string }).detachedRunnerHash,
      "f".repeat(64));
    assert.ok(!JSON.stringify(handoff.rows[0]?.ctx).includes(privateMarker));
    const persistedUses = (handoff.rows[0]?.ctx.boxToolHandoff as {
      toolUses: Array<Record<string, unknown>> }).toolUses;
    assert.ok(persistedUses.every((use) => /^[a-f0-9]{64}$/.test(String(use.inputHash))
      && !Object.hasOwn(use, "input")));
    assert.deepEqual((handoff.rows[0]?.ctx.boxToolHandoff as Record<string, unknown>).usage,
      { inputTokens: 7, outputTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 0 });
    await assert.rejects(() => journal.recordToolHandoff({ ...toolCall, candidate,
      spoolOffset: 1234,
      detachedRunnerHash: "f".repeat(64),
      catalogHash,
      verifiedPendingToolUseIds: ["toolu_not_in_model"] }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_HANDOFF_EVIDENCE_INVALID");
    await assert.rejects(() => journal.recordToolHandoff({ ...toolCall, candidate,
      spoolOffset: 1234,
      detachedRunnerHash: "f".repeat(64),
      catalogHash,
      verifiedPendingToolUseIds: ["toolu_A"] }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_HANDOFF_FENCE_LOST");

    await put(`box-d-${suffix}`);
    const resumeBody = { ...firstBody, messages: [
        ...firstBody.messages,
        { role: "assistant", content: firstAssistantContent },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_B", content: "second" },
          { type: "tool_result", tool_use_id: "toolu_A", content: "x".repeat(1_100_000) },
        ] },
      ] };
    await client.query(`UPDATE request_finalize_journal SET
      ctx=jsonb_set(ctx,'{boxToolHandoff,spoolOffset}',to_jsonb($2::bigint))
      WHERE request_id=$1`, [toolCall.requestId, 64 * 1024 * 1024 - 1_000_000]);
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: resumeBody }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_SPOOL_CAPACITY_EXCEEDED");
    await client.query(`UPDATE request_finalize_journal SET
      ctx=jsonb_set(ctx,'{boxToolHandoff,spoolOffset}',to_jsonb(1234::bigint))
      WHERE request_id=$1`, [toolCall.requestId]);
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model,
      canonicalBody: { ...resumeBody, messages: [...resumeBody.messages.slice(0, -1),
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_B", content: "second" }] }] } }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_RESULT_MISMATCH");
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model,
      canonicalBody: { ...resumeBody, tools: [{ ...toolDeclarations[0]!,
        description: "changed after Box launch" }] } }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_CATALOG_CHANGED");
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model,
      canonicalBody: { ...resumeBody, tools: [{ ...toolDeclarations[0]!,
        name: "renamed_echo" }] } }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_CATALOG_CHANGED");
    await client.query(`UPDATE request_finalize_journal SET
      ctx=jsonb_set(ctx,'{boxToolHandoff,toolUses,1,id}','"toolu_A"'::jsonb)
      WHERE request_id=$1`, [toolCall.requestId]);
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: resumeBody }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_OWNER_INVALID");
    await client.query(`UPDATE request_finalize_journal SET
      ctx=jsonb_set(ctx,'{boxToolHandoff,toolUses,1,id}','"toolu_B"'::jsonb)
      WHERE request_id=$1`, [toolCall.requestId]);
    await client.query(`UPDATE request_finalize_journal SET
      ctx=jsonb_set(ctx,'{boxToolHandoff,verifiedPendingToolUseIds}',
        '["toolu_A","toolu_A"]'::jsonb) WHERE request_id=$1`, [toolCall.requestId]);
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: resumeBody }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_OWNER_INVALID");
    await client.query(`UPDATE request_finalize_journal SET
      ctx=jsonb_set(ctx,'{boxToolHandoff,verifiedPendingToolUseIds}',
        '["toolu_A"]'::jsonb) WHERE request_id=$1`, [toolCall.requestId]);
    for (const alteredContent of [
      [{ type: "text", text: "Box said B before calling tools" },
        ...firstAssistantContent.slice(1)],
      firstAssistantContent.slice(1),
      [{ type: "thinking", thinking: "inserted", signature: "sig" },
        ...firstAssistantContent],
    ]) {
      await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
        uid: 3n, canonicalModel: basis.model,
        canonicalBody: { ...resumeBody, messages: [
          ...resumeBody.messages.slice(0, -2),
          { role: "assistant", content: alteredContent }, resumeBody.messages.at(-1)!] } }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_TOOL_ASSISTANT_CHANGED");
    }
    for (const changedContext of [
      { ...resumeBody, system: "changed system" },
      { ...resumeBody, max_tokens: 256 },
      { ...resumeBody, output_config: { effort: "high" } },
      { ...resumeBody, thinking: { type: "enabled", budget_tokens: 64 } },
      { ...resumeBody, messages: [
        { role: "user", content: "changed history" }, ...resumeBody.messages.slice(1)] },
    ]) {
      await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
        uid: 3n, canonicalModel: basis.model,
        canonicalBody: changedContext as ProxyBody }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_TOOL_CONTEXT_CHANGED");
    }
    const stillHandoff = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [toolCall.requestId]);
    assert.equal(stillHandoff.rows[0]?.ctx.boxState, "handoff",
      "context mismatch must reject before claim and file publication");
    const resumed = await journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: resumeBody });
    assert.equal(resumed.ownerRequestId, toolCall.requestId);
    assert.equal(resumed.accountId, 20n);
    assert.equal(resumed.spoolOffset, 1234);
    assert.equal(resumed.roundNo, 2);
    assert.equal(resumed.detachedRunnerHash, "f".repeat(64));
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
    assert.equal(linked.rows.find((row) => row.request_id === `box-d-${suffix}`)?.ctx.boxRoundNo,
      2);
    assert.deepEqual(linked.rows.find((row) => row.request_id === `box-d-${suffix}`)
      ?.ctx.boxPriorMessageIds, [candidate.messageId]);
    await assert.rejects(() => journal.claimToolResume({ requestId: `box-d-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: resumeBody }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_CALL_AMBIGUOUS");
    const secondToolUses = [
      { id: "toolu_C", boxName: "mcp__ocbridge__t0",
        clientName: "local_echo", input: { value: privateMarker } },
    ];
    const secondAssistantContent = secondToolUses.map((use) => ({ type: "tool_use",
      id: use.id, name: use.clientName, input: use.input }));
    const secondCandidate = { messageId: "msg_box_tool_2", toolUses: secondToolUses,
      assistantContentHash: hashBoxAssistantContent(secondAssistantContent),
      inputTokens: 8, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 1 };
    await assert.rejects(() => journal.recordToolHandoff({
      requestId: `box-d-${suffix}`, uid: 3n, leaseEpoch: toolCall.leaseEpoch,
      candidate: secondCandidate, roundNo: 1, spoolOffset: 2345,
      detachedRunnerHash: "f".repeat(64), catalogHash,
      verifiedPendingToolUseIds: ["toolu_C"] }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_HANDOFF_FENCE_LOST");
    for (const mutation of [
      { candidate: secondCandidate, spoolOffset: 1234, detachedRunnerHash: "f".repeat(64) },
      { candidate: { ...secondCandidate, messageId: candidate.messageId },
        spoolOffset: 2345, detachedRunnerHash: "f".repeat(64) },
      { candidate: secondCandidate, spoolOffset: 2345,
        detachedRunnerHash: "e".repeat(64) },
    ]) {
      await assert.rejects(() => journal.recordToolHandoff({
        requestId: `box-d-${suffix}`, uid: 3n, leaseEpoch: toolCall.leaseEpoch,
        roundNo: 2, catalogHash, verifiedPendingToolUseIds: ["toolu_C"],
        ...mutation }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_TOOL_HANDOFF_FENCE_LOST");
    }
    await journal.recordToolHandoff({ requestId: `box-d-${suffix}`, uid: 3n,
      leaseEpoch: toolCall.leaseEpoch, candidate: secondCandidate, roundNo: 2,
      spoolOffset: 2345, detachedRunnerHash: "f".repeat(64),
      catalogHash,
      verifiedPendingToolUseIds: ["toolu_C"] });
    await put(`box-e-${suffix}`);
    const secondResumeBody = { ...resumeBody, messages: [
      ...resumeBody.messages,
      { role: "assistant", content: secondAssistantContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_C",
        content: "third" }] },
    ] };
    const secondResume = await journal.claimToolResume({ requestId: `box-e-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: secondResumeBody });
    assert.equal(secondResume.ownerRequestId, `box-d-${suffix}`);
    assert.equal(secondResume.spoolOffset, 2345);
    assert.equal(secondResume.roundNo, 3);
    const third = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [`box-e-${suffix}`]);
    assert.equal(third.rows[0]?.ctx.boxRoundNo, 3);
    assert.deepEqual(third.rows[0]?.ctx.boxPriorMessageIds,
      [candidate.messageId, secondCandidate.messageId]);
    await journal.markUnknown({ requestId: `box-e-${suffix}`, uid: 3n,
      leaseEpoch: toolCall.leaseEpoch, phase: "resume_stream_aborted" });
    const unknownLinked = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [`box-e-${suffix}`]);
    assert.equal(unknownLinked.rows[0]?.ctx.boxState, "unknown");
    const chainProof = { runNonce: toolCall.runNonce, leaseEpoch: toolCall.leaseEpoch,
      keeperPid: 101, cliPid: 102, reason: "worker_complete" as const,
      revision: 1 as const };
    const finalUsage = { inputTokens: 9, outputTokens: 13,
      cacheReadTokens: 1, cacheWriteTokens: 0 };
    for (const invalid of [{}, [], { inputTokens: 9, outputTokens: 13,
      cacheReadTokens: 1 }, { ...finalUsage, extra: 1 },
      { "cacheReadTokens,cacheWriteTokens,inputTokens,outputTokens": 1 }]) {
      await assert.rejects(() => journal.completeToolChain({
        requestId: `box-e-${suffix}`, uid: 3n, leaseEpoch: toolCall.leaseEpoch,
        proof: chainProof, usage: invalid as never }),
      (error: unknown) => error instanceof BoxDurableJournalError
        && error.code === "BOX_TOOL_CHAIN_EVIDENCE_INVALID");
    }
    await assert.rejects(() => journal.completeToolChain({
      requestId: `box-e-${suffix}`, uid: 3n, leaseEpoch: toolCall.leaseEpoch,
      proof: { ...chainProof, reason: "keeper_stopped" }, usage: finalUsage }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_CHAIN_EVIDENCE_INVALID");
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxResumeRequestId}','"wrong-child"'::jsonb)
      WHERE request_id=$1`, [`box-d-${suffix}`]);
    await assert.rejects(() => journal.completeToolChain({
      requestId: `box-e-${suffix}`, uid: 3n, leaseEpoch: toolCall.leaseEpoch,
      proof: chainProof, usage: finalUsage }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_CHAIN_INVALID");
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxResumeRequestId}',to_jsonb($2::text))
      WHERE request_id=$1`, [`box-d-${suffix}`, `box-e-${suffix}`]);
    const revisionRow = await client.query<{ ctx: Record<string, unknown> }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [`box-d-${suffix}`]);
    const secondRevision = revisionRow.rows[0]?.ctx.boxResumeRevision;
    assert.match(String(secondRevision), /^[0-9a-f-]{36}$/);
    await client.query(`UPDATE request_finalize_journal SET ctx=ctx-'boxResumeRevision'
      WHERE request_id=$1`, [`box-d-${suffix}`]);
    await client.query(`UPDATE request_finalize_journal SET ctx=ctx-'boxParentResumeRevision'
      WHERE request_id=$1`, [`box-e-${suffix}`]);
    await assert.rejects(() => journal.completeToolChain({
      requestId: `box-e-${suffix}`, uid: 3n, leaseEpoch: toolCall.leaseEpoch,
      proof: chainProof, usage: finalUsage }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_CHAIN_INVALID");
    for (const [id, key] of [[`box-d-${suffix}`, "boxResumeRevision"],
      [`box-e-${suffix}`, "boxParentResumeRevision"]]) {
      await client.query(`UPDATE request_finalize_journal
        SET ctx=jsonb_set(ctx,ARRAY[$2::text],to_jsonb($3::text)) WHERE request_id=$1`,
      [id, key, secondRevision]);
    }
    await journal.completeToolChain({ requestId: `box-e-${suffix}`,
      uid: 3n, leaseEpoch: toolCall.leaseEpoch, proof: chainProof, usage: finalUsage });
    const closed = await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
      `SELECT request_id,ctx FROM request_finalize_journal
        WHERE request_id IN ($1,$2,$3) ORDER BY request_id`,
      [toolCall.requestId, `box-d-${suffix}`, `box-e-${suffix}`]);
    assert.deepEqual(closed.rows.map((row) => row.ctx.boxState),
      ["terminal", "terminal", "terminal"]);
    assert.deepEqual(closed.rows.find((row) => row.request_id === toolCall.requestId)
      ?.ctx.boxToolHandoff && (closed.rows.find((row) => row.request_id === toolCall.requestId)
        ?.ctx.boxToolHandoff as { usage: unknown }).usage, candidate && {
      inputTokens: candidate.inputTokens, outputTokens: candidate.outputTokens,
      cacheReadTokens: candidate.cacheReadTokens, cacheWriteTokens: candidate.cacheWriteTokens });
    assert.deepEqual(closed.rows.find((row) => row.request_id === `box-e-${suffix}`)?.ctx.boxUsage,
      finalUsage);
    for (let i = 0; i < 10; i++) {
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,updated_at)
        SELECT $1,user_id,'committed',ctx,NOW()-INTERVAL '1 day'
          FROM request_finalize_journal WHERE request_id=$2`,
      [`box-old-text-${i}-${suffix}`, input.requestId]);
    }
    for (let i = 0; i < 10; i++) {
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,updated_at)
        SELECT $1,user_id,'committed',
          jsonb_set(ctx,'{boxTerminalProof,keeperPid}','"invalid"'::jsonb),
          NOW()-INTERVAL '1 day'
          FROM request_finalize_journal WHERE request_id=$2`,
      [`box-corrupt-tool-${i}-${suffix}`, `box-e-${suffix}`]);
    }
    assert.equal((await journal.listRemoteCleanupCandidates(10)).length, 0,
      "invalid oldest batch is quarantined rather than retried forever");
    const quarantined = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM request_finalize_journal
        WHERE request_id LIKE $1 AND ctx->>'boxRemoteCleanupQuarantine'='invalid_evidence'`,
      [`box-corrupt-tool-%-${suffix}`]);
    assert.equal(quarantined.rows[0]?.n, "10");
    const cleanupCandidates = await journal.listRemoteCleanupCandidates(10);
    assert.ok(!cleanupCandidates.some((item) => item.requestId === input.requestId),
      "text rows were already cleaned by their own path");
    const finalCleanup = cleanupCandidates.find((item) =>
      item.requestId === `box-e-${suffix}`);
    assert.ok(finalCleanup);
    // Retry fairness must not depend on updated_at: that is the billing age.
    // Ten older failing runs become eligible again, but a never-attempted
    // eleventh run must still get a cleanup slot on the next tick.
    for (let i = 0; i < 10; i++) {
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,updated_at)
        SELECT $1,user_id,'committed',ctx,NOW()-INTERVAL '1 day'
          FROM request_finalize_journal WHERE request_id=$2`,
      [`box-retry-${i}-${suffix}`, `box-e-${suffix}`]);
    }
    const oldRetries = await journal.listRemoteCleanupCandidates(10);
    assert.equal(oldRetries.length, 10);
    for (const old of oldRetries) {
      assert.equal(await journal.claimRemoteCleanup(old), true);
      await client.query(`UPDATE request_finalize_journal
        SET ctx=jsonb_set(ctx,'{boxRemoteCleanupRetryAfterMs}',
          to_jsonb((EXTRACT(EPOCH FROM NOW()-INTERVAL '1 minute')*1000)::bigint))
        WHERE request_id=$1`, [old.requestId]);
    }
    assert.ok((await journal.listRemoteCleanupCandidates(10)).some((item) =>
      item.requestId === `box-e-${suffix}`),
    "previously failed runs must not starve a fresh terminal cleanup");
    assert.equal(await journal.remoteCleanupStatus(finalCleanup!), "pending");
    assert.equal(await journal.remoteCleanupStatus({ ...finalCleanup!, accountId: 21n }),
      "invalid");
    assert.ok(!cleanupCandidates.some((item) => item.requestId === toolCall.requestId),
      "handoff ancestors have no independent terminal proof");
    await assert.rejects(() => journal.markRemoteCleaned({ ...finalCleanup!,
      accountId: 21n }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_CLEANUP_FENCE_LOST");
    assert.equal(await journal.claimRemoteCleanup({ ...finalCleanup!,
      proof: { ...finalCleanup!.proof, keeperPid: 999 } }), false,
    "proof changed after selection cannot authorize remote cleanup");
    await client.query(`UPDATE request_finalize_journal
      SET updated_at=NOW()-INTERVAL '6 minutes' WHERE request_id=$1`,
    [`box-e-${suffix}`]);
    const beforeCleanup = await client.query<{ updated_at: Date }>(
      "SELECT updated_at FROM request_finalize_journal WHERE request_id=$1",
      [`box-e-${suffix}`]);
    assert.equal(await journal.claimRemoteCleanup(finalCleanup!), true);
    const afterClaim = await client.query<{ updated_at: Date }>(
      "SELECT updated_at FROM request_finalize_journal WHERE request_id=$1",
      [`box-e-${suffix}`]);
    assert.equal(afterClaim.rows[0]?.updated_at.getTime(),
      beforeCleanup.rows[0]?.updated_at.getTime(),
    "remote cleanup retries must never reset billing recovery grace");
    assert.equal(await journal.claimRemoteCleanup(finalCleanup!), false);
    assert.ok(!(await journal.listRemoteCleanupCandidates()).some((item) =>
      item.requestId === `box-e-${suffix}`), "claimed failure is briefly backed off");
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxRemoteCleanupRetryAfterMs}',
        to_jsonb((EXTRACT(EPOCH FROM NOW()-INTERVAL '1 minute')*1000)::bigint))
      WHERE request_id=$1`,
    [`box-e-${suffix}`]);
    assert.ok((await journal.listRemoteCleanupCandidates(20)).some((item) =>
      item.requestId === `box-e-${suffix}`));
    assert.equal(await journal.claimRemoteCleanup(finalCleanup!), true);
    await assert.rejects(() => journal.markRemoteCleaned({ ...finalCleanup!,
      proof: { ...finalCleanup!.proof, keeperPid: 999 } }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_CLEANUP_FENCE_LOST");
    await journal.markRemoteCleaned(finalCleanup!);
    await journal.markRemoteCleaned(finalCleanup!);
    const afterDone = await client.query<{ updated_at: Date }>(
      "SELECT updated_at FROM request_finalize_journal WHERE request_id=$1",
      [`box-e-${suffix}`]);
    assert.equal(afterDone.rows[0]?.updated_at.getTime(),
      beforeCleanup.rows[0]?.updated_at.getTime());
    assert.equal(await journal.remoteCleanupStatus(finalCleanup!), "done");
    assert.ok(!(await journal.listRemoteCleanupCandidates()).some((item) =>
      item.requestId === `box-e-${suffix}`));
    await assert.rejects(() => journal.completeToolChain({
      requestId: `box-e-${suffix}`, uid: 3n, leaseEpoch: toolCall.leaseEpoch,
      proof: chainProof, usage: { ...finalUsage, outputTokens: 999 } }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_CHAIN_INVALID");
    await put(`box-f-${suffix}`);
    const failedCall = { ...input, requestId: `box-f-${suffix}`,
      invocationMode: "detached_tool" as const, contextHash: "7".repeat(64),
      fingerprint: { ...fingerprint, replayFingerprint: "8".repeat(64) },
      runNonce: "5".repeat(24), leaseEpoch: "6".repeat(32) };
    await journal.admit(failedCall);
    await journal.markRunning(failedCall);
    await journal.markUnknown({ ...failedCall, phase: "synthetic_failed_model" });
    const failedProof = { runNonce: failedCall.runNonce,
      leaseEpoch: failedCall.leaseEpoch, keeperPid: 111, cliPid: 112,
      reason: "worker_failed" as const, revision: 2 as const, workerExitCode: 7 };
    await assert.rejects(() => journal.complete({ ...failedCall,
      proof: failedProof, usage }), /BOX_JOURNAL_EVIDENCE_INVALID/);
    await assert.rejects(() => journal.markFirstRoundStoppedFailure({ ...failedCall,
      proof: { ...failedProof, workerExitCode: 0 } }),
    /BOX_FAILED_STOP_EVIDENCE_INVALID/);
    await journal.markFirstRoundStoppedFailure({ ...failedCall, proof: failedProof });
    await journal.markFirstRoundStoppedFailure({ ...failedCall, proof: failedProof });
    const failedRow = await client.query<{ state: string; ctx: Record<string, unknown>;
      final_credits: string }>(
      `SELECT state,ctx,final_credits::text FROM request_finalize_journal
        WHERE request_id=$1`, [failedCall.requestId]);
    assert.equal(failedRow.rows[0]?.state, "aborted");
    assert.equal(failedRow.rows[0]?.ctx.boxState, "failed_stopped");
    assert.deepEqual(failedRow.rows[0]?.ctx.boxTerminalProof, failedProof);
    assert.equal(failedRow.rows[0]?.ctx.boxUsage, undefined);
    assert.equal(failedRow.rows[0]?.final_credits, "0");
    await put(`box-g-${suffix}`);
    await journal.admit({ ...failedCall, requestId: `box-g-${suffix}`,
      fingerprint: { ...fingerprint, replayFingerprint: "7".repeat(64) },
      runNonce: "6".repeat(24), leaseEpoch: "7".repeat(32) });
    await put(`box-h-${suffix}`);
    await assert.rejects(() => journal.admit({ ...failedCall,
      requestId: `box-h-${suffix}` }), /BOX_CALL_AMBIGUOUS/);
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.usage_records");
    await client.query("DROP TABLE IF EXISTS pg_temp.request_finalize_journal");
    client.release();
    await pool.end();
  }
});
