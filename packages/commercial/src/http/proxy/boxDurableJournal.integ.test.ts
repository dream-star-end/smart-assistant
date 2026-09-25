/** Real PostgreSQL transaction test against a session-local TEMP shadow table.
 * No migration and no writes to the live request_finalize_journal. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash,
  hashBoxAssistantContent, hashBoxAssistantEchoContent } from "./boxCallFingerprint.js";
import type { ProxyBody } from "./shared.js";
import { abortInflightJournal } from "../../billing/proxyBilling.js";

test("Box journal fences replay/account capacity and persists proof plus exact usage",
  { skip: !process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL,
    max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL,
      container_id bigint, state text NOT NULL,
      ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text CHECK (failure_code IN (
        'UNKNOWN','INVALID_REQUEST','RATE_LIMITED','UPSTREAM_UNAVAILABLE',
        'UPSTREAM_REJECTED','CLIENT_ABORT','STREAM_FAILED','BILLING_FAILED',
        'INTERNAL_ERROR','USER_CANCELLED')), final_credits bigint)`);
    await client.query(`CREATE TEMP TABLE usage_records (
      request_id text NOT NULL, user_id bigint NOT NULL)`);
    // Pin all journal operations to this one connection, whose temp table
    // shadows the real table. No shared schema or persistent row is touched.
    const privateMarker = "synthetic-private-marker";
    let enforceChainLockOrder = false, sawSessionAdvisoryLock = false;
    const guardedQuery = async (sql: string, params: unknown[] = []) => {
      assert.ok(!JSON.stringify(params).includes(privateMarker),
        "raw tool arguments must never enter a PostgreSQL query parameter");
      if (enforceChainLockOrder) {
        if (sql.includes("pg_advisory_xact_lock")
          && String(params[0]).startsWith("box:session:")) sawSessionAdvisoryLock = true;
        if (sql.includes("request_finalize_journal") && sql.includes("FOR UPDATE")) {
          assert.ok(sawSessionAdvisoryLock,
            "multi-row terminal/cancel must take session lock before any row lock");
        }
      }
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
      { type: "thinking", thinking: "synthetic model reasoning", signature: "synthetic-signature" },
      { type: "text", text: "Box said A before calling tools" },
      ...firstToolUses.map((use) => ({ type: "tool_use", id: use.id,
        name: use.clientName, input: use.input,
        caller: { type: "provider_only" } })),
    ];
    const candidate = { messageId: "msg_box_tool_1", toolUses: firstToolUses,
      assistantContentHash: hashBoxAssistantContent(firstAssistantContent),
      assistantEchoHash: hashBoxAssistantEchoContent(firstAssistantContent),
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
         { role: "assistant", content: [firstAssistantContent[1],
           ...firstToolUses.map((use) => ({ type: "tool_use", id: use.id,
             name: use.clientName, input: use.input }))] },
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
         ...firstAssistantContent.slice(2)],
       firstAssistantContent.slice(2),
       [{ type: "thinking", thinking: "inserted", signature: "sig" },
         ...firstAssistantContent.slice(1)],
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
    const roundBudget = (tokens: number) => ({ role: "system", content: [{ type: "text",
      text: `<total_tokens>${tokens} tokens left</total_tokens>`,
      cache_control: { type: "ephemeral" } }] });
    const secondResumeBody = { ...resumeBody, messages: [
      ...resumeBody.messages,
      roundBudget(14_999_987),
      { role: "assistant", content: secondAssistantContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_C",
        content: "third" }] },
      roundBudget(14_999_974),
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
    enforceChainLockOrder = true; sawSessionAdvisoryLock = false;
    await journal.completeToolChain({ requestId: `box-e-${suffix}`,
      uid: 3n, leaseEpoch: toolCall.leaseEpoch, proof: chainProof, usage: finalUsage });
    assert.equal(sawSessionAdvisoryLock, true);
    enforceChainLockOrder = false;
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
    assert.equal(await journal.remoteCleanupDoneByRunIdentity({ uid: 3n,
      accountId: finalCleanup!.accountId, runNonce: finalCleanup!.runNonce,
      leaseEpoch: finalCleanup!.leaseEpoch }), true);
    assert.equal(await journal.remoteCleanupDoneByRunIdentity({ uid: 3n,
      accountId: finalCleanup!.accountId, runNonce: finalCleanup!.runNonce,
      leaseEpoch: "0".repeat(32) }), false);
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
    const firstProbe = (await journal.listStoppedFailureProbeCandidates(20))
      .find((item) => item.requestId === failedCall.requestId);
    assert.ok(firstProbe);
    assert.equal(firstProbe.linked, false);
    assert.equal(await journal.claimStoppedFailureProbe(firstProbe), true);
    assert.equal(await journal.claimStoppedFailureProbe(firstProbe), false);
    const failedProof = { runNonce: failedCall.runNonce,
      leaseEpoch: failedCall.leaseEpoch, keeperPid: 111, cliPid: 112,
      reason: "worker_failed" as const, revision: 2 as const, workerExitCode: 7 };
    await assert.rejects(() => journal.complete({ ...failedCall,
      proof: failedProof, usage }), /BOX_JOURNAL_EVIDENCE_INVALID/);
    await assert.rejects(() => journal.markFirstRoundStoppedFailure({ ...failedCall,
      proof: { ...failedProof, workerExitCode: 0 } }),
    /BOX_FAILED_STOP_EVIDENCE_INVALID/);
    await assert.rejects(() => client.query(
      `UPDATE request_finalize_journal SET failure_code='BOX_REMOTE_STOPPED_FAILED'
        WHERE request_id=$1`, [failedCall.requestId]),
    (error: unknown) => (error as { code?: string }).code === "23514",
    "the former failure code must be red under the real migration constraint");
    await journal.markFirstRoundStoppedFailure({ ...failedCall, proof: failedProof });
    await journal.markFirstRoundStoppedFailure({ ...failedCall, proof: failedProof });
    const failedRow = await client.query<{ state: string; ctx: Record<string, unknown>;
      final_credits: string; failure_code: string }>(
      `SELECT state,ctx,final_credits::text,failure_code FROM request_finalize_journal
        WHERE request_id=$1`, [failedCall.requestId]);
    assert.equal(failedRow.rows[0]?.state, "aborted");
    assert.equal(failedRow.rows[0]?.ctx.boxState, "failed_stopped");
    assert.deepEqual(failedRow.rows[0]?.ctx.boxTerminalProof, failedProof);
    assert.equal(failedRow.rows[0]?.ctx.boxUsage, undefined);
    assert.equal(failedRow.rows[0]?.final_credits, "0");
    assert.equal(failedRow.rows[0]?.failure_code, "STREAM_FAILED");
    const failedCleanup = (await journal.listRemoteCleanupCandidates(20))
      .find((item) => item.requestId === failedCall.requestId);
    assert.ok(failedCleanup, "a proven stopped failure still needs remote private-file cleanup");
    assert.equal(failedCleanup.proof.reason, "worker_failed");
    assert.equal(await journal.claimRemoteCleanup(failedCleanup), true);
    assert.equal(await journal.remoteCleanupStatus(failedCleanup), "pending");
    await assert.rejects(() => journal.markRemoteCleaned({ ...failedCleanup,
      runNonce: "f".repeat(24) }), /BOX_CLEANUP_IDENTITY_INVALID/);
    await journal.markRemoteCleaned(failedCleanup);
    await journal.markRemoteCleaned(failedCleanup);
    assert.equal(await journal.remoteCleanupStatus(failedCleanup), "done");
    assert.ok(!(await journal.listRemoteCleanupCandidates(20)).some((item) =>
      item.requestId === failedCall.requestId));
    const failedSession = `failed-session-${suffix}`;
    const failedTurn = "f".repeat(64);
    const failedFirstBody: ProxyBody = { ...firstBody,
      metadata: { user_id: JSON.stringify({ oc_turn_key: failedTurn,
        session_id: failedSession }) },
      messages: [{ role: "user", content: "a distinct synthetic first prompt" }] };
    const failedResumeBody: ProxyBody = { ...failedFirstBody,
      messages: [...failedFirstBody.messages, ...resumeBody.messages.slice(1)] };
    const failedBasis = { ...basis, boxBillingContext: {
      ...basis.boxBillingContext, sessionId: failedSession, turnKey: failedTurn } };
    const putFailed = async (id: string) => client.query(
      `INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
       VALUES ($1,3,'inflight',$2::jsonb)`, [id, JSON.stringify(failedBasis)]);
    await putFailed(`box-g-${suffix}`);
    const failedChainRoot = { ...failedCall, requestId: `box-g-${suffix}`,
      contextHash: deriveBoxContextHash(failedFirstBody),
      fingerprint: deriveBoxCallFingerprint(3n, failedFirstBody),
      runNonce: "6".repeat(24), leaseEpoch: "7".repeat(32) };
    await journal.admit(failedChainRoot);
    await putFailed(`box-h-${suffix}`);
    await assert.rejects(() => journal.admit({ ...failedChainRoot,
      requestId: `box-h-${suffix}` }), /BOX_CALL_AMBIGUOUS/);
    await journal.markRunning(failedChainRoot);
    await journal.recordToolHandoff({ ...failedChainRoot, candidate,
      spoolOffset: 1234, detachedRunnerHash: "f".repeat(64), catalogHash,
      verifiedPendingToolUseIds: ["toolu_A"] });
    await journal.claimToolResume({ requestId: `box-h-${suffix}`,
      uid: 3n, canonicalModel: basis.model, canonicalBody: failedResumeBody });
    await client.query(`UPDATE request_finalize_journal SET container_id=123
      WHERE request_id=$1`, [`box-h-${suffix}`]);
    const selectedStop = await journal.findCancelableRun({ uid: 3n,
      containerId: 123n, sessionId: failedSession, turnKey: failedTurn });
    assert.equal(selectedStop.requestId, `box-h-${suffix}`);
    assert.equal(selectedStop.accountId, 20n);
    await assert.rejects(() => journal.findCancelableRun({ uid: 3n,
      containerId: 124n, sessionId: failedSession, turnKey: failedTurn }),
    /BOX_CANCEL_RUN_UNKNOWN/);
    await assert.rejects(() => journal.findCancelableRun({ uid: 4n,
      containerId: 123n, sessionId: failedSession, turnKey: failedTurn }),
    /BOX_CANCEL_RUN_UNKNOWN/);
    enforceChainLockOrder = true; sawSessionAdvisoryLock = false;
    await journal.recordUserCancelIntent(failedChainRoot);
    assert.equal(sawSessionAdvisoryLock, true);
    enforceChainLockOrder = false;
    await journal.recordUserCancelIntent(failedChainRoot);
    const failedChainLeaf = await journal.getCancelLeaf(failedChainRoot);
    assert.equal(failedChainLeaf.requestId, `box-h-${suffix}`);
    assert.equal(failedChainLeaf.linked, true);
    const canceledChain = await client.query<{ request_id: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,ctx FROM request_finalize_journal
        WHERE request_id IN ($1,$2) ORDER BY request_id`,
      [failedChainRoot.requestId, `box-h-${suffix}`]);
    assert.deepEqual(canceledChain.rows.map((row) => row.ctx.boxCancelIntent),
      [canceledChain.rows[0]?.ctx.boxCancelIntent,
        canceledChain.rows[0]?.ctx.boxCancelIntent]);
    await assert.rejects(() => journal.recordToolHandoff({
      requestId: `box-h-${suffix}`, uid: 3n, leaseEpoch: failedChainRoot.leaseEpoch,
      candidate: secondCandidate, roundNo: 2, spoolOffset: 2345,
      detachedRunnerHash: "f".repeat(64), catalogHash,
      verifiedPendingToolUseIds: ["toolu_C"] }), /BOX_TOOL_HANDOFF_FENCE_LOST/);
    await putFailed(`box-cancel-child-${suffix}`);
    const afterCancelBody: ProxyBody = { ...failedResumeBody, messages: [
      ...failedResumeBody.messages,
      { role: "assistant", content: secondAssistantContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_C",
        content: "third" }] },
    ] };
    await assert.rejects(() => journal.claimToolResume({
      requestId: `box-cancel-child-${suffix}`, uid: 3n,
      canonicalModel: basis.model, canonicalBody: afterCancelBody }),
    /BOX_TOOL_OWNER_UNKNOWN/);
    const linkedProbe = (await journal.listStoppedFailureProbeCandidates(20))
      .find((item) => item.requestId === `box-h-${suffix}`);
    assert.ok(linkedProbe);
    assert.equal(linkedProbe.linked, true);
    assert.equal(await journal.claimStoppedFailureProbe(linkedProbe), true);
    const failedChainProof = { ...failedProof, runNonce: failedChainRoot.runNonce,
      leaseEpoch: failedChainRoot.leaseEpoch };
    await assert.rejects(() => journal.markToolChainStoppedFailure({
      requestId: failedChainRoot.requestId, uid: 3n,
      leaseEpoch: failedChainRoot.leaseEpoch, proof: failedChainProof }),
    /BOX_FAILED_STOP_CHAIN_INVALID/, "root with handoff is not an unbilled final row");
    enforceChainLockOrder = true; sawSessionAdvisoryLock = false;
    await journal.markToolChainStoppedFailure({ requestId: `box-h-${suffix}`,
      uid: 3n, leaseEpoch: failedChainRoot.leaseEpoch, proof: failedChainProof });
    assert.equal(sawSessionAdvisoryLock, true);
    enforceChainLockOrder = false;
    await journal.markToolChainStoppedFailure({ requestId: `box-h-${suffix}`,
      uid: 3n, leaseEpoch: failedChainRoot.leaseEpoch, proof: failedChainProof });
    const failedChainRows = await client.query<{ request_id: string; state: string;
      ctx: Record<string, unknown>; final_credits: string | null }>(
      `SELECT request_id,state,ctx,final_credits::text
         FROM request_finalize_journal WHERE request_id IN ($1,$2) ORDER BY request_id`,
      [failedChainRoot.requestId, `box-h-${suffix}`]);
    assert.equal(failedChainRows.rows.find((row) => row.request_id === failedChainRoot.requestId)
      ?.ctx.boxState, "failed_stopped");
    assert.deepEqual((failedChainRows.rows.find((row) =>
      row.request_id === failedChainRoot.requestId)?.ctx.boxToolHandoff as
      { usage: unknown }).usage, candidate && { inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens, cacheReadTokens: candidate.cacheReadTokens,
      cacheWriteTokens: candidate.cacheWriteTokens });
    assert.equal(failedChainRows.rows.find((row) => row.request_id === `box-h-${suffix}`)
      ?.state, "aborted");
    assert.equal(failedChainRows.rows.find((row) => row.request_id === `box-h-${suffix}`)
      ?.final_credits, "0");
    assert.ok((await journal.listRemoteCleanupCandidates(20)).some((item) =>
      item.requestId === `box-h-${suffix}`));
    await putFailed(`box-i-${suffix}`);
    await assert.rejects(() => journal.admit({ ...failedChainRoot,
      requestId: `box-i-${suffix}` }), /BOX_CALL_AMBIGUOUS/);

    const cancelTurn = "1".repeat(64), cancelSession = `cancel-${suffix}`;
    const cancelBody: ProxyBody = { ...firstBody,
      metadata: { user_id: JSON.stringify({ oc_turn_key: cancelTurn,
        session_id: cancelSession }) },
      messages: [{ role: "user", content: "synthetic cancel only" }] };
    const cancelId = `box-cancel-${suffix}`;
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx) VALUES ($1,3,'inflight',$2::jsonb)`,
    [cancelId, JSON.stringify({ ...basis, boxBillingContext: {
      ...basis.boxBillingContext, sessionId: cancelSession, turnKey: cancelTurn } })]);
    const cancelCall = { ...toolCall, requestId: cancelId,
      runNonce: "9".repeat(24), leaseEpoch: "a".repeat(32),
      fingerprint: deriveBoxCallFingerprint(3n, cancelBody),
      contextHash: deriveBoxContextHash(cancelBody) };
    await journal.admit(cancelCall);
    await journal.markRunning(cancelCall);
    await journal.recordUserCancelIntent(cancelCall);
    await journal.recordUserCancelIntent(cancelCall);
    const cancelled = await client.query<{ state: string; ctx: Record<string, unknown> }>(
      `SELECT state,ctx FROM request_finalize_journal WHERE request_id=$1`, [cancelId]);
    assert.equal(cancelled.rows[0]?.state, "inflight",
      "stop intent cannot release paid-call capacity");
    assert.equal((cancelled.rows[0]?.ctx.boxCancelIntent as
      Record<string, unknown>).reason, "user_cancel");
    await assert.rejects(() => journal.recordToolHandoff({ ...cancelCall, candidate,
      spoolOffset: 1234, detachedRunnerHash: "f".repeat(64), catalogHash,
      verifiedPendingToolUseIds: ["toolu_A"] }), /BOX_TOOL_HANDOFF_FENCE_LOST/);
    await assert.rejects(() => journal.admit({ ...cancelCall,
      requestId: `box-i-${suffix}`, runNonce: "a".repeat(24),
      leaseEpoch: "b".repeat(32), fingerprint: { ...cancelCall.fingerprint,
        replayFingerprint: "0".repeat(64) } }), /BOX_CAPACITY_HELD/);
    const cancelProof = { ...failedProof, runNonce: cancelCall.runNonce,
      leaseEpoch: cancelCall.leaseEpoch };
    await journal.markFirstRoundStoppedFailure({ ...cancelCall, proof: cancelProof });

    // A stopped CLI can be waiting on OpenClaude-local tools after a completed
    // assistant handoff. Preserve that billable handoff; release only remote
    // capacity and stage remote cleanup after the exact keeper proof.
    const handoffTurn = "3".repeat(64), handoffSession = `handoff-${suffix}`;
    const handoffBody: ProxyBody = { ...firstBody,
      metadata: { user_id: JSON.stringify({ oc_turn_key: handoffTurn,
        session_id: handoffSession }) },
      messages: [{ role: "user", content: "synthetic stopped handoff" }] };
    const handoffRoot = { ...toolCall, requestId: `box-handoff-stop-${suffix}`,
      runNonce: "b".repeat(24), leaseEpoch: "c".repeat(32),
      fingerprint: deriveBoxCallFingerprint(3n, handoffBody),
      contextHash: deriveBoxContextHash(handoffBody) };
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx) VALUES ($1,3,'inflight',$2::jsonb)`,
    [handoffRoot.requestId, JSON.stringify({ ...basis, boxBillingContext: {
      ...basis.boxBillingContext, sessionId: handoffSession, turnKey: handoffTurn } })]);
    await journal.admit(handoffRoot);
    await journal.markRunning(handoffRoot);
    await journal.recordToolHandoff({ ...handoffRoot, candidate,
      spoolOffset: 1234, detachedRunnerHash: "f".repeat(64), catalogHash,
      verifiedPendingToolUseIds: ["toolu_A"] });
    await journal.recordUserCancelIntent(handoffRoot);
    const handoffLeaf = await journal.getCancelLeaf(handoffRoot);
    assert.equal(handoffLeaf.requestId, handoffRoot.requestId);
    assert.equal(handoffLeaf.linked, false);
    const handoffResumeBody: ProxyBody = { ...handoffBody,
      messages: [...handoffBody.messages, ...resumeBody.messages.slice(1)] };
    await put(`box-handoff-next-${suffix}`);
    await assert.rejects(() => journal.claimToolResume({
      requestId: `box-handoff-next-${suffix}`, uid: 3n,
      canonicalModel: basis.model, canonicalBody: handoffResumeBody }),
    /BOX_TOOL_OWNER_UNKNOWN/);
    const handoffProbe = (await journal.listStoppedFailureProbeCandidates(20))
      .find((item) => item.requestId === handoffRoot.requestId);
    assert.ok(handoffProbe);
    assert.equal(handoffProbe.linked, false);
    assert.equal(await journal.claimStoppedFailureProbe(handoffProbe), true);
    const handoffStopProof = { ...failedProof, runNonce: handoffRoot.runNonce,
      leaseEpoch: handoffRoot.leaseEpoch };
    await journal.markFirstRoundStoppedFailure({ ...handoffRoot, proof: handoffStopProof });
    await journal.markFirstRoundStoppedFailure({ ...handoffRoot, proof: handoffStopProof });
    const stoppedHandoff = await client.query<{ state: string;
      ctx: Record<string, unknown> }>(
      `SELECT state,ctx FROM request_finalize_journal WHERE request_id=$1`,
      [handoffRoot.requestId]);
    assert.equal(stoppedHandoff.rows[0]?.state, "inflight");
    assert.equal(stoppedHandoff.rows[0]?.ctx.boxState, "failed_stopped");
    assert.deepEqual((stoppedHandoff.rows[0]?.ctx.boxToolHandoff as
      { usage: unknown }).usage, { inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens, cacheReadTokens: candidate.cacheReadTokens,
      cacheWriteTokens: candidate.cacheWriteTokens });
    assert.ok((await journal.listRemoteCleanupCandidates(20)).some((item) =>
      item.requestId === handoffRoot.requestId));

    const linkedTurn = "4".repeat(64), linkedSession = `linked-handoff-${suffix}`;
    const linkedBody: ProxyBody = { ...firstBody,
      metadata: { user_id: JSON.stringify({ oc_turn_key: linkedTurn,
        session_id: linkedSession }) },
      messages: [{ role: "user", content: "synthetic linked handoff" }] };
    const linkedBasis = { ...basis, boxBillingContext: {
      ...basis.boxBillingContext, sessionId: linkedSession, turnKey: linkedTurn } };
    const linkedRoot = { ...toolCall, requestId: `box-linked-root-${suffix}`,
      runNonce: "d".repeat(24), leaseEpoch: "f".repeat(32),
      fingerprint: deriveBoxCallFingerprint(3n, linkedBody),
      contextHash: deriveBoxContextHash(linkedBody) };
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx) VALUES ($1,3,'inflight',$2::jsonb)`,
    [linkedRoot.requestId, JSON.stringify(linkedBasis)]);
    await journal.admit(linkedRoot);
    await journal.markRunning(linkedRoot);
    await journal.recordToolHandoff({ ...linkedRoot, candidate,
      spoolOffset: 1234, detachedRunnerHash: "f".repeat(64), catalogHash,
      verifiedPendingToolUseIds: ["toolu_A"] });
    const linkedChildId = `box-linked-child-${suffix}`;
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx) VALUES ($1,3,'inflight',$2::jsonb)`,
    [linkedChildId, JSON.stringify(linkedBasis)]);
    const linkedResumeBody: ProxyBody = { ...linkedBody,
      messages: [...linkedBody.messages, ...resumeBody.messages.slice(1)] };
    await journal.claimToolResume({ requestId: linkedChildId, uid: 3n,
      canonicalModel: basis.model, canonicalBody: linkedResumeBody });
    await journal.recordToolHandoff({ requestId: linkedChildId, uid: 3n,
      leaseEpoch: linkedRoot.leaseEpoch, candidate: secondCandidate, roundNo: 2,
      spoolOffset: 2345, detachedRunnerHash: "f".repeat(64), catalogHash,
      verifiedPendingToolUseIds: ["toolu_C"] });
    await journal.recordUserCancelIntent(linkedRoot);
    const linkedHandoffProbe = (await journal.listStoppedFailureProbeCandidates(20))
      .find((item) => item.requestId === linkedChildId);
    assert.ok(linkedHandoffProbe);
    assert.equal(linkedHandoffProbe.linked, true);
    assert.equal(await journal.claimStoppedFailureProbe(linkedHandoffProbe), true);
    const linkedStopProof = { ...failedProof, runNonce: linkedRoot.runNonce,
      leaseEpoch: linkedRoot.leaseEpoch };
    const linkedRevisionRow = await client.query<{ ctx: Record<string, unknown> }>(
      `SELECT ctx FROM request_finalize_journal WHERE request_id=$1`, [linkedChildId]);
    const linkedRevision = linkedRevisionRow.rows[0]?.ctx.boxHandoffRevision;
    assert.match(String(linkedRevision), /^[0-9a-f-]{36}$/);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=ctx-'boxHandoffRevision' WHERE request_id=$1`, [linkedChildId]);
    await assert.rejects(() => journal.markToolChainStoppedFailure({
      requestId: linkedChildId, uid: 3n, leaseEpoch: linkedRoot.leaseEpoch,
      proof: linkedStopProof }), /BOX_FAILED_STOP_CHAIN_INVALID/);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxHandoffRevision}',to_jsonb($2::text))
      WHERE request_id=$1`, [linkedChildId, linkedRevision]);
    await journal.markToolChainStoppedFailure({ requestId: linkedChildId,
      uid: 3n, leaseEpoch: linkedRoot.leaseEpoch, proof: linkedStopProof });
    await journal.markToolChainStoppedFailure({ requestId: linkedChildId,
      uid: 3n, leaseEpoch: linkedRoot.leaseEpoch, proof: linkedStopProof });
    const linkedStopped = await client.query<{ request_id: string; state: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,state,ctx FROM request_finalize_journal
        WHERE request_id IN ($1,$2) ORDER BY request_id`,
      [linkedRoot.requestId, linkedChildId]);
    assert.equal(linkedStopped.rows.length, 2);
    assert.ok(linkedStopped.rows.every((row) => row.state === "inflight"
      && row.ctx.boxState === "failed_stopped" && row.ctx.boxToolHandoff));
    assert.ok((await journal.listRemoteCleanupCandidates(20)).some((item) =>
      item.requestId === linkedChildId));

    // Real CCB addCacheBreakpoints moves the ephemeral marker from the first
    // prompt/tool catalog to the just-completed tool_result. It cannot change
    // the model-visible history or strand an already-paid tool handoff.
    const cacheSession = `cache-${suffix}`, cacheTurn = "6".repeat(64);
    const budget = (tokens: number) => ({ role: "system", content: [{ type: "text",
      text: `<total_tokens>${tokens} tokens left</total_tokens>`,
      cache_control: { type: "ephemeral" } }] });
    const cacheTools = toolDeclarations.map((tool) => ({ ...tool,
      cache_control: { type: "ephemeral" } }));
    const cacheFirst: ProxyBody = { ...firstBody, tools: cacheTools,
      metadata: { user_id: JSON.stringify({ oc_turn_key: cacheTurn,
        session_id: cacheSession }) },
      messages: [{ role: "user", content: [{ type: "text",
        text: "synthetic cache prompt", cache_control: { type: "ephemeral" } }] },
        budget(15_000_000)] };
    const cacheBasis = { ...basis, boxBillingContext: {
      ...basis.boxBillingContext, sessionId: cacheSession, turnKey: cacheTurn } };
    const cacheRoot = { ...toolCall, requestId: `box-cache-root-${suffix}`,
      runNonce: "e".repeat(24), leaseEpoch: "8".repeat(32),
      fingerprint: deriveBoxCallFingerprint(3n, cacheFirst),
      contextHash: deriveBoxContextHash(cacheFirst) };
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx) VALUES ($1,3,'inflight',$2::jsonb)`,
    [cacheRoot.requestId, JSON.stringify(cacheBasis)]);
    await journal.admit(cacheRoot);
    await journal.markRunning(cacheRoot);
    await journal.recordToolHandoff({ ...cacheRoot, candidate,
      spoolOffset: 1234, detachedRunnerHash: "f".repeat(64), catalogHash,
      verifiedPendingToolUseIds: ["toolu_A"] });
    const cacheChild = `box-cache-child-${suffix}`;
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx) VALUES ($1,3,'inflight',$2::jsonb)`,
    [cacheChild, JSON.stringify(cacheBasis)]);
    const cacheResume: ProxyBody = { ...cacheFirst, tools: toolDeclarations,
      messages: [{ role: "user", content: "synthetic cache prompt" },
        budget(15_000_000),
        { role: "assistant", content: firstAssistantContent.map((block, index) =>
          index === firstAssistantContent.length - 1
            ? { ...block, cache_control: { type: "ephemeral" } } : block) },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_A", content: "first" },
          { type: "tool_result", tool_use_id: "toolu_B", content: "second",
            cache_control: { type: "ephemeral" } },
        ] },
        budget(14_999_987),
      ] };
    const cacheClaim = await journal.claimToolResume({ requestId: cacheChild,
      uid: 3n, canonicalModel: basis.model, canonicalBody: cacheResume });
    assert.equal(cacheClaim.ownerRequestId, cacheRoot.requestId);
    assert.deepEqual(cacheClaim.results.map((result) => result.modelToolUseId),
      ["toolu_A", "toolu_B"]);
    await journal.completeToolChain({ requestId: cacheChild, uid: 3n,
      leaseEpoch: cacheRoot.leaseEpoch,
      proof: { ...chainProof, runNonce: cacheRoot.runNonce,
        leaseEpoch: cacheRoot.leaseEpoch }, usage: finalUsage });

    // Queue fairness: malformed oldest rows cannot occupy LIMIT slots; ten
    // proof-less old runs must rotate behind one newer recoverable run even
    // when the tick arrives after the full two-minute retry delay.
    const probeCtx = { boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool",
      boxState: "unknown", boxAccountId: "20", boxLeaseEpoch: "9".repeat(32) };
    for (let i = 0; i < 10; i++) {
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,updated_at)
        VALUES ($1,3,'inflight',$2::jsonb,NOW()-INTERVAL '2 days')`,
      [`box-bad-probe-${i}-${suffix}`, JSON.stringify({ ...probeCtx,
        boxRunNonce: i.toString(16).padStart(24, "0"), boxOwnerRequestId: null })]);
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,updated_at)
        VALUES ($1,3,'inflight',$2::jsonb,NOW()-INTERVAL '2 days')`,
      [`box-number-probe-${i}-${suffix}`, JSON.stringify({ ...probeCtx,
        boxAccountId: 20, boxRunNonce: (i + 40).toString(16).padStart(24, "0") })]);
      await client.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,updated_at)
        VALUES ($1,3,'inflight',$2::jsonb,NOW()-INTERVAL '1 day')`,
      [`box-old-probe-${i}-${suffix}`, JSON.stringify({ ...probeCtx,
        boxRunNonce: (i + 20).toString(16).padStart(24, "0") })]);
    }
    const oldProbes = await journal.listStoppedFailureProbeCandidates(10);
    assert.equal(oldProbes.length, 10);
    assert.ok(oldProbes.every((item) => item.requestId.startsWith("box-old-probe-")));
    for (const item of oldProbes) assert.equal(await journal.claimStoppedFailureProbe(item), true);
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx) VALUES ($1,3,'inflight',$2::jsonb)`,
    [`box-new-probe-${suffix}`, JSON.stringify({ ...probeCtx,
      boxRunNonce: "8".repeat(24) })]);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxStopProbeAfterMs}',to_jsonb($2::bigint))
      WHERE request_id LIKE $1`, [`box-old-probe-%-${suffix}`, String(Date.now() - 1)]);
    const rotated = await journal.listStoppedFailureProbeCandidates(10);
    assert.equal(rotated[0]?.requestId, `box-new-probe-${suffix}`);
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.usage_records");
    await client.query("DROP TABLE IF EXISTS pg_temp.request_finalize_journal");
    client.release();
    await pool.end();
  }
});
