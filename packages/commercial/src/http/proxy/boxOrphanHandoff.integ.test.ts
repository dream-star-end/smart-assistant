// OCV5-304: identify the handoff of a finished dispatch that a recovered
// dispatch's tool results were meant for.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";

const url = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

async function stoppedRecoveryFixture() {
  const schema = `box_stale_recovery_${randomBytes(8).toString("hex")}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, max: 4,
    options: `-c search_path=${schema}` });
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await q(`CREATE TABLE request_finalize_journal (request_id text PRIMARY KEY,
    user_id bigint NOT NULL, state text NOT NULL, ctx jsonb NOT NULL,
    updated_at timestamptz DEFAULT now())`);
  await q(`CREATE TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY,
    user_id bigint NOT NULL, status text NOT NULL)`);
  const dispatchId = "11111111-1111-4111-8111-111111111111";
  await q(`INSERT INTO turn_dispatches VALUES ($1,3,'terminal')`, [dispatchId]);
  const parent = { model: "box-api-claude-opus-5-5", boxSessionId: "sess-stale",
    boxTurnKey: "aa".repeat(32), boxState: "failed_stopped", boxAccountId: "20",
    boxRunNonce: "a".repeat(24), boxLeaseEpoch: "b".repeat(32), boxRecoveredBy: "box-holder",
    boxNativeSessionId: "97e7cf80-82f8-42f5-8024-8ce817427990",
    boxBillingContext: { v: 1, sessionId: "web", mode: "chat", parentSessionId: null,
      delegateAgentId: null, turnKey: "aa".repeat(32), parentTurnKey: null, authority: null,
      dispatchId, attemptNo: 1, verificationSponsorship: null, apiKeyId: null },
    boxToolHandoff: { version: 1, roundNo: 1, messageId: "msg_1", catalogHash: "c".repeat(64),
      detachedRunnerHash: "d".repeat(64), spoolOffset: 10, assistantContentHash: "1".repeat(64),
      assistantEchoHash: "2".repeat(64), assistantNoCallerHash: "3".repeat(64),
      verifiedPendingToolUseIds: ["toolu_S"],
      usage: { inputTokens: 2, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolUses: [{ id: "toolu_S", boxName: "mcp__ocbridge__Skill", clientName: "Skill",
        inputHash: "e".repeat(64) }] } };
  const holder = { model: parent.model, boxSessionId: parent.boxSessionId,
    boxTurnKey: "bb".repeat(32), boxState: "failed_stopped", boxStopOutcome: "failed",
    boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool", boxAccountId: "20",
    boxRunNonce: "c".repeat(24), boxLeaseEpoch: "d".repeat(32),
    boxNativeSessionId: "1c920e55-5463-4b73-adf8-302f64e7a925",
    boxCancelIntent: { v: 1, reason: "user_cancel", requestId: "box-holder", atMs: 1 },
    boxBillingContext: { ...parent.boxBillingContext, turnKey: "bb".repeat(32) },
    boxTerminalProof: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
      keeperPid: 100, cliPid: 101, reason: "worker_failed", revision: 2, workerExitCode: 143 } };
  await q(`INSERT INTO request_finalize_journal VALUES
    ('box-parent',3,'committed',$1),('box-holder',3,'aborted',$2)`,
    [JSON.stringify(parent), JSON.stringify(holder)]);
  const journal = new BoxDurableJournal(pool);
  const find = () => journal.findOrphanToolHandoff({ uid: 3n, sessionId: "sess-stale",
    turnKey: "ff".repeat(32), toolIds: ["toolu_S"] });
  return { pool, q, journal, find, parent, holder, dispatchId,
    close: async () => { await pool.end();
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } };
}

test("stopped admitted recovery holder is reclaimable after terminal failure",
  { skip: !url }, async () => {
  const f = await stoppedRecoveryFixture();
  try {
    const found = await f.find();
    assert.equal(found.kind === "orphan" && found.staleClaim, "box-holder");
    assert.equal(await f.journal.claimOrphanRecovery({ requestId: "box-parent", uid: 3n,
      by: "box-next", replacing: "box-holder" }), true);
    assert.equal(await f.journal.claimOrphanRecovery({ requestId: "box-parent", uid: 3n,
      by: "box-other", replacing: "box-holder" }), false);
    const row = await f.q(`SELECT ctx->>'boxRecoveredBy' AS holder
      FROM request_finalize_journal WHERE request_id='box-parent'`);
    assert.equal(row.rows[0].holder, "box-next");
    // A second recovery can itself fail before any delivered handoff; the
    // original exchange must remain recoverable through another replacement.
    await f.q(`INSERT INTO request_finalize_journal VALUES ('box-next',3,'aborted',$1)`,
      [JSON.stringify({ ...f.holder, boxRunNonce: "e".repeat(24), boxLeaseEpoch: "f".repeat(32),
        boxTerminalProof: { runNonce: "e".repeat(24), leaseEpoch: "f".repeat(32),
          keeperPid: 200, cliPid: 201, reason: "keeper_stopped", revision: 1 } })]);
    const next = await f.find();
    assert.equal(next.kind === "orphan" && next.staleClaim, "box-next");
    assert.equal(await f.journal.claimOrphanRecovery({ requestId: "box-parent", uid: 3n,
      by: "box-third", replacing: "box-next" }), true);
  } finally { await f.close(); }
});

test("admitted recovery holders require bound failure proof and no successor",
  { skip: !url }, async () => {
  const f = await stoppedRecoveryFixture();
  try {
    const invalid = [
      { state: "inflight" }, { state: "finalizing" }, { state: "committed" },
      { boxState: "unknown" }, { boxState: "handoff" }, { boxStopOutcome: "rejected_stream" },
      { boxInvocationRecovery: "v0" }, { boxInvocationMode: "text" },
      { model: "box-api-claude-sonnet-5-5" }, { boxSessionId: "other" },
      { boxTerminalProof: null }, { boxTerminalProof: { ...f.holder.boxTerminalProof, revision: 1 } },
      { boxTerminalProof: { ...f.holder.boxTerminalProof, runNonce: "f".repeat(24) } },
      { boxTerminalProof: { ...f.holder.boxTerminalProof, leaseEpoch: "f".repeat(32) } },
      { boxTerminalProof: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
        keeperPid: 100, cliPid: 101, reason: "worker_complete", revision: 1 } },
      { boxToolHandoff: {} }, { boxReplayMessage: {} }, { boxOwnerRequestId: "other" },
      { boxResumeRequestId: "other" }, { boxRecoveredBy: "other" }, { boxBillingContext: {} },
    ];
    for (const change of invalid) {
      const { state = "aborted", ...ctx } = change as Record<string, unknown>;
      await f.q(`UPDATE request_finalize_journal SET state=$1,ctx=$2 WHERE request_id='box-holder'`,
        [state, JSON.stringify({ ...f.holder, ...ctx })]);
      assert.equal((await f.find()).kind, "claimed", JSON.stringify(change));
    }
    await f.q(`UPDATE request_finalize_journal SET state='aborted',ctx=$1 WHERE request_id='box-holder'`,
      [JSON.stringify(f.holder)]);
    await f.q(`UPDATE turn_dispatches SET status='running'`);
    assert.equal((await f.find()).kind, "claimed", "holder dispatch is live");
    await f.q("DELETE FROM turn_dispatches");
    assert.equal((await f.find()).kind, "claimed", "missing dispatch is unknown");
  } finally { await f.close(); }
});

test("stale recovery replacement rechecks the holder after lookup",
  { skip: !url }, async () => {
  const f = await stoppedRecoveryFixture();
  try {
    for (const change of [{ state: "committed" }, { boxToolHandoff: {} }, { boxResumeRequestId: "next" }]) {
      await f.q(`UPDATE request_finalize_journal SET state='aborted',ctx=$1 WHERE request_id='box-holder'`,
        [JSON.stringify(f.holder)]);
      assert.equal((await f.find()).kind, "orphan");
      const { state = "aborted", ...ctx } = change as Record<string, unknown>;
      await f.q(`UPDATE request_finalize_journal SET state=$1,ctx=$2 WHERE request_id='box-holder'`,
        [state, JSON.stringify({ ...f.holder, ...ctx })]);
      assert.equal(await f.journal.claimOrphanRecovery({ requestId: "box-parent", uid: 3n,
        by: "box-next", replacing: "box-holder" }), false, JSON.stringify(change));
    }
  } finally { await f.close(); }
});

test("two recoveries replace a stopped holder with one PostgreSQL CAS winner",
  { skip: !url }, async () => {
  const f = await stoppedRecoveryFixture();
  const clients = await Promise.all([f.pool.connect(), f.pool.connect()]);
  try {
    const pids = await Promise.all(clients.map((client) => client.query("SELECT pg_backend_pid() AS pid")));
    assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid, "independent PostgreSQL sessions");
    const journals = clients.map((client) => {
      const query = client.query.bind(client);
      return new BoxDurableJournal({ query, connect: async () => ({ query, release: () => {} }) } as never);
    });
    const claims = await Promise.all(journals.map((journal, i) => journal.claimOrphanRecovery({
      requestId: "box-parent", uid: 3n, by: `box-contender-${i}`, replacing: "box-holder" })));
    assert.equal(claims.filter(Boolean).length, 1);
    const row = await f.q(`SELECT ctx->>'boxRecoveredBy' AS holder
      FROM request_finalize_journal WHERE request_id='box-parent'`);
    assert.equal(row.rows[0].holder, `box-contender-${claims.indexOf(true)}`);
  } finally { clients.forEach((client) => client.release()); await f.close(); }
});

test("orphan handoff lookup requires same tool ids, another turn and a terminal dispatch",
  { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (request_id text PRIMARY KEY,
      user_id bigint NOT NULL, state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz DEFAULT now())`);
    await client.query(`CREATE TEMP TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY,
      user_id bigint NOT NULL, status text NOT NULL)`);
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const journal = new BoxDurableJournal({ connect: async () => ({ query: q, release: () => {} }), query: q } as never);
    const done = "11111111-1111-4111-8111-111111111111", live = "22222222-2222-4222-8222-222222222222";
    await q(`INSERT INTO turn_dispatches VALUES ($1,3,'terminal'),($2,3,'running')`, [done, live]);
    // Same shape as a live stored handoff (keys verified on production).
    const handoff = (ids: string[]) => ({ version: 1, roundNo: 1, messageId: "msg_1",
      catalogHash: "c".repeat(64), detachedRunnerHash: "d".repeat(64), spoolOffset: 10,
      assistantContentHash: "1".repeat(64), assistantEchoHash: "2".repeat(64),
      assistantNoCallerHash: "3".repeat(64), verifiedPendingToolUseIds: [ids[0]],
      usage: { inputTokens: 2, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolUses: ids.map((id) => ({ id, boxName: "mcp__ocbridge__Skill", clientName: "Skill",
        inputHash: "e".repeat(64) })) });
    const row = (id: string, dispatchId: string, ids: string[], turnKey = "aa".repeat(32), extra = {}) =>
      q(`INSERT INTO request_finalize_journal VALUES ($1,3,'committed',$2::jsonb)`, [id, JSON.stringify({
        boxSessionId: "sess", boxTurnKey: turnKey, boxState: "handoff", boxAccountId: "20",
        boxRunNonce: "a".repeat(24), boxLeaseEpoch: "b".repeat(32), boxToolHandoff: handoff(ids),
        boxBillingContext: { v: 1, sessionId: "web", mode: "chat", parentSessionId: null, delegateAgentId: null,
          turnKey, parentTurnKey: null, authority: null, dispatchId, attemptNo: 1,
          verificationSponsorship: null, apiKeyId: null }, ...extra })]);
    const find = (toolIds: string[], turnKey = "ff".repeat(32)) =>
      journal.findOrphanToolHandoff({ uid: 3n, sessionId: "sess", turnKey, toolIds });
    await row("box-old", done, ["toolu_S"]);
    const hit = await find(["toolu_S"]);
    assert.equal(hit.kind, "orphan");
    if (hit.kind === "orphan") {
      assert.deepEqual(hit.identity, { requestId: "box-old", uid: 3n, accountId: 20n,
        runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) });
    }
    assert.equal((await find(["toolu_S", "toolu_X"])).kind, "none", "different id set");
    assert.equal((await find(["toolu_S"], "aa".repeat(32))).kind, "none", "same turn is the owner path");
    await row("box-live", live, ["toolu_L"]);
    assert.equal((await find(["toolu_L"])).kind, "live", "dispatch still running");
    await row("box-cancel", done, ["toolu_C"], "aa".repeat(32), { boxCancelIntent: true });
    assert.equal((await find(["toolu_C"])).kind, "live", "a Stop in flight is not ours");
    await row("box-stopped", done, ["toolu_F"], "aa".repeat(32), { boxState: "failed_stopped", boxCancelIntent: true });
    const stopped = await find(["toolu_F"]);
    assert.equal(stopped.kind === "orphan" && stopped.stopped, true, "already stopped exchange is recoverable");
    // exactly one recovery claims an exchange; release gives it back
    const claims = await Promise.all([1, 2].map((n) =>
      journal.claimOrphanRecovery({ requestId: "box-old", uid: 3n, by: `box-recover-${n}` })));
    assert.deepEqual(claims.filter(Boolean).length, 1);
    assert.equal((await find(["toolu_S"])).kind, "claimed");
    const winner = claims[0] ? "box-recover-1" : "box-recover-2";
    await journal.releaseOrphanRecovery({ requestId: "box-old", uid: 3n, by: "box-recover-x" });
    assert.equal((await find(["toolu_S"])).kind, "claimed", "only the winner may release");
    await journal.releaseOrphanRecovery({ requestId: "box-old", uid: 3n, by: winner });
    assert.equal((await find(["toolu_S"])).kind, "orphan");
    // a user Stop that lands between find and claim wins (no resurrection)
    const seen = await find(["toolu_S"]);
    assert.equal(seen.kind, "orphan");
    await q(`UPDATE request_finalize_journal SET ctx = ctx || '{"boxCancelIntent":true}'::jsonb WHERE request_id='box-old'`);
    assert.equal(await journal.claimOrphanRecovery({ requestId: "box-old", uid: 3n, by: "box-recover-3" }), false);
    // once that Stop is proven, the exchange may be recovered
    await q(`UPDATE request_finalize_journal SET ctx = ctx || '{"boxState":"failed_stopped"}'::jsonb WHERE request_id='box-old'`);
    assert.equal(await journal.claimOrphanRecovery({ requestId: "box-old", uid: 3n, by: "box-recover-3" }), true);
    // an unknown claimer is never presumed gone
    assert.equal((await find(["toolu_S"])).kind, "claimed");
    // a claimer that ended before any Box admission leaves a stale claim a later recovery takes over
    await q(`INSERT INTO request_finalize_journal VALUES ('box-recover-3',3,'aborted','{}'::jsonb)`);
    const stale = await find(["toolu_S"]);
    assert.equal(stale.kind === "orphan" && stale.staleClaim, "box-recover-3");
    assert.equal(await journal.claimOrphanRecovery({ requestId: "box-old", uid: 3n, by: "box-recover-4" }), false,
      "a stale claim is only replaced by naming it");
    assert.equal(await journal.claimOrphanRecovery({ requestId: "box-old", uid: 3n, by: "box-recover-4",
      replacing: "box-recover-3" }), true);
    // an admitted claimer keeps it
    await q(`INSERT INTO request_finalize_journal VALUES ('box-recover-4',3,'inflight','{"boxState":"running"}'::jsonb)`);
    assert.equal((await find(["toolu_S"])).kind, "claimed");
  } finally { client.release(); await pool.end(); }
});

// OCV5-377: the handoff of this very turn that still waits for exactly these
// results is taken over (claimed, stopped) before an answered exchange runs fresh.
test("waiting handoff lookup returns this turn's waiting run, or live when it cannot be taken over",
  { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (request_id text PRIMARY KEY,
      user_id bigint NOT NULL, state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz DEFAULT now())`);
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const journal = new BoxDurableJournal({ connect: async () => ({ query: q, release: () => {} }), query: q } as never);
    const turn = "aa".repeat(32);
    const handoff = (ids: string[]) => ({ version: 1, roundNo: 1, messageId: "msg_1",
      catalogHash: "c".repeat(64), detachedRunnerHash: "d".repeat(64), spoolOffset: 10,
      assistantContentHash: "1".repeat(64), assistantEchoHash: "2".repeat(64),
      assistantNoCallerHash: "3".repeat(64), verifiedPendingToolUseIds: [ids[0]],
      usage: { inputTokens: 2, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolUses: ids.map((id) => ({ id, boxName: "mcp__ocbridge__t0", clientName: "Read",
        inputHash: "e".repeat(64) })) });
    const row = (id: string, session: string, ids: string[], extra = {}) =>
      q(`INSERT INTO request_finalize_journal VALUES ($1,3,'committed',$2::jsonb)`, [id, JSON.stringify({
        boxSessionId: session, boxTurnKey: turn, boxState: "handoff", boxAccountId: "20",
        boxRunNonce: "a".repeat(24), boxLeaseEpoch: "b".repeat(32), boxToolHandoff: handoff(ids), ...extra })]);
    const find = (session: string, toolIds: string[], turnKey = turn) =>
      journal.findWaitingToolHandoff({ uid: 3n, sessionId: session, turnKey, toolIds });
    await row("box-wait", "s1", ["toolu_1", "toolu_2"]);
    assert.deepEqual(await find("s1", ["toolu_2", "toolu_1"]), { kind: "waiting", identity: {
      requestId: "box-wait", uid: 3n, accountId: 20n, runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) } });
    assert.deepEqual(await find("s1", ["toolu_1"]), { kind: "none" }, "different id set");
    assert.deepEqual(await find("s1", ["toolu_1", "toolu_2"], "ff".repeat(32)), { kind: "none" }, "another turn");
    await row("box-cancel", "s2", ["toolu_3"], { boxCancelIntent: true });
    assert.deepEqual(await find("s2", ["toolu_3"]), { kind: "live" }, "a Stop in flight is not ours");
    await row("box-claimed", "s3", ["toolu_4"], { boxRecoveredBy: "box-other" });
    assert.deepEqual(await find("s3", ["toolu_4"]), { kind: "live" }, "another recovery owns it");
    await row("box-bad", "s4", ["toolu_5"], { boxRunNonce: "short" });
    assert.deepEqual(await find("s4", ["toolu_5"]), { kind: "live" }, "malformed identity");
    await row("box-dup-1", "s5", ["toolu_6"]); await row("box-dup-2", "s5", ["toolu_6"]);
    assert.deepEqual(await find("s5", ["toolu_6"]), { kind: "live" }, "not unique");
    // claimed by this recovery, then proven stopped: nothing waits any more
    assert.equal(await journal.claimOrphanRecovery({ requestId: "box-wait", uid: 3n, by: "box-fresh" }), true);
    assert.deepEqual(await find("s1", ["toolu_1", "toolu_2"]), { kind: "live" });
    await q(`UPDATE request_finalize_journal SET ctx = ctx || '{"boxState":"failed_stopped"}'::jsonb WHERE request_id='box-wait'`);
    assert.deepEqual(await find("s1", ["toolu_1", "toolu_2"]), { kind: "none" });
  } finally { client.release(); await pool.end(); }
});
