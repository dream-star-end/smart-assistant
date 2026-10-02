/** Settled multi-root snapshot through the real read-only proof, then HTTP. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";
import { makeBoxIdleProofHandler } from "./boxIdleProofHandler.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL
  ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";

test("a committed summary root plus a handoff chain is a ready set", async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL,
      container_id bigint, state text NOT NULL,
      ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    const reg = await client.query<{ name: string | null }>(
      `SELECT to_regclass('request_finalize_journal')::text AS name`);
    assert.equal(typeof reg.rows[0]?.name, "string");
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
    const revisionId = "11111111-1111-4111-8111-111111111111";
    const pointer = (requestId: string, sha256: string) => ({
      version: 1, uid: "3", requestId, runNonce: "3".repeat(24),
      leaseEpoch: "4".repeat(32), roundNo: 1, bytes: 40, sha256,
    });
    const base = {
      boxSessionId: sessionId, boxTurnKey: turnKey, model: "box-api-claude-opus-5-5",
      boxInvocationRecovery: "v1", boxState: "terminal",
    };
    const insert = (id: string, state: string, ctx: Record<string, unknown>) => client.query(
      `INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
       VALUES ($1,3,7,$2,$3::jsonb)`, [id, state, JSON.stringify(ctx)]);
    await insert(`parent-${suffix}`, "committed", {
      ...base, boxToolHandoff: { roundNo: 1 }, boxResumeRequestId: `child-${suffix}`,
      boxResumeRevision: revisionId,
      boxTerminalProof: { reason: "worker_complete", runNonce: "a".repeat(24) },
      boxRunNonce: "a".repeat(24), boxAccountId: "11",
    });
    await insert(`child-${suffix}`, "committed", {
      ...base, boxOwnerRequestId: `parent-${suffix}`, boxParentResumeRevision: revisionId,
      boxTerminalProof: { reason: "worker_complete", runNonce: "a".repeat(24) },
      boxReplayMessage: pointer(`child-${suffix}`, "c".repeat(64)),
      boxRunNonce: "a".repeat(24), boxAccountId: "11", boxRoundNo: 2,
      boxUsage: { inputTokens: 40 },
    });
    await insert(`biz-${suffix}`, "committed", {
      ...base,
      boxTerminalProof: { reason: "worker_complete", runNonce: "b".repeat(24) },
      boxReplayMessage: pointer(`biz-${suffix}`, "d".repeat(64)),
      boxRunNonce: "b".repeat(24), boxAccountId: "22",
      boxUsage: { inputTokens: 12 },
    });
    const read = async (sha: string) => ({ content: [{ type: "text", text: `capsule ${sha}` }] });
    const ready = await journal.readIdleProof({ uid: 3n, containerId: 7n, sessionId, turnKey },
      async (item) => read(item.sha256));
    assert.equal(ready.status, "terminal_set");
    if (ready.status !== "terminal_set") return;
    assert.deepEqual(ready.requestIds, [`biz-${suffix}`, `child-${suffix}`, `parent-${suffix}`]);
    assert.equal("summaryText" in ready, false);
    const again = await journal.readIdleProof({ uid: 3n, containerId: 7n, sessionId, turnKey },
      async (item) => read(item.sha256));
    assert.equal(again.status, "terminal_set");
    if (again.status === "terminal_set") assert.equal(again.revision, ready.revision);
    const missingCapsule = await journal.readIdleProof(
      { uid: 3n, containerId: 7n, sessionId, turnKey },
      async () => { throw new Error("capsule unreadable"); });
    assert.deepEqual(missingCapsule, { status: "pending", reason: "capsule" });
    await client.query(`UPDATE request_finalize_journal SET state='inflight' WHERE request_id=$1`,
      [`biz-${suffix}`]);
    const unsettled = await journal.readIdleProof({ uid: 3n, containerId: 7n, sessionId, turnKey });
    assert.equal(unsettled.status, "pending");
    await client.query(`DELETE FROM request_finalize_journal WHERE request_id=$1`, [`biz-${suffix}`]);
    await insert(`biz-${suffix}`, "committed", {
      ...base,
      boxTerminalProof: { reason: "worker_complete", runNonce: "b".repeat(24) },
      boxReplayMessage: pointer(`biz-${suffix}`, "d".repeat(64)),
      boxRunNonce: "b".repeat(24), boxAccountId: "22",
      boxUsage: { inputTokens: 12 },
    });
    await insert(`other-${suffix}`, "inflight", {
      ...base, boxTurnKey: "b".repeat(64), boxState: "terminal",
    });
    const otherTurn = await journal.readIdleProof({ uid: 3n, containerId: 7n, sessionId, turnKey });
    assert.equal(otherTurn.status, "pending");
    if (otherTurn.status === "pending") assert.equal(otherTurn.reason, "other_chain");
    await client.query(`DELETE FROM request_finalize_journal WHERE request_id=$1`, [`other-${suffix}`]);
    const handler = makeBoxIdleProofHandler({
      identity: { resolve: async () => ({ uid: 3n, containerId: 7n }) } as never,
      journal, readCapsule: async (item) => read(item.sha256),
    });
    const server = createServer((req, res) => {
      void handler(req, res, { hostUuid: "selfhost-test", boundIp: "127.0.0.1" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/internal/box/idle-proof`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, oc_turn_key: turnKey }),
      });
      const body = await response.json() as { status?: string; revision?: string; summaryText?: string };
      assert.equal(response.status, 200);
      assert.equal(body.status, "terminal_set");
      assert.equal(body.revision, ready.revision);
      assert.equal(body.summaryText, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    client.release();
    await pool.end();
  }
});
