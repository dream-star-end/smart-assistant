import { assertTestDatabaseUrl, assertConnectedTestDatabase } from "../../../../../scripts/lib/testDatabaseIdentity.mjs";
/** Read-only owner-chain projection. Loopback 55432 / openclaude_test only.
 * Tables are session TEMP; a second connection must not see those rows. */
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";
import { consumePrepared } from "./boxPreparedContinuation.js";
import type { ProxyBody } from "./shared.js";

const url = "postgres://test:test@127.0.0.1:55432/openclaude_test";
assertTestDatabaseUrl(url);
const allowed = process.env.TEST_DATABASE_URL === url
  || process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL === url;
const native = "a3672b03-820a-4834-8d6a-c644d0f0df10";
const otherNative = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const outer = "session-outer";

test("TEMP owner chain projects prior tool uses and the root native session",
  { skip: !allowed }, async () => {
  assert.match(url, /^postgres:\/\/test:test@127\.0\.0\.1:55432\/openclaude_test$/);
  const pool = new Pool({ connectionString: url, max: 1,
    connectionTimeoutMillis: 4000, statement_timeout: 8000 });
  const outsider = new Pool({ connectionString: url, max: 1,
    connectionTimeoutMillis: 4000, statement_timeout: 8000 });
  const client = await pool.connect();
  try {
    await assertConnectedTestDatabase(client);
    const publicRel = async () => {
      const rel = await outsider.query<{ rel: string | null }>(
        "SELECT to_regclass('public.request_finalize_journal')::text AS rel");
      if (!rel.rows[0]?.rel) return { rel: null as string | null, n: "0" };
      const counted = await outsider.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.request_finalize_journal
          WHERE request_id LIKE 'prog-%'`);
      return { rel: rel.rows[0].rel, n: counted.rows[0]?.n ?? "0" };
    };
    const publicBefore = await publicRel();
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query(`CREATE TEMP TABLE usage_records (
      request_id text NOT NULL, user_id bigint NOT NULL)`);
    const reg = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid = to_regclass('request_finalize_journal')`);
    assert.ok(reg.rows[0]?.nspname.startsWith("pg_temp"));
    const body = { model: "box-api-claude-opus-5-5", stream: true, max_tokens: 128,
      messages: [{ role: "user", content: "synthetic progress projection" }],
      tools: [{ name: "Bash", description: "synthetic",
        input_schema: { type: "object", properties: {} } }],
      metadata: { user_id: JSON.stringify({ session_id: outer,
        oc_turn_key: "a".repeat(64) }) } } as ProxyBody;
    const view = consumePrepared({ uid: 3n, canonicalModel: body.model,
      canonicalBody: body, allowPrepareOnce: true, replayAlias: true });
    const fp = view.fingerprint;
    assert.equal(fp.sessionId, outer);
    assert.notEqual(fp.sessionId, native);
    const catalog = "c".repeat(64), runner = "d".repeat(64);
    const revision = "11111111-1111-4111-8111-111111111111";
    const handoff = { version: 1, roundNo: 1, messageId: "msg_progress",
      assistantContentHash: "a".repeat(64), assistantEchoHash: "b".repeat(64),
      assistantNoCallerHash: "e".repeat(64), spoolOffset: 1234,
      detachedRunnerHash: runner, catalogHash: catalog,
      toolUses: [{ id: "toolu_prior_a", boxName: "mcp__ocbridge__t2",
        clientName: "Bash", inputHash: "f".repeat(64) }],
      verifiedPendingToolUseIds: ["toolu_prior_a"],
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } };
    const shared = { boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool",
      boxAccountId: "20", boxRunNonce: "1".repeat(24), boxLeaseEpoch: "2".repeat(32),
      boxSessionId: fp.sessionId, boxTurnKey: fp.turnKey, model: body.model,
      boxCatalogHash: catalog, boxDetachedRunnerHash: runner, boxNativeSessionId: native };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'committed',$2::jsonb), ($3,3,'inflight',$4::jsonb)`, [
      "prog-root", JSON.stringify({ ...shared, boxState: "resuming", boxLaunchPermit: true,
        boxToolHandoff: handoff, boxResumeRequestId: "prog-child", boxResumeRevision: revision,
        boxResumeResultHashes: [{ modelToolUseId: "toolu_prior_a",
          contentHash: "9".repeat(64), isError: false }] }),
      "prog-child", JSON.stringify({ ...shared, boxState: "unknown", boxRoundNo: 2,
        boxResumeSpoolOffset: 1234, boxOwnerRequestId: "prog-root",
        boxParentResumeRevision: revision, boxReplayFingerprint: fp.replayFingerprint })]);
    const query = client.query.bind(client);
    const journal = new BoxDurableJournal({ connect: async () => ({ query, release() {} }),
      query } as never);
    const found = await journal.findReplayIdentity({ uid: 3n, canonicalModel: body.model,
      canonicalBody: body });
    assert.equal(found?.requestId, "prog-child");
    assert.equal(found?.rootRequestId, "prog-root");
    assert.deepEqual(found?.priorToolUses?.map((use) => [use.id, use.boxName, use.clientName]),
      [["toolu_prior_a", "mcp__ocbridge__t2", "Bash"]]);
    assert.equal(found?.nativeSessionId, native);
    assert.notEqual(found?.nativeSessionId, outer);
    const recovered = await journal.readDetachedUnknownRecovery({
      requestId: "prog-child", uid: 3n, accountId: 20n,
      runNonce: "1".repeat(24), leaseEpoch: "2".repeat(32), linked: true });
    assert.equal(recovered.ok, true);
    if (recovered.ok) {
      assert.deepEqual(recovered.evidence.priorToolUses?.map((use) => use.id), ["toolu_prior_a"]);
      assert.equal(recovered.evidence.nativeSessionId, native);
    }
    await client.query(`UPDATE request_finalize_journal
      SET ctx=ctx-'boxNativeSessionId' WHERE request_id='prog-root'`);
    const childCannotCertify = await journal.findReplayIdentity({ uid: 3n,
      canonicalModel: body.model, canonicalBody: body });
    assert.equal(childCannotCertify?.nativeSessionId, undefined);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxNativeSessionId}',to_jsonb($1::text))
      WHERE request_id='prog-root'`, [native]);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxToolHandoff,catalogHash}',to_jsonb($1::text))
      WHERE request_id='prog-root'`, ["0".repeat(64)]);
    const mismatched = await journal.findReplayIdentity({ uid: 3n, canonicalModel: body.model,
      canonicalBody: body });
    assert.equal(mismatched?.priorToolUses, undefined);
    assert.equal(mismatched?.nativeSessionId, native);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxNativeSessionId}',to_jsonb($1::text))
      WHERE request_id='prog-child'`, [otherNative]);
    const conflicted = await journal.findReplayIdentity({ uid: 3n, canonicalModel: body.model,
      canonicalBody: body });
    assert.equal(conflicted?.nativeSessionId, undefined);
    const body3 = { ...body, metadata: { user_id: JSON.stringify({
      session_id: "session-outer-3", oc_turn_key: "b".repeat(64) }) } } as ProxyBody;
    const view3 = consumePrepared({ uid: 3n, canonicalModel: body3.model,
      canonicalBody: body3, allowPrepareOnce: true, replayAlias: true });
    const revOwner = "33333333-3333-4333-8333-333333333333";
    const revLeaf = "44444444-4444-4444-8444-444444444444";
    const rootHandoff = { ...handoff, spoolOffset: 100, toolUses: [{
      id: "toolu_root_only", boxName: "mcp__ocbridge__t2", clientName: "Bash",
      inputHash: "1".repeat(64) }], verifiedPendingToolUseIds: ["toolu_root_only"] };
    const ownerHandoff = { ...handoff, roundNo: 2, spoolOffset: 200, toolUses: [{
      id: "toolu_immediate", boxName: "mcp__ocbridge__t2", clientName: "Bash",
      inputHash: "2".repeat(64) }], verifiedPendingToolUseIds: ["toolu_immediate"] };
    const chain = { ...shared, boxSessionId: view3.fingerprint.sessionId,
      boxTurnKey: view3.fingerprint.turnKey };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'committed',$2::jsonb), ($3,3,'committed',$4::jsonb),
             ($5,3,'inflight',$6::jsonb)`, [
      "prog3-root", JSON.stringify({ ...chain, boxState: "resuming", boxLaunchPermit: true,
        boxToolHandoff: rootHandoff, boxResumeRequestId: "prog3-owner",
        boxResumeRevision: revOwner, boxResumeResultHashes: [{
          modelToolUseId: "toolu_root_only", contentHash: "9".repeat(64), isError: false }] }),
      "prog3-owner", JSON.stringify({ ...chain, boxState: "resuming", boxRoundNo: 2,
        boxResumeSpoolOffset: 100, boxOwnerRequestId: "prog3-root",
        boxParentResumeRevision: revOwner, boxToolHandoff: ownerHandoff,
        boxResumeRequestId: "prog3-leaf", boxResumeRevision: revLeaf,
        boxResumeResultHashes: [{ modelToolUseId: "toolu_immediate",
          contentHash: "8".repeat(64), isError: false }] }),
      "prog3-leaf", JSON.stringify({ ...chain, boxState: "unknown", boxRoundNo: 3,
        boxResumeSpoolOffset: 200, boxOwnerRequestId: "prog3-owner",
        boxParentResumeRevision: revLeaf,
        boxReplayFingerprint: view3.fingerprint.replayFingerprint })]);
    const three = await journal.findReplayIdentity({ uid: 3n, canonicalModel: body3.model,
      canonicalBody: body3 });
    assert.deepEqual(three?.priorToolUses?.map((use) => use.id), ["toolu_immediate"],
      "three-row owner projects the immediate tool and not a child session");
    assert.equal(three?.nativeSessionId, native);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=jsonb_set(ctx,'{boxToolHandoff,catalogHash}',to_jsonb($1::text))
      WHERE request_id='prog3-owner'`, ["0".repeat(64)]);
    const noFallback = await journal.findReplayIdentity({ uid: 3n,
      canonicalModel: body3.model, canonicalBody: body3 });
    assert.equal(noFallback?.priorToolUses, undefined);
    await client.query(`UPDATE request_finalize_journal
      SET ctx=ctx-'boxNativeSessionId' WHERE request_id='prog3-root'`);
    const rootMissing = await journal.findReplayIdentity({ uid: 3n,
      canonicalModel: body3.model, canonicalBody: body3 });
    assert.equal(rootMissing?.nativeSessionId, undefined);
    const publicAfter = await publicRel();
    assert.deepEqual(publicAfter, publicBefore);
    assert.equal(publicAfter.n, "0");
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.usage_records").catch(() => {});
    await client.query("DROP TABLE IF EXISTS pg_temp.request_finalize_journal").catch(() => {});
    client.release();
    await pool.end();
    await outsider.end();
  }
});
