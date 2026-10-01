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
