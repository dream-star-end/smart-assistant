/** OCV5-313: markRunExpiredUnproven on real PostgreSQL. Session-local TEMP
 * tables shadow the real ones on one pinned connection (same technique as
 * boxDurableJournal.integ.test.ts); no shared row is touched. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { prepareBoxContinuation } from "./boxPreparedContinuation.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxContextHash, hashBoxAssistantContent, hashBoxAssistantEchoContent,
  hashBoxAssistantNoCallerContent } from "./boxCallFingerprint.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;
const MODEL = "box-api-claude-opus-5-5";
const RUNNER = "c".repeat(64), CATALOG = "d".repeat(64), EPOCH = "9".repeat(32);
const OLD = "5 hours", FRESH = "1 minute";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const code = (expected: string) => (error: unknown) =>
  error instanceof BoxDurableJournalError && error.code === expected;

function handoffOf(roundNo: number, id: string, extra: Record<string, unknown> = {}) {
  return { version: 1, roundNo, messageId: `msg_${id}`, assistantContentHash: "e".repeat(64),
    spoolOffset: 8, detachedRunnerHash: RUNNER, catalogHash: CATALOG,
    toolUses: [{ id: `toolu_${id}`, boxName: "mcp__ocbridge__t0", clientName: "Note",
      inputHash: "f".repeat(64) }],
    verifiedPendingToolUseIds: [`toolu_${id}`],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...extra };
}

async function withDb(fn: (db: {
  client: PoolClient; journal: BoxDurableJournal;
  put(id: string, state: string, ctx: Record<string, unknown>, age: string,
    credits?: number | null): Promise<void>;
  /** A resumed chain of `rounds` rows; returns the ids root first, leaf last. */
  chain(name: string, rounds: number, leafState: string, age?: string): Promise<{
    ids: string[]; leaf: string; identity: { requestId: string; uid: bigint; accountId: bigint;
      runNonce: string; leaseEpoch: string; cause: string }; session: string; turn: string }>;
  ctxOf(id: string): Promise<{ state: string; final_credits: string | null;
    failure_code: string | null; ctx: Record<string, unknown> }>;
  patch(id: string, ctx: Record<string, unknown>): Promise<void>;
  snapshot(): Promise<string>;
}) => Promise<void>): Promise<void> {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, final_credits bigint, failure_code text,
      error_msg text, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE TEMP TABLE usage_records (
      request_id text NOT NULL, user_id bigint NOT NULL)`);
    const query = client.query.bind(client);
    const journal = new BoxDurableJournal({ connect: async () => ({ query,
      release: () => {} }), query } as never);
    const put = async (id: string, state: string, ctx: Record<string, unknown>, age: string,
      credits: number | null = null) => { await client.query(
      `INSERT INTO request_finalize_journal
         (request_id,user_id,container_id,state,ctx,final_credits,created_at,updated_at)
       VALUES ($1,3,635,$2,$3::jsonb,$4,NOW()-$5::interval,NOW()-$5::interval)`,
      [id, state, JSON.stringify(ctx), credits, age]); };
    let seq = 0;
    const chain = async (name: string, rounds: number, leafState: string, age = OLD) => {
      const nonce = randomBytes(12).toString("hex");
      const session = `sess-${name}-${++seq}`, turn = randomBytes(32).toString("hex");
      const base = { model: MODEL, boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool",
        boxAccountId: "20", boxRunNonce: nonce, boxLeaseEpoch: EPOCH, boxSessionId: session,
        boxTurnKey: turn, boxCatalogHash: CATALOG, boxDetachedRunnerHash: RUNNER };
      const ids = Array.from({ length: rounds }, (_, i) => `${name}-r${i + 1}`);
      for (let i = 0; i < rounds; i++) {
        const round = i + 1, last = round === rounds;
        const link = round === 1 ? { boxLaunchPermit: true } : { boxOwnerRequestId: ids[i - 1],
          boxRoundNo: round, boxParentResumeRevision: uuid(round - 1) };
        if (last) {
          await put(ids[i]!, "inflight", { ...base, ...link, boxState: leafState,
            ...(leafState === "unknown" ? { boxUnknownPhase: "continuation_unknown" } : {}) }, age);
        } else {
          await put(ids[i]!, "committed", { ...base, ...link, boxState: "resuming",
            boxToolHandoff: handoffOf(round, `${name}${round}`),
            boxHandoffRevision: uuid(100 + round), boxResumeRequestId: ids[i + 1],
            boxResumeRevision: uuid(round) }, age, 8);
        }
      }
      return { ids, leaf: ids.at(-1)!, session, turn, identity: { requestId: ids.at(-1)!, uid: 3n,
        accountId: 20n, runNonce: nonce, leaseEpoch: EPOCH, cause: "BOX_ACCOUNT_UNAVAILABLE" } };
    };
    const ctxOf = async (id: string) => (await client.query<{ state: string;
      final_credits: string | null; failure_code: string | null; ctx: Record<string, unknown> }>(
      `SELECT state,final_credits::text AS final_credits,failure_code,ctx
         FROM request_finalize_journal WHERE request_id=$1`, [id])).rows[0]!;
    const patch = async (id: string, ctx: Record<string, unknown>) => { await client.query(
      `UPDATE request_finalize_journal SET ctx=ctx || $2::jsonb WHERE request_id=$1`,
      [id, JSON.stringify(ctx)]); };
    const snapshot = async () => JSON.stringify((await client.query(
      `SELECT request_id,state,final_credits,failure_code,ctx::text AS ctx
         FROM request_finalize_journal ORDER BY request_id`)).rows);
    await fn({ client, journal, put, chain, ctxOf, patch, snapshot });
  } finally { client.release(); await pool.end(); }
}

test("an expired linked chain closes once: unbilled leaf aborted, waiting ancestors released",
  { skip: !testDatabaseUrl }, async () => withDb(async (db) => {
  for (const leafState of ["unknown", "linked"]) {
    const young = await db.chain(`young-${leafState}`, 2, leafState, FRESH);
    const before = await db.snapshot();
    await assert.rejects(db.journal.markRunExpiredUnproven(young.identity),
      code("BOX_EXPIRED_CLOSE_RUN_NOT_EXPIRED"));
    assert.equal(await db.snapshot(), before, "a run that may still be alive is never closed");

    const run = await db.chain(`exp-${leafState}`, 3, leafState);
    const listed = (await db.journal.listStoppedFailureProbeCandidates(20))
      .find((item) => item.requestId === run.leaf);
    assert.equal(listed?.expired, true);
    assert.equal(listed?.linked, true);
    const held = await db.snapshot();
    assert.deepEqual(await db.journal.markRunExpiredUnproven({ ...run.identity, apply: false }),
      { action: "would_close", shape: "unbilled_leaf", priorBoxState: leafState, ancestors: 2 });
    assert.equal(await db.snapshot(), held, "dry-run runs the same statements and rolls back");

    assert.deepEqual(await db.journal.markRunExpiredUnproven(run.identity),
      { action: "closed", shape: "unbilled_leaf", priorBoxState: leafState, ancestors: 2 });
    const leaf = await db.ctxOf(run.leaf);
    assert.equal(leaf.state, "aborted");
    assert.equal(leaf.final_credits, "0");
    assert.equal(leaf.failure_code, "STREAM_FAILED");
    assert.equal(leaf.ctx.boxState, "expired_unproven");
    assert.equal(leaf.ctx.boxTerminalProof, undefined, "no proof is invented");
    const marker = leaf.ctx.boxExpiredClose as Record<string, unknown>;
    assert.deepEqual({ ...marker, atMs: 0 }, { v: 1, atMs: 0, priorBoxState: leafState,
      cause: "BOX_ACCOUNT_UNAVAILABLE" });
    assert.ok(Math.abs(Number(marker.atMs) - Date.now()) < 60_000);
    for (const id of run.ids.slice(0, -1)) {
      const ancestor = await db.ctxOf(id);
      assert.equal(ancestor.ctx.boxState, "expired_unproven");
      assert.equal(ancestor.state, "committed");
      assert.equal(ancestor.final_credits, "8", "a billed round keeps its settlement");
    }
    assert.equal((await db.journal.listStoppedFailureProbeCandidates(20))
      .some((item) => run.ids.includes(item.requestId)), false);
    assert.deepEqual(await db.journal.readIdleProof({ uid: 3n, containerId: 635n,
      sessionId: run.session, turnKey: run.turn }),
    { status: "failed", sessionId: run.session, turnKey: run.turn, requestIds: [...run.ids].sort() });

    const closed = await db.snapshot();
    assert.deepEqual(await db.journal.markRunExpiredUnproven(run.identity),
      { action: "already_closed", shape: "unbilled_leaf", priorBoxState: leafState, ancestors: 2 });
    // Every late writer of this run loses its own fence and changes nothing.
    const proof = { runNonce: run.identity.runNonce, leaseEpoch: EPOCH, keeperPid: 11, cliPid: 12 };
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const id = { requestId: run.leaf, uid: 3n, leaseEpoch: EPOCH };
    await assert.rejects(db.journal.markUnknown({ ...id, phase: "continuation_unknown" }),
      code("BOX_JOURNAL_UNKNOWN_FENCE_LOST"));
    await assert.rejects(db.journal.completeToolChain({ ...id, usage,
      proof: { ...proof, reason: "worker_complete", revision: 1 } }), BoxDurableJournalError);
    await assert.rejects(db.journal.markToolChainStoppedFailure({ ...id,
      proof: { ...proof, reason: "keeper_stopped", revision: 1 } }), BoxDurableJournalError);
    await assert.rejects(db.journal.recordToolHandoff({ ...id, roundNo: 3, spoolOffset: 16,
      detachedRunnerHash: RUNNER, catalogHash: CATALOG, verifiedPendingToolUseIds: ["toolu_late"],
      candidate: { messageId: "msg_late", toolUses: [{ id: "toolu_late",
        boxName: "mcp__ocbridge__t0", clientName: "Note", input: {} }],
      assistantContentHash: "e".repeat(64), inputTokens: 1, outputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0 } as never }), BoxDurableJournalError);
    assert.equal(await db.journal.recordStaleResumeStop({ requestId: run.leaf, uid: 3n,
      accountId: 20n, runNonce: run.identity.runNonce, leaseEpoch: EPOCH, linked: true,
      phase: "continuation_unknown" }), false);
    assert.equal(await db.journal.claimStoppedFailureProbe({ requestId: run.leaf, uid: 3n,
      accountId: 20n, runNonce: run.identity.runNonce, leaseEpoch: EPOCH, linked: true }), false);
    assert.equal(await db.snapshot(), closed);
  }
}));

test("an expired first round closes from running or unknown; a detached text run too",
  { skip: !testDatabaseUrl }, async () => withDb(async (db) => {
  const proofOf = (nonce: string) => ({ runNonce: nonce, leaseEpoch: EPOCH, keeperPid: 11,
    cliPid: 12 });
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const state of ["running", "unknown"]) {
    const young = await db.chain(`f-young-${state}`, 1, state, FRESH);
    await assert.rejects(db.journal.markRunExpiredUnproven(young.identity),
      code("BOX_EXPIRED_CLOSE_RUN_NOT_EXPIRED"));
    const run = await db.chain(`f-${state}`, 1, state);
    assert.deepEqual(await db.journal.markRunExpiredUnproven(run.identity),
      { action: "closed", shape: "unbilled_leaf", priorBoxState: state, ancestors: 0 });
    const row = await db.ctxOf(run.leaf);
    assert.deepEqual([row.state, row.final_credits, row.failure_code, row.ctx.boxState],
      ["aborted", "0", "STREAM_FAILED", "expired_unproven"]);
    assert.equal((await db.journal.readIdleProof({ uid: 3n, containerId: 635n,
      sessionId: run.session, turnKey: run.turn })).status, "failed");
    const closed = await db.snapshot();
    const id = { requestId: run.leaf, uid: 3n, leaseEpoch: EPOCH };
    await assert.rejects(db.journal.markUnknown({ ...id, phase: "first_round_unknown" }),
      code("BOX_JOURNAL_UNKNOWN_FENCE_LOST"));
    await assert.rejects(db.journal.markRunning(id), code("BOX_JOURNAL_START_FENCE_LOST"));
    await assert.rejects(db.journal.complete({ ...id, usage, proof: {
      ...proofOf(run.identity.runNonce), reason: "worker_complete", revision: 1 } }),
    BoxDurableJournalError);
    await assert.rejects(db.journal.markFirstRoundStoppedFailure({ ...id, proof: {
      ...proofOf(run.identity.runNonce), reason: "keeper_stopped", revision: 1 } }),
    BoxDurableJournalError);
    assert.equal(await db.snapshot(), closed);
  }
  // `linked` is not a first-round state and `running` is not a linked one.
  const wrongFirst = await db.chain("f-linked", 1, "linked");
  await assert.rejects(db.journal.markRunExpiredUnproven(wrongFirst.identity),
    code("BOX_EXPIRED_CLOSE_CHAIN_INVALID"));
  const wrongLinked = await db.chain("l-running", 2, "running");
  await assert.rejects(db.journal.markRunExpiredUnproven(wrongLinked.identity),
    code("BOX_EXPIRED_CLOSE_CHAIN_INVALID"));

  // The durably armed detached text lane shares the stop fence.
  const text = { model: MODEL, boxInvocationRecovery: "v1", boxInvocationMode: "text",
    boxAccountId: "20", boxLeaseEpoch: EPOCH, boxSessionId: "sess-text", boxTurnKey: "ab".repeat(32),
    boxState: "unknown", boxUnknownPhase: "model_outcome_unknown" };
  const armed = "1".repeat(24), unarmed = "2".repeat(24);
  await db.put("text-armed", "inflight", { ...text, boxRunNonce: armed, boxLaunchPermit: true,
    boxUpstreamModel: "claude-opus-5-5", boxDetachedRunnerHash: RUNNER }, OLD);
  await db.put("text-plain", "inflight", { ...text, boxRunNonce: unarmed,
    boxSessionId: "sess-text-2" }, OLD);
  const textId = { uid: 3n, accountId: 20n, leaseEpoch: EPOCH, cause: "BOX_EXEC_REMOTE_EXIT" };
  assert.deepEqual(await db.journal.markRunExpiredUnproven({ ...textId, requestId: "text-armed",
    runNonce: armed }), { action: "closed", shape: "unbilled_leaf", priorBoxState: "unknown",
    ancestors: 0 });
  const before = await db.snapshot();
  await assert.rejects(db.journal.markRunExpiredUnproven({ ...textId, requestId: "text-plain",
    runNonce: unarmed }), code("BOX_EXPIRED_CLOSE_CHAIN_INVALID"));
  assert.equal(await db.snapshot(), before);
}));

test("a billed handoff nobody answered closes without touching its settlement and can no longer be resumed",
  { skip: !testDatabaseUrl }, async () => withDb(async (db) => {
  const tools = [{ name: "Note", description: "note",
    input_schema: { type: "object", properties: { file_path: { type: "string" } } } }];
  const catalog = compileBoxToolCatalog(tools);
  const assistant = [{ type: "tool_use", id: "toolu_exp_claim", name: "Note",
    input: { file_path: "a.md" } }];
  const pricing = { v: 1, modelId: MODEL, displayName: "Opus", inputPerMtok: "1",
    outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" };
  const owner = async (name: string, age: string) => {
    const session = `sess-${name}`, turn = randomBytes(32).toString("hex");
    const nonce = randomBytes(12).toString("hex");
    const body = { model: MODEL, stream: true, max_tokens: 128, tools, messages: [
      { role: "user", content: "look" }, { role: "assistant", content: assistant },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_exp_claim",
        content: "note-bytes" }] },
      { role: "system", content: [{ type: "text",
        text: "<total_tokens>100 tokens left</total_tokens>",
        cache_control: { type: "ephemeral" } }] }],
    metadata: { user_id: JSON.stringify({ session_id: session, oc_turn_key: turn }) } } as ProxyBody;
    const billing = { v: 1, sessionId: session, mode: "chat", parentSessionId: null,
      delegateAgentId: null, turnKey: turn, parentTurnKey: null, authority: null,
      dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null };
    await db.put(`${name}-owner`, "committed", { model: MODEL, boxInvocationRecovery: "v1",
      boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: nonce,
      boxLeaseEpoch: EPOCH, boxContextHash: deriveBoxContextHash(body, true),
      boxHandoffRevision: uuid(7), boxState: "handoff", boxLaunchPermit: true,
      boxToolHandoff: { ...handoffOf(1, "exp_claim"), detachedRunnerHash: RUNNER,
        catalogHash: catalog.bindingSha256,
        assistantContentHash: hashBoxAssistantContent(assistant),
        assistantNoCallerHash: hashBoxAssistantNoCallerContent(assistant),
        assistantEchoHash: hashBoxAssistantEchoContent(assistant),
        toolUses: [{ id: "toolu_exp_claim", boxName: "mcp__ocbridge__t0", clientName: "Note",
          inputHash: hashBoxToolInput({ file_path: "a.md" }) }] },
      boxCatalogHash: catalog.bindingSha256, boxDetachedRunnerHash: RUNNER,
      boxSessionId: session, boxTurnKey: turn, billingPricing: pricing,
      boxBillingContext: billing }, age, 8);
    await db.put(`${name}-child`, "inflight", { model: MODEL, boxInvocationRecovery: "v1",
      billingPricing: pricing, boxBillingContext: billing }, FRESH);
    const claim = () => db.journal.claimToolResume({ requestId: `${name}-child`, uid: 3n,
      canonicalModel: MODEL, canonicalBody: body, prepared: prepareBoxContinuation({ uid: 3n,
        canonicalModel: MODEL, rawBody: body, authorityKind: "local_catalog",
        authorityTurnId: null }) });
    return { nonce, session, turn, claim };
  };
  // Control: the same exchange on a live handoff is claimable.
  const live = await owner("live", FRESH);
  assert.equal((await live.claim()).runNonce, live.nonce);

  const dead = await owner("dead", OLD);
  const waiting = { uid: 3n, sessionId: dead.session, turnKey: dead.turn,
    toolIds: ["toolu_exp_claim"] };
  assert.equal(await db.journal.hasWaitingToolHandoff(waiting), true);
  assert.deepEqual(await db.journal.markRunExpiredUnproven({ requestId: "dead-owner", uid: 3n,
    accountId: 20n, runNonce: dead.nonce, leaseEpoch: EPOCH, cause: "BOX_ACCOUNT_UNAVAILABLE" }),
  { action: "closed", shape: "billed_handoff", priorBoxState: "handoff", ancestors: 0 });
  const row = await db.ctxOf("dead-owner");
  assert.deepEqual([row.state, row.final_credits, row.failure_code, row.ctx.boxState],
    ["committed", "8", null, "expired_unproven"]);
  assert.equal((row.ctx.boxExpiredClose as { priorBoxState: string }).priorBoxState, "handoff");
  assert.equal(await db.journal.hasWaitingToolHandoff(waiting), false);
  const closed = await db.snapshot();
  await assert.rejects(dead.claim(), BoxDurableJournalError);
  assert.equal(await db.snapshot(), closed, "a late tool result cannot resume the closed run");
  assert.equal((await db.journal.readIdleProof({ uid: 3n, containerId: 635n,
    sessionId: dead.session, turnKey: dead.turn })).status, "failed");
}));

test("evidence, settlement and identity that contradict an unproven close refuse it",
  { skip: !testDatabaseUrl }, async () => withDb(async (db) => {
  const refuse = async (name: string, expected: string,
    mutate: (run: Awaited<ReturnType<typeof db.chain>>) => Promise<Partial<{
      runNonce: string; leaseEpoch: string; accountId: bigint; uid: bigint }> | void>) => {
    const run = await db.chain(name, 2, "unknown");
    const override = await mutate(run) ?? {};
    const before = await db.snapshot();
    await assert.rejects(db.journal.markRunExpiredUnproven({ ...run.identity, ...override }),
      code(expected), name);
    assert.equal(await db.snapshot(), before, `${name}: nothing changed`);
  };
  // A proof, a usage row, a resume linkage or a settlement that landed first.
  await refuse("late-proof", "BOX_EXPIRED_CLOSE_EVIDENCE_PRESENT", (run) => db.patch(run.leaf, {
    boxTerminalProof: { reason: "worker_complete", runNonce: run.identity.runNonce,
      leaseEpoch: EPOCH, keeperPid: 1, cliPid: 2, revision: 1 } }));
  await refuse("late-usage", "BOX_EXPIRED_CLOSE_USAGE_CONFLICT", async (run) => {
    await db.client.query("INSERT INTO usage_records(request_id,user_id) VALUES ($1,3)", [run.leaf]);
  });
  await refuse("late-resume", "BOX_EXPIRED_CLOSE_EVIDENCE_PRESENT", (run) =>
    db.patch(run.leaf, { boxResumeRequestId: "someone-else" }));
  await refuse("late-settlement", "BOX_EXPIRED_CLOSE_EVIDENCE_PRESENT", (run) =>
    db.patch(run.leaf, { settlementClaimId: "claim-1" }));
  await refuse("settled-state", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", async (run) => {
    await db.client.query(`UPDATE request_finalize_journal SET state='committed', final_credits=3
      WHERE request_id=$1`, [run.leaf]);
  });
  await refuse("credits-set", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", async (run) => {
    await db.client.query(`UPDATE request_finalize_journal SET final_credits=0
      WHERE request_id=$1`, [run.leaf]);
  });
  await refuse("terminal-leaf", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.leaf, { boxState: "terminal" }));
  // The caller's identity must be the row's.
  await refuse("other-nonce", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", async () =>
    ({ runNonce: "0".repeat(24) }));
  await refuse("other-epoch", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", async () =>
    ({ leaseEpoch: "0".repeat(32) }));
  await refuse("other-account", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", async () =>
    ({ accountId: 25n }));
  await refuse("other-user", "BOX_TOOL_CHAIN_INVALID", async () => ({ uid: 4n }));
  // A corrupt chain is never closed, however old.
  await refuse("round-number", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.leaf, { boxRoundNo: 3 }));
  await refuse("round-one-leaf", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.leaf, { boxRoundNo: 1 }));
  await refuse("catalog-leaf", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.leaf, { boxCatalogHash: "nope" }));
  await refuse("catalog-ancestor", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxToolHandoff: handoffOf(1, "x", { catalogHash: "a".repeat(64) }) }));
  await refuse("runner-ancestor", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxToolHandoff: handoffOf(1, "x", { detachedRunnerHash: "a".repeat(64) }) }));
  await refuse("handoff-round", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxToolHandoff: handoffOf(2, "x") }));
  await refuse("revision-malformed", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", async (run) => {
    await db.patch(run.ids[0]!, { boxResumeRevision: "rev-1" });
    await db.patch(run.leaf, { boxParentResumeRevision: "rev-1" });
  });
  await refuse("revision-mismatch", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.leaf, { boxParentResumeRevision: uuid(77) }));
  await refuse("resume-other-child", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxResumeRequestId: "another-child" }));
  await refuse("ancestor-terminal", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxState: "terminal" }));
  await refuse("ancestor-turn", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxTurnKey: "ef".repeat(32) }));
  await refuse("ancestor-session", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxSessionId: "another-session" }));
  await refuse("ancestor-account", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxAccountId: "25" }));
  await refuse("ancestor-mode", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.ids[0]!, { boxInvocationMode: "text" }));
  await refuse("owner-missing", "BOX_EXPIRED_CLOSE_CHAIN_INVALID", (run) =>
    db.patch(run.leaf, { boxOwnerRequestId: "no-such-row" }));
  await assert.rejects(db.journal.markRunExpiredUnproven({ requestId: "x", uid: 3n, accountId: 20n,
    runNonce: "a".repeat(24), leaseEpoch: EPOCH, cause: "free text!" }),
  code("BOX_EXPIRED_CLOSE_IDENTITY_INVALID"));
}));

test("the operator's unreachable close converts only with its exact marker and only for the operator",
  { skip: !testDatabaseUrl }, async () => withDb(async (db) => {
  const operatorMarker = (prior: string) => ({ v: 1, ticket: "OCV5-312", atMs: 1791096241420,
    priorBoxState: prior, accountStatus: "disabled", terminalProof: false, remoteCleanup: false });
  const closedByOperator = async (name: string, marker: unknown) => {
    const run = await db.chain(name, 2, "unknown");
    await db.patch(run.leaf, { boxState: "operator_unreachable_closed",
      boxOperatorUnreachableClose: marker });
    return run;
  };
  // The cleanup worker never passes operatorClosed.
  const worker = await closedByOperator("op-worker", operatorMarker("unknown"));
  const before = await db.snapshot();
  await assert.rejects(db.journal.markRunExpiredUnproven(worker.identity),
    code("BOX_EXPIRED_CLOSE_CHAIN_INVALID"));
  for (const [name, marker] of Object.entries({
    missing: undefined, extra: { ...operatorMarker("unknown"), note: "x" },
    proofClaimed: { ...operatorMarker("unknown"), terminalProof: true },
    enabledAccount: { ...operatorMarker("unknown"), accountStatus: "active" },
    priorTerminal: operatorMarker("terminal"), badTicket: { ...operatorMarker("unknown"), ticket: "x" },
  })) {
    const bad = await closedByOperator(`op-bad-${name}`, marker);
    await assert.rejects(db.journal.markRunExpiredUnproven({ ...bad.identity, cause: "operator",
      operatorClosed: true }), code("BOX_EXPIRED_CLOSE_CHAIN_INVALID"), name);
  }
  // A live leaf carrying a stray operator marker is not accepted either.
  const stray = await db.chain("op-stray", 2, "unknown");
  await db.patch(stray.leaf, { boxOperatorUnreachableClose: operatorMarker("unknown") });
  await assert.rejects(db.journal.markRunExpiredUnproven({ ...stray.identity,
    operatorClosed: true }), code("BOX_EXPIRED_CLOSE_CHAIN_INVALID"));

  const leaf = await closedByOperator("op-leaf", operatorMarker("unknown"));
  assert.equal((await db.journal.readIdleProof({ uid: 3n, containerId: 635n,
    sessionId: leaf.session, turnKey: leaf.turn })).status, "pending",
  "the operator state alone is not a failure shape");
  assert.deepEqual(await db.journal.markRunExpiredUnproven({ ...leaf.identity, cause: "operator",
    operatorClosed: true }), { action: "closed", shape: "unbilled_leaf", priorBoxState: "unknown",
    ancestors: 1 });
  const row = await db.ctxOf(leaf.leaf);
  assert.deepEqual([row.state, row.final_credits, row.ctx.boxState], ["aborted", "0",
    "expired_unproven"]);
  assert.deepEqual(row.ctx.boxOperatorUnreachableClose, operatorMarker("unknown"),
    "the operator's audit marker is kept");
  assert.deepEqual({ ...(row.ctx.boxExpiredClose as object), atMs: 0 },
    { v: 1, atMs: 0, priorBoxState: "unknown", cause: "operator" });
  assert.equal((await db.ctxOf(leaf.ids[0]!)).ctx.boxState, "expired_unproven");
  assert.equal((await db.journal.readIdleProof({ uid: 3n, containerId: 635n,
    sessionId: leaf.session, turnKey: leaf.turn })).status, "failed");

  // Billed handoff shape (0146534c… / a4c35ef6…): a committed first round.
  const handoff = await db.chain("op-handoff", 1, "unknown");
  await db.client.query(`UPDATE request_finalize_journal SET state='committed', final_credits=8
    WHERE request_id=$1`, [handoff.leaf]);
  await db.patch(handoff.leaf, { boxState: "operator_unreachable_closed",
    boxToolHandoff: handoffOf(1, "oph"), boxHandoffRevision: uuid(9),
    boxOperatorUnreachableClose: operatorMarker("handoff") });
  assert.deepEqual(await db.journal.markRunExpiredUnproven({ ...handoff.identity,
    cause: "operator", operatorClosed: true }), { action: "closed", shape: "billed_handoff",
    priorBoxState: "handoff", ancestors: 0 });
  const billed = await db.ctxOf(handoff.leaf);
  assert.deepEqual([billed.state, billed.final_credits, billed.ctx.boxState],
    ["committed", "8", "expired_unproven"]);
  void before;
}));

test("a closed run stops blocking the other turns of its session",
  { skip: !testDatabaseUrl }, async () => withDb(async (db) => {
  const stuck = await db.chain("blocker", 2, "unknown");
  const turn = "cd".repeat(32), nonce = "7".repeat(24);
  await db.put("next-turn", "committed", { model: MODEL, boxInvocationRecovery: "v1",
    boxInvocationMode: "detached_tool", boxAccountId: "25", boxRunNonce: nonce,
    boxLeaseEpoch: EPOCH, boxSessionId: stuck.session, boxTurnKey: turn, boxState: "terminal",
    boxTerminalProof: { reason: "worker_complete", runNonce: nonce, leaseEpoch: EPOCH,
      keeperPid: 1, cliPid: 2, revision: 1 },
    boxReplayMessage: { version: 1, sha256: "c".repeat(64) },
    boxUsage: { inputTokens: 10, cacheReadTokens: 0 } }, FRESH, 3);
  const next = () => db.journal.readIdleProof({ uid: 3n, containerId: 635n,
    sessionId: stuck.session, turnKey: turn });
  assert.deepEqual(await next(), { status: "pending", reason: "other_chain" });
  // The OCV5-312 operator state alone already releases the other turns …
  await db.patch(stuck.leaf, { boxState: "operator_unreachable_closed" });
  await db.patch(stuck.ids[0]!, { boxState: "operator_unreachable_closed" });
  assert.equal((await next()).status, "terminal");
  // … and so does the expired close of the whole chain.
  await db.patch(stuck.leaf, { boxState: "unknown" });
  await db.patch(stuck.ids[0]!, { boxState: "resuming" });
  assert.deepEqual(await next(), { status: "pending", reason: "other_chain" });
  await db.journal.markRunExpiredUnproven(stuck.identity);
  assert.equal((await next()).status, "terminal");
}));
