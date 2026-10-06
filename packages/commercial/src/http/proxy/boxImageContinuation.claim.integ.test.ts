import { assertTestDatabaseUrl, assertConnectedTestDatabase } from "../../../../../scripts/lib/testDatabaseIdentity.mjs";
/** TEMP claim chain for a coordinate caption that stays a client sibling.
 * The second request is built from the original history, not from normalized output.
 * Loopback 55432 / openclaude_test only. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { prepareBoxContinuation } from "./boxPreparedContinuation.js";
import { publishBoxToolResume } from "./boxToolResumePublish.js";
import { runBoxToolContinuation } from "./boxToolContinuation.js";
import { runBoxToolFirstRound } from "./boxToolFirstRound.js";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { matchesBoxNativeHistory } from "./boxNativeHistory.js";
import { BoxToolResultEcho } from "./boxToolResultEcho.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash, hashBoxAssistantContent,
  hashBoxAssistantEchoContent, hashBoxAssistantNoCallerContent } from "./boxCallFingerprint.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";

const url = "postgres://test:test@127.0.0.1:55432/openclaude_test";
assertTestDatabaseUrl(url);
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
    await assertConnectedTestDatabase(client);
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query("CREATE TEMP TABLE usage_records (request_id text NOT NULL, user_id bigint NOT NULL)");
    const located = await client.query<{ name: string; nspname: string }>(
      `SELECT c.relname AS name, n.nspname FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid IN (to_regclass('request_finalize_journal'), to_regclass('usage_records'))`);
    assert.equal(located.rows.length, 2);
    assert.ok(located.rows.every((row) => row.nspname.startsWith("pg_temp")));
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
      boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}`, boxNativeCliVersion: "2.1.280" })]);
    const childBasis = { model, boxInvocationRecovery: "v1", billingPricing: pricing,
      boxBillingContext: billing };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [child, JSON.stringify(childBasis)]);
    const prepared = prepareBoxContinuation({ uid: 3n, canonicalModel: model, rawBody: first,
      authorityKind: "local_catalog", authorityTurnId: null });
    const usageBefore = await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM usage_records");
    const claimed = await journal.claimToolResume({ requestId: child, uid: 3n,
      canonicalModel: model, canonicalBody: first, prepared });
    assert.equal(claimed.results.find((item) => item.modelToolUseId === "toolu_img_claim")
      ?.content.some((part) => part.type === "text" && part.text === caption), true);
    const storedNext = await client.query<{ hash: string }>(
      "SELECT ctx->>'boxContextHash' AS hash FROM request_finalize_journal WHERE request_id=$1",
      [child]);
    assert.equal(storedNext.rows[0]?.hash, prepared.nextContextHash);
    const usageAfter = await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM usage_records");
    assert.equal(usageAfter.rows[0]?.n, usageBefore.rows[0]?.n);
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
    await assertConnectedTestDatabase(client);
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query("CREATE TEMP TABLE usage_records (request_id text NOT NULL, user_id bigint NOT NULL)");
    const located = await client.query<{ name: string; nspname: string }>(
      `SELECT c.relname AS name, n.nspname FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid IN (to_regclass('request_finalize_journal'), to_regclass('usage_records'))`);
    assert.equal(located.rows.length, 2);
    assert.ok(located.rows.every((row) => row.nspname.startsWith("pg_temp")));
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
      boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}`, boxNativeCliVersion: "2.1.280" })]);
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
        WHERE c.oid IN (to_regclass('request_finalize_journal'), to_regclass('usage_records'))`);
    assert.equal(stillTemp.rows.length, 2);
    assert.ok(stillTemp.rows.every((row) => row.nspname.startsWith("pg_temp")));
  } finally {
    client.release();
    outsider.release();
    await pool.end();
    await other.end();
  }
});

test("raw image sibling publishes once, then final and a new user gain no second publish", async () => {
  assert.match(url, /^postgres:\/\/test:test@127\.0\.0\.1:55432\/openclaude_test$/);
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const localNonce = randomBytes(12).toString("hex");
  const runDir = `/tmp/ocv5-289-run-${localNonce}`;
  const fast = process.env.OC_BOX_FAST_NATIVE;
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query("CREATE TEMP TABLE usage_records (request_id text NOT NULL, user_id bigint NOT NULL)");
    const located = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid IN (to_regclass('request_finalize_journal'), to_regclass('usage_records'))`);
    assert.equal(located.rows.length, 2);
    assert.ok(located.rows.every((row) => row.nspname.startsWith("pg_temp")));
    const journal = new BoxDurableJournal({ connect: async () => ({
      query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as never);
    const hex = randomBytes(4).toString("hex");
    const session = `imgfin-${hex}`;
    const turn = randomBytes(32).toString("hex");
    const owner = `ownf-${hex}`;
    const child = `chf-${hex}`;
    const grand = `grf-${hex}`;
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
    const prepared = prepareBoxContinuation({ uid: 3n, canonicalModel: model, rawBody: first,
      authorityKind: "local_catalog", authorityTurnId: null });
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'committed',$2::jsonb)`, [owner, JSON.stringify({ model,
      boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool", boxAccountId: "20",
      boxRunNonce: localNonce, boxLeaseEpoch: epoch,
      boxContextHash: prepared.priorContextHash, boxHandoffRevision: "rev-1",
      boxToolHandoff: handoff, boxState: "handoff", boxSessionId: session, boxTurnKey: turn,
      billingPricing: pricing, boxBillingContext: billing,
      boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
      boxNativeCliCwd: runDir, boxNativeCliVersion: "2.1.280" })]);
    const childBasis = { model, boxInvocationRecovery: "v1", billingPricing: pricing,
      boxBillingContext: billing };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [child, JSON.stringify(childBasis)]);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    for (const [id, name, args] of [
      ["toolu_img_claim", "t0", { file_path: "a.png" }],
      ["toolu_note_claim", "t1", { file_path: "a.md" }],
    ] as const) {
      writeFileSync(`${runDir}/pending.${id}.json`, JSON.stringify({
        version: 1, modelToolUseId: id, mcpRequestId: 1, name, arguments: args }), { mode: 0o600 });
    }
    let finishes = 0;
    const published = await publishBoxToolResume({
      uid: 3n, sessionId: session, requestId: child, canonicalModel: model, canonicalBody: first,
      upstreamModel: "claude-opus-5-5", url: BOX_INTERNAL_ENDPOINT,
      init: { method: "POST", body: JSON.stringify({ ...first, model: "claude-opus-5-5" }) },
      prepared,
    }, { journal, resolveTarget: async () => ({ accountId: 20n, exec: { run: async (command: {
      command: string; args: string[]; cwd: string; environment?: Record<string, string> }) => {
      if (command.command !== "/usr/bin/python3" || command.args[0] !== "-I") {
        throw new Error("BOX_TEST_EXEC_NOT_PYTHON");
      }
      const ran = spawnSync(command.command, command.args, { cwd: command.cwd,
        env: { ...process.env, ...command.environment }, encoding: "utf8", timeout: 5000 });
      if (ran.status !== 0) throw new Error(ran.stderr || "python plan failed");
      if (command.args.some((arg) => arg.includes("os.link("))) finishes += 1;
      return { stdout: ran.stdout ?? "", stderrBytes: Buffer.byteLength(ran.stderr ?? ""),
        exitCode: 0 as const };
    } } }) as never,
      retainUnknownTarget: () => { throw new Error("owner must not be marked unknown"); },
      onUnknown: async () => { throw new Error("owner must not be marked unknown"); } });
    assert.equal(finishes, 2);
    assert.equal(published.claim.nativeSessionId, "12345678-1234-4123-8123-123456789abc");
    const imageFile = JSON.parse(readFileSync(`${runDir}/result.toolu_img_claim.json`, "utf8")) as {
      modelToolUseId: string; content: Array<{ type: string; text?: string; data?: string }>; isError: boolean };
    assert.equal(imageFile.modelToolUseId, "toolu_img_claim");
    assert.equal(imageFile.content.some((part) => part.text === caption), true);
    const imageHash = createHash("sha256").update(JSON.stringify({
      content: imageFile.content, isError: false })).digest("hex");
    const echo = new BoxToolResultEcho([{ modelToolUseId: "toolu_img_claim", contentHash: imageHash, isError: false }]);
    echo.accept({ type: "user", message: { role: "user", content: [{ type: "tool_result",
      tool_use_id: "toolu_img_claim", content: imageFile.content.map((part) => part.type === "text"
        ? { type: "text", text: part.text } : { type: "image", source: { type: "base64",
          media_type: "image/png", data: part.data } }) }] } });
    echo.assertComplete();
    const rawStill = JSON.stringify(first.messages);
    assert.equal(rawStill.includes(caption), true, "publish must not normalize the client history");
    const secondAssistant = [{ type: "tool_use", id: "toolu_next_claim", name: "Note",
      input: { file_path: "b.md" } }];
    const second = request(session, turn, [
      ...originalBoundary(),
      { role: "assistant", content: secondAssistant },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_next_claim",
        content: "next-bytes" }] },
      budget(90),
    ]);
    assert.equal(JSON.stringify(second.messages).includes(caption), true);
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
    const nextPrepared = prepareBoxContinuation({ uid: 3n, canonicalModel: model, rawBody: second,
      authorityKind: "local_catalog", authorityTurnId: null });
    const next = await journal.claimToolResume({ requestId: grand, uid: 3n, canonicalModel: model,
      canonicalBody: second, prepared: nextPrepared });
    assert.equal(next.ownerRequestId, child);
    assert.equal(JSON.stringify(second.messages).includes(caption), true, "next claim does not backfill normalize");
    process.env.OC_BOX_FAST_NATIVE = "1";
    const cliModel = "claude-opus-5-5";
    const streamEvent = (value: unknown) => ({ type: "stream_event", event: value });
    const finalText = "done";
    const spool = Buffer.from([
      { type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_next_claim", content: "next-bytes" }] } },
      streamEvent({ type: "message_start", message: { id: "msg_final_img", model: cliModel,
        role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: finalText } }),
      { type: "assistant", message: { id: "msg_final_img", model: cliModel, role: "assistant",
        content: [{ type: "text", text: finalText }] } },
      streamEvent({ type: "content_block_stop", index: 0 }),
      streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 2, output_tokens: 4 } }),
      streamEvent({ type: "message_stop" }),
      { type: "result", subtype: "success", is_error: false,
        usage: { input_tokens: 2, output_tokens: 4 } },
    ].map((row) => JSON.stringify(row) + "\n").join(""));
    const transcriptSha = "ab".repeat(32);
    const contExec = { run: async (command: { args: string[] }) => {
      const args = command.args;
      if (args[5] === "--read") {
        const offset = Number(args[7]);
        const part = spool.subarray(Math.max(0, offset - next.spoolOffset));
        return { stdout: JSON.stringify({ offset: offset + part.length, data: part.toString("base64") }),
          stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[2]?.includes("print(json.dumps({'sha256':actual")) {
        return { stdout: JSON.stringify({ sha256: transcriptSha, size: spool.length }) + "\n",
          stderrBytes: 0, exitCode: 0 as const };
      }
      return { stdout: JSON.stringify({ runNonce: localNonce, leaseEpoch: epoch, keeperPid: 101,
        cliPid: 102, reason: "worker_complete", revision: 1 }) + "\n",
        stderrBytes: 0, exitCode: 0 as const };
    } };
    const continued = await runBoxToolContinuation({
      // A native pointer is recorded only for a Box whose CLI build has
      // verified native resume (OCV5-313).
      published: { claim: next, target: { accountId: 20n, exec: contExec, cliVersion: "2.1.280" },
        access: makeBoxDetachedRunAccess({ runNonce: next.runNonce,
          detachedRunnerHash: next.detachedRunnerHash }) },
      uid: 3n, requestId: grand, canonicalBody: second, upstreamModel: cliModel,
      emit: () => {}, prepared: nextPrepared,
    }, { journal, retainUnknownTarget: () => { throw new Error("owner must not be marked unknown"); },
      onUnknown: async () => { throw new Error("owner must not be marked unknown"); } });
    assert.equal(continued.kind, "final");
    if (continued.kind !== "final") return;
    assert.equal(continued.nativePointer?.nativeSessionId, "12345678-1234-4123-8123-123456789abc");
    assert.equal(continued.nativePointer?.cliCwd, runDir);
    assert.equal(continued.nativePointer?.transcriptSha256, transcriptSha);
    const storedPointer = await client.query<{ pointer: { nativeSessionId?: string; cliCwd?: string } | null }>(
      "SELECT ctx->'boxNativePointer' AS pointer FROM request_finalize_journal WHERE request_id=$1",
      [grand]);
    assert.equal(storedPointer.rows[0]?.pointer?.nativeSessionId, continued.nativePointer?.nativeSessionId);
    assert.equal(storedPointer.rows[0]?.pointer?.cliCwd, runDir);
    const terminal = await client.query<{ state: string }>(
      "SELECT ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=$1", [owner]);
    assert.equal(terminal.rows[0]?.state, "terminal");
    const nextTurn = randomBytes(32).toString("hex");
    const nextPrompt = "thanks, the caption stayed";
    const ordinary = request(session, nextTurn, [
      ...second.messages,
      { role: "assistant", content: [{ type: "text", text: finalText }] },
      { role: "user", content: nextPrompt },
    ]);
    assert.equal(JSON.stringify(ordinary.messages).includes(caption), true);
    assert.equal(ordinary.messages.some((message) => JSON.stringify(message).includes(caption)
      && JSON.stringify(message) === JSON.stringify(second.messages.find((item) =>
        JSON.stringify(item).includes(caption)))), true, "caption bytes stay the raw sibling");
    const fresh = prepareBoxContinuation({ uid: 3n, canonicalModel: model, rawBody: ordinary,
      authorityKind: "local_catalog", authorityTurnId: null });
    assert.equal(fresh.classification, "fresh");
    const nextId = `nat-${hex}`;
    const candidate = await journal.findNativeCandidate({ uid: 3n, sessionId: session,
      currentRequestId: nextId, canonicalModel: model });
    assert.ok(candidate, "the continuation pointer is the native candidate");
    assert.equal(candidate?.pointer.cliCwd, runDir);
    assert.equal(matchesBoxNativeHistory(ordinary, candidate!.pointer), true,
      "next raw history must match the persisted pointer");
    assert.equal(candidate!.pointer.catalogHash, compileBoxToolCatalog(ordinary.tools).bindingSha256);
    const parsedTools = (JSON.parse(JSON.stringify({ ...ordinary, model: cliModel })) as { tools: unknown }).tools;
    assert.equal(compileBoxToolCatalog(parsedTools).bindingSha256, candidate!.pointer.catalogHash);
    assert.equal(candidate!.pointer.upstreamModel, cliModel);
    assert.equal(candidate!.pointer.accountId, "20");
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [nextId, JSON.stringify({ model,
      boxInvocationRecovery: "v1", billingPricing: pricing,
      boxBillingContext: { ...billing, turnKey: nextTurn } })]);
    const seenLaunch: { args: string[]; cwd: string; staged: string } = { args: [], cwd: "", staged: "" };
    let controlHash = "";
    let nativeInspects = 0;
    let nextNonce = localNonce;
    let nextEpoch = epoch;
    const nativeExec = { run: async (command: { args: string[]; cwd: string }) => {
      const args = command.args;
      if (args[2]?.includes("identity['identityHash']")) {
        const manifest = { accountId: args[5], controlDev: "2049", controlId: args[6],
          controlIno: "9001", leaseEpoch: args[4], lockDev: "2049", lockIno: "9002",
          runNonce: args[3], version: 2 };
        nextNonce = String(args[3]);
        nextEpoch = String(args[4]);
        controlHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
        return { stdout: JSON.stringify({ ...manifest, identityHash: controlHash }) + "\n",
          stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[2]?.includes("def clean_dir(parent_path,name,allowed):")) {
        return { stdout: `cleaned:${controlHash}\n`, stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[2]?.includes("print(json.dumps({'sha256':actual")) {
        nativeInspects += 1;
        assert.equal(args[3], runDir);
        assert.equal(args[4], "12345678-1234-4123-8123-123456789abc");
        return { stdout: JSON.stringify({ sha256: transcriptSha, size: spool.length }) + "\n",
          stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[2]?.includes("print('staged:'+str(len(steps)))")) {
        const decoded = Buffer.from(args[3]!, "base64").toString("utf8");
        seenLaunch.staged = decoded;
        for (const match of decoded.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
          try { seenLaunch.staged += Buffer.from(match[0], "base64").toString("utf8"); }
          catch { /* not a payload */ }
        }
        const steps = JSON.parse(decoded) as unknown[];
        return { stdout: `staged:${steps.length}\n`, stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("sys.argv=[p,*argv]")
        && args[3]?.startsWith("/tmp/ocv5-289-v2-detached-runner-") && args[5] !== "--read") {
        seenLaunch.args = args;
        seenLaunch.cwd = command.cwd;
        return { stdout: "launched\n", stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[5] === "--read") {
        const offset = Number(args[7]);
        const nextSpool = Buffer.from([
          { type: "system", subtype: "init", tools: ["mcp__ocbridge__t0", "mcp__ocbridge__t1"],
            mcp_servers: [{}] },
          streamEvent({ type: "message_start", message: { id: "msg_native_next", model: cliModel,
            role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }),
          streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
          streamEvent({ type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: "native-next" } }),
          { type: "assistant", message: { id: "msg_native_next", model: cliModel, role: "assistant",
            content: [{ type: "text", text: "native-next" }] } },
          streamEvent({ type: "content_block_stop", index: 0 }),
          streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 1, output_tokens: 4 } }),
          streamEvent({ type: "message_stop" }),
          { type: "result", subtype: "success", is_error: false,
            usage: { input_tokens: 1, output_tokens: 4 } },
        ].map((row) => JSON.stringify(row) + "\n").join(""));
        const part = nextSpool.subarray(Math.min(offset, nextSpool.length));
        return { stdout: JSON.stringify({ data: part.toString("base64"), offset: offset + part.length }),
          stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[2]?.includes("terminal.json")) {
        return { stdout: JSON.stringify({ runNonce: nextNonce, leaseEpoch: nextEpoch,
          keeperPid: 1, cliPid: 2, reason: "worker_complete", revision: 1 }) + "\n",
          stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[3]?.startsWith("/tmp/ocv5-289-") && !args[3]?.startsWith("/tmp/ocv5-289-run-")) {
        const manifest = Array.from({ length: (args.length - 3) / 4 }, (_, i) => args[5 + i * 4]).join(",");
        return { stdout: `${manifest}\n`, stderrBytes: 0, exitCode: 0 as const };
      }
      return { stdout: "ok\n", stderrBytes: 0, exitCode: 0 as const };
    } };
    const filesBefore = readdirSync(runDir).filter((name) => name.startsWith("result.")).sort();
    const imageBefore = readFileSync(`${runDir}/result.toolu_img_claim.json`);
    await runBoxToolFirstRound({
      uid: 3n, sessionId: session, requestId: nextId, canonicalModel: model,
      canonicalBody: ordinary, upstreamModel: cliModel, url: BOX_INTERNAL_ENDPOINT,
      init: { method: "POST", body: JSON.stringify({ ...ordinary, model: cliModel }) },
      emit: () => {},
    }, {
      supervisorAsset: Buffer.from("print('supervisor')\n"),
      keeperAsset: Buffer.from("print('keeper')\n"),
      virtualMcpAsset: Buffer.from("print('virtual')\n"),
      detachedRunnerAsset: Buffer.from("print('runner')\n"),
      journal, maxOutputTokensForModel: () => 128,
      resolveTarget: async () => ({ accountId: 20n, exec: nativeExec, cliVersion: "2.1.280",
        dispose: async () => {} }) as never,
      onUnknown: async () => { seenLaunch.staged += "\nUNKNOWN"; },
      retainUnknownTarget: () => { seenLaunch.staged += "\nRETAIN"; },
      retainCleanupTarget: () => {},
    });
    assert.ok(nativeInspects >= 1, "native preflight must run before the resume launch");
    const cliCwdAt = seenLaunch.args.indexOf("--cli-cwd");
    const resumeAt = seenLaunch.args.indexOf("--resume");
    assert.equal(seenLaunch.args[cliCwdAt + 1], runDir);
    assert.equal(seenLaunch.args[resumeAt + 1], "12345678-1234-4123-8123-123456789abc");
    assert.equal(seenLaunch.args.includes("--session-id"), false);
    assert.equal(seenLaunch.staged.includes(nextPrompt), true);
    assert.deepEqual(readdirSync(runDir).filter((name) => name.startsWith("result.")).sort(), filesBefore);
    assert.equal(readFileSync(`${runDir}/result.toolu_img_claim.json`).equals(imageBefore), true);
    const rebuilt = new BoxDurableJournal({ connect: async () => ({
      query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as never);
    assert.equal(rebuilt instanceof BoxDurableJournal, true);
    assert.notEqual(rebuilt, journal, "a new Journal object is not an OS restart");
    const again = await rebuilt.decideToolResume({ requestId: `new-${hex}`, uid: 3n,
      canonicalModel: model, canonicalBody: first, prepared });
    assert.notEqual(again.kind, "new_claim");
    assert.deepEqual(readdirSync(runDir).filter((name) => name.startsWith("result.")).sort(), filesBefore);
    const ownerAfter = await client.query<{ state: string }>(
      "SELECT ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=$1", [owner]);
    assert.equal(ownerAfter.rows[0]?.state, "terminal");
  } finally {
    if (fast === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = fast;
    rmSync(runDir, { recursive: true, force: true });
    client.release();
    await pool.end();
  }
});

test("commit failure, lost ack, and a rebuilt journal do not gain a publish", async () => {
  assert.match(url, /^postgres:\/\/test:test@127\.0\.0\.1:55432\/openclaude_test$/);
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const localNonce = randomBytes(12).toString("hex");
  const runDir = `/tmp/ocv5-289-run-${localNonce}`;
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query("CREATE TEMP TABLE usage_records (request_id text NOT NULL, user_id bigint NOT NULL)");
    const journal = new BoxDurableJournal({ connect: async () => ({
      query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as never);
    const hex = randomBytes(3).toString("hex");
    const session = `fail-${hex}`;
    const turn = randomBytes(32).toString("hex");
    const first = request(session, turn, originalBoundary());
    const prepared = prepareBoxContinuation({ uid: 3n, canonicalModel: model, rawBody: first,
      authorityKind: "local_catalog", authorityTurnId: null });
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
    const owner = `ownx-${hex}`;
    const child = `chx-${hex}`;
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'committed',$2::jsonb)`, [owner, JSON.stringify({ model,
      boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool", boxAccountId: "20",
      boxRunNonce: localNonce, boxLeaseEpoch: epoch, boxContextHash: prepared.priorContextHash,
      boxHandoffRevision: "rev-1", boxToolHandoff: handoff, boxState: "handoff",
      boxSessionId: session, boxTurnKey: turn, billingPricing: pricing, boxBillingContext: billing,
      boxNativeSessionId: "12345678-1234-4123-8123-123456789abc", boxNativeCliCwd: runDir, boxNativeCliVersion: "2.1.280" })]);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [child, JSON.stringify({ model,
      boxInvocationRecovery: "v1", billingPricing: pricing, boxBillingContext: billing })]);
    journal.resumeLookupBarrier = async () => { throw new Error("COMMIT_BEFORE_FAILURE"); };
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    await assert.rejects(() => journal.decideToolResume({ requestId: child, uid: 3n,
      canonicalModel: model, canonicalBody: first, prepared }), /COMMIT_BEFORE_FAILURE/);
    assert.equal(readdirSync(runDir).filter((name) => name.startsWith("result.")).length, 0);
    const rolled = await client.query<{ state: string }>(
      "SELECT ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=$1", [owner]);
    assert.equal(rolled.rows[0]?.state, "handoff");
    journal.resumeLookupBarrier = null;
    const claimed = await journal.decideToolResume({ requestId: child, uid: 3n,
      canonicalModel: model, canonicalBody: first, prepared });
    assert.equal(claimed.kind, "new_claim");
    assert.equal(readdirSync(runDir).filter((name) => name.startsWith("result.")).length, 0,
      "a committed claim without a publisher call writes no file");
    const rebuilt = new BoxDurableJournal({ connect: async () => ({
      query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as never);
    const rival = `rival-${hex}`;
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [rival, JSON.stringify({ model,
      boxInvocationRecovery: "v1", billingPricing: pricing, boxBillingContext: billing })]);
    const lostAck = await rebuilt.decideToolResume({ requestId: rival, uid: 3n,
      canonicalModel: model, canonicalBody: first, prepared });
    assert.equal(lostAck.kind, "in_progress_or_unknown");
    assert.notEqual(process.pid, 0);
    const ownerState = await client.query<{ state: string }>(
      "SELECT ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=$1", [owner]);
    assert.equal(ownerState.rows[0]?.state, "resuming");
    const exploding = new BoxDurableJournal({ connect: async () => ({
      query: async () => { throw new Error("relation exploded"); }, release() {} }),
      query: async () => { throw new Error("relation exploded"); } } as never);
    await assert.rejects(() => exploding.decideToolResume({ requestId: rival, uid: 3n,
      canonicalModel: model, canonicalBody: first, prepared }), /relation exploded/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    client.release();
    await pool.end();
  }
});
