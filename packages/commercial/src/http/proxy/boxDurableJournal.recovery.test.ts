/** TEMP shadow only. Never writes the live request_finalize_journal. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const handoffUsage = { inputTokens: 4, outputTokens: 5, cacheReadTokens: 6, cacheWriteTokens: 7 };

test("recovery evidence reads parent hashes, root permit, and fixed model mapping",
  { skip: !testDatabaseUrl }, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, state text NOT NULL,
      ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    const same = { connect: async () => ({ query: (sql: string, params?: unknown[]) =>
      client.query(sql, params), release: () => {} }),
      query: (sql: string, params?: unknown[]) => client.query(sql, params) } as never;
    const journal = new BoxDurableJournal(same);
    const catalog = "a".repeat(64), runner = "b".repeat(64);
    const nonce = "c".repeat(24), epoch = "d".repeat(32), turn = "e".repeat(64);
    const revision = randomUUID();
    const toolUse = { id: "toolu_parent", boxName: "mcp__ocbridge__t0",
      clientName: "Bash", inputHash: "f".repeat(64) };
    const handoff = { version: 1, roundNo: 1, messageId: "msg_parent",
      assistantContentHash: "1".repeat(64), spoolOffset: 20,
      detachedRunnerHash: runner, catalogHash: catalog,
      toolUses: [toolUse], verifiedPendingToolUseIds: [toolUse.id], usage: handoffUsage };
    const shared = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: nonce,
      boxLeaseEpoch: epoch, boxSessionId: "session-recovery", boxTurnKey: turn,
      boxCatalogHash: catalog, boxDetachedRunnerHash: runner };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ('root-1',3,'inflight',$1::jsonb)`, [JSON.stringify({ ...shared,
        boxState: "resuming", boxLaunchPermit: true, boxToolHandoff: handoff,
        boxResumeRequestId: "leaf-2", boxResumeRevision: revision,
        boxResumeResultHashes: [{ modelToolUseId: toolUse.id, contentHash: "2".repeat(64),
          isError: false }] })]);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ('leaf-2',3,'inflight',$1::jsonb)`, [JSON.stringify({ ...shared,
        boxState: "unknown", boxOwnerRequestId: "root-1", boxRoundNo: 2,
        boxResumeSpoolOffset: 20, boxParentResumeRevision: revision,
        boxCancelIntent: { version: 1 } })]);
    const candidate = { requestId: "leaf-2", uid: 3n, accountId: 20n,
      runNonce: nonce, leaseEpoch: epoch, linked: true };
    const loaded = await journal.readDetachedUnknownRecovery(candidate);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.evidence.resultHashes?.[0]?.modelToolUseId, toolUse.id);
    assert.equal(loaded.evidence.rootLaunchPermit, true);
    assert.equal(loaded.evidence.upstreamModel, "claude-opus-5-5");
    assert.equal(loaded.evidence.roundNo, 2);
    await client.query(`UPDATE request_finalize_journal SET ctx=ctx-'boxLaunchPermit'
      WHERE request_id='root-1'`);
    const missing = await journal.readDetachedUnknownRecovery(candidate);
    assert.deepEqual(missing, { ok: false, reason: "BOX_RECOVERY_ROOT_PERMIT_MISSING" });
  } finally {
    client.release();
    await pool.end();
  }
});
