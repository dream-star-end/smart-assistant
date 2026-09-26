/** Box invocation fence on the existing request_finalize_journal.ctx JSONB.
 * No schema change. This is deliberately stricter than HTTP idempotency: an
 * identical body in one signed turn remains ambiguous and is never re-run. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { BoxCallFingerprint } from "./boxCallFingerprint.js";
import { parseBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";
import { parseBillingPricing } from "../../billing/persistedBillingPricing.js";
import { parseBoxBillingContext } from "./boxBillingContext.js";
import type { BoxToolHandoffCandidate, BoxToolHandoffProof } from "./boxCliToolHandoff.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash,
  hashBoxAssistantContent } from "./boxCallFingerprint.js";
import { matchBoxToolResults, type BoxMatchedToolResult } from "./boxToolResultMatcher.js";
import { hashBoxToolInput, type BoxToolUseDigest } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";
import { parseBoxStoredToolHandoff } from "./boxStoredToolHandoff.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { BOX_TOOL_SPOOL_MAX_BYTES, reserveBoxToolEcho } from "./boxToolCapacity.js";
import { normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";
import { parseBoxPrelaunchBootstrap, type BoxPrelaunchReceipt } from "./boxPrelaunchControl.js";
import { parseBoxNativePointer, type BoxNativePointer } from "./boxNativePointer.js";

const ACTIVE = ["reserved", "starting", "running", "unknown", "handoff", "resuming", "linked"];

export class BoxDurableJournalError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxDurableJournalError"; }
}

export interface BoxUsageEvidence {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
function validUsageEvidence(value: unknown): value is BoxUsageEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  const keys = ["cacheReadTokens", "cacheWriteTokens", "inputTokens", "outputTokens"];
  return Object.keys(usage).length === keys.length
    && keys.every((key) => Object.hasOwn(usage, key)
      && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0);
}
function validCancelIntent(value: unknown): value is {
  v: 1; reason: "user_cancel"; requestId: string; atMs: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return Object.keys(intent).sort().join(",") === "atMs,reason,requestId,v"
    && intent.v === 1 && intent.reason === "user_cancel"
    && typeof intent.requestId === "string"
    && /^[A-Za-z0-9_-]{1,64}$/.test(intent.requestId)
    && Number.isSafeInteger(intent.atMs) && Number(intent.atMs) > 0;
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface BoxJournalAdmission {
  requestId: string;
  uid: bigint;
  accountId: bigint;
  model: string;
  fingerprint: BoxCallFingerprint;
  runNonce: string;
  leaseEpoch: string;
  invocationMode?: "text" | "detached_tool";
  /** Hash of model-affecting context actually launched in the detached CLI. */
  contextHash?: string;
  /** Optional completed-turn native cache claim, never inferred from body hash. */
  nativeClaim?: { ownerRequestId: string; pointer: BoxNativePointer;
    upstreamModel: string };
  /** First native invocation mints an opaque Claude UUID in its own run cwd. */
  nativeStart?: { sessionId: string; cliCwd: string };
}
export interface BoxNativeCandidate {
  readonly ownerRequestId: string;
  readonly pointer: BoxNativePointer;
}
export interface BoxToolResumeClaim {
  readonly ownerRequestId: string;
  readonly accountId: bigint;
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly spoolOffset: number;
  readonly roundNo: number;
  readonly detachedRunnerHash: string;
  readonly catalogHash: string;
  readonly durableRevision: string;
  readonly results: readonly BoxMatchedToolResult[];
  readonly toolUses: readonly BoxToolUseDigest[];
  readonly nativeSessionId?: string;
  readonly nativeCliCwd?: string;
}
export interface BoxRemoteCleanupCandidate {
  readonly requestId: string;
  readonly uid: bigint;
  readonly accountId: bigint;
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly proof: BoxTerminalProof;
  /** Exact optional pointer observed when this cleanup candidate was read. */
  readonly nativePointer?: BoxNativePointer;
}
export interface BoxPrelaunchRecoveryCandidate {
  readonly requestId: string;
  readonly uid: bigint;
  readonly accountId: bigint;
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly receipt: BoxPrelaunchReceipt;
}
export interface BoxStoppedFailureProbeCandidate {
  readonly requestId: string;
  readonly uid: bigint;
  readonly accountId: bigint;
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly linked: boolean;
}

/** Cleanup never promotes a stopped failure to a successful model result. */
function cleanupProofMatchesState(state: unknown, proof: BoxTerminalProof): boolean {
  return state === "terminal" ? proof.reason === "worker_complete"
    : state === "failed_stopped" && proof.reason !== "worker_complete";
}

const CLEANUP_STATE_FENCE = `((ctx->>'boxState'='terminal'
  AND state IN ('inflight','finalizing','committed'))
  OR (ctx->>'boxState'='failed_stopped'
    AND (state='aborted' OR (state IN ('inflight','finalizing','committed')
      AND ctx ? 'boxToolHandoff'))))`;

const CLEANUP_PROOF_FENCE = `((ctx->>'boxState'='terminal'
  AND ctx->'boxTerminalProof'->>'reason'='worker_complete'
  AND state IN ('inflight','finalizing','committed'))
  OR (ctx->>'boxState'='failed_stopped'
    AND ctx->'boxTerminalProof'->>'reason' IN ('keeper_stopped','worker_failed')
    AND (state='aborted' OR (state IN ('inflight','finalizing','committed')
      AND ctx ? 'boxToolHandoff'))))`;

const STOP_PROBE_STATE_FENCE = `((state='inflight'
  AND ctx->>'boxState' IN ('running','unknown','linked')
  AND NOT (ctx ? 'boxToolHandoff'))
  OR (state IN ('inflight','finalizing','committed')
    AND ctx->>'boxState' IN ('handoff','unknown')
    AND ctx ? 'boxToolHandoff'))`;

export interface BoxJournalPort {
  admit(input: BoxJournalAdmission): Promise<void>;
  markRunning(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void>;
  markPrestartStopped(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void>;
  recordPrelaunchControl?(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> &
    { receipt: BoxPrelaunchReceipt }): Promise<void>;
  armGuardedLaunch?(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> &
    { receipt: BoxPrelaunchReceipt }): Promise<void>;
  markGuardedPrestartStopped?(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> &
    { receipt: BoxPrelaunchReceipt; cleanedReceipt: string }): Promise<void>;
  markUnknown(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { phase: string }): Promise<void>;
  recordUserCancelIntent?(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch">): Promise<void>;
  complete(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { proof: BoxTerminalProof; usage: BoxUsageEvidence }): Promise<void>;
  recordToolHandoff?(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { candidate: BoxToolHandoffCandidate;
      roundNo?: number;
      spoolOffset: number;
      detachedRunnerHash: string;
      catalogHash: string;
      verifiedPendingToolUseIds: readonly string[] }): Promise<BoxToolHandoffProof>;
  claimToolResume?(input: { requestId: string; uid: bigint;
    canonicalModel: string; canonicalBody: ProxyBody }): Promise<BoxToolResumeClaim>;
  completeToolChain?(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { proof: BoxTerminalProof; usage: BoxUsageEvidence }): Promise<void>;
  markToolChainStoppedFailure?(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "leaseEpoch"> & { proof: BoxTerminalProof }): Promise<void>;
}

function goodId(input: BoxJournalAdmission): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
    || input.uid <= 0n || input.accountId <= 0n
    || !/^[a-f0-9]{24}$/.test(input.runNonce)
    || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
    || !/^[a-f0-9]{64}$/.test(input.fingerprint.replayFingerprint)
    || !/^[a-f0-9]{64}$/.test(input.fingerprint.requestHash)
    || !/^[a-f0-9]{64}$/.test(input.fingerprint.turnKey)
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.fingerprint.sessionId)
    || (input.invocationMode !== undefined && input.invocationMode !== "text"
      && input.invocationMode !== "detached_tool")
    || (input.invocationMode === "detached_tool"
      && !/^[a-f0-9]{64}$/.test(input.contextHash ?? ""))
    || (input.nativeStart !== undefined && (input.nativeClaim !== undefined
      || !UUID_V4.test(input.nativeStart.sessionId)
      || input.nativeStart.cliCwd !== `/tmp/ocv5-289-run-${input.runNonce}`))
    || !/^(?:box-api-)?claude-[a-z0-9-]{3,64}$/.test(input.model)) {
    throw new BoxDurableJournalError("BOX_JOURNAL_IDENTITY_INVALID");
  }
}

async function lock(client: PoolClient, keys: string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
  }
}

/** Every multi-row transition and resume uses the session advisory lock
 * before taking any row lock. The later FOR UPDATE must revalidate this peek. */
async function lockChainSession(client: PoolClient, uid: bigint,
  requestId: string): Promise<string> {
  const found = await client.query<{ session_id: string }>(
    `SELECT ctx->>'boxSessionId' AS session_id FROM request_finalize_journal
      WHERE request_id=$1 AND user_id=$2`, [requestId, uid.toString()]);
  const sessionId = found.rows[0]?.session_id;
  if (found.rowCount !== 1 || typeof sessionId !== "string"
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) {
    throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
  }
  await lock(client, [`box:session:${uid}:${sessionId}`]);
  return sessionId;
}

export class BoxDurableJournal implements BoxJournalPort {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  /** An older pointer cannot be reused after an intervening uncached turn. */
  async findNativeCandidate(input: { uid: bigint; sessionId: string;
    currentRequestId: string;
    canonicalModel: string }): Promise<BoxNativeCandidate | null> {
    if (input.uid <= 0n || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.sessionId)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(input.currentRequestId)
      || !/^(?:box-api-)?claude-[a-z0-9-]{3,64}$/.test(input.canonicalModel)) return null;
    const found = await this.pool.query<{ request_id: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,ctx FROM request_finalize_journal
        WHERE user_id=$1 AND ctx->>'boxSessionId'=$2
          AND ctx->>'model'=$3 AND ctx->>'boxInvocationRecovery'='v1'
          AND request_id<>$4
        ORDER BY updated_at DESC, request_id DESC LIMIT 1`,
      [input.uid.toString(), input.sessionId, input.canonicalModel,
        input.currentRequestId]);
    const row = found.rows[0];
    if (found.rowCount !== 1 || !row || !row.ctx
      || row.ctx.boxState !== "terminal" || row.ctx.boxNativeClaimRequestId !== undefined
      || !/^[A-Za-z0-9_-]{1,64}$/.test(row.request_id)) return null;
    const pointer = parseBoxNativePointer(row.ctx.boxNativePointer);
    if (!pointer || row.ctx.boxAccountId !== pointer.accountId
      || row.ctx.boxSessionId !== input.sessionId
      || row.ctx.model !== input.canonicalModel) return null;
    const proof = row.ctx.boxTerminalProof;
    if (!proof || typeof proof !== "object" || Array.isArray(proof)
      || (proof as { reason?: unknown }).reason !== "worker_complete") return null;
    return { ownerRequestId: row.request_id, pointer };
  }

  async admit(input: BoxJournalAdmission): Promise<void> {
    goodId(input);
    const native = input.nativeClaim;
    if (native && (!/^[A-Za-z0-9_-]{1,64}$/.test(native.ownerRequestId)
      || native.ownerRequestId === input.requestId
      || parseBoxNativePointer(native.pointer) === null
      || native.pointer.accountId !== input.accountId.toString()
      || native.pointer.upstreamModel !== native.upstreamModel)) {
      throw new BoxDurableJournalError("BOX_NATIVE_CLAIM_INVALID");
    }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await lock(client, [
        `box:account:${input.accountId}`, `box:fingerprint:${input.fingerprint.replayFingerprint}`,
        `box:session:${input.uid}:${input.fingerprint.sessionId}`,
      ]);
      const duplicate = await client.query(
        "SELECT 1 FROM request_finalize_journal WHERE ctx->>'boxReplayFingerprint' = $1 LIMIT 1",
        [input.fingerprint.replayFingerprint]);
      if (duplicate.rowCount) throw new BoxDurableJournalError("BOX_CALL_AMBIGUOUS");
      const occupied = await client.query(
        `SELECT 1 FROM request_finalize_journal
          WHERE ctx->>'boxState' = ANY($1::text[])
            AND (ctx->>'boxAccountId' = $2 OR
              (user_id = $3 AND ctx->>'boxSessionId' = $4)) LIMIT 1`,
        [ACTIVE, input.accountId.toString(), input.uid.toString(), input.fingerprint.sessionId]);
      if (occupied.rowCount) throw new BoxDurableJournalError("BOX_CAPACITY_HELD");
      if (native) {
        // The candidate was read before the account/turn locks. A completed
        // intervening turn can make it stale without leaving ACTIVE capacity.
        const latest = await client.query<{ request_id: string }>(
          `SELECT request_id FROM request_finalize_journal
            WHERE user_id=$1 AND ctx->>'boxSessionId'=$2
              AND ctx->>'model'=$3 AND ctx->>'boxInvocationRecovery'='v1'
              AND request_id<>$4
            ORDER BY updated_at DESC, request_id DESC LIMIT 1 FOR UPDATE`,
          [input.uid.toString(), input.fingerprint.sessionId,
            input.model, input.requestId]);
        if (latest.rowCount !== 1
          || latest.rows[0]?.request_id !== native.ownerRequestId) {
          throw new BoxDurableJournalError("BOX_NATIVE_CLAIM_LOST");
        }
        const prior = await client.query<{ ctx: Record<string, unknown> }>(
          `SELECT ctx FROM request_finalize_journal
            WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
          [native.ownerRequestId, input.uid.toString()]);
        const ctx = prior.rows[0]?.ctx;
        if (prior.rowCount !== 1 || !ctx || ctx.boxState !== "terminal"
          || ctx.boxInvocationRecovery !== "v1"
          || ctx.boxAccountId !== input.accountId.toString()
          || ctx.boxSessionId !== input.fingerprint.sessionId
          || ctx.model !== input.model
          || ctx.boxNativeClaimRequestId !== undefined
          || !isDeepStrictEqual(ctx.boxNativePointer, native.pointer)
          || !ctx.boxTerminalProof || typeof ctx.boxTerminalProof !== "object"
          || (ctx.boxTerminalProof as { reason?: unknown }).reason !== "worker_complete") {
          throw new BoxDurableJournalError("BOX_NATIVE_CLAIM_LOST");
        }
        const claimed = await client.query(
          `UPDATE request_finalize_journal
              SET ctx=ctx || $3::jsonb, updated_at=NOW()
            WHERE request_id=$1 AND user_id=$2
              AND ctx->>'boxState'='terminal' AND NOT (ctx ? 'boxNativeClaimRequestId')`,
          [native.ownerRequestId, input.uid.toString(),
            JSON.stringify({ boxNativeClaimRequestId: input.requestId })]);
        if (claimed.rowCount !== 1) throw new BoxDurableJournalError("BOX_NATIVE_CLAIM_LOST");
      }
      const identity = { boxInvocationRecovery: "v1", boxState: "reserved",
        boxInvocationMode: input.invocationMode ?? "text",
        boxAccountId: input.accountId.toString(),
        boxReplayFingerprint: input.fingerprint.replayFingerprint,
        boxRequestHash: input.fingerprint.requestHash,
        boxTurnKey: input.fingerprint.turnKey,
        boxSessionId: input.fingerprint.sessionId,
        ...(input.invocationMode === "detached_tool"
          ? { boxContextHash: input.contextHash } : {}),
        boxRunNonce: input.runNonce, boxLeaseEpoch: input.leaseEpoch,
        ...(native ? { boxNativeOwnerRequestId: native.ownerRequestId,
          boxNativeSessionId: native.pointer.nativeSessionId,
          boxNativeCliCwd: native.pointer.cliCwd } : {}),
        ...(input.nativeStart ? { boxNativeSessionId: input.nativeStart.sessionId,
          boxNativeCliCwd: input.nativeStart.cliCwd } : {}) };
      const updated = await client.query<{ ctx: Record<string, unknown> }>(
        `UPDATE request_finalize_journal
            SET ctx = ctx || $4::jsonb, updated_at = NOW()
          WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
            AND ctx->>'model' = $3 AND ctx->>'boxInvocationRecovery' = 'v1'
            AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'
            AND NOT (ctx ? 'boxState')
          RETURNING ctx`,
        [input.requestId, input.uid.toString(), input.model, JSON.stringify(identity)]);
      if (updated.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_NOT_INFLIGHT");
      const ctx = updated.rows[0]?.ctx;
      const billingContext = parseBoxBillingContext(ctx?.boxBillingContext);
      if (!parseBillingPricing(ctx?.billingPricing, input.model)
        || !billingContext || billingContext.turnKey !== input.fingerprint.turnKey) {
        throw new BoxDurableJournalError("BOX_JOURNAL_BASIS_INVALID");
      }
      await client.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async markRunning(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void> {
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = jsonb_set(ctx, '{boxState}', '"running"'::jsonb), updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
          AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxState' = 'reserved'
          AND NOT (ctx ? 'boxPrelaunchControl')`,
      [input.requestId, input.uid.toString(), input.leaseEpoch]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_START_FENCE_LOST");
  }

  /** Only the caller that has not invoked plan.run may use this transition. */
  async markPrestartStopped(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void> {
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = jsonb_set(ctx, '{boxState}', '"prestart_stopped"'::jsonb),
              updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
          AND ctx->>'boxLeaseEpoch' = $3
          AND ctx->>'boxState' IN ('reserved', 'running')
          AND NOT (ctx ? 'boxPrelaunchControl')`,
      [input.requestId, input.uid.toString(), input.leaseEpoch]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_PRESTART_FENCE_LOST");
  }

  /** Persist the exact remote lock/control identity before the first private
   * stage Exec. Failure or an ambiguous DB response must not dispatch input. */
  async recordPrelaunchControl(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> &
    { receipt: BoxPrelaunchReceipt }): Promise<void> {
    this.validatePrelaunchReceipt(input);
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || $6::jsonb, updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND state='inflight'
          AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
          AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->>'boxState'='reserved'
          AND NOT (ctx ? 'boxPrelaunchControl')
          AND NOT (ctx ? 'boxLaunchPermit')`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch,
        JSON.stringify({ boxPrelaunchControl: input.receipt })]);
    if (changed.rowCount !== 1) {
      throw new BoxDurableJournalError("BOX_PRELAUNCH_CONTROL_FENCE_LOST");
    }
  }

  /** The unique durable launch permit. Recovery must not run prelaunch
   * cleanup after this CAS, even if no paid CLI output has been observed. */
  async armGuardedLaunch(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> &
    { receipt: BoxPrelaunchReceipt }): Promise<void> {
    this.validatePrelaunchReceipt(input);
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || '{"boxState":"running","boxLaunchPermit":true}'::jsonb,
              updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND state='inflight'
          AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
          AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->>'boxState'='reserved'
          AND ctx->'boxPrelaunchControl'=$6::jsonb
          AND NOT (ctx ? 'boxLaunchPermit')
          AND NOT (ctx ? 'boxPrelaunchCleanup')`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch, JSON.stringify(input.receipt)]);
    if (changed.rowCount !== 1) {
      throw new BoxDurableJournalError("BOX_PRELAUNCH_ARM_FENCE_LOST");
    }
  }

  /** Remote CLEANED is necessary but not sufficient: this CAS also proves
   * that the journal never armed a paid launch. */
  async markGuardedPrestartStopped(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> &
    { receipt: BoxPrelaunchReceipt; cleanedReceipt: string }): Promise<void> {
    this.validatePrelaunchReceipt(input);
    if (input.cleanedReceipt !== `cleaned:${input.receipt.identityHash}`) {
      throw new BoxDurableJournalError("BOX_PRELAUNCH_CLEAN_EVIDENCE_INVALID");
    }
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || $7::jsonb, updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND state='inflight'
          AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
          AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->>'boxState' IN ('reserved','unknown')
          AND ctx->'boxPrelaunchControl'=$6::jsonb
          AND NOT (ctx ? 'boxLaunchPermit')
          AND NOT (ctx ? 'boxTerminalProof')`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch, JSON.stringify(input.receipt),
        JSON.stringify({ boxState: "prestart_stopped",
          boxPrelaunchCleanup: { v: 1, receipt: input.cleanedReceipt } })]);
    if (changed.rowCount !== 1) {
      throw new BoxDurableJournalError("BOX_PRELAUNCH_STOP_FENCE_LOST");
    }
  }

  private validatePrelaunchReceipt(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"> &
    { receipt: BoxPrelaunchReceipt }): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || input.accountId <= 0n || input.receipt.runNonce !== input.runNonce
      || input.receipt.leaseEpoch !== input.leaseEpoch
      || input.receipt.accountId !== input.accountId.toString()) {
      throw new BoxDurableJournalError("BOX_PRELAUNCH_IDENTITY_INVALID");
    }
    try {
      const sorted = Object.fromEntries(Object.entries(input.receipt)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      parseBoxPrelaunchBootstrap(JSON.stringify(sorted), input.receipt);
    }
    catch { throw new BoxDurableJournalError("BOX_PRELAUNCH_IDENTITY_INVALID"); }
  }

  async markUnknown(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { phase: string }): Promise<void> {
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = ctx || $4::jsonb, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2
          AND ctx->>'boxLeaseEpoch' = $3
          AND ctx->>'boxState' = ANY($5::text[])`,
      [input.requestId, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "unknown", boxUnknownPhase: input.phase.slice(0, 80) }), ACTIVE]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_UNKNOWN_FENCE_LOST");
  }

  /** A user stop is durable intent, not a terminal or release event. The
   * original keeper must still prove all descendants stopped. */
  async recordUserCancelIntent(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch">): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || input.accountId <= 0n || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) {
      throw new BoxDurableJournalError("BOX_CANCEL_IDENTITY_INVALID");
    }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      // claimToolResume acquires this same advisory lock before row locks. A
      // pre-lock read only finds its key; all identity is rechecked below.
      const peek = await client.query<{ ctx: Record<string, unknown> }>(
        `SELECT ctx FROM request_finalize_journal WHERE request_id=$1 AND user_id=$2`,
        [input.requestId, input.uid.toString()]);
      const sessionId = peek.rows[0]?.ctx?.boxSessionId;
      if (peek.rowCount !== 1 || typeof sessionId !== "string"
        || !/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) {
        throw new BoxDurableJournalError("BOX_CANCEL_IDENTITY_INVALID");
      }
      await lock(client, [`box:session:${input.uid}:${sessionId}`]);
      const found = await client.query<{ state: string; ctx: Record<string, unknown> }>(
        `SELECT state,ctx FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.requestId, input.uid.toString()]);
      const row = found.rows[0], ctx = row?.ctx;
      if (found.rowCount !== 1 || !row || !ctx
        || ctx.boxInvocationRecovery !== "v1"
        || ctx.boxInvocationMode !== "detached_tool"
        || ctx.boxAccountId !== input.accountId.toString()
        || ctx.boxRunNonce !== input.runNonce
        || ctx.boxLeaseEpoch !== input.leaseEpoch
        || ctx.boxSessionId !== sessionId
        || typeof ctx.boxTurnKey !== "string"
        || !/^[a-f0-9]{64}$/.test(ctx.boxTurnKey)
        || typeof ctx.model !== "string") {
        throw new BoxDurableJournalError("BOX_CANCEL_IDENTITY_INVALID");
      }
      const prior = ctx.boxCancelIntent;
      if (prior !== undefined && !validCancelIntent(prior)) {
        throw new BoxDurableJournalError("BOX_CANCEL_CONFLICT");
      }
      if (prior === undefined && (!["inflight", "finalizing", "committed"].includes(row.state)
        || !ACTIVE.includes(String(ctx.boxState))
        || ctx.boxTerminalProof !== undefined)) {
        throw new BoxDurableJournalError("BOX_CANCEL_NOT_ACTIVE");
      }
      const active = await client.query<{ request_id: string; state: string;
        ctx: Record<string, unknown> }>(
        `SELECT request_id,state,ctx FROM request_finalize_journal
          WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
            AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
            AND ctx->>'boxState'=ANY($5::text[])
          ORDER BY request_id FOR UPDATE`,
        [input.uid.toString(), input.accountId.toString(), input.runNonce,
          input.leaseEpoch, ACTIVE]);
      const intent = prior ?? { v: 1, reason: "user_cancel",
        requestId: input.requestId, atMs: Date.now() };
      for (const current of active.rows) {
        const linked = current.ctx;
        if (linked.boxInvocationRecovery !== "v1"
          || linked.boxInvocationMode !== "detached_tool"
          || linked.boxSessionId !== sessionId
          || linked.boxTurnKey !== ctx.boxTurnKey
          || linked.model !== ctx.model
          || !["inflight", "finalizing", "committed"].includes(current.state)
          || linked.boxTerminalProof !== undefined
          || (linked.boxCancelIntent !== undefined
            && (!validCancelIntent(linked.boxCancelIntent)
              || !isDeepStrictEqual(linked.boxCancelIntent, intent)))) {
          throw new BoxDurableJournalError("BOX_CANCEL_CHAIN_INVALID");
        }
        if (linked.boxCancelIntent !== undefined) continue;
        const changed = await client.query(
          `UPDATE request_finalize_journal SET ctx=ctx || $5::jsonb
            WHERE request_id=$1 AND user_id=$2
              AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
              AND ctx->>'boxState'=ANY($6::text[])
              AND NOT (ctx ? 'boxCancelIntent')`,
          [current.request_id, input.uid.toString(), input.runNonce,
            input.leaseEpoch, JSON.stringify({ boxCancelIntent: intent }), ACTIVE]);
        if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_CANCEL_FENCE_LOST");
      }
      if (active.rowCount === 0 && prior === undefined) {
        throw new BoxDurableJournalError("BOX_CANCEL_FENCE_LOST");
      }
      await client.query("COMMIT"); committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  /** A failed first detached round may release capacity only after the exact
   * keeper proves every descendant stopped. No usage or success is inferred. */
  async markFirstRoundStoppedFailure(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "leaseEpoch"> & { proof: BoxTerminalProof }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
      || !input.proof || input.proof.reason === "worker_complete") {
      throw new BoxDurableJournalError("BOX_FAILED_STOP_EVIDENCE_INVALID");
    }
    try { parseBoxTerminalProof(JSON.stringify(input.proof) + "\n", {
      runNonce: input.proof.runNonce, leaseEpoch: input.leaseEpoch }); }
    catch { throw new BoxDurableJournalError("BOX_FAILED_STOP_EVIDENCE_INVALID"); }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const found = await client.query<{ state: string; ctx: Record<string, unknown> }>(
        `SELECT state,ctx FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.requestId, input.uid.toString()]);
      const row = found.rows[0], ctx = row?.ctx;
      if (found.rowCount !== 1 || !row || !ctx
        || ctx.boxInvocationRecovery !== "v1"
        || ctx.boxInvocationMode !== "detached_tool"
        || ctx.boxRunNonce !== input.proof.runNonce
        || ctx.boxLeaseEpoch !== input.leaseEpoch
        || typeof ctx.boxAccountId !== "string"
        || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
        || ctx.boxOwnerRequestId !== undefined
        || ctx.boxResumeRequestId !== undefined) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
      }
      const handoff = ctx.boxToolHandoff === undefined ? null
        : parseBoxStoredToolHandoff(ctx.boxToolHandoff);
      if (ctx.boxToolHandoff !== undefined && (!handoff || handoff.roundNo !== 1
        || typeof ctx.boxHandoffRevision !== "string"
        || !UUID_V4.test(ctx.boxHandoffRevision))) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
      }
      if ((handoff ? ["inflight", "finalizing", "committed"].includes(row.state)
        : row.state === "aborted") && ctx.boxState === "failed_stopped"
        && isDeepStrictEqual(ctx.boxTerminalProof, input.proof)) {
        await client.query("COMMIT"); committed = true; return;
      }
      if (handoff) {
        if (!["inflight", "finalizing", "committed"].includes(row.state)
          || !["handoff", "unknown"].includes(String(ctx.boxState))) {
          throw new BoxDurableJournalError("BOX_FAILED_STOP_FENCE_LOST");
        }
        const changed = await client.query(
          `UPDATE request_finalize_journal SET ctx=ctx || $4::jsonb
            WHERE request_id=$1 AND user_id=$2
              AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
              AND ctx->>'boxInvocationMode'='detached_tool'
              AND ctx->>'boxState' IN ('handoff','unknown')
              AND ctx ? 'boxToolHandoff' AND NOT (ctx ? 'boxOwnerRequestId')
              AND NOT (ctx ? 'boxResumeRequestId')
              AND state IN ('inflight','finalizing','committed')`,
          [input.requestId, input.uid.toString(), input.leaseEpoch,
            JSON.stringify({ boxState: "failed_stopped", boxTerminalProof: input.proof,
              boxStopOutcome: "failed" }), input.proof.runNonce]);
        if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_FAILED_STOP_FENCE_LOST");
        await client.query("COMMIT"); committed = true; return;
      }
      if (row.state !== "inflight" || !["running", "unknown"].includes(String(ctx.boxState))) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_FENCE_LOST");
      }
      const usage = await client.query(
        `SELECT 1 FROM usage_records WHERE request_id=$1 AND user_id=$2 LIMIT 1`,
        [input.requestId, input.uid.toString()]);
      if (usage.rowCount) throw new BoxDurableJournalError("BOX_FAILED_STOP_USAGE_CONFLICT");
      const changed = await client.query(
        `UPDATE request_finalize_journal
            SET state='aborted', failure_code='STREAM_FAILED',
                final_credits=0,
                ctx=ctx || $4::jsonb, updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2 AND state='inflight'
            AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
            AND ctx->>'boxInvocationMode'='detached_tool'
            AND ctx->>'boxState' IN ('running','unknown')
            AND NOT (ctx ? 'boxToolHandoff') AND NOT (ctx ? 'boxOwnerRequestId')
            AND NOT (ctx ? 'boxResumeRequestId')`,
        [input.requestId, input.uid.toString(), input.leaseEpoch,
          JSON.stringify({ boxState: "failed_stopped", boxTerminalProof: input.proof,
            boxStopOutcome: "failed" }), input.proof.runNonce]);
      if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_FAILED_STOP_FENCE_LOST");
      await client.query("COMMIT"); committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async complete(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { proof: BoxTerminalProof; usage: BoxUsageEvidence }): Promise<void> {
    const u = input.usage;
    if (input.proof.leaseEpoch !== input.leaseEpoch
      || input.proof.reason !== "worker_complete"
      || !validUsageEvidence(u)) {
      throw new BoxDurableJournalError("BOX_JOURNAL_EVIDENCE_INVALID");
    }
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = ctx || $4::jsonb, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
          AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxRunNonce' = $5
          AND ctx->>'boxState' IN ('running', 'unknown')
          AND ctx ? 'billingPricing'`,
      [input.requestId, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "terminal", boxUsage: u, boxTerminalProof: input.proof }),
        input.proof.runNonce]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_COMPLETE_FENCE_LOST");
  }

  /** Optional text cache publication AFTER exact terminal proof and billable
   * usage are durable. Detached runs remain ineligible until their shared
   * cleanup worker can preserve the native transcript. */
  async attachNativePointer(input: { requestId: string; uid: bigint;
    accountId: bigint; proof: BoxTerminalProof; pointer: BoxNativePointer }): Promise<boolean> {
    const pointer = parseBoxNativePointer(input.pointer);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || input.accountId <= 0n || !pointer
      || pointer.accountId !== input.accountId.toString()
      || input.proof.reason !== "worker_complete") return false;
    const ownerCwd = `/tmp/ocv5-289-run-${input.proof.runNonce}`;
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || $5::jsonb
        WHERE request_id=$1 AND user_id=$2
          AND ctx->>'boxAccountId'=$3 AND ctx->>'boxState'='terminal'
          AND (ctx->>'boxInvocationMode'='text' OR
            (ctx->>'boxInvocationMode'='detached_tool'
              AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'
              AND ctx->>'boxRemoteCleanupClaimed' IS DISTINCT FROM 'true'
              AND NOT (ctx ? 'boxRemoteCleanupQuarantine')))
          AND ctx->'boxTerminalProof'=$4::jsonb
          AND ctx ? 'boxUsage' AND NOT (ctx ? 'boxNativePointer')
          AND ((ctx ? 'boxNativeCliCwd' AND ctx->>'boxNativeCliCwd'=$6)
            OR (NOT (ctx ? 'boxNativeCliCwd')
              AND $6=$11 AND ctx->>'boxRunNonce'=$7))
          AND (ctx->>'boxNativeSessionId' IS NULL
            OR ctx->>'boxNativeSessionId'=$8)
          AND (ctx->>'boxContextHash' IS NULL
            OR ctx->>'boxContextHash'=$9)
          AND (ctx->>'boxCatalogHash' IS NULL
            OR ctx->>'boxCatalogHash'=$10)`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        JSON.stringify(input.proof), JSON.stringify({ boxNativePointer: pointer }),
        pointer.cliCwd, input.proof.runNonce, pointer.nativeSessionId,
        pointer.contextHashBeforeFinal, pointer.catalogHash, ownerCwd]);
    return changed.rowCount === 1;
  }

  /** The full model set and exact round usage must commit before the first
   * tool-use terminal SSE. A pending subset proves the CLI began dispatch;
   * later sidecar calls may appear only after earlier tool results. */
  async recordToolHandoff(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { candidate: BoxToolHandoffCandidate;
      roundNo?: number;
      spoolOffset: number;
      detachedRunnerHash: string;
      catalogHash: string;
      verifiedPendingToolUseIds: readonly string[] }): Promise<BoxToolHandoffProof> {
    const candidate = input.candidate;
    const roundNo = input.roundNo ?? 1;
    const toolUses = candidate && Array.isArray(candidate.toolUses) ? candidate.toolUses : [];
    const ids = toolUses.map((use) => use?.id ?? "");
    const pending = input.verifiedPendingToolUseIds;
    const usage = { inputTokens: candidate?.inputTokens,
      outputTokens: candidate?.outputTokens,
      cacheReadTokens: candidate?.cacheReadTokens,
      cacheWriteTokens: candidate?.cacheWriteTokens };
    if (!Number.isSafeInteger(roundNo) || roundNo < 1 || roundNo > 32
      || !candidate || typeof candidate.messageId !== "string"
      || candidate.messageId.length < 1 || candidate.messageId.length > 128
      || typeof candidate.assistantContentHash !== "string"
      || !/^[a-f0-9]{64}$/.test(candidate.assistantContentHash)
      || (candidate.assistantEchoHash !== undefined
        && (typeof candidate.assistantEchoHash !== "string"
          || !/^[a-f0-9]{64}$/.test(candidate.assistantEchoHash)))
      || typeof candidate.assistantNoCallerHash !== "string"
      || !/^[a-f0-9]{64}$/.test(candidate.assistantNoCallerHash)
      || ids.length < 1 || ids.length > 32 || new Set(ids).size !== ids.length
      || ids.some((id) => typeof id !== "string"
        || !/^toolu_[A-Za-z0-9_-]{1,120}$/.test(id))
      || Array.from({ length: toolUses.length }, (_, index) => index)
        .some((index) => !Object.hasOwn(toolUses, index))
      || toolUses.some((use) => !use
        || typeof use.boxName !== "string"
        || !/^mcp__ocbridge__t[0-9]{1,3}$/.test(use.boxName)
        || typeof use.clientName !== "string" || use.clientName.length < 1
        || !use.input || typeof use.input !== "object" || Array.isArray(use.input))
      || !Array.isArray(pending) || pending.length < 1
      || pending.length > ids.length || new Set(pending).size !== pending.length
      || !Number.isSafeInteger(input.spoolOffset) || input.spoolOffset < 1
      || input.spoolOffset > BOX_TOOL_SPOOL_MAX_BYTES
      || typeof input.detachedRunnerHash !== "string"
      || !/^[a-f0-9]{64}$/.test(input.detachedRunnerHash)
      || typeof input.catalogHash !== "string"
      || !/^[a-f0-9]{64}$/.test(input.catalogHash)
      || Array.from({ length: pending.length }, (_, index) => index)
        .some((index) => !Object.hasOwn(pending, index)
          || typeof pending[index] !== "string" || !ids.includes(pending[index]!))
      || Object.values(usage).some((n) => !Number.isSafeInteger(n) || Number(n) < 0)) {
      throw new BoxDurableJournalError("BOX_TOOL_HANDOFF_EVIDENCE_INVALID");
    }
    const pendingIds = [...pending];
    let digests: BoxToolUseDigest[];
    try { digests = toolUses.map((use) => ({ id: use.id,
      boxName: use.boxName, clientName: use.clientName,
      inputHash: hashBoxToolInput(use.input) })); }
    catch { throw new BoxDurableJournalError("BOX_TOOL_HANDOFF_EVIDENCE_INVALID"); }
    const frozen = { version: 1, roundNo, messageId: candidate.messageId,
      assistantContentHash: candidate.assistantContentHash,
      ...(candidate.assistantEchoHash === undefined ? {}
        : { assistantEchoHash: candidate.assistantEchoHash }),
      assistantNoCallerHash: candidate.assistantNoCallerHash,
      spoolOffset: input.spoolOffset,
      detachedRunnerHash: input.detachedRunnerHash,
      catalogHash: input.catalogHash,
      toolUses: digests, verifiedPendingToolUseIds: pendingIds, usage };
    if (!parseBoxStoredToolHandoff(frozen)) {
      throw new BoxDurableJournalError("BOX_TOOL_HANDOFF_EVIDENCE_INVALID");
    }
    let encoded: string;
    try { encoded = JSON.stringify(frozen); }
    catch { throw new BoxDurableJournalError("BOX_TOOL_HANDOFF_EVIDENCE_INVALID"); }
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) {
      throw new BoxDurableJournalError("BOX_TOOL_HANDOFF_TOO_LARGE");
    }
    const durableRevision = randomUUID();
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = ctx || $4::jsonb, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
          AND ctx->>'boxLeaseEpoch' = $3
          AND ctx->>'boxInvocationMode' = 'detached_tool'
          AND NOT (ctx ? 'boxCancelIntent')
          AND ((($5::int = 1) AND ctx->>'boxState' = 'running')
            OR (($5::int > 1) AND ctx->>'boxState' = 'linked'
              AND ctx->>'boxRoundNo' = $5::text
              AND ctx->>'boxCatalogHash' = $6
              AND ctx->>'boxDetachedRunnerHash' = $7
              AND jsonb_typeof(ctx->'boxResumeSpoolOffset') = 'number'
              AND (ctx->>'boxResumeSpoolOffset')::bigint < $9::bigint
              AND jsonb_typeof(ctx->'boxPriorMessageIds') = 'array'
              AND jsonb_array_length(ctx->'boxPriorMessageIds') = $5::int - 1
              AND NOT (ctx->'boxPriorMessageIds' ? $8)))
          AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'`,
      [input.requestId, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "handoff", boxHandoffRevision: durableRevision,
          boxToolHandoff: frozen }), roundNo, input.catalogHash,
        input.detachedRunnerHash, candidate.messageId, input.spoolOffset]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_TOOL_HANDOFF_FENCE_LOST");
    return { durableRevision, journaledToolUseIds: ids,
      verifiedPendingToolUseIds: pendingIds };
  }

  /** Claim the next HTTP request against a previous model tool message.
   * This transaction runs BEFORE any pending result file is published. If its
   * outcome is ambiguous, no tool result or model call is automatically retried. */
  async claimToolResume(input: { requestId: string; uid: bigint;
    canonicalModel: string; canonicalBody: ProxyBody }): Promise<BoxToolResumeClaim> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
      || input.uid <= 0n || input.canonicalBody.model !== input.canonicalModel) {
      throw new BoxDurableJournalError("BOX_TOOL_RESUME_IDENTITY_INVALID");
    }
    let fingerprint: BoxCallFingerprint;
    let priorContextHash: string;
    let nextContextHash: string;
    try {
      fingerprint = deriveBoxCallFingerprint(input.uid, input.canonicalBody);
      priorContextHash = deriveBoxContextHash(input.canonicalBody, true);
      nextContextHash = deriveBoxContextHash(input.canonicalBody);
    }
    catch { throw new BoxDurableJournalError("BOX_TOOL_RESUME_IDENTITY_INVALID"); }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await lock(client, [`box:fingerprint:${fingerprint.replayFingerprint}`,
        `box:session:${input.uid}:${fingerprint.sessionId}`]);
      const duplicate = await client.query(
        "SELECT 1 FROM request_finalize_journal WHERE ctx->>'boxReplayFingerprint'=$1 LIMIT 1",
        [fingerprint.replayFingerprint]);
      if (duplicate.rowCount) throw new BoxDurableJournalError("BOX_CALL_AMBIGUOUS");
      const owners = await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
        `SELECT request_id,ctx FROM request_finalize_journal
          WHERE user_id=$1 AND ctx->>'boxSessionId'=$2 AND ctx->>'boxTurnKey'=$3
            AND ctx->>'boxState'='handoff' AND NOT (ctx ? 'boxCancelIntent')
            AND state IN ('inflight','finalizing','committed') FOR UPDATE`,
        [input.uid.toString(), fingerprint.sessionId, fingerprint.turnKey]);
      if (owners.rows.length !== 1) throw new BoxDurableJournalError("BOX_TOOL_OWNER_UNKNOWN");
      const owner = owners.rows[0]!, ctx = owner.ctx;
      const nativeSessionId = ctx.boxNativeSessionId;
      const nativeCliCwd = ctx.boxNativeCliCwd;
      if (ctx.model !== input.canonicalModel
        || ctx.boxInvocationMode !== "detached_tool"
        || typeof ctx.boxAccountId !== "string" || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
        || typeof ctx.boxRunNonce !== "string" || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
        || typeof ctx.boxLeaseEpoch !== "string" || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)
        || typeof ctx.boxContextHash !== "string"
        || !/^[a-f0-9]{64}$/.test(ctx.boxContextHash)
        || typeof ctx.boxHandoffRevision !== "string" || ctx.boxHandoffRevision.length > 128
        || !ctx.boxToolHandoff || typeof ctx.boxToolHandoff !== "object"
        || Array.isArray(ctx.boxToolHandoff)
        || (nativeSessionId === undefined) !== (nativeCliCwd === undefined)
        || (nativeSessionId !== undefined &&
          (typeof nativeSessionId !== "string" || !UUID_V4.test(nativeSessionId)
            || typeof nativeCliCwd !== "string"
            || !/^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/.test(nativeCliCwd)))) {
        throw new BoxDurableJournalError("BOX_TOOL_OWNER_INVALID");
      }
      const handoff = parseBoxStoredToolHandoff(ctx.boxToolHandoff);
      if (!handoff) throw new BoxDurableJournalError("BOX_TOOL_OWNER_INVALID");
      if (handoff.roundNo >= 32) throw new BoxDurableJournalError("BOX_TOOL_ROUND_LIMIT");
      const priorIds = ctx.boxPriorMessageIds === undefined ? [] : ctx.boxPriorMessageIds;
      if (!Array.isArray(priorIds) || priorIds.length !== handoff.roundNo - 1
        || new Set(priorIds).size !== priorIds.length
        || priorIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 128)
        || Array.from({ length: priorIds.length }, (_, i) => i)
          .some((i) => !Object.hasOwn(priorIds, i))
        || priorIds.includes(handoff.messageId)) {
        throw new BoxDurableJournalError("BOX_TOOL_OWNER_INVALID");
      }
      try {
        if (compileBoxToolCatalog(input.canonicalBody.tools).bindingSha256 !== handoff.catalogHash) {
          throw new BoxDurableJournalError("BOX_TOOL_CATALOG_CHANGED");
        }
      } catch (error) {
        if (error instanceof BoxDurableJournalError) throw error;
        throw new BoxDurableJournalError("BOX_TOOL_CATALOG_CHANGED");
      }
      if (ctx.boxContextHash !== priorContextHash) {
        throw new BoxDurableJournalError("BOX_TOOL_CONTEXT_CHANGED");
      }
      let effectiveBody: ProxyBody;
      try { effectiveBody = normalizeBoxSemanticBody(input.canonicalBody); }
      catch { throw new BoxDurableJournalError("BOX_TOOL_RESULT_MISMATCH"); }
      const digests = handoff.toolUses;
      let results: readonly BoxMatchedToolResult[];
      try { results = matchBoxToolResults(input.canonicalBody,
        digests); }
      catch { throw new BoxDurableJournalError("BOX_TOOL_RESULT_MISMATCH"); }
      try {
        const assistant = effectiveBody.messages.at(-2) as
          { content?: unknown } | undefined;
        if (!assistant) throw new Error("assistant message missing");
        const fullHash = hashBoxAssistantContent(assistant.content);
        const echoed = Array.isArray(assistant.content)
          && assistant.content.every((block: unknown) => {
            if (!block || typeof block !== "object" || Array.isArray(block)) return true;
            const type = (block as Record<string, unknown>).type;
            return type !== "thinking" && type !== "redacted_thinking";
          });
        if (fullHash !== handoff.assistantContentHash
          && !(handoff.assistantNoCallerHash
            && fullHash === handoff.assistantNoCallerHash)
          && !(echoed && handoff.assistantEchoHash
            && fullHash === handoff.assistantEchoHash)) {
          throw new Error("assistant message changed");
        }
      } catch {
        throw new BoxDurableJournalError("BOX_TOOL_ASSISTANT_CHANGED");
      }
      try {
        reserveBoxToolEcho(handoff.spoolOffset, effectiveBody.messages.at(-1));
      } catch {
        throw new BoxDurableJournalError("BOX_TOOL_SPOOL_CAPACITY_EXCEEDED");
      }
      const durableRevision = randomUUID();
      const resultHashes = results.map((result) => ({
        modelToolUseId: result.modelToolUseId, contentHash: result.contentHash,
        isError: result.isError }));
      const claimedOwner = await client.query(
        `UPDATE request_finalize_journal
            SET ctx=ctx || $4::jsonb, updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2
            AND ctx->>'boxState'='handoff' AND NOT (ctx ? 'boxCancelIntent')
            AND state IN ('inflight','finalizing','committed')
            AND ctx->>'boxHandoffRevision'=$3`,
        [owner.request_id, input.uid.toString(), ctx.boxHandoffRevision,
          JSON.stringify({ boxState: "resuming", boxResumeRequestId: input.requestId,
            boxResumeRevision: durableRevision, boxResumeResultHashes: resultHashes })]);
      if (claimedOwner.rowCount !== 1) throw new BoxDurableJournalError("BOX_TOOL_RESUME_FENCE_LOST");
      const linked = await client.query<{ ctx: Record<string, unknown> }>(
        `UPDATE request_finalize_journal
            SET ctx=ctx || $4::jsonb, updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2 AND state='inflight'
            AND ctx->>'model'=$3 AND ctx->>'boxInvocationRecovery'='v1'
            AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'
            AND NOT (ctx ? 'boxState') RETURNING ctx`,
        [input.requestId, input.uid.toString(), input.canonicalModel,
          JSON.stringify({ boxState: "linked", boxOwnerRequestId: owner.request_id,
            boxInvocationMode: "detached_tool",
            boxAccountId: ctx.boxAccountId, boxRunNonce: ctx.boxRunNonce,
            boxLeaseEpoch: ctx.boxLeaseEpoch, boxTurnKey: fingerprint.turnKey,
            boxResumeSpoolOffset: handoff.spoolOffset,
            boxRoundNo: handoff.roundNo + 1,
            boxPriorMessageIds: [...priorIds, handoff.messageId],
            boxDetachedRunnerHash: handoff.detachedRunnerHash,
            boxCatalogHash: handoff.catalogHash,
            boxSessionId: fingerprint.sessionId,
            boxReplayFingerprint: fingerprint.replayFingerprint,
             boxRequestHash: fingerprint.requestHash,
             boxContextHash: nextContextHash,
             boxParentResumeRevision: durableRevision,
             ...(nativeSessionId === undefined ? {} : {
               boxNativeSessionId: nativeSessionId,
               boxNativeCliCwd: nativeCliCwd }) })]);
      const linkedCtx = linked.rows[0]?.ctx;
      const basis = parseBoxBillingContext(linkedCtx?.boxBillingContext);
      if (linked.rowCount !== 1 || !basis || basis.turnKey !== fingerprint.turnKey
        || !parseBillingPricing(linkedCtx?.billingPricing, input.canonicalModel)) {
        throw new BoxDurableJournalError("BOX_TOOL_RESUME_JOURNAL_INVALID");
      }
      await client.query("COMMIT");
      committed = true;
      return { ownerRequestId: owner.request_id, accountId: BigInt(ctx.boxAccountId),
        runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch,
        spoolOffset: handoff.spoolOffset, roundNo: handoff.roundNo + 1,
        durableRevision, results,
        detachedRunnerHash: handoff.detachedRunnerHash,
         catalogHash: handoff.catalogHash,
         toolUses: digests,
         ...(nativeSessionId === undefined ? {} : {
           nativeSessionId: nativeSessionId as string,
           nativeCliCwd: nativeCliCwd as string }) };
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  /** A final model message closes every row in its one remote invocation.
   * Earlier HTTP rows retain their own handoff usage for per-round settlement;
   * only the final linked row receives final-message usage and terminal proof.
   * Until this transaction commits, the original owner keeps account capacity. */
  async completeToolChain(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { proof: BoxTerminalProof; usage: BoxUsageEvidence }): Promise<void> {
    const usage = input.usage;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
      || !validUsageEvidence(usage)) {
      throw new BoxDurableJournalError("BOX_TOOL_CHAIN_EVIDENCE_INVALID");
    }
    try {
      parseBoxTerminalProof(JSON.stringify(input.proof) + "\n", {
        runNonce: input.proof.runNonce, leaseEpoch: input.leaseEpoch });
    } catch { throw new BoxDurableJournalError("BOX_TOOL_CHAIN_EVIDENCE_INVALID"); }
    if (input.proof.reason !== "worker_complete") {
      throw new BoxDurableJournalError("BOX_TOOL_CHAIN_EVIDENCE_INVALID");
    }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const lockedSessionId = await lockChainSession(client, input.uid, input.requestId);
      type Row = { request_id: string; state: string; ctx: Record<string, unknown> };
      const rows: Row[] = [];
      const seen = new Set<string>();
      let cursor: string | null = input.requestId;
      while (cursor !== null) {
        if (rows.length >= 32 || seen.has(cursor)) {
          throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
        }
        seen.add(cursor);
        const found: { rows: Row[]; rowCount: number | null } = await client.query<Row>(
          `SELECT request_id,state,ctx FROM request_finalize_journal
            WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
          [cursor, input.uid.toString()]);
        const row: Row | undefined = found.rows[0];
        if (found.rowCount !== 1 || !row || !row.ctx
          || row.ctx.boxInvocationRecovery !== "v1"
          || row.ctx.boxInvocationMode !== "detached_tool"
          || row.ctx.boxRunNonce !== input.proof.runNonce
          || row.ctx.boxLeaseEpoch !== input.leaseEpoch) {
          throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
        }
        rows.push(row);
        const parent: unknown = row.ctx.boxOwnerRequestId;
        if (parent === undefined) cursor = null;
        else if (typeof parent === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(parent)) {
          cursor = parent;
        } else throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
      }
      const current = rows[0]!;
      const basis = current.ctx;
      const roundNo = basis.boxRoundNo;
      if (!Number.isSafeInteger(roundNo) || Number(roundNo) < 2
        || Number(roundNo) > 32 || rows.length !== roundNo
        || basis.boxSessionId !== lockedSessionId
        || current.state !== "inflight"
        || !["linked", "unknown"].includes(String(basis.boxState))
        || basis.boxToolHandoff !== undefined
        || typeof basis.boxCatalogHash !== "string"
        || !/^[a-f0-9]{64}$/.test(basis.boxCatalogHash)
        || typeof basis.boxDetachedRunnerHash !== "string"
        || !/^[a-f0-9]{64}$/.test(basis.boxDetachedRunnerHash)) {
        throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
      }
      for (let i = 1; i < rows.length; i++) {
        const child = rows[i - 1]!, parent = rows[i]!;
        const ctx = parent.ctx;
        const handoff = parseBoxStoredToolHandoff(ctx.boxToolHandoff);
        if (!handoff || handoff.roundNo !== Number(roundNo) - i
          || handoff.catalogHash !== basis.boxCatalogHash
          || handoff.detachedRunnerHash !== basis.boxDetachedRunnerHash
          || !["inflight", "finalizing", "committed"].includes(parent.state)
          || !["resuming", "unknown"].includes(String(ctx.boxState))
          || ctx.boxResumeRequestId !== child.request_id
          || typeof ctx.boxResumeRevision !== "string"
          || !UUID_V4.test(ctx.boxResumeRevision)
          || typeof child.ctx.boxParentResumeRevision !== "string"
          || !UUID_V4.test(child.ctx.boxParentResumeRevision)
          || ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision
          || ctx.boxAccountId !== basis.boxAccountId
          || ctx.boxSessionId !== basis.boxSessionId
          || ctx.boxTurnKey !== basis.boxTurnKey
          || ctx.model !== basis.model
          || ctx.boxNativeSessionId !== basis.boxNativeSessionId
          || ctx.boxNativeCliCwd !== basis.boxNativeCliCwd) {
          throw new BoxDurableJournalError("BOX_TOOL_CHAIN_INVALID");
        }
      }
      const final = await client.query(
        `UPDATE request_finalize_journal
            SET ctx=ctx || $4::jsonb, updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2 AND state='inflight'
            AND ctx->>'boxLeaseEpoch'=$3
            AND ctx->>'boxState' IN ('linked','unknown')`,
        [current.request_id, input.uid.toString(), input.leaseEpoch,
          JSON.stringify({ boxState: "terminal", boxTerminalProof: input.proof,
            boxUsage: usage })]);
      if (final.rowCount !== 1) throw new BoxDurableJournalError("BOX_TOOL_CHAIN_FENCE_LOST");
      for (const ancestor of rows.slice(1)) {
        const changed = await client.query(
          `UPDATE request_finalize_journal
              SET ctx=jsonb_set(ctx,'{boxState}','"terminal"'::jsonb), updated_at=NOW()
            WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxLeaseEpoch'=$3
              AND ctx->>'boxState' IN ('resuming','unknown')`,
          [ancestor.request_id, input.uid.toString(), input.leaseEpoch]);
        if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_TOOL_CHAIN_FENCE_LOST");
      }
      await client.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  /** A linked final round failed after earlier tool messages were durably
   * handed off. Abort only the unbilled final row. Earlier rows retain their
   * exact handoff usage and billing state, but cease holding remote capacity.
   * No missing model usage is invented and no CLI/tool call is replayed. */
  async markToolChainStoppedFailure(input: Pick<BoxJournalAdmission,
    "requestId" | "uid" | "leaseEpoch"> & { proof: BoxTerminalProof }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
      || !input.proof || input.proof.reason === "worker_complete") {
      throw new BoxDurableJournalError("BOX_FAILED_STOP_EVIDENCE_INVALID");
    }
    try { parseBoxTerminalProof(JSON.stringify(input.proof) + "\n", {
      runNonce: input.proof.runNonce, leaseEpoch: input.leaseEpoch }); }
    catch { throw new BoxDurableJournalError("BOX_FAILED_STOP_EVIDENCE_INVALID"); }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const lockedSessionId = await lockChainSession(client, input.uid, input.requestId);
      type Row = { request_id: string; state: string; ctx: Record<string, unknown> };
      const rows: Row[] = [];
      const seen = new Set<string>();
      let cursor: string | null = input.requestId;
      while (cursor !== null) {
        if (rows.length >= 32 || seen.has(cursor)) {
          throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
        }
        seen.add(cursor);
        const found: { rows: Row[]; rowCount: number | null } = await client.query<Row>(
          `SELECT request_id,state,ctx FROM request_finalize_journal
            WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
          [cursor, input.uid.toString()]);
        const row = found.rows[0];
        if (found.rowCount !== 1 || !row?.ctx
          || row.ctx.boxInvocationRecovery !== "v1"
          || row.ctx.boxInvocationMode !== "detached_tool"
          || row.ctx.boxRunNonce !== input.proof.runNonce
          || row.ctx.boxLeaseEpoch !== input.leaseEpoch) {
          throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
        }
        rows.push(row);
        const parent: unknown = row.ctx.boxOwnerRequestId;
        if (parent === undefined) cursor = null;
        else if (typeof parent === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(parent)) cursor = parent;
        else throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
      }
      const current = rows[0]!;
      const basis = current.ctx;
      const roundNo = basis.boxRoundNo;
      const handoff = basis.boxToolHandoff === undefined ? null
        : parseBoxStoredToolHandoff(basis.boxToolHandoff);
      if (basis.boxToolHandoff !== undefined && !handoff) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
      }
      if ((handoff ? ["inflight", "finalizing", "committed"].includes(current.state)
        : current.state === "aborted") && basis.boxState === "failed_stopped"
        && rows.length === roundNo && isDeepStrictEqual(basis.boxTerminalProof, input.proof)) {
        await client.query("COMMIT"); committed = true; return;
      }
      if (!Number.isSafeInteger(roundNo) || Number(roundNo) < 2
        || Number(roundNo) > 32 || rows.length !== roundNo
        || basis.boxSessionId !== lockedSessionId
        || (handoff
          ? (!["inflight", "finalizing", "committed"].includes(current.state)
            || !["handoff", "unknown"].includes(String(basis.boxState))
            || handoff.roundNo !== roundNo
            || typeof basis.boxHandoffRevision !== "string"
            || !UUID_V4.test(basis.boxHandoffRevision)
            || handoff.catalogHash !== basis.boxCatalogHash
            || handoff.detachedRunnerHash !== basis.boxDetachedRunnerHash)
          : (current.state !== "inflight"
            || !["linked", "unknown"].includes(String(basis.boxState))))
        || basis.boxResumeRequestId !== undefined
        || typeof basis.boxAccountId !== "string"
        || !/^[1-9][0-9]{0,19}$/.test(basis.boxAccountId)
        || typeof basis.boxCatalogHash !== "string"
        || !/^[a-f0-9]{64}$/.test(basis.boxCatalogHash)
        || typeof basis.boxDetachedRunnerHash !== "string"
        || !/^[a-f0-9]{64}$/.test(basis.boxDetachedRunnerHash)) {
        throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
      }
      for (let i = 1; i < rows.length; i++) {
        const child = rows[i - 1]!, parent = rows[i]!;
        const ctx = parent.ctx;
        const handoff = parseBoxStoredToolHandoff(ctx.boxToolHandoff);
        if (!handoff || handoff.roundNo !== Number(roundNo) - i
          || handoff.catalogHash !== basis.boxCatalogHash
          || handoff.detachedRunnerHash !== basis.boxDetachedRunnerHash
          || !["inflight", "finalizing", "committed"].includes(parent.state)
          || !["resuming", "unknown"].includes(String(ctx.boxState))
          || ctx.boxResumeRequestId !== child.request_id
          || typeof ctx.boxResumeRevision !== "string"
          || !UUID_V4.test(ctx.boxResumeRevision)
          || typeof child.ctx.boxParentResumeRevision !== "string"
          || !UUID_V4.test(child.ctx.boxParentResumeRevision)
          || ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision
          || ctx.boxAccountId !== basis.boxAccountId
          || ctx.boxSessionId !== basis.boxSessionId
          || ctx.boxTurnKey !== basis.boxTurnKey
          || ctx.model !== basis.model) {
          throw new BoxDurableJournalError("BOX_FAILED_STOP_CHAIN_INVALID");
        }
      }
      if (!handoff) {
        const usage = await client.query(
          `SELECT 1 FROM usage_records WHERE request_id=$1 AND user_id=$2 LIMIT 1`,
          [current.request_id, input.uid.toString()]);
        if (usage.rowCount) throw new BoxDurableJournalError("BOX_FAILED_STOP_USAGE_CONFLICT");
      }
      const stopParams = [current.request_id, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "failed_stopped", boxTerminalProof: input.proof,
          boxStopOutcome: "failed" }), input.proof.runNonce];
      const stopped = handoff ? await client.query(
        `UPDATE request_finalize_journal SET ctx=ctx || $4::jsonb
          WHERE request_id=$1 AND user_id=$2
            AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
            AND ctx->>'boxState' IN ('handoff','unknown')
            AND ctx ? 'boxToolHandoff' AND NOT (ctx ? 'boxResumeRequestId')
            AND state IN ('inflight','finalizing','committed')`, stopParams)
        : await client.query(
          `UPDATE request_finalize_journal
              SET state='aborted', failure_code='STREAM_FAILED', final_credits=0,
                  ctx=ctx || $4::jsonb, updated_at=NOW()
            WHERE request_id=$1 AND user_id=$2 AND state='inflight'
              AND ctx->>'boxLeaseEpoch'=$3 AND ctx->>'boxRunNonce'=$5
              AND ctx->>'boxState' IN ('linked','unknown')
              AND NOT (ctx ? 'boxToolHandoff')`, stopParams);
      if (stopped.rowCount !== 1) throw new BoxDurableJournalError("BOX_FAILED_STOP_FENCE_LOST");
      for (const ancestor of rows.slice(1)) {
        const changed = await client.query(
          `UPDATE request_finalize_journal
              SET ctx=ctx || '{"boxState":"failed_stopped","boxStopOutcome":"failed"}'::jsonb,
                  updated_at=NOW()
            WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxLeaseEpoch'=$3
              AND ctx->>'boxState' IN ('resuming','unknown')
              AND ctx ? 'boxToolHandoff'`,
          [ancestor.request_id, input.uid.toString(), input.leaseEpoch]);
        if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_FAILED_STOP_FENCE_LOST");
      }
      await client.query("COMMIT"); committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  /** Bounded, shared-leader discovery only. These rows are unknown until a
   * pinned Box read returns a valid terminal marker; no paid call is retried. */
  async listStoppedFailureProbeCandidates(limit = 10): Promise<BoxStoppedFailureProbeCandidate[]> {
    const found = await this.pool.query<{ request_id: string; user_id: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,user_id::text,ctx FROM request_finalize_journal
        WHERE ${STOP_PROBE_STATE_FENCE} AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND request_id ~ '^[A-Za-z0-9_-]{1,64}$' AND user_id>0
          AND jsonb_typeof(ctx->'boxAccountId')='string'
          AND ctx->>'boxAccountId' ~ '^[1-9][0-9]{0,19}$'
          AND jsonb_typeof(ctx->'boxRunNonce')='string'
          AND ctx->>'boxRunNonce' ~ '^[a-f0-9]{24}$'
          AND jsonb_typeof(ctx->'boxLeaseEpoch')='string'
          AND ctx->>'boxLeaseEpoch' ~ '^[a-f0-9]{32}$'
          AND (NOT (ctx ? 'boxOwnerRequestId')
            OR (jsonb_typeof(ctx->'boxOwnerRequestId')='string'
              AND ctx->>'boxOwnerRequestId' ~ '^[A-Za-z0-9_-]{1,64}$'))
          AND NOT (ctx ? 'boxResumeRequestId')
          AND NOT (ctx ? 'boxTerminalProof')
          AND (NOT (ctx ? 'boxStopProbeAfterMs')
            OR (jsonb_typeof(ctx->'boxStopProbeAfterMs')='number'
              AND (ctx->>'boxStopProbeAfterMs') ~ '^[0-9]{13}$'
              AND (ctx->>'boxStopProbeAfterMs')::bigint
                <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))
        ORDER BY CASE WHEN jsonb_typeof(ctx->'boxStopProbeLastAttemptMs')='number'
            AND (ctx->>'boxStopProbeLastAttemptMs') ~ '^[0-9]{13}$'
          THEN (ctx->>'boxStopProbeLastAttemptMs')::bigint ELSE 0 END ASC,
          updated_at ASC LIMIT $1`,
      [Math.max(1, Math.min(20, Number.isSafeInteger(limit) ? limit : 10))]);
    const candidates: BoxStoppedFailureProbeCandidate[] = [];
    for (const row of found.rows) {
      const ctx = row.ctx;
      if (!ctx || !/^[A-Za-z0-9_-]{1,64}$/.test(row.request_id)
        || !/^[1-9][0-9]{0,19}$/.test(row.user_id)
        || typeof ctx.boxAccountId !== "string"
        || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
        || typeof ctx.boxRunNonce !== "string"
        || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
        || typeof ctx.boxLeaseEpoch !== "string"
        || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)
        || (ctx.boxOwnerRequestId !== undefined
          && (typeof ctx.boxOwnerRequestId !== "string"
            || !/^[A-Za-z0-9_-]{1,64}$/.test(ctx.boxOwnerRequestId)))) continue;
      candidates.push({ requestId: row.request_id, uid: BigInt(row.user_id),
        accountId: BigInt(ctx.boxAccountId), runNonce: ctx.boxRunNonce,
        leaseEpoch: ctx.boxLeaseEpoch, linked: ctx.boxOwnerRequestId !== undefined });
    }
    return candidates;
  }

  /** Cross-worker CAS with a durable retry clock; never changes billing age. */
  async claimStoppedFailureProbe(input: BoxStoppedFailureProbeCandidate): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || input.accountId <= 0n || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) {
      throw new BoxDurableJournalError("BOX_STOP_PROBE_IDENTITY_INVALID");
    }
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || jsonb_build_object(
            'boxStopProbeLastAttemptMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint,
            'boxStopProbeAfterMs',
              (EXTRACT(EPOCH FROM NOW()+INTERVAL '2 minutes')*1000)::bigint)
        WHERE request_id=$1 AND user_id=$2 AND ${STOP_PROBE_STATE_FENCE}
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND jsonb_typeof(ctx->'boxAccountId')='string'
          AND jsonb_typeof(ctx->'boxRunNonce')='string'
          AND jsonb_typeof(ctx->'boxLeaseEpoch')='string'
          AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
          AND ctx->>'boxLeaseEpoch'=$5
          AND NOT (ctx ? 'boxResumeRequestId')
          AND NOT (ctx ? 'boxTerminalProof')
          AND (NOT (ctx ? 'boxOwnerRequestId')
            OR (jsonb_typeof(ctx->'boxOwnerRequestId')='string'
              AND ctx->>'boxOwnerRequestId' ~ '^[A-Za-z0-9_-]{1,64}$'))
          AND (($6::boolean AND ctx->>'boxOwnerRequestId' IS NOT NULL)
            OR (NOT $6::boolean AND NOT (ctx ? 'boxOwnerRequestId')))
          AND (NOT (ctx ? 'boxStopProbeAfterMs')
            OR (jsonb_typeof(ctx->'boxStopProbeAfterMs')='number'
              AND (ctx->>'boxStopProbeAfterMs') ~ '^[0-9]{13}$'
              AND (ctx->>'boxStopProbeAfterMs')::bigint
                <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch, input.linked]);
    return changed.rowCount === 1;
  }

  /** After a durable user stop, locate the one current HTTP leaf. The caller
   * must never infer it from the request that originally received the stop. */
  async getCancelLeaf(input: Pick<BoxJournalAdmission,
    "uid" | "accountId" | "runNonce" | "leaseEpoch">): Promise<BoxStoppedFailureProbeCandidate> {
    if (input.uid <= 0n || input.accountId <= 0n
      || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) {
      throw new BoxDurableJournalError("BOX_CANCEL_IDENTITY_INVALID");
    }
    const found = await this.pool.query<{ request_id: string; user_id: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,user_id::text,ctx FROM request_finalize_journal
        WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
          AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ${STOP_PROBE_STATE_FENCE}
          AND NOT (ctx ? 'boxResumeRequestId')
          AND NOT (ctx ? 'boxTerminalProof')
          AND ctx ? 'boxCancelIntent'`,
      [input.uid.toString(), input.accountId.toString(), input.runNonce,
        input.leaseEpoch]);
    const row = found.rows[0], ctx = row?.ctx;
    if (found.rowCount !== 1 || !row || !ctx
      || !/^[A-Za-z0-9_-]{1,64}$/.test(row.request_id)
      || typeof ctx.boxAccountId !== "string"
      || typeof ctx.boxRunNonce !== "string"
      || typeof ctx.boxLeaseEpoch !== "string"
      || !validCancelIntent(ctx.boxCancelIntent)
      || (ctx.boxOwnerRequestId !== undefined
        && (typeof ctx.boxOwnerRequestId !== "string"
          || !/^[A-Za-z0-9_-]{1,64}$/.test(ctx.boxOwnerRequestId)))) {
      throw new BoxDurableJournalError("BOX_CANCEL_LEAF_UNKNOWN");
    }
    return { requestId: row.request_id, uid: input.uid,
      accountId: input.accountId, runNonce: input.runNonce,
      leaseEpoch: input.leaseEpoch, linked: ctx.boxOwnerRequestId !== undefined };
  }

  /** Resolve a stop only from the currently authenticated user container's
   * active turn. No client-supplied account, nonce, epoch or request ID is
   * trusted; a different user's or stale container's row cannot be stopped. */
  async findCancelableRun(input: { uid: bigint; containerId: bigint;
    sessionId: string; turnKey: string }): Promise<Pick<BoxJournalAdmission,
      "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch">> {
    if (input.uid <= 0n || input.containerId <= 0n
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.sessionId)
      || !/^[a-f0-9]{64}$/.test(input.turnKey)) {
      throw new BoxDurableJournalError("BOX_CANCEL_IDENTITY_INVALID");
    }
    const found = await this.pool.query<{ request_id: string; ctx: Record<string, unknown> }>(
      `SELECT request_id,ctx FROM request_finalize_journal
        WHERE user_id=$1 AND container_id=$2
          AND ctx->>'boxSessionId'=$3 AND ctx->>'boxTurnKey'=$4
          AND ctx->>'model'='box-api-claude-opus-5-5'
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ${STOP_PROBE_STATE_FENCE}
          AND NOT (ctx ? 'boxResumeRequestId')
          AND NOT (ctx ? 'boxTerminalProof')`,
      [input.uid.toString(), input.containerId.toString(),
        input.sessionId, input.turnKey]);
    const row = found.rows[0], ctx = row?.ctx;
    if (found.rowCount !== 1 || !row || !ctx
      || !/^[A-Za-z0-9_-]{1,64}$/.test(row.request_id)
      || typeof ctx.boxAccountId !== "string"
      || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
      || typeof ctx.boxRunNonce !== "string"
      || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
      || typeof ctx.boxLeaseEpoch !== "string"
      || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)) {
      throw new BoxDurableJournalError("BOX_CANCEL_RUN_UNKNOWN");
    }
    return { requestId: row.request_id, uid: input.uid,
      accountId: BigInt(ctx.boxAccountId), runNonce: ctx.boxRunNonce,
      leaseEpoch: ctx.boxLeaseEpoch };
  }

  /** Restart-safe privacy cleanup selection. Corrupt terminal evidence is
   * durably quarantined (no remote touch) so it cannot starve newer runs. */
  /** Restart takeover only for runs that have never received a durable paid
   * launch permit. Reserved rows need to age past the entire HTTP budget so a
   * still-live first-round cannot be preempted during normal staging. */
  async listPrelaunchRecoveryCandidates(limit = 10): Promise<BoxPrelaunchRecoveryCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BoxDurableJournalError("BOX_PRELAUNCH_LIMIT_INVALID");
    }
    const found = await this.pool.query<{ request_id: string; user_id: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,user_id,ctx FROM request_finalize_journal
        WHERE state='inflight' AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx ? 'boxPrelaunchControl' AND NOT (ctx ? 'boxLaunchPermit')
          AND NOT (ctx ? 'boxTerminalProof')
          AND NOT (ctx ? 'boxPrelaunchRecoveryQuarantine')
          AND ((ctx->>'boxState'='unknown') OR
            (ctx->>'boxState'='reserved' AND updated_at < NOW() - INTERVAL '16 minutes'))
          AND (NOT (ctx ? 'boxPrelaunchRetryAfterMs') OR
            (jsonb_typeof(ctx->'boxPrelaunchRetryAfterMs')='number'
             AND (ctx->>'boxPrelaunchRetryAfterMs') ~ '^[0-9]{13}$'
             AND (ctx->>'boxPrelaunchRetryAfterMs')::bigint <= $2))
        ORDER BY updated_at ASC LIMIT $1`, [limit, Date.now()]);
    const out: BoxPrelaunchRecoveryCandidate[] = [];
    for (const row of found.rows) {
      const ctx = row.ctx;
      try {
        const uid = BigInt(row.user_id);
        if (typeof ctx.boxAccountId !== "string"
          || !/^[1-9][0-9]{0,18}$/.test(ctx.boxAccountId)) {
          throw new Error("noncanonical account");
        }
        const accountId = BigInt(ctx.boxAccountId);
        const receipt = ctx.boxPrelaunchControl as BoxPrelaunchReceipt;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(row.request_id)
          || uid <= 0n || accountId <= 0n || !receipt
          || receipt.runNonce !== ctx.boxRunNonce
          || receipt.leaseEpoch !== ctx.boxLeaseEpoch
          || receipt.accountId !== accountId.toString()) throw new Error("identity");
        const sorted = Object.fromEntries(Object.entries(receipt)
          .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        parseBoxPrelaunchBootstrap(JSON.stringify(sorted), receipt);
        out.push({ requestId: row.request_id, uid, accountId,
          runNonce: receipt.runNonce, leaseEpoch: receipt.leaseEpoch, receipt });
      } catch {
        // A malformed row is held, not promoted or retried on every tick.
        await this.pool.query(
          `UPDATE request_finalize_journal
             SET ctx=ctx || '{"boxPrelaunchRecoveryQuarantine":"invalid_evidence"}'::jsonb
           WHERE request_id=$1 AND user_id=$2 AND state='inflight'
             AND ctx->>'boxInvocationMode'='detached_tool'
             AND ctx ? 'boxPrelaunchControl' AND NOT (ctx ? 'boxLaunchPermit')
             AND NOT (ctx ? 'boxPrelaunchRecoveryQuarantine')`,
          [row.request_id, row.user_id]);
      }
    }
    return out;
  }

  /** Cross-worker backoff/claim. A second worker cannot dispatch cleanup for
   * this run until the retry window expires; retries remain safe/idempotent. */
  async claimPrelaunchRecovery(input: BoxPrelaunchRecoveryCandidate): Promise<boolean> {
    this.validatePrelaunchReceipt(input);
    const now = Date.now();
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || $7::jsonb, updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND state='inflight'
          AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
          AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->'boxPrelaunchControl'=$6::jsonb
          AND NOT (ctx ? 'boxLaunchPermit') AND NOT (ctx ? 'boxTerminalProof')
          AND NOT (ctx ? 'boxPrelaunchRecoveryQuarantine')
          AND ((ctx->>'boxState'='unknown') OR
            (ctx->>'boxState'='reserved' AND updated_at < NOW() - INTERVAL '16 minutes'))
          AND (NOT (ctx ? 'boxPrelaunchRetryAfterMs') OR
            (jsonb_typeof(ctx->'boxPrelaunchRetryAfterMs')='number'
             AND (ctx->>'boxPrelaunchRetryAfterMs') ~ '^[0-9]{13}$'
             AND (ctx->>'boxPrelaunchRetryAfterMs')::bigint <= $8))`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch, JSON.stringify(input.receipt),
        JSON.stringify({ boxState: "unknown", boxPrelaunchLastAttemptMs: now,
          boxPrelaunchRetryAfterMs: now + 60_000 }), now]);
    return changed.rowCount === 1;
  }

  async listRemoteCleanupCandidates(limit = 10): Promise<BoxRemoteCleanupCandidate[]> {
    const found = await this.pool.query<{ request_id: string; user_id: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,user_id::text,ctx FROM request_finalize_journal
        WHERE ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ${CLEANUP_STATE_FENCE} AND ctx ? 'boxTerminalProof'
          AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'
          AND NOT (ctx ? 'boxRemoteCleanupQuarantine')
           AND (ctx->>'boxRemoteCleanupClaimed' IS DISTINCT FROM 'true'
             OR (jsonb_typeof(ctx->'boxRemoteCleanupRetryAfterMs')='number'
               AND (ctx->>'boxRemoteCleanupRetryAfterMs') ~ '^[0-9]{13}$'
               AND (ctx->>'boxRemoteCleanupRetryAfterMs')::bigint
                 <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint)
             OR (NOT (ctx ? 'boxRemoteCleanupRetryAfterMs')
               AND updated_at <= NOW()-INTERVAL '2 minutes'))
         ORDER BY CASE WHEN jsonb_typeof(ctx->'boxRemoteCleanupLastAttemptMs')='number'
             AND (ctx->>'boxRemoteCleanupLastAttemptMs') ~ '^[0-9]{13}$'
           THEN (ctx->>'boxRemoteCleanupLastAttemptMs')::bigint ELSE 0 END ASC,
           updated_at ASC LIMIT $1`,
      [Math.max(1, Math.min(20, Number.isSafeInteger(limit) ? limit : 10))]);
    const candidates: BoxRemoteCleanupCandidate[] = [];
    for (const row of found.rows) {
      const ctx = row.ctx;
      const quarantine = async (): Promise<void> => {
        await this.pool.query(
          `UPDATE request_finalize_journal
              SET ctx=ctx || '{"boxRemoteCleanupQuarantine":"invalid_evidence"}'::jsonb
            WHERE request_id=$1 AND user_id=$2
              AND ctx->'boxTerminalProof'=$3::jsonb
              AND ctx->>'boxInvocationRecovery'='v1'
              AND ctx->>'boxInvocationMode'='detached_tool'
              AND ${CLEANUP_STATE_FENCE} AND ctx ? 'boxTerminalProof'
              AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'
              AND NOT (ctx ? 'boxRemoteCleanupQuarantine')`,
          [row.request_id, row.user_id, JSON.stringify(ctx?.boxTerminalProof)]);
      };
      if (!ctx || typeof ctx.boxRunNonce !== "string"
        || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
        || typeof ctx.boxLeaseEpoch !== "string"
        || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)
        || typeof ctx.boxAccountId !== "string"
        || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
        || !/^[1-9][0-9]{0,19}$/.test(row.user_id)) {
        await quarantine();
        continue;
      }
      try {
        const proof = parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + "\n",
          { runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch });
        if (!cleanupProofMatchesState(ctx.boxState, proof)) { await quarantine(); continue; }
        const pointer = ctx.boxNativePointer === undefined ? undefined
          : parseBoxNativePointer(ctx.boxNativePointer, Date.now(), true);
        if (ctx.boxNativePointer !== undefined && (!pointer
          || pointer.accountId !== ctx.boxAccountId)) {
          await quarantine(); continue;
        }
        candidates.push({ requestId: row.request_id, uid: BigInt(row.user_id),
          accountId: BigInt(ctx.boxAccountId), runNonce: ctx.boxRunNonce,
          leaseEpoch: ctx.boxLeaseEpoch, proof,
          ...(pointer ? { nativePointer: pointer } : {}) });
      } catch { await quarantine(); /* Corrupt proof is manual, never automatic cleanup. */ }
    }
    return candidates;
  }

  /** Move a proven detached run to the back of the queue before a network
   * attempt. A crashed worker becomes eligible again after two minutes. */
  async claimRemoteCleanup(input: BoxRemoteCleanupCandidate): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
      || input.uid <= 0n || input.accountId <= 0n
      || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) {
      throw new BoxDurableJournalError("BOX_CLEANUP_IDENTITY_INVALID");
    }
    try {
      parseBoxTerminalProof(JSON.stringify(input.proof) + "\n", input);
    } catch { throw new BoxDurableJournalError("BOX_CLEANUP_IDENTITY_INVALID"); }
    if (input.nativePointer && (parseBoxNativePointer(input.nativePointer, Date.now(), true) === null
      || input.nativePointer.accountId !== input.accountId.toString())) {
      throw new BoxDurableJournalError("BOX_CLEANUP_IDENTITY_INVALID");
    }
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || jsonb_build_object(
             'boxRemoteCleanupClaimed',true,
             'boxRemoteCleanupLastAttemptMs',
               (EXTRACT(EPOCH FROM NOW())*1000)::bigint,
             'boxRemoteCleanupRetryAfterMs',
              (EXTRACT(EPOCH FROM NOW()+INTERVAL '2 minutes')*1000)::bigint)
        WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
          AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ${CLEANUP_PROOF_FENCE} AND ctx ? 'boxTerminalProof'
          AND ctx->'boxTerminalProof'->>'runNonce'=$4
          AND ctx->'boxTerminalProof'->>'leaseEpoch'=$5
           AND ctx->'boxTerminalProof'=$6::jsonb
           AND ctx->'boxNativePointer' IS NOT DISTINCT FROM $7::jsonb
          AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'
          AND NOT (ctx ? 'boxRemoteCleanupQuarantine')
           AND (ctx->>'boxRemoteCleanupClaimed' IS DISTINCT FROM 'true'
             OR (jsonb_typeof(ctx->'boxRemoteCleanupRetryAfterMs')='number'
               AND (ctx->>'boxRemoteCleanupRetryAfterMs') ~ '^[0-9]{13}$'
               AND (ctx->>'boxRemoteCleanupRetryAfterMs')::bigint
                 <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint)
             OR (NOT (ctx ? 'boxRemoteCleanupRetryAfterMs')
               AND updated_at <= NOW()-INTERVAL '2 minutes'))`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch, JSON.stringify(input.proof),
        input.nativePointer ? JSON.stringify(input.nativePointer) : null]);
    return changed.rowCount === 1;
  }

  /** A losing worker may close only its local ProxyAgent after another worker
   * has durably marked the exact same proven remote run cleaned. */
  async remoteCleanupStatus(input: BoxRemoteCleanupCandidate): Promise<"done" | "pending" | "invalid"> {
    try {
      parseBoxTerminalProof(JSON.stringify(input.proof) + "\n", input);
    } catch { return "invalid"; }
    const found = await this.pool.query<{ status: string | null }>(
      `SELECT ctx->>'boxRemoteCleanup' AS status FROM request_finalize_journal
        WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
          AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ${CLEANUP_PROOF_FENCE} AND NOT (ctx ? 'boxRemoteCleanupQuarantine')
          AND ctx->'boxTerminalProof'=$6::jsonb`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch, JSON.stringify(input.proof)]);
    if (found.rowCount !== 1) return "invalid";
    return found.rows[0]?.status === "done" ? "done" : "pending";
  }

  /** The original egress may still own a local ProxyAgent after the shared
   * worker cleaned the remote run. Only this exact proven/done row permits
   * disposing that local handle; this does not touch the remote Box. */
  async remoteCleanupDoneByRunIdentity(input: Pick<BoxJournalAdmission,
    "uid" | "accountId" | "runNonce" | "leaseEpoch">): Promise<boolean> {
    if (input.uid <= 0n || input.accountId <= 0n
      || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) return false;
    const found = await this.pool.query<{ ctx: Record<string, unknown> }>(
      `SELECT ctx FROM request_finalize_journal
        WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
          AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->>'boxRemoteCleanup'='done'
          AND ${CLEANUP_PROOF_FENCE}`,
      [input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch]);
    const ctx = found.rows[0]?.ctx;
    if (found.rowCount !== 1 || !ctx) return false;
    try {
      const proof = parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + "\n",
        { runNonce: input.runNonce, leaseEpoch: input.leaseEpoch });
      return cleanupProofMatchesState(ctx.boxState, proof);
    } catch { return false; }
  }

  /** Exact durable proof for a still-live egress process to release its old
   * local target after a different worker completed prelaunch cleanup. */
  async prelaunchCleanupDoneByRunIdentity(input: Pick<BoxJournalAdmission,
    "uid" | "accountId" | "runNonce" | "leaseEpoch">): Promise<boolean> {
    if (input.uid <= 0n || input.accountId <= 0n
      || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) return false;
    const found = await this.pool.query<{ ctx: Record<string, unknown> }>(
      `SELECT ctx FROM request_finalize_journal
        WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
          AND ctx->>'boxRunNonce'=$3 AND ctx->>'boxLeaseEpoch'=$4
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->>'boxState'='prestart_stopped'
          AND ctx ? 'boxPrelaunchControl' AND ctx ? 'boxPrelaunchCleanup'
          AND NOT (ctx ? 'boxLaunchPermit')`,
      [input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch]);
    const ctx = found.rows[0]?.ctx;
    if (found.rowCount !== 1 || !ctx) return false;
    try {
      const receipt = ctx.boxPrelaunchControl as BoxPrelaunchReceipt;
      const sorted = Object.fromEntries(Object.entries(receipt)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      parseBoxPrelaunchBootstrap(JSON.stringify(sorted), receipt);
      const cleanup = ctx.boxPrelaunchCleanup as Record<string, unknown>;
      return receipt.accountId === input.accountId.toString()
        && receipt.runNonce === input.runNonce
        && receipt.leaseEpoch === input.leaseEpoch
        && cleanup.v === 1
        && cleanup.receipt === `cleaned:${receipt.identityHash}`;
    } catch { return false; }
  }

  async markRemoteCleaned(input: BoxRemoteCleanupCandidate): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
      || input.uid <= 0n || input.accountId <= 0n
      || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) {
      throw new BoxDurableJournalError("BOX_CLEANUP_IDENTITY_INVALID");
    }
    try {
      parseBoxTerminalProof(JSON.stringify(input.proof) + "\n", input);
    } catch { throw new BoxDurableJournalError("BOX_CLEANUP_IDENTITY_INVALID"); }
    if (input.nativePointer && (parseBoxNativePointer(input.nativePointer, Date.now(), true) === null
      || input.nativePointer.accountId !== input.accountId.toString())) {
      throw new BoxDurableJournalError("BOX_CLEANUP_IDENTITY_INVALID");
    }
    const params = [input.requestId, input.uid.toString(), input.accountId.toString(),
      input.runNonce, input.leaseEpoch, JSON.stringify(input.proof),
      input.nativePointer ? JSON.stringify(input.nativePointer) : null];
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || '{"boxRemoteCleanup":"done"}'::jsonb
        WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
          AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
          AND ${CLEANUP_PROOF_FENCE} AND ctx ? 'boxTerminalProof'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->'boxTerminalProof'->>'runNonce'=$4
          AND ctx->'boxTerminalProof'->>'leaseEpoch'=$5
          AND ctx->'boxTerminalProof'=$6::jsonb
          AND ctx->'boxNativePointer' IS NOT DISTINCT FROM $7::jsonb
          AND ctx->>'boxRemoteCleanupClaimed'='true'
          AND NOT (ctx ? 'boxRemoteCleanupQuarantine')
          AND COALESCE(ctx->>'boxRemoteCleanup','pending')<>'done'`, params);
    if (changed.rowCount === 1) return;
    const already = await this.pool.query(
      `SELECT 1 FROM request_finalize_journal
        WHERE request_id=$1 AND user_id=$2 AND ctx->>'boxAccountId'=$3
          AND ctx->>'boxRunNonce'=$4 AND ctx->>'boxLeaseEpoch'=$5
          AND ${CLEANUP_PROOF_FENCE} AND ctx ? 'boxTerminalProof'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->'boxTerminalProof'->>'runNonce'=$4
          AND ctx->'boxTerminalProof'->>'leaseEpoch'=$5
          AND ctx->'boxTerminalProof'=$6::jsonb
          AND ctx->'boxNativePointer' IS NOT DISTINCT FROM $7::jsonb
          AND ctx->>'boxRemoteCleanup'='done'`, params);
    if (already.rowCount !== 1) throw new BoxDurableJournalError("BOX_CLEANUP_FENCE_LOST");
  }
}
