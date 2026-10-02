// OCV5-300: a first round whose stream egress rejected locally and whose CLI
// then finished by itself settles as an unbilled failed_stopped row, so the
// idle projection releases the session instead of wedging it as unknown.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from "./boxDurableJournal.js";
import { projectBoxIdleChain } from "./boxIdleChain.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;

test("rejected first-round stream settles unbilled, idempotently, and only once",
  { skip: !testDatabaseUrl }, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    // Temp tables shadow the real ones on this one pinned connection; the
    // failure_code CHECK mirrors production so an unknown code fails here.
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
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const journal = new BoxDurableJournal({ connect: async () => ({ query: q,
      release: () => {} }), query: q } as never);
    const suffix = randomBytes(6).toString("hex");
    const runNonce = "d".repeat(24), leaseEpoch = "e".repeat(32);
    const sessionId = `session-${suffix}`, turnKey = "a".repeat(64);
    const ctx = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      boxInvocationMode: "detached_tool", boxRunNonce: runNonce, boxLeaseEpoch: leaseEpoch,
      boxAccountId: "20", boxState: "unknown", boxSessionId: sessionId, boxTurnKey: turnKey };
    const put = (id: string, extra: Record<string, unknown> = {}, state = "inflight") =>
      q(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
         VALUES ($1,3,$2,$3::jsonb)`, [id, state, JSON.stringify({ ...ctx, ...extra })]);
    const proof = { runNonce, leaseEpoch, keeperPid: 101, cliPid: 102,
      reason: "worker_complete" as const, revision: 1 as const };
    const rejects = async (requestId: string, code: string, p = proof) => assert.rejects(
      () => journal.markFirstRoundRejectedStream({ requestId, uid: 3n, leaseEpoch, proof: p }),
      (error: unknown) => error instanceof BoxDurableJournalError && error.code === code);

    const id = `box-rej-${suffix}`;
    await put(id);
    await rejects(id, "BOX_REJECTED_STREAM_EVIDENCE_INVALID", { ...proof, runNonce: "zz" });
    await rejects(id, "BOX_REJECTED_STREAM_CHAIN_INVALID", { ...proof, runNonce: "f".repeat(24) });
    await journal.markFirstRoundRejectedStream({ requestId: id, uid: 3n, leaseEpoch, proof });
    const row = (await q(`SELECT state,failure_code,final_credits::int fc,ctx
      FROM request_finalize_journal WHERE request_id=$1`, [id])).rows[0];
    assert.equal(row.state, "aborted");
    assert.equal(row.failure_code, "STREAM_FAILED");
    assert.equal(row.fc, 0);
    assert.equal(row.ctx.boxState, "failed_stopped");
    assert.equal(row.ctx.boxStopOutcome, "rejected_stream");
    assert.deepEqual(row.ctx.boxTerminalProof, proof);
    // idempotent replay; a different proof on the settled row is a lost fence
    await journal.markFirstRoundRejectedStream({ requestId: id, uid: 3n, leaseEpoch, proof });
    await rejects(id, "BOX_REJECTED_STREAM_FENCE_LOST", { ...proof, keeperPid: 999 });
    // the idle projection now releases the session
    assert.equal(projectBoxIdleChain({ sessionId, turnKey,
      rows: [{ requestId: id, state: row.state, ctx: row.ctx }] }).status, "failed");

    const used = `box-used-${suffix}`;
    await put(used);
    await q(`INSERT INTO usage_records VALUES ($1,3)`, [used]);
    await rejects(used, "BOX_REJECTED_STREAM_USAGE_CONFLICT");
    const handed = `box-hand-${suffix}`;
    await put(handed, { boxToolHandoff: { roundNo: 1 } });
    await rejects(handed, "BOX_REJECTED_STREAM_CHAIN_INVALID");
    const text = `box-text-${suffix}`;
    await put(text, { boxInvocationMode: "detached_text" });
    await rejects(text, "BOX_REJECTED_STREAM_CHAIN_INVALID");
    const done = `box-done-${suffix}`;
    await put(done, { boxState: "terminal" }, "committed");
    await rejects(done, "BOX_REJECTED_STREAM_FENCE_LOST");
    const states = (await q(`SELECT request_id,state FROM request_finalize_journal
      WHERE request_id <> $1 ORDER BY 1`, [id])).rows.map((r) => r.state);
    assert.deepEqual(states, ["committed", "inflight", "inflight", "inflight"]);
  } finally {
    client.release();
    await pool.end();
  }
});

test("OCV5-306 an unknown linked leaf whose CLI exited by itself settles unbilled and releases the chain",
  { skip: !testDatabaseUrl }, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
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
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const journal = new BoxDurableJournal({ connect: async () => ({ query: q,
      release: () => {} }), query: q } as never);
    const suffix = randomBytes(6).toString("hex");
    const runNonce = "c".repeat(24), leaseEpoch = "b".repeat(32);
    const catalogHash = "1".repeat(64), detachedRunnerHash = "2".repeat(64);
    const rev = "33333333-3333-4333-8333-333333333333";
    const sessionId = `cut-${suffix}`, turnKey = "4".repeat(64);
    const base = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      boxInvocationMode: "detached_tool", boxRunNonce: runNonce, boxLeaseEpoch: leaseEpoch,
      boxAccountId: "20", boxSessionId: sessionId, boxTurnKey: turnKey,
      boxCatalogHash: catalogHash, boxDetachedRunnerHash: detachedRunnerHash };
    const parentId = `box-cut-parent-${suffix}`, leafId = `box-cut-leaf-${suffix}`;
    const handoff = { version: 1, roundNo: 1, messageId: "msg_1", catalogHash, detachedRunnerHash,
      spoolOffset: 10, assistantContentHash: "5".repeat(64), assistantEchoHash: "6".repeat(64),
      assistantNoCallerHash: "7".repeat(64), verifiedPendingToolUseIds: ["toolu_A"],
      usage: { inputTokens: 2, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolUses: [{ id: "toolu_A", boxName: "mcp__ocbridge__Bash", clientName: "Bash",
        inputHash: "8".repeat(64) }] };
    const put = (id: string, state: string, ctx: Record<string, unknown>) =>
      q(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx) VALUES ($1,3,$2,$3::jsonb)`,
        [id, state, JSON.stringify({ ...base, ...ctx })]);
    await put(parentId, "committed", { boxState: "resuming", boxToolHandoff: handoff,
      boxHandoffRevision: "44444444-4444-4444-8444-444444444444", boxRoundNo: 1,
      boxResumeRequestId: leafId, boxResumeRevision: rev });
    await put(leafId, "inflight", { boxState: "unknown", boxRoundNo: 2,
      boxOwnerRequestId: parentId, boxParentResumeRevision: rev });
    const proof = { runNonce, leaseEpoch, keeperPid: 101, cliPid: 102,
      reason: "worker_complete" as const, revision: 1 as const };
    const stop = { requestId: leafId, uid: 3n, leaseEpoch };
    await assert.rejects(() => journal.markToolChainStoppedFailure({ ...stop, proof }),
      (e: unknown) => e instanceof BoxDurableJournalError && e.code === "BOX_FAILED_STOP_EVIDENCE_INVALID",
      "worker_complete needs the explicit rejected-stream close");
    await assert.rejects(() => journal.markToolChainStoppedFailure({ ...stop, rejectedStream: true,
      proof: { ...proof, reason: "keeper_stopped" as never } }),
      (e: unknown) => e instanceof BoxDurableJournalError && e.code === "BOX_FAILED_STOP_EVIDENCE_INVALID");
    await journal.markToolChainStoppedFailure({ ...stop, proof, rejectedStream: true });
    await journal.markToolChainStoppedFailure({ ...stop, proof, rejectedStream: true });
    const rows = (await q(`SELECT request_id,state,failure_code,final_credits::int fc,ctx
      FROM request_finalize_journal WHERE request_id IN ($1,$2)`, [parentId, leafId])).rows;
    const leaf = rows.find((r) => r.request_id === leafId)!, parent = rows.find((r) => r.request_id === parentId)!;
    assert.equal(leaf.state, "aborted");
    assert.equal(leaf.failure_code, "STREAM_FAILED");
    assert.equal(leaf.fc, 0);
    assert.equal(leaf.ctx.boxState, "failed_stopped");
    assert.equal(leaf.ctx.boxStopOutcome, "rejected_stream");
    assert.deepEqual(leaf.ctx.boxTerminalProof, proof);
    assert.equal(parent.state, "committed");
    assert.equal(parent.ctx.boxState, "failed_stopped");
    assert.equal(parent.ctx.boxStopOutcome, "failed");
    assert.equal(projectBoxIdleChain({ sessionId, turnKey, rows: rows.map((r) => ({
      requestId: r.request_id, state: r.state, ctx: r.ctx })) }).status, "failed");
    // the OCV5-304 recovery now sees a proven-stopped exchange it may continue
    const done = "55555555-5555-4555-8555-555555555555";
    await client.query(`CREATE TEMP TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY,
      user_id bigint NOT NULL, status text NOT NULL)`);
    await q(`INSERT INTO turn_dispatches VALUES ($1,3,'terminal')`, [done]);
    await q(`UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object('boxBillingContext',
      jsonb_build_object('v',1,'sessionId','web','mode','chat','parentSessionId',null,'delegateAgentId',null,
      'turnKey',$2::text,'parentTurnKey',null,'authority',null,'dispatchId',$3::text,'attemptNo',1,
      'verificationSponsorship',null,'apiKeyId',null)) WHERE request_id=$1`, [parentId, turnKey, done]);
    const orphan = await journal.findOrphanToolHandoff({ uid: 3n, sessionId, turnKey: "f".repeat(64),
      toolIds: ["toolu_A"] });
    assert.equal(orphan.kind === "orphan" && orphan.stopped, true);
    // a live (non-unknown) leaf is never closed this way
    const liveParent = `box-live-parent-${suffix}`, liveLeaf = `box-live-leaf-${suffix}`;
    await put(liveParent, "committed", { boxState: "resuming", boxToolHandoff: handoff,
      boxHandoffRevision: "66666666-6666-4666-8666-666666666666", boxRoundNo: 1,
      boxResumeRequestId: liveLeaf, boxResumeRevision: rev, boxRunNonce: "d".repeat(24) });
    await put(liveLeaf, "inflight", { boxState: "linked", boxRoundNo: 2, boxRunNonce: "d".repeat(24),
      boxOwnerRequestId: liveParent, boxParentResumeRevision: rev });
    await assert.rejects(() => journal.markToolChainStoppedFailure({ requestId: liveLeaf, uid: 3n,
      leaseEpoch, rejectedStream: true, proof: { ...proof, runNonce: "d".repeat(24) } }),
    (e: unknown) => e instanceof BoxDurableJournalError && e.code === "BOX_FAILED_STOP_CHAIN_INVALID");
  } finally {
    client.release();
    await pool.end();
  }
});
