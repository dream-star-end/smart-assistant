/** TEMP shadow claims for the Edit omit↔false alias. Loopback octest only.
 * Oracle is claimToolResume plus SQL readback of hashes taken from the
 * original stored message. incomingAssistantAccepted is not consulted. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash, hashBoxAssistantContent,
  hashBoxAssistantEchoContent, hashBoxAssistantNoCallerContent } from "./boxCallFingerprint.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";

const url = "postgres://test:test@127.0.0.1:55432/openclaude_test";
const allowed = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL === url
  || process.env.TEST_DATABASE_URL === url;
const editSchema = {
  type: "object", required: ["file_path", "old_string", "new_string"],
  properties: { file_path: { type: "string" }, old_string: { type: "string" },
    new_string: { type: "string" }, replace_all: { type: "boolean", default: false } },
};
const plain = { file_path: "/tmp/ocv5-edit-default/sample.txt", old_string: "OLD", new_string: "NEW" };
const explicit = { ...plain, replace_all: false as const };
const model = "box-api-claude-opus-5-5";
const nonce = "d".repeat(24);
const epoch = "e".repeat(32);
const runner = "f".repeat(64);

type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
type Handle = { journal: BoxDurableJournal; client: PoolClient; seen: Set<string>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

function editTool(schema: Record<string, unknown> = editSchema): Tool {
  return { name: "Edit", description: "edit", input_schema: schema };
}
function ids(label: string): { session: string; turn: string; owner: string; child: string } {
  const hex = randomBytes(4).toString("hex");
  return { session: `sess-${label}-${hex}`, turn: randomBytes(32).toString("hex"),
    owner: `own-${label}-${hex}`, child: `ch-${label}-${hex}` };
}
function storedHashes(content: unknown): {
  assistantContentHash: string; assistantNoCallerHash: string; assistantEchoHash: string;
} {
  return {
    assistantContentHash: hashBoxAssistantContent(content),
    assistantNoCallerHash: hashBoxAssistantNoCallerContent(content),
    assistantEchoHash: hashBoxAssistantEchoContent(content),
  };
}
function bodyOf(session: string, turn: string, tools: Tool[],
  assistant: unknown, results: Array<{ id: string; text: string }>): ProxyBody {
  return { model, stream: true, max_tokens: 128, tools,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: assistant },
      { role: "user", content: results.map((item) => ({
        type: "tool_result", tool_use_id: item.id, content: item.text })) },
    ],
    metadata: { user_id: JSON.stringify({ session_id: session, oc_turn_key: turn }) },
  } as ProxyBody;
}
async function withDb(run: (handle: Handle) => Promise<void>): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const seen = new Set<string>();
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const guarded = async (sql: string, params: unknown[] = []) => {
    if (/\b(?:public|pg_catalog)\.(?:request_finalize_journal|usage_records)\b/.test(sql)) {
      throw new Error("non-temp qualified relation");
    }
    const here = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    assert.equal(here.rows[0]!.pid, pid);
    for (const name of new Set([...sql.matchAll(/\b(request_finalize_journal|usage_records)\b/g)]
      .map((item) => item[1]!))) {
      const found = await client.query<{ nspname: string }>(
        `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.oid = to_regclass($1)`, [name]);
      assert.equal(found.rows.length, 1);
      assert.ok(found.rows[0]!.nspname.startsWith("pg_temp"), name);
      seen.add(`${found.rows[0]!.nspname}.${name}`);
    }
    return client.query(sql, params);
  };
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query(`CREATE TEMP TABLE usage_records (
      request_id text NOT NULL, user_id bigint NOT NULL)`);
    const temp = await client.query<{ nspname: string; relname: string }>(
      `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid IN (to_regclass('request_finalize_journal'), to_regclass('usage_records'))`);
    assert.equal(temp.rows.length, 2);
    assert.ok(temp.rows.every((row) => row.nspname.startsWith("pg_temp")));
    const journal = new BoxDurableJournal({ connect: async () => ({
      query: guarded, release: () => {} }), query: guarded } as never);
    await run({ journal, client, seen, query: guarded });
    assert.ok(seen.size > 0);
    assert.ok([...seen].every((item) => item.startsWith("pg_temp")));
  } finally {
    client.release();
    await pool.end();
  }
}
async function seed(handle: Handle, label: string, tools: Tool[],
  assistant: unknown, uses: Array<{ id: string; input: Record<string, unknown> }>,
  results: Array<{ id: string; text: string }>): Promise<{
  body: ProxyBody; owner: string; child: string; hashes: ReturnType<typeof storedHashes>;
  baseline: { raw: string; replay: string; request: string; full: string; tail: string };
}> {
  const key = ids(label);
  const catalog = compileBoxToolCatalog(tools);
  const hashes = storedHashes(assistant);
  const body = bodyOf(key.session, key.turn, tools, assistant, results);
  const baseline = { raw: JSON.stringify(body),
    replay: deriveBoxCallFingerprint(3n, body).replayFingerprint,
    request: deriveBoxCallFingerprint(3n, body).requestHash,
    full: deriveBoxContextHash(body), tail: deriveBoxContextHash(body, true) };
  const pricing = { v: 1, modelId: model, displayName: "Opus", inputPerMtok: "1",
    outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" };
  const billing = { v: 1, sessionId: key.session, mode: "chat", parentSessionId: null,
    delegateAgentId: null, turnKey: key.turn, parentTurnKey: null, authority: null,
    dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null };
  const handoff = { version: 1, roundNo: 1, messageId: `msg_${label}_${key.owner.slice(-8)}`,
    ...hashes, spoolOffset: 8, detachedRunnerHash: runner, catalogHash: catalog.bindingSha256,
    toolUses: uses.map((use) => ({ id: use.id, boxName: "mcp__ocbridge__t0", clientName: "Edit",
      inputHash: hashBoxToolInput(use.input) })),
    verifiedPendingToolUseIds: uses.map((use) => use.id),
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  const ownerCtx = { model, boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool",
    boxAccountId: "20", boxRunNonce: nonce, boxLeaseEpoch: epoch,
    boxContextHash: baseline.tail, boxHandoffRevision: "rev-1", boxToolHandoff: handoff,
    boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
    boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}`, boxSessionId: key.session, boxTurnKey: key.turn,
    boxState: "handoff", billingPricing: pricing, boxBillingContext: billing };
  await handle.client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
    VALUES ($1,3,'committed',$2::jsonb)`, [key.owner, JSON.stringify(ownerCtx)]);
  await handle.client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
    VALUES ($1,3,'inflight',$2::jsonb)`, [key.child, JSON.stringify({
    model, boxInvocationRecovery: "v1", billingPricing: pricing, boxBillingContext: billing })]);
  return { body, owner: key.owner, child: key.child, hashes, baseline };
}
async function parked(client: PoolClient, owner: string, child: string): Promise<void> {
  const ownerRow = await client.query<{ state: string; rev: string }>(
    `SELECT ctx->>'boxState' AS state, ctx->>'boxHandoffRevision' AS rev
       FROM request_finalize_journal WHERE request_id=$1`, [owner]);
  assert.equal(ownerRow.rows[0]?.state, "handoff");
  assert.equal(ownerRow.rows[0]?.rev, "rev-1");
  const childRow = await client.query<{ has: boolean }>(
    `SELECT ctx ? 'boxState' AS has FROM request_finalize_journal WHERE request_id=$1`, [child]);
  assert.equal(childRow.rows[0]?.has, false);
}
async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof BoxDurableJournalError
    && error.code === code);
}
async function keptDigests(client: PoolClient, owner: string, hashes: ReturnType<typeof storedHashes>,
  inputHashes: string[]): Promise<void> {
  const row = await client.query<{ ctx: { boxToolHandoff: {
    messageId: string; catalogHash: string; spoolOffset: number; detachedRunnerHash: string;
    assistantContentHash: string; assistantNoCallerHash: string; assistantEchoHash: string;
    toolUses: Array<{ inputHash: string }>;
  }; boxState: string } }>("SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [owner]);
  const handoff = row.rows[0]!.ctx.boxToolHandoff;
  assert.equal(handoff.assistantContentHash, hashes.assistantContentHash);
  assert.equal(handoff.assistantNoCallerHash, hashes.assistantNoCallerHash);
  assert.equal(handoff.assistantEchoHash, hashes.assistantEchoHash);
  assert.deepEqual(handoff.toolUses.map((use) => use.inputHash), inputHashes);
  assert.equal(handoff.spoolOffset, 8);
  assert.equal(handoff.detachedRunnerHash, runner);
  assert.equal(row.rows[0]!.ctx.boxState, "resuming");
}
function resultText(content: ReadonlyArray<{ type: string; text?: string }> | undefined): string | undefined {
  const block = content?.[0];
  return block?.type === "text" ? block.text : undefined;
}
function sameBody(body: ProxyBody, baseline: { raw: string; replay: string; request: string;
  full: string; tail: string }): void {
  assert.equal(JSON.stringify(body), baseline.raw);
  const again = deriveBoxCallFingerprint(3n, body);
  assert.equal(again.replayFingerprint, baseline.replay);
  assert.equal(again.requestHash, baseline.request);
  assert.equal(deriveBoxContextHash(body), baseline.full);
  assert.equal(deriveBoxContextHash(body, true), baseline.tail);
}

test("temp journal tables on one connection are pg_temp", { skip: !allowed }, async () => {
  await withDb(async ({ client, query }) => {
    await query("SELECT 1 FROM request_finalize_journal WHERE false");
    await query("SELECT 1 FROM usage_records WHERE false");
    const names = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname IN ('request_finalize_journal','usage_records')
          AND n.nspname = ANY (current_schemas(true))`);
    assert.ok(names.rows.length >= 2);
    assert.ok(names.rows.every((row) => row.nspname.startsWith("pg_temp")));
  });
});

test("raw stored-full claim keeps digests, capsule and same-body fingerprint", { skip: !allowed }, async () => {
  await withDb(async (handle) => {
    const tools = [editTool()];
    const assistant = [{ type: "tool_use", id: "toolu_raw", name: "Edit", input: plain,
      caller: { type: "direct" } }];
    const seeded = await seed(handle, "raw", tools, assistant,
      [{ id: "toolu_raw", input: plain }], [{ id: "toolu_raw", text: "ok" }]);
    const claimed = await handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: seeded.body });
    assert.equal(claimed.ownerRequestId, seeded.owner);
    assert.equal(resultText(claimed.results[0]?.content), "ok");
    assert.equal(claimed.results.length, 1);
    sameBody(seeded.body, seeded.baseline);
    await keptDigests(handle.client, seeded.owner, seeded.hashes, [hashBoxToolInput(plain)]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: seeded.body,
    }), "BOX_CALL_AMBIGUOUS");
    const child = await handle.client.query<{ state: string }>(
      `SELECT ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=$1`,
      [seeded.child]);
    assert.equal(child.rows[0]?.state, "linked");
  });
});

test("alias both directions and a mixed batch claim", { skip: !allowed }, async () => {
  await withDb(async (handle) => {
    const tools = [editTool()];
    const omitStored = [{ type: "tool_use", id: "toolu_omit", name: "Edit", input: plain }];
    const omitBody = await seed(handle, "omit", tools, omitStored,
      [{ id: "toolu_omit", input: plain }], [{ id: "toolu_omit", text: "ok" }]);
    const session = JSON.parse(String(omitBody.body.metadata!.user_id));
    const rebuilt = bodyOf(session.session_id, session.oc_turn_key, tools,
      [{ type: "tool_use", id: "toolu_omit", name: "Edit", input: explicit }],
      [{ id: "toolu_omit", text: "ok" }]);
    const baseline = { raw: JSON.stringify(rebuilt),
      replay: deriveBoxCallFingerprint(3n, rebuilt).replayFingerprint,
      request: deriveBoxCallFingerprint(3n, rebuilt).requestHash,
      full: deriveBoxContextHash(rebuilt), tail: deriveBoxContextHash(rebuilt, true) };
    assert.equal(baseline.tail, omitBody.baseline.tail);
    assert.notEqual(hashBoxToolInput(explicit), hashBoxToolInput(plain));
    const claimed = await handle.journal.claimToolResume({
      requestId: omitBody.child, uid: 3n, canonicalModel: model, canonicalBody: rebuilt });
    assert.equal(resultText(claimed.results[0]?.content), "ok");
    sameBody(rebuilt, baseline);
    await keptDigests(handle.client, omitBody.owner, omitBody.hashes, [hashBoxToolInput(plain)]);

    const falseStored = [{ type: "tool_use", id: "toolu_false", name: "Edit", input: explicit }];
    const falseSeed = await seed(handle, "false", tools, falseStored,
      [{ id: "toolu_false", input: explicit }], [{ id: "toolu_false", text: "ok" }]);
    const back = JSON.parse(String(falseSeed.body.metadata!.user_id));
    const omitted = bodyOf(back.session_id, back.oc_turn_key, tools,
      [{ type: "tool_use", id: "toolu_false", name: "Edit", input: plain }],
      [{ id: "toolu_false", text: "ok" }]);
    const claimedBack = await handle.journal.claimToolResume({
      requestId: falseSeed.child, uid: 3n, canonicalModel: model, canonicalBody: omitted });
    assert.equal(resultText(claimedBack.results[0]?.content), "ok");
    await keptDigests(handle.client, falseSeed.owner, falseSeed.hashes, [hashBoxToolInput(explicit)]);

    const mixedStored = [
      { type: "text", text: "keep" },
      { type: "tool_use", id: "toolu_mixa", name: "Edit", input: plain },
      { type: "tool_use", id: "toolu_mixb", name: "Edit", input: explicit },
    ];
    const mixed = await seed(handle, "mix", tools, mixedStored, [
      { id: "toolu_mixa", input: plain }, { id: "toolu_mixb", input: explicit },
    ], [{ id: "toolu_mixa", text: "a" }, { id: "toolu_mixb", text: "b" }]);
    const who = JSON.parse(String(mixed.body.metadata!.user_id));
    const mixedBody = bodyOf(who.session_id, who.oc_turn_key, tools, [
      { type: "text", text: "keep" },
      { type: "tool_use", id: "toolu_mixa", name: "Edit", input: explicit },
      { type: "tool_use", id: "toolu_mixb", name: "Edit", input: plain },
    ], [{ id: "toolu_mixa", text: "a" }, { id: "toolu_mixb", text: "b" }]);
    const mixedClaim = await handle.journal.claimToolResume({
      requestId: mixed.child, uid: 3n, canonicalModel: model, canonicalBody: mixedBody });
    assert.deepEqual(mixedClaim.results.map((item) => resultText(item.content)), ["a", "b"]);
    await keptDigests(handle.client, mixed.owner, mixed.hashes,
      [hashBoxToolInput(plain), hashBoxToolInput(explicit)]);
  });
});

test("stored noCaller echo claims and a changed caller does not advance", { skip: !allowed }, async () => {
  await withDb(async (handle) => {
    const tools = [editTool()];
    const stored = [{ type: "tool_use", id: "toolu_caller", name: "Edit", input: plain,
      caller: { type: "direct" }, provider_meta: "keep" }];
    const hashes = storedHashes(stored);
    const echoed = [{ type: "tool_use", id: "toolu_caller", name: "Edit", input: plain,
      provider_meta: "keep" }];
    assert.equal(hashBoxAssistantContent(echoed), hashes.assistantNoCallerHash);
    assert.notEqual(hashBoxAssistantContent(echoed), hashes.assistantContentHash);
    assert.notEqual(hashBoxAssistantContent(echoed), hashes.assistantEchoHash);
    const seeded = await seed(handle, "nocaller", tools, stored,
      [{ id: "toolu_caller", input: plain }], [{ id: "toolu_caller", text: "ok" }]);
    const who = JSON.parse(String(seeded.body.metadata!.user_id));
    const changed = bodyOf(who.session_id, who.oc_turn_key, tools,
      [{ ...echoed[0], caller: { type: "tampered" } }], [{ id: "toolu_caller", text: "ok" }]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: changed }),
    "BOX_TOOL_ASSISTANT_CHANGED");
    await parked(handle.client, seeded.owner, seeded.child);
    const added = bodyOf(who.session_id, who.oc_turn_key, tools,
      [{ type: "tool_use", id: "toolu_caller", name: "Edit", input: explicit,
        caller: { type: "added" }, provider_meta: "keep" }],
      [{ id: "toolu_caller", text: "ok" }]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: added }),
    "BOX_TOOL_ASSISTANT_CHANGED");
    await parked(handle.client, seeded.owner, seeded.child);
    const accepted = bodyOf(who.session_id, who.oc_turn_key, tools, echoed,
      [{ id: "toolu_caller", text: "ok" }]);
    const claimed = await handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: accepted });
    assert.equal(resultText(claimed.results[0]?.content), "ok");
    await keptDigests(handle.client, seeded.owner, hashes, [hashBoxToolInput(plain)]);
  });
});

test("stored echo claims; signature, redacted and text changes do not advance", { skip: !allowed }, async () => {
  await withDb(async (handle) => {
    const tools = [editTool()];
    const stored = [
      { type: "thinking", thinking: "note", signature: "sig-a" },
      { type: "tool_use", id: "toolu_echo", name: "Edit", input: plain, caller: { type: "direct" } },
    ];
    const hashes = storedHashes(stored);
    const echoed = [{ type: "tool_use", id: "toolu_echo", name: "Edit", input: explicit }];
    const selected = [{ type: "tool_use", id: "toolu_echo", name: "Edit", input: plain }];
    assert.equal(hashBoxAssistantContent(selected), hashes.assistantEchoHash);
    assert.notEqual(hashBoxAssistantContent(selected), hashes.assistantContentHash);
    assert.notEqual(hashBoxAssistantContent(selected), hashes.assistantNoCallerHash);
    const seeded = await seed(handle, "echo", tools, stored,
      [{ id: "toolu_echo", input: plain }], [{ id: "toolu_echo", text: "ok" }]);
    const who = JSON.parse(String(seeded.body.metadata!.user_id));
    const signed = bodyOf(who.session_id, who.oc_turn_key, tools, [
      { type: "thinking", thinking: "note", signature: "sig-b" },
      { type: "tool_use", id: "toolu_echo", name: "Edit", input: plain, caller: { type: "direct" } },
    ], [{ id: "toolu_echo", text: "ok" }]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: signed }),
    "BOX_TOOL_ASSISTANT_CHANGED");
    const redacted = bodyOf(who.session_id, who.oc_turn_key, tools, [
      { type: "redacted_thinking", data: "opaque" }, ...echoed,
    ], [{ id: "toolu_echo", text: "ok" }]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: redacted }),
    "BOX_TOOL_ASSISTANT_CHANGED");
    const text = bodyOf(who.session_id, who.oc_turn_key, tools, [
      { type: "text", text: "changed" }, ...stored.slice(1),
    ], [{ id: "toolu_echo", text: "ok" }]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: text }),
    "BOX_TOOL_ASSISTANT_CHANGED");
    await parked(handle.client, seeded.owner, seeded.child);
    const accepted = bodyOf(who.session_id, who.oc_turn_key, tools, echoed,
      [{ id: "toolu_echo", text: "ok" }]);
    const claimed = await handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: accepted });
    assert.equal(resultText(claimed.results[0]?.content), "ok");
    await keptDigests(handle.client, seeded.owner, hashes, [hashBoxToolInput(plain)]);
  });
});

test("true, unknown key and wrong id order fail closed", { skip: !allowed }, async () => {
  await withDb(async (handle) => {
    const tools = [editTool()];
    const stored = [
      { type: "tool_use", id: "toolu_ord1", name: "Edit", input: plain },
      { type: "tool_use", id: "toolu_ord2", name: "Edit", input: explicit },
    ];
    const seeded = await seed(handle, "neg", tools, stored, [
      { id: "toolu_ord1", input: plain }, { id: "toolu_ord2", input: explicit },
    ], [{ id: "toolu_ord1", text: "a" }, { id: "toolu_ord2", text: "b" }]);
    const who = JSON.parse(String(seeded.body.metadata!.user_id));
    const truthy = bodyOf(who.session_id, who.oc_turn_key, tools, [
      { type: "tool_use", id: "toolu_ord1", name: "Edit", input: { ...plain, replace_all: true } },
      stored[1],
    ], [{ id: "toolu_ord1", text: "a" }, { id: "toolu_ord2", text: "b" }]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: truthy }),
    "BOX_TOOL_RESULT_MISMATCH");
    const extra = bodyOf(who.session_id, who.oc_turn_key, tools, [
      { type: "tool_use", id: "toolu_ord1", name: "Edit", input: { ...explicit, extra: true } },
      stored[1],
    ], [{ id: "toolu_ord1", text: "a" }, { id: "toolu_ord2", text: "b" }]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: extra }),
    "BOX_TOOL_RESULT_MISMATCH");
    const swapped = bodyOf(who.session_id, who.oc_turn_key, tools, [stored[1], stored[0]],
      [{ id: "toolu_ord2", text: "b" }, { id: "toolu_ord1", text: "a" }]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: swapped }),
    "BOX_TOOL_RESULT_MISMATCH");
    await parked(handle.client, seeded.owner, seeded.child);
  });
});

test("catalog type, default and required changes reject before assistant compare", { skip: !allowed }, async () => {
  await withDb(async (handle) => {
    const tools = [editTool()];
    const stored = [{ type: "tool_use", id: "toolu_cat", name: "Edit", input: plain,
      caller: { type: "direct" } }];
    const seeded = await seed(handle, "cat", tools, stored,
      [{ id: "toolu_cat", input: plain }], [{ id: "toolu_cat", text: "ok" }]);
    const who = JSON.parse(String(seeded.body.metadata!.user_id));
    const tamperedAssistant = [{ type: "tool_use", id: "toolu_cat", name: "Edit", input: explicit,
      caller: { type: "tampered" } }];
    const changedType = structuredClone(editSchema);
    (changedType.properties.replace_all as { type: string }).type = "string";
    const changedDefault = structuredClone(editSchema);
    (changedDefault.properties.replace_all as { default: unknown }).default = true;
    const required = structuredClone(editSchema);
    required.required = [...editSchema.required, "replace_all"];
    for (const schema of [changedType, changedDefault, required]) {
      const next = bodyOf(who.session_id, who.oc_turn_key, [editTool(schema)], tamperedAssistant,
        [{ id: "toolu_cat", text: "ok" }]);
      await expectCode(() => handle.journal.claimToolResume({
        requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: next }),
      "BOX_TOOL_CATALOG_CHANGED");
      await parked(handle.client, seeded.owner, seeded.child);
    }
  });
});

test("next handoff and claim continue the client history context", { skip: !allowed }, async () => {
  await withDb(async (handle) => {
    const tools = [editTool()];
    const catalog = compileBoxToolCatalog(tools);
    const assistant = [{ type: "tool_use", id: "toolu_cont", name: "Edit", input: explicit }];
    const seeded = await seed(handle, "cont", tools, assistant,
      [{ id: "toolu_cont", input: explicit }], [{ id: "toolu_cont", text: "ok" }]);
    const first = await handle.journal.claimToolResume({
      requestId: seeded.child, uid: 3n, canonicalModel: model, canonicalBody: seeded.body });
    assert.equal(resultText(first.results[0]?.content), "ok");
    sameBody(seeded.body, seeded.baseline);
    const linked = await handle.client.query<{ hash: string }>(
      `SELECT ctx->>'boxContextHash' AS hash FROM request_finalize_journal WHERE request_id=$1`,
      [seeded.child]);
    assert.equal(linked.rows[0]?.hash, seeded.baseline.full);
    await handle.client.query(`UPDATE request_finalize_journal
      SET ctx=ctx || '{"boxLaunchPermit":true}'::jsonb WHERE request_id=$1`, [seeded.owner]);
    const nextInput = { file_path: "/tmp/ocv5-edit-default/next.txt", old_string: "A",
      new_string: "B", replace_all: false as const };
    const nextContent = [{ type: "tool_use", id: "toolu_next", name: "Edit", input: nextInput }];
    const nextHash = storedHashes(nextContent);
    await handle.journal.recordToolHandoff({
      requestId: seeded.child, uid: 3n, leaseEpoch: epoch, roundNo: 2, spoolOffset: 80,
      detachedRunnerHash: runner, catalogHash: catalog.bindingSha256,
      verifiedPendingToolUseIds: ["toolu_next"],
      candidate: { messageId: "msg_next_cont", toolUses: [{ id: "toolu_next",
        boxName: "mcp__ocbridge__t0", clientName: "Edit", input: nextInput }],
        ...nextHash, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const grandId = `gr-${seeded.child.slice(-12)}`;
    const billing = (await handle.client.query<{ ctx: { boxBillingContext: unknown;
      billingPricing: unknown } }>(
      "SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [seeded.child])).rows[0]!.ctx;
    await handle.client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb)`, [grandId, JSON.stringify({
      model, boxInvocationRecovery: "v1", billingPricing: billing.billingPricing,
      boxBillingContext: billing.boxBillingContext })]);
    const who = JSON.parse(String(seeded.body.metadata!.user_id));
    const nextBody = bodyOf(who.session_id, who.oc_turn_key, tools, nextContent,
      [{ id: "toolu_next", text: "next-ok" }]);
    nextBody.messages = [...seeded.body.messages, ...nextBody.messages.slice(1)];
    const broken = "b".repeat(64);
    await handle.client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxContextHash}',to_jsonb($2::text)) WHERE request_id=$1`,
    [seeded.child, broken]);
    await expectCode(() => handle.journal.claimToolResume({
      requestId: grandId, uid: 3n, canonicalModel: model, canonicalBody: nextBody }),
    "BOX_TOOL_CONTEXT_CHANGED");
    const still = await handle.client.query<{ state: string; has: boolean }>(
      `SELECT ctx->>'boxState' AS state, ctx ? 'boxState' AS has
         FROM request_finalize_journal WHERE request_id=$1`, [grandId]);
    assert.equal(still.rows[0]?.has, false);
    const ownerStill = await handle.client.query<{ state: string }>(
      `SELECT ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=$1`,
      [seeded.child]);
    assert.equal(ownerStill.rows[0]?.state, "handoff");
    await handle.client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxContextHash}',to_jsonb($2::text)) WHERE request_id=$1`,
    [seeded.child, seeded.baseline.full]);
    const second = await handle.journal.claimToolResume({
      requestId: grandId, uid: 3n, canonicalModel: model, canonicalBody: nextBody });
    assert.equal(second.ownerRequestId, seeded.child);
    assert.equal(resultText(second.results[0]?.content), "next-ok");
    assert.equal(second.roundNo, 3);
    const original = await handle.client.query<{ hash: string }>(
      `SELECT ctx->'boxToolHandoff'->>'assistantContentHash' AS hash
         FROM request_finalize_journal WHERE request_id=$1`, [seeded.owner]);
    assert.equal(original.rows[0]?.hash, seeded.hashes.assistantContentHash);
    const secondKept = await handle.client.query<{ hash: string }>(
      `SELECT ctx->'boxToolHandoff'->'toolUses'->0->>'inputHash' AS hash
         FROM request_finalize_journal WHERE request_id=$1`, [seeded.child]);
    assert.equal(secondKept.rows[0]?.hash, hashBoxToolInput(nextInput));
  });
});
