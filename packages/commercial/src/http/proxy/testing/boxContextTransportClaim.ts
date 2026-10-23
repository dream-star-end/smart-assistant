/** Uses only the caller's session-local TEMP billing mirror. No test reset. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BoxDurableJournal, BoxDurableJournalError } from "../boxDurableJournal.js";
import { prepareBoxContinuation } from "../boxPreparedContinuation.js";
import { compileBoxToolCatalog } from "../boxToolCatalog.js";
import { hashBoxToolInput } from "../boxToolInputHash.js";
import { deriveBoxContextHash, hashBoxAssistantContent, hashBoxAssistantEchoContent,
  hashBoxAssistantNoCallerContent } from "../boxCallFingerprint.js";
import type { ProxyBody } from "../shared.js";

type Db = { query: (sql: string, params?: unknown[]) => Promise<any> };
export async function assertLegacyContextClaim(db: Db, body: ProxyBody): Promise<void> {
  const located = await db.query("SELECT c.relname AS name,n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid = ANY(ARRAY[to_regclass('request_finalize_journal'),to_regclass('usage_records'),to_regclass('credit_ledger'),to_regclass('users')])");
  assert.equal(located.rows.length, 4);
  assert.ok(located.rows.every((r: any) => /^pg_temp(?:_\d+)?$/.test(r.schema)),
    "proof billing tables must be session-local TEMP tables");
  const uid = 765n;
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'g607-context-765@test.invalid','unused',10000) ON CONFLICT(id) DO NOTHING", [uid.toString()]);
  const beforeMoney = async () => JSON.stringify((await db.query("SELECT (SELECT COUNT(*)::text FROM usage_records) AS usage, (SELECT COUNT(*)::text FROM credit_ledger) AS ledger, (SELECT credits::text FROM users WHERE id=$1) AS wallet", [uid.toString()])).rows);
  const money = await beforeMoney();
  const meta = JSON.parse(body.metadata!.user_id!);
  const session = String(meta.session_id);
  const turn = String(meta.oc_turn_key);
  const tag = randomBytes(6).toString("hex");
  const owner = `g607-owner-${tag}`;
  const child = `g607-child-${tag}`;
  const nonce = randomBytes(12).toString("hex");
  const epoch = randomBytes(16).toString("hex");
  const runner = "c".repeat(64);
  const catalog = compileBoxToolCatalog(body.tools!);
  const assistant = (body.messages.at(-2) as { content: any[] }).content;
  assert.equal(assistant.length, 6);
  const pricing = { v: 1, modelId: body.model, displayName: "Opus fixture",
    inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" };
  const billing = { v: 1, sessionId: session, mode: "chat", parentSessionId: null,
    delegateAgentId: null, turnKey: turn, parentTurnKey: null, authority: null,
    dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null };
  const handoff = { version: 1, roundNo: 1, messageId: `msg_g607_${tag}`,
    assistantContentHash: hashBoxAssistantContent(assistant),
    assistantNoCallerHash: hashBoxAssistantNoCallerContent(assistant),
    assistantEchoHash: hashBoxAssistantEchoContent(assistant),
    spoolOffset: 8, detachedRunnerHash: runner, catalogHash: catalog.bindingSha256,
    toolUses: assistant.map((tool) => ({ id: tool.id, boxName: "mcp__ocbridge__t0",
      clientName: "Read", inputHash: hashBoxToolInput(tool.input) })),
    verifiedPendingToolUseIds: assistant.map((tool) => tool.id),
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  await db.query("INSERT INTO request_finalize_journal(request_id,user_id,state,ctx) VALUES ($1,$2,'committed',$3::jsonb)",
    [owner, uid.toString(), JSON.stringify({
      model: body.model, boxInvocationRecovery: "v1", boxInvocationMode: "detached_tool",
      boxAccountId: "765", boxRunNonce: nonce, boxLeaseEpoch: epoch,
      boxContextHash: deriveBoxContextHash(body, true), boxHandoffRevision: "g607-legacy",
      boxToolHandoff: handoff, boxState: "handoff", boxSessionId: session, boxTurnKey: turn,
      billingPricing: pricing, boxBillingContext: billing,
      boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
      boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}`, boxNativeCliVersion: "2.1.280",
    })]);
  await db.query("INSERT INTO request_finalize_journal(request_id,user_id,state,ctx) VALUES ($1,$2,'inflight',$3::jsonb)",
    [child, uid.toString(), JSON.stringify({
      model: body.model, boxInvocationRecovery: "v1", billingPricing: pricing, boxBillingContext: billing,
    })]);
  const journal = new BoxDurableJournal({ connect: async () => ({
    query: db.query.bind(db), release: () => {} }), query: db.query.bind(db) } as never);
  const rows = async () => (await db.query("SELECT request_id,ctx->>'boxState' AS state FROM request_finalize_journal WHERE request_id=ANY($1::text[]) ORDER BY request_id", [[owner, child]])).rows;
  const prior = await rows();
  const broken = structuredClone(body);
  (broken.messages[0] as { content: string }).content += " changed";
  await assert.rejects(journal.claimToolResume({ requestId: child, uid,
    canonicalModel: body.model, canonicalBody: broken }),
  (e: unknown) => e instanceof BoxDurableJournalError && e.code === "BOX_TOOL_CONTEXT_CHANGED");
  assert.deepEqual(await rows(), prior, "bad old prefix cannot consume or advance a handoff");
  const prepared = prepareBoxContinuation({ uid, canonicalModel: body.model, rawBody: body,
    authorityKind: "local_catalog", authorityTurnId: null });
  const claimed = await journal.claimToolResume({ requestId: child, uid,
    canonicalModel: body.model, canonicalBody: body, prepared });
  assert.equal(claimed.ownerRequestId, owner);
  assert.equal(claimed.results.length, 6);
  const stored = await db.query("SELECT ctx->>'boxContextHash' AS hash FROM request_finalize_journal WHERE request_id=$1",
    [child]);
  assert.equal(stored.rows[0]?.hash, deriveBoxContextHash(body));
  await assert.rejects(journal.claimToolResume({ requestId: child, uid,
    canonicalModel: body.model, canonicalBody: body, prepared }),
  (e: unknown) => e instanceof BoxDurableJournalError && e.code === "BOX_CALL_AMBIGUOUS");
  assert.equal(await beforeMoney(), money, "stage and claim do not debit or settle prior successful usage");
}

