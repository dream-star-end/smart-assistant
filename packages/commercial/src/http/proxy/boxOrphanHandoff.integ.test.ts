// OCV5-304: identify the handoff of a finished dispatch that a recovered
// dispatch's tool results were meant for.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";

const url = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
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
  } finally { client.release(); await pool.end(); }
});
