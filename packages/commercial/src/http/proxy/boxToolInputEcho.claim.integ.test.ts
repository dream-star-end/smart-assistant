/** TEMP shadow claim for the Edit omit↔false alias. Loopback octest only. */
import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxContextHash, hashAssistantClaimViews } from "./boxCallFingerprint.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";

const url = "postgres://test:test@127.0.0.1:55432/openclaude_test";
const allowed = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL === url
  || process.env.TEST_DATABASE_URL === url;

test("claim accepts echoed replace_all false against a stored omit digest", { skip: !allowed }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query(`CREATE TEMP TABLE usage_records (
      request_id text NOT NULL, user_id bigint NOT NULL)`);
    const guarded = async (sql: string, params: unknown[] = []) => client.query(sql, params);
    const journal = new BoxDurableJournal({ connect: async () => ({
      query: guarded, release: () => {} }), query: guarded } as never);
    const tools = [{ name: "Edit", description: "edit", input_schema: {
      type: "object", required: ["file_path", "old_string", "new_string"],
      properties: { file_path: { type: "string" }, old_string: { type: "string" },
        new_string: { type: "string" }, replace_all: { type: "boolean", default: false } },
    } }];
    const catalog = compileBoxToolCatalog(tools);
    const plain = { file_path: "/tmp/ocv5-edit-default/sample.txt", old_string: "OLD", new_string: "NEW" };
    const storedContent = [{ type: "tool_use", id: "toolu_edit_omit", name: "Edit", input: plain }];
    const storedHashes = hashAssistantClaimViews(storedContent);
    const sessionId = "session-edit-default";
    const turn = "a".repeat(64);
    const nonce = "d".repeat(24);
    const epoch = "e".repeat(32);
    const body = { model: "box-api-claude-opus-5-5", stream: true, max_tokens: 128, tools,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_edit_omit", name: "Edit",
          input: { ...plain, replace_all: false } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_edit_omit", content: "ok" }] },
      ],
      metadata: { user_id: JSON.stringify({ session_id: sessionId, oc_turn_key: turn }) },
    } as ProxyBody;
    const handoff = {
      version: 1, roundNo: 1, messageId: "msg_edit_default",
      assistantContentHash: storedHashes.full,
      assistantEchoHash: storedHashes.echo,
      assistantNoCallerHash: storedHashes.noCaller,
      spoolOffset: 8, detachedRunnerHash: "f".repeat(64), catalogHash: catalog.bindingSha256,
      toolUses: [{ id: "toolu_edit_omit", boxName: "mcp__ocbridge__t0", clientName: "Edit",
        inputHash: hashBoxToolInput(plain) }],
      verifiedPendingToolUseIds: ["toolu_edit_omit"],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const ownerCtx = {
      model: body.model, boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool",
      boxAccountId: "20", boxRunNonce: nonce, boxLeaseEpoch: epoch,
      boxContextHash: deriveBoxContextHash(body, true), boxHandoffRevision: "rev-1",
      boxToolHandoff: handoff, boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
      boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}`, boxSessionId: sessionId, boxTurnKey: turn,
      boxState: "handoff",
      billingPricing: { v: 1, modelId: body.model, displayName: "Opus", inputPerMtok: "1",
        outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" },
      boxBillingContext: { v: 1, sessionId, mode: "chat", parentSessionId: null,
        delegateAgentId: null, turnKey: turn, parentTurnKey: null, authority: null,
        dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null },
    };
    const before = JSON.stringify(handoff);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ('box-owner-edit',3,'committed',$1::jsonb)`, [JSON.stringify(ownerCtx)]);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ('box-child-edit',3,'inflight',$1::jsonb)`, [JSON.stringify({
      model: body.model, boxInvocationRecovery: "v1",
      billingPricing: ownerCtx.billingPricing, boxBillingContext: ownerCtx.boxBillingContext,
    })]);
    const claimed = await journal.claimToolResume({
      requestId: "box-child-edit", uid: 3n, canonicalModel: body.model, canonicalBody: body,
    });
    assert.equal(claimed.ownerRequestId, "box-owner-edit");
    assert.equal(claimed.results.length, 1);
    const row = await client.query<{ ctx: { boxToolHandoff: {
      toolUses: Array<{ inputHash: string }>;
      assistantContentHash: string; assistantEchoHash: string; assistantNoCallerHash: string;
    } } }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id='box-owner-edit'");
    const kept = row.rows[0]?.ctx.boxToolHandoff;
    assert.equal(kept?.toolUses[0]?.inputHash, hashBoxToolInput(plain));
    assert.equal(kept?.assistantContentHash, storedHashes.full);
    assert.equal(kept?.assistantEchoHash, storedHashes.echo);
    assert.equal(kept?.assistantNoCallerHash, storedHashes.noCaller);
    assert.equal(before.includes(hashBoxToolInput(plain)), true);
  } finally {
    client.release();
    await pool.end();
  }
});
