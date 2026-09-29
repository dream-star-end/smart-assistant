/** TEMP claim chain for a coordinate caption that stays a client sibling.
 * The second request is built from the original history, not from normalized output.
 * Loopback 55432 / openclaude_test only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash, hashBoxAssistantContent,
  hashBoxAssistantEchoContent, hashBoxAssistantNoCallerContent } from "./boxCallFingerprint.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";

const url = "postgres://test:test@127.0.0.1:55432/openclaude_test";
const model = "box-api-claude-opus-5-5";
const caption = "[Image: original 80x2200, displayed at 73x2000. Multiply coordinates by 1.10 to map to original image.]";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const nonce = "a".repeat(24);
const epoch = "b".repeat(32);
const runner = "c".repeat(64);
const tools = [
  { name: "Read", description: "read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
  { name: "Note", description: "note", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
];

function budget(tokens: number) {
  return { role: "system", content: [{ type: "text",
    text: `<total_tokens>${tokens} tokens left</total_tokens>`,
    cache_control: { type: "ephemeral" } }] };
}
function imageResult() {
  return { type: "tool_result", tool_use_id: "toolu_img_claim", content: [{ type: "image",
    source: { type: "base64", media_type: "image/png", data: png } }] };
}
function noteResult() {
  return { type: "tool_result", tool_use_id: "toolu_note_claim", content: "note-bytes" };
}
function firstAssistant() {
  return [
    { type: "tool_use", id: "toolu_img_claim", name: "Read", input: { file_path: "a.png" } },
    { type: "tool_use", id: "toolu_note_claim", name: "Note", input: { file_path: "a.md" } },
  ];
}
function originalBoundary(): unknown[] {
  return [
    { role: "user", content: "look" },
    { role: "assistant", content: firstAssistant() },
    { role: "user", content: [imageResult(), noteResult(), { type: "text", text: caption }] },
    budget(100),
  ];
}
function request(session: string, turn: string, messages: unknown[]): ProxyBody {
  return { model, stream: true, max_tokens: 128, tools, messages,
    metadata: { user_id: JSON.stringify({ session_id: session, oc_turn_key: turn }) } } as ProxyBody;
}

test("second TEMP claim keeps the client sibling and does not advance on failure", async () => {
  assert.match(url, /^postgres:\/\/test:test@127\.0\.0\.1:55432\/openclaude_test$/);
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    const where = await client.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port");
    assert.equal(where.rows[0]?.db, "openclaude_test");
    assert.equal(Number(where.rows[0]?.port), 55432);
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query("CREATE TEMP TABLE usage_records (request_id text NOT NULL, user_id bigint NOT NULL)");
    const located = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid = to_regclass('request_finalize_journal')`);
    assert.ok(located.rows[0]?.nspname.startsWith("pg_temp"));
    const journal = new BoxDurableJournal({ connect: async () => ({
      query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as never);
    const hex = randomBytes(4).toString("hex");
    const session = `img-${hex}`;
    const turn = randomBytes(32).toString("hex");
    const owner = `own-${hex}`;
    const child = `ch1-${hex}`;
    const grand = `ch2-${hex}`;
    const first = request(session, turn, originalBoundary());
    const catalog = compileBoxToolCatalog(tools);
    const assistant = firstAssistant();
    const hashes = { assistantContentHash: hashBoxAssistantContent(assistant),
      assistantNoCallerHash: hashBoxAssistantNoCallerContent(assistant),
      assistantEchoHash: hashBoxAssistantEchoContent(assistant) };
    const pricing = { v: 1, modelId: model, displayName: "Opus", inputPerMtok: "1",
      outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" };
    const billing = { v: 1, sessionId: session, mode: "chat", parentSessionId: null,
      delegateAgentId: null, turnKey: turn, parentTurnKey: null, authority: null,
      dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null };
    const handoff = { version: 1, roundNo: 1, messageId: `msg_${hex}`, ...hashes, spoolOffset: 8,
      detachedRunnerHash: runner, catalogHash: catalog.bindingSha256,
      toolUses: [
        { id: "toolu_img_claim", boxName: "mcp__ocbridge__t0", clientName: "Read",
          inputHash: hashBoxToolInput({ file_path: "a.png" }) },
        { id: "toolu_note_claim", boxName: "mcp__ocbridge__t1", clientName: "Note",
          inputHash: hashBoxToolInput({ file_path: "a.md" }) },
      ],
      verifiedPendingToolUseIds: ["toolu_img_claim", "toolu_note_claim"],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'committed',$2::jsonb)`, [owner, JSON.stringify({ model,
      boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool", boxAccountId: "20",
      boxRunNonce: nonce, boxLeaseEpoch: epoch, boxContextHash: deriveBoxContextHash(first, true),
      boxHandoffRevision: "rev-1", boxToolHandoff: handoff, boxState: "handoff",
      boxSessionId: session, boxTurnKey: turn, billingPricing: pricing, boxBillingContext: billing,
      boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
      boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}` })]);
    const childBasis = { model, boxInvocationRecovery: "v1", billingPricing: pricing,
      boxBillingContext: billing };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [child, JSON.stringify(childBasis)]);
    const claimed = await journal.claimToolResume({ requestId: child, uid: 3n,
      canonicalModel: model, canonicalBody: first });
    assert.equal(claimed.results.find((item) => item.modelToolUseId === "toolu_img_claim")
      ?.content.some((part) => part.type === "text" && part.text === caption), true);
    const storedNext = await client.query<{ hash: string }>(
      "SELECT ctx->>'boxContextHash' AS hash FROM request_finalize_journal WHERE request_id=$1",
      [child]);
    assert.equal(storedNext.rows[0]?.hash, deriveBoxContextHash(first));
    const secondAssistant = [{ type: "tool_use", id: "toolu_next_claim", name: "Note",
      input: { file_path: "b.md" } }];
    const second = request(session, turn, [
      ...originalBoundary(),
      { role: "assistant", content: secondAssistant },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_next_claim",
        content: "next-bytes" }] },
      budget(90),
    ]);
    const historical = (second.messages[2] as { content: Array<{ text?: string }> }).content;
    assert.equal(historical.some((part) => part.text === caption), true,
      "the second request still carries the client sibling");
    assert.equal(deriveBoxContextHash(second, true), deriveBoxContextHash(first));
    await journal.recordToolHandoff({ requestId: child, uid: 3n, leaseEpoch: epoch,
      roundNo: 2, spoolOffset: 16, detachedRunnerHash: runner, catalogHash: catalog.bindingSha256,
      verifiedPendingToolUseIds: ["toolu_next_claim"],
      candidate: { messageId: `msg2_${hex}`, toolUses: [{ id: "toolu_next_claim",
        boxName: "mcp__ocbridge__t1", clientName: "Note", input: { file_path: "b.md" } }],
        assistantContentHash: hashBoxAssistantContent(secondAssistant),
        assistantNoCallerHash: hashBoxAssistantNoCallerContent(secondAssistant),
        assistantEchoHash: hashBoxAssistantEchoContent(secondAssistant),
        inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [grand, JSON.stringify(childBasis)]);
    const broken = structuredClone(second) as ProxyBody;
    const brokenCaption = ((broken.messages[2] as { content: Array<{ text?: string }> }).content)
      .find((part) => part.text === caption)!;
    brokenCaption.text = `${caption} `;
    const before = await client.query<{ id: string; state: string | null }>(
      `SELECT request_id AS id, ctx->>'boxState' AS state FROM request_finalize_journal
        WHERE request_id = ANY($1::text[]) ORDER BY request_id`, [[child, grand]]);
    await assert.rejects(() => journal.claimToolResume({ requestId: grand, uid: 3n,
      canonicalModel: model, canonicalBody: broken }),
    (error: unknown) => error instanceof BoxDurableJournalError
      && error.code === "BOX_TOOL_CONTEXT_CHANGED");
    const afterFail = await client.query<{ id: string; state: string | null }>(
      `SELECT request_id AS id, ctx->>'boxState' AS state FROM request_finalize_journal
        WHERE request_id = ANY($1::text[]) ORDER BY request_id`, [[child, grand]]);
    assert.deepEqual(afterFail.rows, before.rows);
    const again = await journal.claimToolResume({ requestId: grand, uid: 3n,
      canonicalModel: model, canonicalBody: second });
    assert.equal(again.ownerRequestId, child);
    const nextBlock = again.results[0]?.content[0];
    assert.equal(nextBlock?.type === "text" ? nextBlock.text : "", "next-bytes");
    const grandHash = await client.query<{ hash: string }>(
      "SELECT ctx->>'boxContextHash' AS hash FROM request_finalize_journal WHERE request_id=$1",
      [grand]);
    assert.equal(grandHash.rows[0]?.hash, deriveBoxContextHash(second));
  } finally {
    client.release();
    await pool.end();
  }
});

test("TEMP authority mismatch and a second request id do not publish twice", async () => {
  assert.match(url, /^postgres:\/\/test:test@127\.0\.0\.1:55432\/openclaude_test$/);
  const pool = new Pool({ connectionString: url, max: 1 });
  const other = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const outsider = await other.connect();
  try {
    const where = await client.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port");
    assert.equal(where.rows[0]?.db, "openclaude_test");
    assert.equal(Number(where.rows[0]?.port), 55432);
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query("CREATE TEMP TABLE usage_records (request_id text NOT NULL, user_id bigint NOT NULL)");
    const located = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid = to_regclass('request_finalize_journal')`);
    assert.ok(located.rows[0]?.nspname.startsWith("pg_temp"));
    const journal = new BoxDurableJournal({ connect: async () => ({
      query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as never);
    const hex = randomBytes(4).toString("hex");
    const session = `race-${hex}`;
    const turn = randomBytes(32).toString("hex");
    const owner = `own2-${hex}`;
    const child = `chA-${hex}`;
    const rival = `chB-${hex}`;
    const signed = "ab".repeat(16);
    const first = request(session, turn, originalBoundary());
    const catalog = compileBoxToolCatalog(tools);
    const assistant = firstAssistant();
    const handoff = { version: 1, roundNo: 1, messageId: `msg_${hex}`,
      assistantContentHash: hashBoxAssistantContent(assistant),
      assistantNoCallerHash: hashBoxAssistantNoCallerContent(assistant),
      assistantEchoHash: hashBoxAssistantEchoContent(assistant), spoolOffset: 8,
      detachedRunnerHash: runner, catalogHash: catalog.bindingSha256,
      toolUses: [
        { id: "toolu_img_claim", boxName: "mcp__ocbridge__t0", clientName: "Read",
          inputHash: hashBoxToolInput({ file_path: "a.png" }) },
        { id: "toolu_note_claim", boxName: "mcp__ocbridge__t1", clientName: "Note",
          inputHash: hashBoxToolInput({ file_path: "a.md" }) },
      ],
      verifiedPendingToolUseIds: ["toolu_img_claim", "toolu_note_claim"],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const pricing = { v: 1, modelId: model, displayName: "Opus", inputPerMtok: "1",
      outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" };
    const billing = { v: 1, sessionId: session, mode: "chat", parentSessionId: null,
      delegateAgentId: null, turnKey: turn, parentTurnKey: null, authority: null,
      dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'committed',$2::jsonb)`, [owner, JSON.stringify({ model,
      authorityKind: "bridge_signed", authorityTurnId: signed,
      boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool", boxAccountId: "20",
      boxRunNonce: nonce, boxLeaseEpoch: epoch, boxContextHash: deriveBoxContextHash(first, true),
      boxHandoffRevision: "rev-1", boxToolHandoff: handoff, boxState: "handoff",
      boxSessionId: session, boxTurnKey: turn, billingPricing: pricing, boxBillingContext: billing,
      boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
      boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}` })]);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [child, JSON.stringify({ model,
      authorityKind: "bridge_signed", authorityTurnId: "cd".repeat(16),
      boxInvocationRecovery: "v1", billingPricing: pricing, boxBillingContext: billing })]);
    const ownerBefore = await client.query<{ state: string }>(
      "SELECT ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=$1", [owner]);
    await assert.rejects(() => journal.claimToolResume({ requestId: child, uid: 3n,
      canonicalModel: model, canonicalBody: first,
      trustedAuthority: { kind: "bridge_signed", authorityTurnId: "cd".repeat(16) } }),
    (error: unknown) => error instanceof BoxDurableJournalError && error.code === "BOX_AUTHORITY_REJECTED");
    const ownerAfter = await client.query<{ state: string; child: string | null }>(
      `SELECT ctx->>'boxState' AS state, ctx->>'boxResumeRequestId' AS child
        FROM request_finalize_journal WHERE request_id=$1`, [owner]);
    assert.equal(ownerAfter.rows[0]?.state, ownerBefore.rows[0]?.state);
    assert.equal(ownerAfter.rows[0]?.child ?? null, null);
    await client.query(`UPDATE request_finalize_journal
      SET ctx = ctx || '{"authorityTurnId":"${signed}"}'::jsonb WHERE request_id=$1`, [child]);
    let entered!: () => void;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => { entered = resolve; });
    const closed = new Promise<void>((resolve) => { release = resolve; });
    journal.resumeLookupBarrier = async () => { entered(); await closed; };
    const pending = journal.decideToolResume({ requestId: child, uid: 3n,
      canonicalModel: model, canonicalBody: first,
      trustedAuthority: { kind: "bridge_signed", authorityTurnId: signed } });
    await opened;
    await outsider.query("BEGIN");
    await outsider.query("SET LOCAL lock_timeout = '400ms'");
    await assert.rejects(() => outsider.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [`box:session:3:${session}`]), /lock timeout|canceling statement due to lock timeout/i);
    await outsider.query("ROLLBACK");
    release();
    const decision = await pending;
    assert.equal(decision.kind, "new_claim");
    journal.resumeLookupBarrier = null;
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [rival, JSON.stringify({ model,
      authorityKind: "bridge_signed", authorityTurnId: signed,
      boxInvocationRecovery: "v1", billingPricing: pricing, boxBillingContext: billing })]);
    const again = await journal.decideToolResume({ requestId: rival, uid: 3n,
      canonicalModel: model, canonicalBody: first,
      trustedAuthority: { kind: "bridge_signed", authorityTurnId: signed } });
    assert.equal(again.kind, "in_progress_or_unknown");
    const states = await client.query<{ id: string; state: string | null }>(
      `SELECT request_id AS id, ctx->>'boxState' AS state FROM request_finalize_journal
        WHERE request_id = ANY($1::text[]) ORDER BY request_id`, [[owner, child, rival]]);
    assert.equal(states.rows.find((row) => row.id === owner)?.state, "resuming");
    assert.equal(states.rows.find((row) => row.id === child)?.state, "linked");
    assert.equal(states.rows.find((row) => row.id === rival)?.state ?? null, null);
    const stillTemp = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid = to_regclass('request_finalize_journal')`);
    assert.ok(stillTemp.rows[0]?.nspname.startsWith("pg_temp"));
  } finally {
    client.release();
    outsider.release();
    await pool.end();
    await other.end();
  }
});
