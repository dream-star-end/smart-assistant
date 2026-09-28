/** TEMP or a private schema only. Never writes public financial tables or Box. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { recoverBoxBillingRequest } from "./boxBillingRecovery.js";
import { BoxDurableJournal, BoxDurableJournalError } from "../http/proxy/boxDurableJournal.js";
import { compileBoxToolCatalog } from "../http/proxy/boxToolCatalog.js";
import { observeBoxToolTerminalOnly } from "../http/proxy/boxToolTerminalRecovery.js";
import { createBoxReplayReader, createBoxReplayWriter } from "../egress/boxReplaySetup.js";

const testDatabaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;
const ACTIVE = ["reserved", "starting", "running", "unknown", "handoff", "resuming", "linked"];
const model = "claude-opus-5-5";
const catalog = compileBoxToolCatalog([{ name: "local_echo", description: "synthetic",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }]);
const useId = "toolu_round_final";
const event = (value: unknown) => ({ type: "stream_event", event: value });

function finalSpool() {
  const records = [
    event({ type: "message_start", message: { id: "msg_round3", model,
      role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 0,
        cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
    { type: "assistant", message: { id: "msg_round3", model, role: "assistant",
      content: [{ type: "text", text: "done" }] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 3, output_tokens: 4 } }),
    event({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 90, output_tokens: 80,
        cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } },
  ];
  return Buffer.from(records.map((item) => JSON.stringify(item) + "\n").join(""));
}

async function shadow(client: import("pg").PoolClient): Promise<void> {
  const names = ["request_finalize_journal", "usage_records", "pending_usage_patches",
    "users", "user_subscriptions", "org_memberships", "orgs",
    "org_subscriptions", "turn_waivers", "client_sessions", "chat_projects",
    "credit_ledger"];
  const source = await client.query<{ ready: boolean }>(
    `SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) AS ready
       FROM unnest($1::text[]) AS name`, [names]);
  await client.query("CREATE TEMP SEQUENCE box_success_usage_id_seq");
  if (source.rows[0]?.ready === true) {
    for (const name of names) {
      await client.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
    }
  } else {
    await client.query(readFileSync(new URL("./boxBillingRecoveryTempSchema.sql", import.meta.url), "utf8"));
  }
  await client.query("ALTER TABLE pg_temp.usage_records ALTER COLUMN id SET DEFAULT nextval('pg_temp.box_success_usage_id_seq'::regclass)");
  await client.query("CREATE TEMP SEQUENCE box_success_ledger_id_seq");
  await client.query("ALTER TABLE pg_temp.credit_ledger ALTER COLUMN id SET DEFAULT nextval('pg_temp.box_success_ledger_id_seq'::regclass)");
  const shadowOk = await client.query<{ only_temp: boolean }>(
    `SELECT 'request_finalize_journal'::regclass = 'pg_temp.request_finalize_journal'::regclass
      AND 'usage_records'::regclass = 'pg_temp.usage_records'::regclass
      AND 'credit_ledger'::regclass = 'pg_temp.credit_ledger'::regclass
      AND 'users'::regclass = 'pg_temp.users'::regclass AS only_temp`);
  assert.equal(shadowOk.rows[0]?.only_temp, true);
}

test("third-round unknown closes once and settles each original request",
  { skip: !testDatabaseUrl }, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  const capsuleRoot = mkdtempSync(join(tmpdir(), "ocv5-success-"));
  try {
    await shadow(client);
    const same = { connect: async () => ({ query: client.query.bind(client), release: () => {} }),
      query: client.query.bind(client) } as unknown as Pool;
    const userId = 900_000_220n;
    const nonce = randomBytes(12).toString("hex");
    const epoch = randomBytes(16).toString("hex");
    const turn = "a".repeat(64);
    const sessionId = "web-success-recovery";
    const rev12 = randomUUID();
    const rev23 = randomUUID();
    const hash = createHash("sha256").update(JSON.stringify({
      content: [{ type: "text", text: "ok" }], isError: false })).digest("hex");
    const tool = { id: useId, boxName: "mcp__ocbridge__t0", clientName: "local_echo",
      inputHash: "b".repeat(64) };
    const usageOf = (input: number) => ({ inputTokens: input, outputTokens: input + 1,
      cacheReadTokens: 0, cacheWriteTokens: 0 });
    const handoff = (roundNo: number, messageId: string, usage: ReturnType<typeof usageOf>) => ({
      version: 1, roundNo, messageId, assistantContentHash: "c".repeat(64),
      spoolOffset: 20, detachedRunnerHash: "d".repeat(64),
      catalogHash: catalog.bindingSha256, toolUses: [tool],
      verifiedPendingToolUseIds: [tool.id], usage });
    const pricing = { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
      inputPerMtok: "100000000", outputPerMtok: "100000000",
      cacheReadPerMtok: "100000000", cacheWritePerMtok: "100000000", multiplier: "1" };
    const shared = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: nonce,
      boxLeaseEpoch: epoch, boxSessionId: sessionId, boxTurnKey: turn,
      boxCatalogHash: catalog.bindingSha256, boxDetachedRunnerHash: "d".repeat(64),
      boxReplayFingerprint: "e".repeat(64), billingPricing: pricing };
    const billing = (id: string) => ({ v: 1, sessionId: id, mode: "chat",
      parentSessionId: null, delegateAgentId: null, turnKey: turn, parentTurnKey: null,
      authority: null, dispatchId: null, attemptNo: null,
      verificationSponsorship: null, apiKeyId: null });
    await client.query(`INSERT INTO users(id,email,password_hash,credits)
      VALUES ($1,$2,'test-only-hash',1000000)`, [userId.toString(), `success-${nonce}@example.invalid`]);
    await client.query(`INSERT INTO user_subscriptions
      (id,user_id,plan_code,period_end,period_credits)
      VALUES (1,$1,'plus',NOW()+INTERVAL '1 day',1)`, [userId.toString()]);
    const rootUsage = usageOf(11);
    const midUsage = usageOf(22);
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx,precheck_credits) VALUES
      ('root-r1',$1,'inflight',$2::jsonb,0)`, [userId.toString(), JSON.stringify({
        ...shared, boxState: "resuming", boxLaunchPermit: true,
        boxToolHandoff: handoff(1, "msg_r1", rootUsage),
        boxHandoffRevision: randomUUID(), boxResumeRequestId: "mid-r2",
        boxResumeRevision: rev12,
        boxResumeResultHashes: [{ modelToolUseId: useId, contentHash: hash, isError: false }],
        boxBillingContext: billing("web-r1") })]);
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx,precheck_credits) VALUES
      ('mid-r2',$1,'inflight',$2::jsonb,0)`, [userId.toString(), JSON.stringify({
        ...shared, boxState: "resuming", boxOwnerRequestId: "root-r1", boxRoundNo: 2,
        boxParentResumeRevision: rev12, boxResumeSpoolOffset: 20,
        boxToolHandoff: handoff(2, "msg_r2", midUsage),
        boxHandoffRevision: randomUUID(), boxResumeRequestId: "leaf-r3",
        boxResumeRevision: rev23,
        boxResumeResultHashes: [{ modelToolUseId: useId, contentHash: hash, isError: false }],
        boxBillingContext: billing("web-r2") })]);
    await client.query(`INSERT INTO request_finalize_journal
      (request_id,user_id,state,ctx,precheck_credits) VALUES
      ('leaf-r3',$1,'inflight',$2::jsonb,0)`, [userId.toString(), JSON.stringify({
        ...shared, boxState: "unknown", boxOwnerRequestId: "mid-r2", boxRoundNo: 3,
        boxParentResumeRevision: rev23, boxResumeSpoolOffset: 20,
        boxCancelIntent: { version: 1, at: "before-proof" },
        boxBillingContext: billing("web-r3") })]);
    const candidate = { requestId: "leaf-r3", uid: userId, accountId: 20n,
      runNonce: nonce, leaseEpoch: epoch, linked: true };
    const cold = new BoxDurableJournal(same);
    const again = new BoxDurableJournal(same);
    const loaded = await cold.readDetachedUnknownRecovery(candidate);
    const loadedAgain = await again.readDetachedUnknownRecovery(candidate);
    assert.equal(loaded.ok && loadedAgain.ok, true);
    if (!loaded.ok || !loadedAgain.ok) return;
    assert.equal(loaded.evidence.rootRequestId, "root-r1");
    assert.equal(loaded.evidence.resultHashes?.[0]?.contentHash, hash);
    assert.deepEqual(loadedAgain.evidence.resultHashes, loaded.evidence.resultHashes);
    const permit = await client.query<{ id: string; permit: string | null }>(
      `SELECT request_id AS id, ctx->>'boxLaunchPermit' AS permit
         FROM request_finalize_journal ORDER BY request_id`);
    assert.deepEqual(permit.rows.map((row) => [row.id, row.permit]),
      [["leaf-r3", null], ["mid-r2", null], ["root-r1", "true"]]);
    const raw = finalSpool();
    const echo = { type: "user", message: { role: "user", content: [{
      type: "tool_result", tool_use_id: useId, content: "ok" }] } };
    const body = Buffer.concat([Buffer.from(JSON.stringify(echo) + "\n"), raw]);
    const proof = { runNonce: nonce, leaseEpoch: epoch, keeperPid: 101, cliPid: 102,
      reason: "worker_complete", revision: 1 };
    const target = { accountId: 20n, exec: { run: async (req: { args: string[] }) => {
      if (req.args[5] === "--read") {
        const offset = Number(req.args[7]);
        const start = offset === 20 ? 0 : body.length;
        const bytes = body.subarray(start);
        return { stdout: JSON.stringify({ data: bytes.toString("base64"),
          offset: 20 + start + bytes.length }), stderrBytes: 0, exitCode: 0 as const };
      }
      if (req.args.some((arg) => String(arg).includes("terminal.json"))) {
        return { stdout: JSON.stringify(proof) + "\n", stderrBytes: 0, exitCode: 0 as const };
      }
      throw new Error("launch or cleanup is not part of this close");
    } } };
    const platformRoot = join(capsuleRoot, "state");
    const writer = createBoxReplayWriter(true, platformRoot);
    const reader = createBoxReplayReader(platformRoot);
    assert.ok(writer && reader);
    const outcome = await observeBoxToolTerminalOnly({
      evidence: loaded.evidence, catalog, target: target as never }, {
      journal: new BoxDurableJournal(same), writeMessage: writer });
    assert.equal(outcome.status, "committed");
    const rows = await client.query<{ id: string; state: string; usage: unknown;
      handoff: unknown }>(
      `SELECT request_id AS id, ctx->>'boxState' AS state,
              ctx->'boxUsage' AS usage, ctx->'boxToolHandoff'->'usage' AS handoff
         FROM request_finalize_journal ORDER BY request_id`);
    for (const row of rows.rows) assert.equal(ACTIVE.includes(row.state), false, row.id);
    assert.deepEqual(rows.rows.find((row) => row.id === "root-r1")?.handoff, rootUsage);
    assert.deepEqual(rows.rows.find((row) => row.id === "mid-r2")?.handoff, midUsage);
    assert.deepEqual(rows.rows.find((row) => row.id === "leaf-r3")?.usage, {
      inputTokens: 3, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2 });
    const storedPointer = await client.query(
      `SELECT ctx->'boxReplayMessage' AS pointer FROM request_finalize_journal
        WHERE request_id='leaf-r3'`);
    const message = await reader(storedPointer.rows[0]!.pointer);
    assert.equal((message as { id: string }).id, "msg_round3");
    await client.query(`UPDATE request_finalize_journal
      SET updated_at=NOW()-INTERVAL '10 minutes'`);
    for (const id of ["root-r1", "mid-r2", "leaf-r3"]) {
      assert.equal(await recoverBoxBillingRequest(same, id, userId), "settled", id);
      assert.equal(await recoverBoxBillingRequest(same, id, userId), "already_committed", id);
    }
    const books = await client.query<{ request_id: string; cost: string; debit: string;
      n: string }>(
      `SELECT ur.request_id, ur.cost_credits::text AS cost,
              COALESCE((SELECT SUM(-cl.delta) FROM credit_ledger cl
                WHERE cl.ref_type='usage_record' AND cl.ref_id=ur.id::text
                  AND cl.reason='chat' AND cl.delta<0),0)::text AS debit,
              (SELECT COUNT(*) FROM credit_ledger cl
                WHERE cl.ref_type='usage_record' AND cl.ref_id=ur.id::text
                  AND cl.reason='chat' AND cl.delta<0)::text AS n
         FROM usage_records ur WHERE ur.user_id=$1 ORDER BY ur.request_id`,
      [userId.toString()]);
    assert.equal(books.rows.length, 3);
    for (const row of books.rows) assert.equal(row.debit, row.cost, row.request_id);
    assert.ok(books.rows.some((row) => Number(row.n) >= 2),
      "period plus wallet must both debit when the period bucket is 1");
    const usageCount = await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM usage_records WHERE user_id=$1", [userId.toString()]);
    assert.equal(usageCount.rows[0]?.n, "3");
  } finally {
    client.release();
    await pool.end();
    rmSync(capsuleRoot, { recursive: true, force: true });
  }
});

test("two connections racing completeToolChain leave one terminal leaf",
  { skip: !testDatabaseUrl }, async () => {
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const schema = `ocv5_294_${randomBytes(4).toString("hex")}`;
  const client = await admin.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, state text NOT NULL,
      ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`SET search_path TO ${schema}`);
    const located = await client.query<{ name: string }>(
      `SELECT n.nspname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='request_finalize_journal'::regclass`);
    assert.equal(located.rows[0]?.name, schema);
    const nonce = "a".repeat(24), epoch = "b".repeat(32);
    const handoff = { version: 1, roundNo: 1, messageId: "msg_root",
      assistantContentHash: "c".repeat(64), spoolOffset: 20,
      detachedRunnerHash: "d".repeat(64), catalogHash: "e".repeat(64),
      toolUses: [{ id: "toolu_parent", boxName: "mcp__ocbridge__t0",
        clientName: "Bash", inputHash: "f".repeat(64) }],
      verifiedPendingToolUseIds: ["toolu_parent"],
      usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const shared = { model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
      boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: nonce,
      boxLeaseEpoch: epoch, boxSessionId: "race-session", boxTurnKey: "1".repeat(64),
      boxCatalogHash: "e".repeat(64), boxDetachedRunnerHash: "d".repeat(64) };
    const revision = randomUUID();
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ('race-root',3,'inflight',$1::jsonb)`, [JSON.stringify({ ...shared,
        boxState: "resuming", boxLaunchPermit: true, boxToolHandoff: handoff,
        boxResumeRequestId: "race-leaf", boxResumeRevision: revision,
        boxResumeResultHashes: [{ modelToolUseId: "toolu_parent",
          contentHash: "2".repeat(64), isError: false }] })]);
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ('race-leaf',3,'inflight',$1::jsonb)`, [JSON.stringify({ ...shared,
        boxState: "unknown", boxOwnerRequestId: "race-root", boxRoundNo: 2,
        boxResumeSpoolOffset: 20, boxParentResumeRevision: revision })]);
    const raw = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const wrapped = { connect: async () => {
      const held = await raw.connect();
      await held.query(`SET search_path TO ${schema}`);
      const seen = await held.query<{ name: string }>(
        `SELECT n.nspname AS name FROM pg_class c
           JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.oid='request_finalize_journal'::regclass`);
      if (seen.rows[0]?.name !== schema) {
        held.release();
        throw new Error("BOX_TEST_SCHEMA_LEAK");
      }
      return { query: held.query.bind(held), release: () => held.release() };
    }, query: async (sql: string, params?: unknown[]) => {
      const held = await raw.connect();
      try {
        await held.query(`SET search_path TO ${schema}`);
        return await held.query(sql, params);
      } finally { held.release(); }
    } } as unknown as Pool;
    const proof = { runNonce: nonce, leaseEpoch: epoch, keeperPid: 1, cliPid: 2,
      reason: "worker_complete" as const, revision: 1 as const };
    const usage = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const run = () => new BoxDurableJournal(wrapped).completeToolChain({
      requestId: "race-leaf", uid: 3n, leaseEpoch: epoch, proof, usage });
    const results = await Promise.allSettled([run(), run()]);
    const won = results.filter((item) => item.status === "fulfilled");
    const lost = results.filter((item) => item.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    const error = (lost[0] as PromiseRejectedResult).reason;
    assert.equal(error instanceof BoxDurableJournalError, true);
    assert.ok(["BOX_TOOL_CHAIN_FENCE_LOST", "BOX_TOOL_CHAIN_INVALID"].includes(error.code));
    const leaf = await client.query<{ state: string; box: string; usage: unknown }>(
      `SELECT state, ctx->>'boxState' AS box, ctx->'boxUsage' AS usage
         FROM request_finalize_journal WHERE request_id='race-leaf'`);
    assert.equal(leaf.rows[0]?.box, "terminal");
    assert.deepEqual(leaf.rows[0]?.usage, usage);
    const root = await client.query<{ usage: unknown }>(
      `SELECT ctx->'boxToolHandoff'->'usage' AS usage
         FROM request_finalize_journal WHERE request_id='race-root'`);
    assert.deepEqual(root.rows[0]?.usage, handoff.usage);
    await raw.end();
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await admin.end();
  }
});
