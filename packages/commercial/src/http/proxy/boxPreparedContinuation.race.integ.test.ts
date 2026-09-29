/** Two real sessions race one handoff. pg_temp is invisible across connections,
 * so this uses the same private-schema fixture as boxToolSuccessRecovery.integ,
 * never a public business table. Loopback 55432 / openclaude_test only.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";
import { prepareBoxContinuation } from "./boxPreparedContinuation.js";
import { publishBoxToolResume } from "./boxToolResumePublish.js";
import { BoxContinuationDecisionError } from "./boxPreparedContinuation.js";
import { hashBoxAssistantContent, hashBoxAssistantEchoContent,
  hashBoxAssistantNoCallerContent } from "./boxCallFingerprint.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { ProxyBody } from "./shared.js";

const url = "postgres://test:test@127.0.0.1:55432/openclaude_test";
const model = "box-api-claude-opus-5-5";
const nonce = "a".repeat(24);
const epoch = "b".repeat(32);
const runner = "c".repeat(64);
const toolId = "toolu_race_claim";

function body(session: string, turn: string): ProxyBody {
  return { model, stream: true, max_tokens: 128,
    tools: [{ name: "Read", description: "read",
      input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
    messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Read",
        input: { file_path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "bytes" }] },
    ],
    metadata: { user_id: JSON.stringify({ session_id: session, oc_turn_key: turn }) },
  } as ProxyBody;
}

test("two concurrent journal claims publish one local file and add no usage row", { timeout: 30_000 }, async () => {
  assert.match(url, /^postgres:\/\/test:test@127\.0\.0\.1:55432\/openclaude_test$/);
  const admin = new Pool({ connectionString: url, max: 1 });
  const schema = `ocv5_294_race_${randomBytes(4).toString("hex")}`;
  const client = await admin.connect();
  const raw = new Pool({ connectionString: url, max: 2 });
  const dir = mkdtempSync(join(tmpdir(), "ocv5-294-race-"));
  try {
    const where = await client.query<{ db: string; port: number }>(
      "SELECT current_database() AS db, inet_server_port() AS port");
    assert.equal(where.rows[0]?.db, "openclaude_test");
    assert.equal(Number(where.rows[0]?.port), 55432);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      error_msg text, failure_code text, final_credits bigint)`);
    await client.query(`CREATE TABLE ${schema}.usage_records (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, cost_credits bigint)`);
    await client.query(`SET search_path TO ${schema}`);
    const located = await client.query<{ name: string; nspname: string }>(
      `SELECT c.relname AS name, n.nspname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid IN (to_regclass('request_finalize_journal'), to_regclass('usage_records'))
        ORDER BY c.relname`);
    assert.deepEqual(located.rows.map((row) => row.name), ["request_finalize_journal", "usage_records"]);
    assert.ok(located.rows.every((row) => row.nspname === schema));
    assert.ok(located.rows.every((row) => !row.nspname.startsWith("public")));
    const hex = randomBytes(3).toString("hex");
    const session = `race-${hex}`;
    const turn = randomBytes(32).toString("hex");
    const owner = `own-${hex}`;
    const childA = `chA-${hex}`;
    const childB = `chB-${hex}`;
    const request = body(session, turn);
    const prepared = prepareBoxContinuation({ uid: 3n, canonicalModel: model, rawBody: request,
      authorityKind: "bridge_signed", authorityTurnId: "ab".repeat(16) });
    assert.ok(prepared.catalog);
    const assistant = [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: "a.txt" } }];
    const handoff = { version: 1, roundNo: 1, messageId: `msg_${hex}`,
      assistantContentHash: hashBoxAssistantContent(assistant),
      assistantNoCallerHash: hashBoxAssistantNoCallerContent(assistant),
      assistantEchoHash: hashBoxAssistantEchoContent(assistant),
      spoolOffset: 8, detachedRunnerHash: runner, catalogHash: prepared.catalog.bindingSha256,
      toolUses: [{ id: toolId, boxName: "mcp__ocbridge__t0", clientName: "Read",
        inputHash: hashBoxToolInput({ file_path: "a.txt" }) }],
      verifiedPendingToolUseIds: [toolId],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const pricing = { v: 1, modelId: model, displayName: "Opus", inputPerMtok: "1",
      outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" };
    const billing = { v: 1, sessionId: session, mode: "chat", parentSessionId: null,
      delegateAgentId: null, turnKey: turn, parentTurnKey: null, authority: null,
      dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null };
    const signed = { authorityKind: "bridge_signed", authorityTurnId: "ab".repeat(16) };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'committed',$2::jsonb)`, [owner, JSON.stringify({ model, ...signed,
      boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool", boxAccountId: "20",
      boxRunNonce: nonce, boxLeaseEpoch: epoch, boxContextHash: prepared.priorContextHash,
      boxHandoffRevision: "rev-1", boxToolHandoff: handoff, boxState: "handoff",
      boxSessionId: session, boxTurnKey: turn, billingPricing: pricing, boxBillingContext: billing,
      boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
      boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}` })]);
    const childCtx = { model, ...signed, boxInvocationRecovery: "v1",
      billingPricing: pricing, boxBillingContext: billing };
    await client.query(`INSERT INTO request_finalize_journal(request_id,user_id,state,ctx)
      VALUES ($1,3,'inflight',$2::jsonb), ($3,3,'inflight',$2::jsonb)`,
      [childA, JSON.stringify(childCtx), childB]);
    const wrapped = { connect: async () => {
      const held = await raw.connect();
      await held.query(`SET search_path TO ${schema}`);
      const seen = await held.query<{ nspname: string }>(
        `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.oid = to_regclass('request_finalize_journal')`);
      if (seen.rows[0]?.nspname !== schema) {
        held.release();
        throw new Error("BOX_TEST_SCHEMA_LEAK");
      }
      return { query: held.query.bind(held), release: () => held.release() };
    }, query: client.query.bind(client) } as unknown as Pool;
    const journal = new BoxDurableJournal(wrapped);
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    let held = false;
    journal.resumeLookupBarrier = async () => {
      if (held) return;
      held = true;
      await hold;
    };
    let writes = 0;
    const target = { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
      const args = request.args;
      if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("pending.")) {
        return { stdout: JSON.stringify({ version: 1, modelToolUseId: toolId, mcpRequestId: 1,
          name: "t0", arguments: { file_path: "a.txt" } }), stderrBytes: 0, exitCode: 0 as const };
      }
      writes += 1;
      writeFileSync(join(dir, `result-${writes}.json`), args.at(-1) ?? "written");
      return { stdout: `${args.at(-1) ?? "written"}\n`, stderrBytes: 0, exitCode: 0 as const };
    } } };
    const publish = (requestId: string) => publishBoxToolResume({
      uid: 3n, sessionId: session, requestId, canonicalModel: model, canonicalBody: request,
      upstreamModel: "claude-opus-5-5", url: BOX_INTERNAL_ENDPOINT,
      init: { method: "POST", body: JSON.stringify({ ...request, model: "claude-opus-5-5" }) },
      prepared,
    }, { journal, resolveTarget: async () => target as never,
      retainUnknownTarget: () => { throw new Error("unknown retain"); },
      onUnknown: async () => { throw new Error("unknown notify"); } });
    const first = publish(childA);
    const second = publish(childB);
    const started = Date.now();
    while (!held && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(held, true);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(secondSettled, false, "rival must still be blocked on the session lock");
    releaseHold();
    const results = await Promise.allSettled([first, second]);
    const won = results.filter((item) => item.status === "fulfilled");
    const lost = results.filter((item) => item.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    const error = (lost[0] as PromiseRejectedResult).reason;
    assert.equal(error instanceof BoxContinuationDecisionError, true);
    assert.equal(error.decision, "in_progress_or_unknown");
    assert.ok(writes >= 1);
    assert.equal(readdirSync(dir).length, writes);
    const states = await client.query<{ id: string; state: string | null }>(
      `SELECT request_id AS id, ctx->>'boxState' AS state FROM request_finalize_journal
        WHERE request_id = ANY($1::text[]) ORDER BY request_id`, [[owner, childA, childB]]);
    const byId = new Map(states.rows.map((row) => [row.id, row.state]));
    assert.equal(byId.get(owner), "resuming");
    const childStates = [byId.get(childA) ?? null, byId.get(childB) ?? null];
    assert.equal(childStates.filter((state) => state === "linked").length, 1);
    assert.equal(childStates.filter((state) => state === null).length, 1);
    const usage = await client.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM usage_records");
    assert.equal(usage.rows[0]?.n, "0");
    const again = await journal.decideToolResume({ requestId: childB, uid: 3n,
      canonicalModel: model, canonicalBody: request, prepared,
      trustedAuthority: prepared.authority });
    assert.equal(again.kind, "in_progress_or_unknown");
    assert.equal(readdirSync(dir).length, writes, "restart does not publish another file");
    const ownerAfter = await client.query<{ state: string }>(
      "SELECT ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=$1", [owner]);
    assert.equal(ownerAfter.rows[0]?.state, "resuming");
    const publicTable = await client.query<{ rel: string | null }>(
      "SELECT to_regclass('public.request_finalize_journal')::text AS rel");
    if (publicTable.rows[0]?.rel) {
      const leaked = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM public.request_finalize_journal
          WHERE request_id = ANY($1::text[])`, [[owner, childA, childB]]);
      assert.equal(leaked.rows[0]?.n, "0");
    }
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    client.release();
    await admin.end();
    await raw.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
