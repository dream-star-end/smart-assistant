/** One explicitly user-approved selfhost exception for a stale Box run whose
 * earlier strict remote proof/spool are now unavailable. This is NOT a new
 * terminal proof, cleanup claim, model/tool replay or user debit. */
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { computeCost } from "../../packages/commercial/src/billing/calculator.js";
import { parseBillingPricing } from
  "../../packages/commercial/src/billing/persistedBillingPricing.js";
import { parseBoxStoredToolHandoff } from
  "../../packages/commercial/src/http/proxy/boxStoredToolHandoff.js";
import { parseBoxReplayMessagePointer } from
  "../../packages/commercial/src/http/proxy/boxReplayMessageFile.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const UID = 3n, ACCOUNT = 20n;
const ACTIVE = ["reserved", "starting", "running", "unknown", "handoff",
  "resuming", "linked"];
function guard(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function envId(name: string, pattern: RegExp): string {
  const value = process.env[name];
  guard(typeof value === "string" && pattern.test(value),
    "BOX_ORPHAN_EXPECTED_IDENTITY_MISSING");
  return value;
}
interface Row { request_id: string; container_id: string; state: string;
  ctx: Record<string, unknown> }
interface Identity { leaf: string; root: string; runNonce: string;
  leaseEpoch: string; sessionId: string; turnKey: string;
  oldContainer: string; currentContainer: string; spoolSha256: string }
interface MessageEvidence extends Record<string, unknown> {
  startOffset: number; endOffset: number; inputTokens: number;
  outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  stopReason: string; afterHandoff: boolean;
}
interface HistoricalEvidence {
  version: 1; rootRequestId: string; leafRequestId: string;
  runNonce: string; leaseEpoch: string; spoolSha256: string; spoolBytes: number;
  rootHandoffRevision: string; rootResumeRevision: string;
  leafHandoffRevision: string; messages: MessageEvidence[];
  priorUsageRecordIds: string[]; writeOffFen: string;
  observedTotalUsage: Record<string, number>;
  historicalProof: { reason: string; revision: number; status: string };
  currentRemoteProof: string; remotePrivacy: string; remoteCleanup: string;
  approval: { ref: string; choice: string; userDebitFen: string;
    platformWriteOffFen: string };
}
function historicalEvidence(id: Identity): { value: HistoricalEvidence; sha256: string } {
  const bytes = readFileSync(new URL("./boxOrphanEvidence.json", import.meta.url));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  guard(sha256 === envId("OCV5_291_EXPECT_EVIDENCE_SHA256", /^[a-f0-9]{64}$/),
    "BOX_ORPHAN_EVIDENCE_FILE_CHANGED");
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("BOX_ORPHAN_EVIDENCE_INVALID"); }
  guard(raw && typeof raw === "object" && !Array.isArray(raw),
    "BOX_ORPHAN_EVIDENCE_INVALID");
  const e = raw as HistoricalEvidence;
  guard(e.version === 1 && e.rootRequestId === id.root
    && e.leafRequestId === id.leaf && e.runNonce === id.runNonce
    && e.leaseEpoch === id.leaseEpoch && e.spoolSha256 === id.spoolSha256
    && e.spoolBytes === 170348 && Array.isArray(e.messages)
    && e.messages.length === 5
    && e.historicalProof?.reason === "worker_complete"
    && e.historicalProof?.revision === 1
    && e.historicalProof?.status === "historical_unverifiable_now"
    && e.currentRemoteProof === "unavailable"
    && e.remotePrivacy === "unknown" && e.remoteCleanup === "unverified"
    && e.writeOffFen === "10" && e.approval?.userDebitFen === "0"
    && e.approval?.platformWriteOffFen === "10"
    && e.approval?.ref ===
      "agent:main:webchat:dm:webmuehg8n99a9p4i:20260928T0429Z:box_no_current_proof"
    && e.approval?.choice === "例外结清并释放（推荐）",
  "BOX_ORPHAN_EVIDENCE_INVALID");
  return { value: e, sha256 };
}
function identity(): Identity {
  return {
    leaf: envId("OCV5_291_EXPECT_LEAF", /^[a-f0-9]{32}$/),
    root: envId("OCV5_291_EXPECT_ROOT", /^[a-f0-9]{32}$/),
    runNonce: envId("OCV5_291_EXPECT_RUN_NONCE", /^[a-f0-9]{24}$/),
    leaseEpoch: envId("OCV5_291_EXPECT_LEASE_EPOCH", /^[a-f0-9]{32}$/),
    sessionId: envId("OCV5_291_EXPECT_BOX_SESSION_ID",
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    turnKey: envId("OCV5_291_EXPECT_TURN_KEY", /^[a-f0-9]{64}$/),
    oldContainer: envId("OCV5_291_EXPECT_OLD_CONTAINER", /^[1-9][0-9]{0,9}$/),
    currentContainer: envId("OCV5_291_EXPECT_CURRENT_CONTAINER", /^[1-9][0-9]{0,9}$/),
    spoolSha256: envId("OCV5_291_EXPECT_SPOOL_SHA256", /^[a-f0-9]{64}$/),
  };
}
function tokenUsage(message: Record<string, unknown>) {
  const values = [message.inputTokens, message.outputTokens,
    message.cacheReadTokens, message.cacheWriteTokens];
  guard(values.every((value) => Number.isSafeInteger(value) && Number(value) >= 0),
    "BOX_ORPHAN_MESSAGE_USAGE_INVALID");
  return { input_tokens: Number(values[0]), output_tokens: Number(values[1]),
    cache_read_tokens: Number(values[2]), cache_write_tokens: Number(values[3]) };
}
function validCancelIntent(value: unknown, leaf: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const x = value as Record<string, unknown>;
  return Object.keys(x).sort().join(",") === "atMs,reason,requestId,v"
    && x.v === 1 && x.reason === "user_cancel" && x.requestId === leaf
    && Number.isSafeInteger(x.atMs) && Number(x.atMs) > 0;
}
async function lock(client: PoolClient, keys: string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",
      [key]);
  }
}
async function rows(client: Pick<Pool, "query"> | PoolClient, id: Identity,
  forUpdate: boolean): Promise<{ leaf: Row; root: Row }> {
  const found = await client.query<Row>(
    `SELECT request_id,container_id::text,state,ctx
       FROM request_finalize_journal
      WHERE user_id=$1 AND request_id=ANY($2::text[])
      ORDER BY request_id ${forUpdate ? "FOR UPDATE" : ""}`,
    [UID.toString(), [id.leaf, id.root]]);
  const leaf = found.rows.find((row) => row.request_id === id.leaf);
  const root = found.rows.find((row) => row.request_id === id.root);
  guard(found.rowCount === 2 && leaf && root, "BOX_ORPHAN_ROWS_MISSING");
  return { leaf, root };
}
async function verifyContainers(client: Pick<Pool, "query"> | PoolClient,
  id: Identity): Promise<void> {
  const found = await client.query<{ id: string; state: string }>(
    `SELECT id::text,state FROM agent_containers WHERE user_id=$1
      AND runtime_channel='v5' AND id IN ($2::bigint,$3::bigint)`,
    [UID.toString(), id.oldContainer, id.currentContainer]);
  const active = await client.query<{ id: string }>(
    `SELECT id::text FROM agent_containers WHERE user_id=$1
      AND state='active' AND runtime_channel='v5'`, [UID.toString()]);
  guard(id.oldContainer !== id.currentContainer && found.rowCount === 2
    && found.rows.some((row) => row.id === id.oldContainer && row.state === "vanished")
    && found.rows.some((row) => row.id === id.currentContainer && row.state === "active")
    && active.rowCount === 1 && active.rows[0]?.id === id.currentContainer,
  "BOX_ORPHAN_CONTAINER_BOUNDARY_INVALID");
}
function verifyChain(pair: { leaf: Row; root: Row }, id: Identity,
  evidence: HistoricalEvidence) {
  const { leaf, root } = pair, l = leaf.ctx, r = root.ctx;
  guard(leaf.state === "committed" && root.state === "committed"
    && leaf.container_id === id.oldContainer && root.container_id === id.oldContainer
    && l.boxState === "handoff" && r.boxState === "resuming"
    && l.boxInvocationRecovery === "v1" && r.boxInvocationRecovery === "v1"
    && l.boxInvocationMode === "detached_tool" && r.boxInvocationMode === "detached_tool"
    && l.model === "box-api-claude-opus-5-5" && r.model === l.model
    && l.boxAccountId === ACCOUNT.toString() && r.boxAccountId === l.boxAccountId
    && l.boxRunNonce === id.runNonce && r.boxRunNonce === id.runNonce
    && l.boxLeaseEpoch === id.leaseEpoch && r.boxLeaseEpoch === id.leaseEpoch
    && l.boxSessionId === id.sessionId && r.boxSessionId === id.sessionId
    && l.boxTurnKey === id.turnKey && r.boxTurnKey === id.turnKey
    && l.boxOwnerRequestId === id.root && r.boxResumeRequestId === id.leaf
    && r.boxOwnerRequestId === undefined && l.boxResumeRequestId === undefined
    && (r.boxRoundNo === undefined || r.boxRoundNo === 1)
    && l.boxRoundNo === 2
    && r.boxLaunchPermit === true
    && r.boxReplayRequired === true && l.boxReplayRequired === true
    && r.boxHandoffRevision === evidence.rootHandoffRevision
    && r.boxResumeRevision === evidence.rootResumeRevision
    && l.boxParentResumeRevision === evidence.rootResumeRevision
    && l.boxHandoffRevision === evidence.leafHandoffRevision
    && l.boxTerminalProof === undefined && r.boxTerminalProof === undefined
    && l.boxCancelIntent !== undefined && validCancelIntent(l.boxCancelIntent, id.leaf)
    && isDeepStrictEqual(l.boxCancelIntent, r.boxCancelIntent)
    && l.boxRemoteCleanup === undefined && r.boxRemoteCleanup === undefined
    && typeof l.boxReplayFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(l.boxReplayFingerprint)
    && typeof r.boxReplayFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(r.boxReplayFingerprint)
    && typeof l.boxFallbackAlias === "string"
    && /^[a-f0-9]{64}$/.test(l.boxFallbackAlias)
    && typeof r.boxFallbackAlias === "string"
    && /^[a-f0-9]{64}$/.test(r.boxFallbackAlias),
  "BOX_ORPHAN_CHAIN_INVALID");
  const first = parseBoxStoredToolHandoff(r.boxToolHandoff);
  const second = parseBoxStoredToolHandoff(l.boxToolHandoff);
  const firstPointer = parseBoxReplayMessagePointer(r.boxReplayMessage);
  const secondPointer = parseBoxReplayMessagePointer(l.boxReplayMessage);
  guard(first && second && firstPointer && secondPointer
    && first.roundNo === 1 && second.roundNo === 2
    && first.spoolOffset === 20801 && second.spoolOffset === 44313
    && first.detachedRunnerHash === second.detachedRunnerHash
    && first.catalogHash === second.catalogHash
    && firstPointer.requestId === id.root && secondPointer.requestId === id.leaf
    && firstPointer.roundNo === 1 && secondPointer.roundNo === 2
    && firstPointer.runNonce === id.runNonce && secondPointer.runNonce === id.runNonce
    && firstPointer.leaseEpoch === id.leaseEpoch
    && secondPointer.leaseEpoch === id.leaseEpoch
    && evidence.messages.length === 5
    && evidence.messages[0]?.endOffset === first.spoolOffset
    && evidence.messages[1]?.endOffset === second.spoolOffset
    && isDeepStrictEqual(tokenUsage(evidence.messages[0]!), {
      input_tokens: first.usage.inputTokens, output_tokens: first.usage.outputTokens,
      cache_read_tokens: first.usage.cacheReadTokens,
      cache_write_tokens: first.usage.cacheWriteTokens })
    && isDeepStrictEqual(tokenUsage(evidence.messages[1]!), {
      input_tokens: second.usage.inputTokens, output_tokens: second.usage.outputTokens,
      cache_read_tokens: second.usage.cacheReadTokens,
      cache_write_tokens: second.usage.cacheWriteTokens })
    && evidence.messages.slice(2).every((message) => message.afterHandoff === true)
    && evidence.messages.slice(0, 4).every((message) => message.stopReason === "tool_use")
    && evidence.messages[4]?.stopReason === "end_turn"
    && evidence.observedTotalUsage.inputTokens
      === evidence.messages.reduce((n, item) => n + item.inputTokens, 0)
    && evidence.observedTotalUsage.outputTokens
      === evidence.messages.reduce((n, item) => n + item.outputTokens, 0)
    && evidence.observedTotalUsage.cacheReadTokens
      === evidence.messages.reduce((n, item) => n + item.cacheReadTokens, 0)
    && evidence.observedTotalUsage.cacheWriteTokens
      === evidence.messages.reduce((n, item) => n + item.cacheWriteTokens, 0)
    && evidence.spoolSha256 === id.spoolSha256,
  "BOX_ORPHAN_EVIDENCE_INVALID");
  const pricing = parseBillingPricing(r.billingPricing, "box-api-claude-opus-5-5");
  guard(pricing && isDeepStrictEqual(r.billingPricing, l.billingPricing),
    "BOX_ORPHAN_PRICING_INVALID");
  return { first, second, firstPointer, secondPointer, pricing };
}

async function verifyLedger(client: Pick<Pool, "query"> | PoolClient,
  pair: { leaf: Row; root: Row }, evidence: HistoricalEvidence,
  pricing: NonNullable<ReturnType<typeof parseBillingPricing>>) {
  const usage = await client.query<{ request_id: string; id: string;
    status: string; cost_credits: string; debit: string }>(
    `SELECT ur.request_id,ur.id::text,ur.status,ur.cost_credits::text,
       COALESCE(SUM(-cl.delta),0)::text AS debit
       FROM usage_records ur LEFT JOIN credit_ledger cl ON cl.user_id=ur.user_id
         AND cl.reason='chat' AND cl.ref_type='usage_record'
         AND cl.ref_id=ur.id::text AND cl.delta<0
      WHERE ur.user_id=$1 AND ur.request_id=ANY($2::text[])
      GROUP BY ur.request_id,ur.id,ur.status,ur.cost_credits`,
    [UID.toString(), [pair.root.request_id, pair.leaf.request_id]]);
  guard(usage.rowCount === 2, "BOX_ORPHAN_BILLING_EVIDENCE_INVALID");
  guard(isDeepStrictEqual(usage.rows.map((row) => row.id).sort(),
    [...evidence.priorUsageRecordIds].sort()),
  "BOX_ORPHAN_BILLING_EVIDENCE_INVALID");
  for (const [index, id] of [pair.root.request_id, pair.leaf.request_id].entries()) {
    const row = usage.rows.find((item) => item.request_id === id);
    const cost = computeCost(tokenUsage(evidence.messages[index]!), pricing).cost_credits;
    guard(row && row.status === "success" && BigInt(row.cost_credits) === cost
      && BigInt(row.debit) >= cost,
    "BOX_ORPHAN_BILLING_EVIDENCE_INVALID");
  }
  const writeOffFen = evidence.messages.slice(2).reduce((total, message) =>
    total + computeCost(tokenUsage(message), pricing).cost_credits, 0n);
  guard(writeOffFen.toString() === evidence.writeOffFen,
    "BOX_ORPHAN_WRITE_OFF_INVALID");
  return { usageIds: usage.rows.map((row) => row.id).sort(),
    writeOffFen: writeOffFen.toString() };
}

export async function runOrphanWriteoff(pool: Pick<Pool, "query" | "connect">,
  mode: "--dry-run" | "--release") {
  guard(["--dry-run", "--release"].includes(mode), "BOX_ORPHAN_MODE_INVALID");
  guard(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OC_USER_ID === "3"
    && process.env.OC_SESSION_KEY === "agent:main:webchat:dm:webmuehg8n99a9p4i"
    && process.env.OCV5_291_TICKET === "OCV5-291",
  "BOX_ORPHAN_SELFHOST_BOUNDARY_INVALID");
  const id = identity();
  guard(id.leaf !== id.root, "BOX_ORPHAN_IDENTITY_INVALID");
  const { value: evidence, sha256: evidenceSha256 } = historicalEvidence(id);
  if (mode === "--release") guard(
    process.env.OCV5_291_EXCEPTION_RELEASE_ACK === "1"
      && process.env.OCV5_291_APPROVAL_REF === evidence.approval.ref,
    "BOX_ORPHAN_APPROVAL_REQUIRED");
    const db = await pool.query<{ current_database: string }>("SELECT current_database()");
    guard(db.rows[0]?.current_database === "openclaude_v5_selfhost",
      "BOX_ORPHAN_DATABASE_BOUNDARY_INVALID");
    const previous = await rows(pool, id, false);
    if (previous.leaf.ctx.boxState === "orphan_exception_closed"
      || previous.root.ctx.boxState === "orphan_exception_closed") {
      guard([previous.leaf, previous.root].every((row) => {
        const audit = row.ctx.boxOrphanException as Record<string, unknown> | undefined;
        return row.state === "committed" && row.ctx.boxState === "orphan_exception_closed"
          && row.ctx.boxTerminalProof === undefined
          && row.ctx.boxUsage === undefined
          && row.ctx.boxToolHandoff === undefined
          && row.ctx.boxReplayMessage === undefined
          && typeof row.ctx.boxReplayFingerprint === "string"
          && typeof row.ctx.boxFallbackAlias === "string"
          && audit?.evidenceSha256 === evidenceSha256
          && audit?.approvalRef === evidence.approval.ref
          && audit?.writeOffFen === evidence.writeOffFen;
      }), "BOX_ORPHAN_IDEMPOTENT_CONFLICT");
      return { status: "already_closed", leaf: id.leaf,
        root: id.root, walletWrites: 0, remoteCleanup: "unverified" };
    }
    const plan = async (client: Pick<Pool, "query"> | PoolClient,
      forUpdate: boolean) => {
      await verifyContainers(client, id);
      const pair = await rows(client, id, forUpdate);
      const verified = verifyChain(pair, id, evidence);
      const billing = await verifyLedger(client, pair, evidence, verified.pricing);
      const held = await client.query<{ request_id: string }>(
        `SELECT request_id FROM request_finalize_journal
          WHERE ctx->>'boxState'=ANY($2::text[])
            AND (ctx->>'boxAccountId'=$1 OR
              (user_id=$3 AND ctx->>'boxSessionId'=$4))`,
        [ACCOUNT.toString(), ACTIVE, UID.toString(), id.sessionId]);
      guard(held.rowCount === 2
        && held.rows.some((item) => item.request_id === id.root)
        && held.rows.some((item) => item.request_id === id.leaf),
      "BOX_ORPHAN_OTHER_CAPACITY_HELD");
      return { pair, verified, billing };
    };
    if (mode === "--dry-run") {
      const { billing } = await plan(pool, false);
      return { mode: "dry_run", leaf: id.leaf,
        root: id.root, proofStatus: evidence.historicalProof.status,
        spoolSha256: evidence.spoolSha256, writeOffFen: billing.writeOffFen,
        priorUsageIds: billing.usageIds, walletWrites: 0, remoteCleanupCalls: 0 };
    }
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      // Pre-lock peek only obtains the advisory keys. All identities and costs
      // are rechecked under the same lock plus sorted row locks below.
      const peek = await rows(client, id, false);
      const fingerprints = [peek.root.ctx.boxReplayFingerprint,
        peek.leaf.ctx.boxReplayFingerprint];
      guard(fingerprints.every((value) => typeof value === "string"
        && /^[a-f0-9]{64}$/.test(value)), "BOX_ORPHAN_FINGERPRINT_INVALID");
      await lock(client, [`box:account:${ACCOUNT}`,
        ...fingerprints.map((value) => `box:fingerprint:${value}`),
        `box:session:${UID}:${id.sessionId}`]);
      const { pair, billing } = await plan(client, true);
      const shared = { v: 1, kind: "user_approved_exception_no_current_proof",
        ticket: "OCV5-291", rootRequestId: id.root, leafRequestId: id.leaf,
        accountId: ACCOUNT.toString(), runNonce: id.runNonce,
        leaseEpoch: id.leaseEpoch, evidenceSha256, spoolSha256: evidence.spoolSha256,
        spoolBytes: evidence.spoolBytes, historicalProof: evidence.historicalProof,
        currentRemoteProof: "unavailable", remotePrivacy: "unknown",
        remoteCleanup: "unverified", messages: evidence.messages,
        priorUsageRecordIds: billing.usageIds, writeOffFen: billing.writeOffFen,
        approvalRef: evidence.approval.ref, approvalChoice: evidence.approval.choice,
        userDebitFen: "0" };
      for (const row of [pair.root, pair.leaf]) {
        const patch = { boxState: "orphan_exception_closed",
          boxRemoteCleanup: "unverified", boxRemotePrivacy: "unknown",
          boxOrphanException: { ...shared, priorState: row.ctx.boxState,
            priorHandoff: row.ctx.boxToolHandoff,
            priorReplayMessage: row.ctx.boxReplayMessage } };
        const changed = await client.query(
          `UPDATE request_finalize_journal
              SET ctx=(ctx - 'boxToolHandoff' - 'boxReplayMessage') || $4::jsonb,
                  updated_at=NOW()
            WHERE request_id=$1 AND user_id=$2 AND state='committed'
              AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxState'=$5
              AND ctx->>'boxReplayFingerprint'=$6
              AND ctx->>'boxFallbackAlias'=$7
              AND ctx->'boxCancelIntent'=$8::jsonb
              AND ctx ? 'boxToolHandoff' AND ctx ? 'boxReplayMessage'
              AND NOT (ctx ? 'boxTerminalProof')`,
          [row.request_id, UID.toString(), id.leaseEpoch, JSON.stringify(patch),
            row.ctx.boxState, row.ctx.boxReplayFingerprint,
            row.ctx.boxFallbackAlias, JSON.stringify(row.ctx.boxCancelIntent)]);
        guard(changed.rowCount === 1, "BOX_ORPHAN_CAS_LOST");
      }
      await client.query("COMMIT"); committed = true;
      return { status: "exception_closed", leaf: id.leaf,
        root: id.root, evidenceSha256, writeOffFen: billing.writeOffFen,
        walletWrites: 0, remoteCleanup: "unverified" };
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2] ?? "--dry-run";
  if (!["--dry-run", "--release"].includes(mode) || process.argv.length > 3) {
    process.stderr.write("BOX_ORPHAN_MODE_INVALID\n"); process.exitCode = 1;
  } else {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    void runOrphanWriteoff(pool, mode as "--dry-run" | "--release")
      .then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); },
        (error: unknown) => {
          process.stderr.write(error instanceof Error
            && /^BOX_[A-Z0-9_]+$/.test(error.message)
            ? error.message + "\n" : "BOX_ORPHAN_FAILED\n");
          process.exitCode = 1;
        }).finally(() => pool.end());
  }
}
