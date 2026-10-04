/** readIdleProof against rows the real journal methods wrote in a TEMP shadow. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash, hashBoxAssistantContent,
  hashBoxAssistantEchoContent, hashBoxAssistantNoCallerContent } from "./boxCallFingerprint.js";
import type { ProxyBody } from "./shared.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL
  ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";

test("readIdleProof sees a journal-written tool chain only after settlement", async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL,
      container_id bigint, state text NOT NULL,
      ctx jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    const owned = await client.query<{ persistence: string; nsp: string }>(
      `SELECT c.relpersistence AS persistence, n.nspname AS nsp
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'request_finalize_journal' AND c.relpersistence = 't'`);
    assert.equal(owned.rows.length, 1);
    assert.match(owned.rows[0]!.nsp, /^pg_temp/);
    const query = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const same = { connect: async () => ({ query, release: () => {} }), query } as never;
    const journal = new BoxDurableJournal(same);
    const suffix = randomBytes(4).toString("hex");
    const sessionId = `session-${suffix}`;
    const turnKey = "a".repeat(64);
    const basis = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
        inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1",
        cacheWritePerMtok: "1", multiplier: "1" },
      boxBillingContext: { v: 1, sessionId, mode: "chat", parentSessionId: null,
        delegateAgentId: null, turnKey, parentTurnKey: null, authority: null,
        dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null } };
    const put = (id: string) => client.query(
      `INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
       VALUES ($1,3,7,'inflight',$2::jsonb)`, [id, JSON.stringify(basis)]);
    const pointer = (requestId: string, runNonce: string, leaseEpoch: string, roundNo: number) => ({
      version: 1 as const, uid: "3", requestId, runNonce, leaseEpoch, roundNo,
      bytes: 80, sha256: "a".repeat(64) });
    const tools = [{ name: "local_echo", description: "local-only",
      input_schema: { type: "object", properties: { value: { type: "string" } } } }];
    const firstBody: ProxyBody = { model: basis.model, max_tokens: 128, stream: true, tools,
      metadata: { user_id: JSON.stringify({ oc_turn_key: turnKey, session_id: sessionId }) },
      messages: [{ role: "user", content: "synthetic first prompt" }] };
    const rootId = `box-root-${suffix}`;
    const childId = `box-child-${suffix}`;
    await put(rootId);
    await put(childId);
    const runNonce = "3".repeat(24);
    const leaseEpoch = "4".repeat(32);
    const catalogHash = compileBoxToolCatalog(tools).bindingSha256;
    const root = { requestId: rootId, uid: 3n, accountId: 20n, model: basis.model,
      invocationMode: "detached_tool" as const, contextHash: deriveBoxContextHash(firstBody),
      detachedRunnerHash: "f".repeat(64), catalogHash,
      fingerprint: { turnKey, sessionId, requestHash: "b".repeat(64), replayFingerprint: "9".repeat(64) },
      runNonce, leaseEpoch,
      nativeStart: { sessionId: "12345678-1234-4123-8123-123456789abc",
        cliCwd: `/tmp/ocv5-289-run-${runNonce}` } };
    await journal.admit(root);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=ctx || '{"boxReplayRequired":true}'::jsonb WHERE request_id=$1`, [rootId]);
    await journal.markRunning(root);
    const toolUses = [
      { id: "toolu_A", boxName: "mcp__ocbridge__t0", clientName: "local_echo", input: { value: "secret-not-in-sql" } },
    ];
    const assistant = [
      { type: "text", text: "Box said A before calling tools" },
      { type: "tool_use", id: "toolu_A", name: "local_echo", input: { value: "secret-not-in-sql" },
        caller: { type: "provider_only" } },
    ];
    await journal.recordToolHandoff({ ...root, candidate: {
      messageId: "msg_box_idle", toolUses, assistantContentHash: hashBoxAssistantContent(assistant),
      assistantEchoHash: hashBoxAssistantEchoContent(assistant),
      assistantNoCallerHash: hashBoxAssistantNoCallerContent(assistant),
      inputTokens: 7, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 0,
    }, spoolOffset: 40, messagePointer: pointer(rootId, runNonce, leaseEpoch, 1),
      detachedRunnerHash: "f".repeat(64), catalogHash, verifiedPendingToolUseIds: ["toolu_A"] });
    const resumeBody: ProxyBody = { ...firstBody, messages: [
      ...firstBody.messages,
      { role: "assistant", content: assistant },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_A", content: "ok" },
        { type: "text", text: "<system-reminder>\nPreToolUse:Bash hook additional context: keep.\n</system-reminder>" },
      ] },
    ] };
    const claimed = await journal.claimToolResume({ requestId: childId, uid: 3n,
      canonicalModel: basis.model, canonicalBody: resumeBody });
    assert.equal(claimed.ownerRequestId, rootId);
    await journal.markUnknown({ requestId: childId, uid: 3n, leaseEpoch, phase: "resume_stream_aborted" });
    const chainProof = { runNonce, leaseEpoch, keeperPid: 11, cliPid: 12,
      reason: "worker_complete" as const, revision: 1 as const };
    const leafUsage = { inputTokens: 30, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await journal.completeToolChain({ requestId: childId, uid: 3n, leaseEpoch,
      proof: chainProof, usage: leafUsage, messagePointer: pointer(childId, runNonce, leaseEpoch, 2) });
    const before = await journal.readIdleProof({ uid: 3n, containerId: 7n, sessionId, turnKey });
    assert.equal(before.status, "pending");
    await client.query(`UPDATE request_finalize_journal SET state='committed'
      WHERE request_id = ANY($1::text[])`, [[rootId, childId]]);
    const settled = await journal.readIdleProof({ uid: 3n, containerId: 7n, sessionId, turnKey });
    assert.equal(settled.status, "terminal");
    if (settled.status === "terminal") {
      assert.equal(settled.requestId, childId);
      assert.equal(settled.compactRequired, false);
      assert.equal(settled.capsuleSha256, "a".repeat(64));
    }
    assert.equal((await journal.readIdleProof({
      uid: 4n, containerId: 7n, sessionId, turnKey })).status, "not_found");
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
      VALUES ($1,3,7,'inflight',$2::jsonb)`, [`box-open-${suffix}`, JSON.stringify({
        ...basis, boxSessionId: sessionId, boxTurnKey: "b".repeat(64), boxState: "running" })]);
    const blocked = await journal.readIdleProof({ uid: 3n, containerId: 7n, sessionId, turnKey });
    assert.equal(blocked.status, "pending");
    if (blocked.status === "pending") assert.equal(blocked.reason, "other_chain");
  } finally {
    client.release();
    await pool.end();
  }
});
