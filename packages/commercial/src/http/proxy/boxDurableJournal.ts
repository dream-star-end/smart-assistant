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
  deriveBoxFallbackAlias, incomingAssistantAccepted } from "./boxCallFingerprint.js";
import { comparableAssistantContent } from "./boxToolInputEcho.js";
import { matchPreparedToolResults, type BoxMatchedToolResult } from "./boxToolResultMatcher.js";
import { hashBoxToolInput, type BoxToolUseDigest } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";
import { parseBoxStoredToolHandoff } from "./boxStoredToolHandoff.js";
import { BOX_TOOL_MAX_ROUNDS, BOX_TOOL_SPOOL_MAX_BYTES,
  reserveBoxToolEcho } from "./boxToolCapacity.js";
import { authorityFromJournalCtx, consumePrepared, isContinuationConflict,
  PreparedConsumptionError, trustedIdentitiesBind,
  type AuthorityProjection, type PreparedContinuation,
  type PreparedConsumption } from "./boxPreparedContinuation.js";
import { parseBoxPrelaunchBootstrap, type BoxPrelaunchReceipt } from "./boxPrelaunchControl.js";
import { parseBoxNativePointer, type BoxNativePointer } from "./boxNativePointer.js";
import { parseBoxReplayMessagePointer,
  type BoxReplayMessagePointer } from "./boxReplayMessageFile.js";

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
function matchingReplayPointer(value: unknown, input: { uid: bigint; requestId: string;
  runNonce: string; leaseEpoch: string; roundNo: number }): BoxReplayMessagePointer | null {
  const pointer = parseBoxReplayMessagePointer(value);
  return pointer && pointer.uid === input.uid.toString()
    && pointer.requestId === input.requestId
    && pointer.runNonce === input.runNonce
    && pointer.leaseEpoch === input.leaseEpoch
    && pointer.roundNo === input.roundNo ? pointer : null;
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
  /** Live callers provide the original body so the alias is derived and
   * checked here, never accepted as an unrelated caller-supplied hash. */
  canonicalBody?: ProxyBody;
  /** New calls with a private Message writer must never terminalize/clean
   * without a same-round capsule pointer. Old in-flight rows omit this. */
  replayRequired?: boolean;
  runNonce: string;
  leaseEpoch: string;
  invocationMode?: "text" | "detached_tool";
  /** Hash of model-affecting context actually launched in the detached CLI. */
  contextHash?: string;
  detachedRunnerHash?: string;
  catalogHash?: string;
  /** Exact upstream CLI model already selected by the authenticated Box route.
   * Required only for newly detached text runs, not legacy text capsules. */
  upstreamModel?: string;
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
export type BoxResumeDecision =
  | { readonly kind: "new_claim"; readonly claim: BoxToolResumeClaim }
  | { readonly kind: "in_progress_or_unknown"; readonly code: string }
  | { readonly kind: "reject"; readonly code: string };
/** A matched HTTP request is observable, never permission to launch it again. */
export interface BoxReplayIdentity {
  readonly requestId: string;
  readonly rootRequestId: string;
  readonly uid: bigint;
  readonly accountId: bigint;
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly invocationMode: "text" | "detached_tool";
  readonly state: string;
  readonly roundNo: number;
  readonly spoolOffset: number;
  readonly rootLaunchPermit: boolean;
  readonly messagePointer?: BoxReplayMessagePointer;
  readonly detachedRunnerHash?: string;
  readonly catalogHash?: string;
  readonly upstreamModel?: string;
  readonly resultHashes?: readonly { modelToolUseId: string;
    contentHash: string; isError: boolean }[];
  /** Immediate previous owner's stored tool digests. Omitted unless that
   * handoff matches this row's catalog, round, runner, and spool offset. */
  readonly priorToolUses?: readonly BoxToolUseDigest[];
  /** CLI session stored on the admitted root run. Not the outer CCB session. */
  readonly nativeSessionId?: string;
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
export interface BoxNativeGcCandidate {
  readonly requestId: string;
  readonly uid: bigint;
  readonly sessionId: string;
  readonly accountId: bigint;
  readonly pointer: BoxNativePointer;
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
export type BoxRecoveryRejectReason =
  | "BOX_RECOVERY_NOT_UNKNOWN_LEAF"
  | "BOX_RECOVERY_CHAIN_INVALID"
  | "BOX_RECOVERY_ROOT_PERMIT_MISSING"
  | "BOX_RECOVERY_PARENT_HASHES_MISSING"
  | "BOX_RECOVERY_REVISION_MISMATCH"
  | "BOX_RECOVERY_MODEL_UNMAPPED"
  | "BOX_RECOVERY_EVIDENCE_MISSING";
export interface BoxDetachedUnknownRecovery {
  readonly requestId: string;
  readonly uid: bigint;
  readonly accountId: bigint;
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly sessionId: string;
  readonly turnKey: string;
  readonly model: "box-api-claude-opus-5-5";
  readonly upstreamModel: "claude-opus-5-5";
  readonly roundNo: number;
  readonly spoolOffset: number;
  readonly catalogHash: string;
  readonly detachedRunnerHash: string;
  readonly rootRequestId: string;
  readonly rootLaunchPermit: true;
  readonly resultHashes: readonly { modelToolUseId: string; contentHash: string;
    isError: boolean }[] | null;
}
export interface BoxRecoveryWinner {
  readonly state: string;
  readonly boxState: string;
  readonly proofReason: string | null;
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
// New successful Box rounds retain the completed Message before stdout is
// truncated. Old rows and proven stopped failures keep their cleanup route.
const CLEANUP_REPLAY_FENCE = `(ctx->>'boxState'<>'terminal'
  OR ctx->>'boxReplayRequired' IS DISTINCT FROM 'true'
  OR ctx ? 'boxReplayMessage')`;
// Legacy connected text has no detached spool and must never enter the
// runner cleanup queue. Only the new, durably armed text lane shares it.
const CLEANUP_MODE_FENCE = `(ctx->>'boxInvocationMode'='detached_tool'
  OR (ctx->>'boxInvocationMode'='text'
    AND ctx->>'boxLaunchPermit'='true'
    AND ctx->>'boxUpstreamModel'='claude-opus-5-5'
    AND (ctx->>'boxDetachedRunnerHash') ~ '^[a-f0-9]{64}$'))`;
const STOP_MODE_FENCE = CLEANUP_MODE_FENCE;
function stoppedRunMode(ctx: Record<string, unknown>): boolean {
  return ctx.boxInvocationMode === "detached_tool"
    || (ctx.boxInvocationMode === "text" && ctx.boxLaunchPermit === true
      && ctx.boxUpstreamModel === "claude-opus-5-5"
      && typeof ctx.boxDetachedRunnerHash === "string"
      && /^[a-f0-9]{64}$/.test(ctx.boxDetachedRunnerHash));
}

const STOP_PROBE_STATE_FENCE = `((state='inflight'
  AND ctx->>'boxState' IN ('running','unknown','linked')
  AND NOT (ctx ? 'boxToolHandoff'))
  OR (state IN ('inflight','finalizing','committed')
    AND ctx->>'boxState' IN ('handoff','unknown')
    AND ctx ? 'boxToolHandoff'))`;

export interface BoxJournalPort {
  admit(input: BoxJournalAdmission): Promise<void>;
  markRunning(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void>;
  armTextLaunch?(input: Pick<BoxJournalAdmission, "requestId" | "uid" |
    "accountId" | "runNonce" | "leaseEpoch"> &
    { detachedRunnerHash: string; upstreamModel: string }): Promise<void>;
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
    { proof: BoxTerminalProof; usage: BoxUsageEvidence;
      messagePointer?: BoxReplayMessagePointer }): Promise<void>;
  claimRemoteCleanup?(input: BoxRemoteCleanupCandidate): Promise<boolean>;
  markRemoteCleaned?(input: BoxRemoteCleanupCandidate): Promise<void>;
  remoteCleanupStatus?(input: BoxRemoteCleanupCandidate): Promise<"done" | "pending" | "invalid">;
  recordToolHandoff?(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { candidate: BoxToolHandoffCandidate;
      roundNo?: number;
      spoolOffset: number;
      detachedRunnerHash: string;
       catalogHash: string;
       verifiedPendingToolUseIds: readonly string[];
       messagePointer?: BoxReplayMessagePointer }): Promise<BoxToolHandoffProof>;
  claimToolResume?(input: { requestId: string; uid: bigint;
    canonicalModel: string; canonicalBody: ProxyBody }): Promise<BoxToolResumeClaim>;
  completeToolChain?(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { proof: BoxTerminalProof; usage: BoxUsageEvidence;
      messagePointer?: BoxReplayMessagePointer }): Promise<void>;
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
    || (input.detachedRunnerHash !== undefined
      && !/^[a-f0-9]{64}$/.test(input.detachedRunnerHash))
    || (input.catalogHash !== undefined
      && !/^[a-f0-9]{64}$/.test(input.catalogHash))
    || (input.replayRequired === true && input.invocationMode === "detached_tool"
      && (!input.detachedRunnerHash || !input.catalogHash))
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

function parseRecoveryResultHashes(raw: unknown):
  BoxDetachedUnknownRecovery["resultHashes"] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32
    || raw.some((item, index) => !Object.hasOwn(raw, index))) return null;
  if (raw.some((item) => !item || typeof item !== "object" || Array.isArray(item)
    || Object.keys(item).sort().join(",") !== "contentHash,isError,modelToolUseId"
    || typeof (item as { modelToolUseId?: unknown }).modelToolUseId !== "string"
    || !/^toolu_[A-Za-z0-9_-]{1,120}$/.test((item as { modelToolUseId: string }).modelToolUseId)
    || typeof (item as { contentHash?: unknown }).contentHash !== "string"
    || !/^[a-f0-9]{64}$/.test((item as { contentHash: string }).contentHash)
    || typeof (item as { isError?: unknown }).isError !== "boolean")) return null;
  const hashes = raw.map((item) => {
    const row = item as { modelToolUseId: string; contentHash: string; isError: boolean };
    return { modelToolUseId: row.modelToolUseId, contentHash: row.contentHash,
      isError: row.isError };
  });
  if (new Set(hashes.map((item) => item.modelToolUseId)).size !== hashes.length) return null;
  return hashes;
}

export class BoxDurableJournal implements BoxJournalPort {
  /** Test seam. Production leaves this null. Held inside the claim transaction
   * after the fingerprint lookup and before the owner mutation. */
  resumeLookupBarrier: (() => Promise<void>) | null = null;
  constructor(private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly maxAccountRuns: (uid: bigint, accountId: bigint) => number = () => 1) {}

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
        ORDER BY updated_at DESC, (ctx ? 'boxNativePointer') DESC,
          request_id DESC LIMIT 1`,
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

  /** At most one latest expired pointer per native project. A successful
   * cleanup claim is still required before any remote file operation. */
  async listNativeGcCandidates(limit = 10): Promise<BoxNativeGcCandidate[]> {
    const found = await this.pool.query<{ request_id: string; user_id: string;
      ctx: Record<string, unknown> }>(
      `WITH pointers AS (
         SELECT request_id,user_id,ctx,
           row_number() OVER (PARTITION BY user_id,ctx->>'boxAccountId',
             ctx->'boxNativePointer'->>'cliCwd',
             ctx->'boxNativePointer'->>'nativeSessionId'
             ORDER BY (ctx->'boxNativePointer'->>'expiresAtMs')::bigint DESC,
               request_id DESC) AS rn
           FROM request_finalize_journal
          WHERE ctx ? 'boxNativePointer'
            AND jsonb_typeof(ctx->'boxNativePointer'->'expiresAtMs')='number'
            AND (ctx->'boxNativePointer'->>'expiresAtMs') ~ '^[0-9]{13}$'
       ) SELECT request_id,user_id::text,ctx FROM pointers
         WHERE rn=1
           AND (ctx->'boxNativePointer'->>'expiresAtMs')::bigint
             <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint
           AND NOT (ctx ? 'boxNativeGcQuarantine')
           AND COALESCE(ctx->>'boxNativeGcStatus','pending')<>'done'
           AND (ctx->>'boxNativeGcStatus' IS DISTINCT FROM 'claimed'
             OR (jsonb_typeof(ctx->'boxNativeGcRetryAfterMs')='number'
               AND (ctx->>'boxNativeGcRetryAfterMs') ~ '^[0-9]{13}$'
               AND (ctx->>'boxNativeGcRetryAfterMs')::bigint
                 <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))
         ORDER BY (ctx->'boxNativePointer'->>'expiresAtMs')::bigint ASC
         LIMIT $1`,
      [Math.max(1, Math.min(10, Number.isSafeInteger(limit) ? limit : 10))]);
    const out: BoxNativeGcCandidate[] = [];
    for (const row of found.rows) {
      const ctx = row.ctx;
      const pointer = parseBoxNativePointer(ctx?.boxNativePointer, Date.now(), true);
      if (!pointer || pointer.expiresAtMs > Date.now()
        || typeof ctx.boxSessionId !== "string"
        || !/^[A-Za-z0-9._:-]{1,256}$/.test(ctx.boxSessionId)
        || ctx.boxAccountId !== pointer.accountId
        || !/^[A-Za-z0-9_-]{1,64}$/.test(row.request_id)) continue;
      out.push({ requestId: row.request_id, uid: BigInt(row.user_id),
        sessionId: ctx.boxSessionId, accountId: BigInt(pointer.accountId), pointer });
    }
    return out;
  }

  /** Same account/session locks as admit. All rows sharing the project are
   * re-read under row locks before a durable claim authorizes remote deletion. */
  async claimNativeGc(input: BoxNativeGcCandidate): Promise<boolean> {
    if (input.uid <= 0n || input.accountId <= 0n
      || !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.sessionId)
      || !parseBoxNativePointer(input.pointer, Date.now(), true)
      || input.pointer.accountId !== input.accountId.toString()) return false;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await lock(client, [`box:account:${input.accountId}`,
        `box:session:${input.uid}:${input.sessionId}`]);
      const found = await client.query<{ request_id: string;
        ctx: Record<string, unknown> }>(
        `SELECT request_id,ctx FROM request_finalize_journal
          WHERE user_id=$1 AND ctx->>'boxAccountId'=$2
            AND ctx->>'boxNativeCliCwd'=$3
          ORDER BY request_id FOR UPDATE`,
        [input.uid.toString(), input.accountId.toString(), input.pointer.cliCwd]);
      const rows = found.rows;
      const owner = rows.find((row) => row.request_id === input.requestId);
      if (!owner || owner.ctx.boxSessionId !== input.sessionId
        || !isDeepStrictEqual(owner.ctx.boxNativePointer, input.pointer)
        || input.pointer.expiresAtMs > Date.now()
        || owner.ctx.boxNativeGcQuarantine !== undefined
        || owner.ctx.boxNativeGcStatus === "done") return false;
      const retry = owner.ctx.boxNativeGcRetryAfterMs;
      if (owner.ctx.boxNativeGcStatus === "claimed"
        && (typeof retry !== "number" || !Number.isSafeInteger(retry)
          || retry > Date.now())) return false;
      const group = rows.filter((row) =>
        row.ctx.boxNativeSessionId === input.pointer.nativeSessionId);
      if (group.length === 0 || group.length !== rows.length) return false;
      const pointers = group.flatMap((row) => {
        const parsed = row.ctx.boxNativePointer === undefined ? null
          : parseBoxNativePointer(row.ctx.boxNativePointer, Date.now(), true);
        return parsed ? [{ row, pointer: parsed }] : [];
      });
      if (pointers.length === 0 || pointers.some(({ pointer }) =>
        pointer.cliCwd !== input.pointer.cliCwd
        || pointer.accountId !== input.pointer.accountId)) return false;
      const latest = pointers.sort((a, b) => b.pointer.expiresAtMs - a.pointer.expiresAtMs
        || b.row.request_id.localeCompare(a.row.request_id))[0];
      if (latest?.row.request_id !== input.requestId) return false;
      const byId = new Map(group.map((row) => [row.request_id, row]));
      if (group.some((row) => ACTIVE.includes(String(row.ctx.boxState))
        || row.ctx.boxSessionId !== input.sessionId
        || row.ctx.boxNativePointer !== undefined
          && !parseBoxNativePointer(row.ctx.boxNativePointer, Date.now(), true)
        || typeof row.ctx.boxNativeClaimRequestId === "string"
          && !byId.has(row.ctx.boxNativeClaimRequestId))) return false;
      const proven = group.some((row) => row.ctx.boxState === "terminal"
        && row.ctx.boxTerminalProof && typeof row.ctx.boxTerminalProof === "object"
        && (row.ctx.boxTerminalProof as { reason?: unknown }).reason === "worker_complete"
        && row.ctx.boxUsage !== undefined
        && (row.ctx.boxInvocationMode === "detached_tool"
          ? row.ctx.boxRemoteCleanup === "done" : row.ctx.boxInvocationMode === "text"));
      if (!proven) return false;
      const changed = await client.query(
        `UPDATE request_finalize_journal
            SET ctx=ctx || $4::jsonb,updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2 AND ctx->'boxNativePointer'=$3::jsonb
            AND COALESCE(ctx->>'boxNativeGcStatus','pending')<>'done'
            AND NOT (ctx ? 'boxNativeGcQuarantine')`,
        [input.requestId, input.uid.toString(), JSON.stringify(input.pointer),
          JSON.stringify({ boxNativeGcStatus: "claimed",
            boxNativeGcRetryAfterMs: Date.now() + 120_000 })]);
      if (changed.rowCount !== 1) return false;
      await client.query("COMMIT");
      committed = true;
      return true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async finishNativeGc(input: BoxNativeGcCandidate,
    outcome: "done" | "blocked"): Promise<boolean> {
    const update = outcome === "done"
      ? { boxNativeGcStatus: "done" }
      : { boxNativeGcQuarantine: "remote_project_not_exclusive" };
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || $4::jsonb,updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2
          AND ctx->'boxNativePointer'=$3::jsonb
          AND ctx->>'boxNativeGcStatus'='claimed'
          AND NOT (ctx ? 'boxNativeGcQuarantine')`,
      [input.requestId, input.uid.toString(), JSON.stringify(input.pointer),
        JSON.stringify(update)]);
    return changed.rowCount === 1;
  }

  /** Find the original round before precharge or account selection. This only
   * reads committed evidence; the caller must separately observe the pinned
   * spool/proof or load a completed Message before returning any answer. */
  async findReplayIdentity(input: { uid: bigint; canonicalModel: string;
    canonicalBody: ProxyBody; trustedAuthority?: AuthorityProjection;
    prepared?: PreparedContinuation }): Promise<BoxReplayIdentity | null> {
    const stream = (input.canonicalBody as { stream?: boolean }).stream;
    if (input.uid <= 0n || input.canonicalBody.model !== input.canonicalModel
      || (stream !== true && stream !== false)) {
      throw new BoxDurableJournalError("BOX_REPLAY_IDENTITY_INVALID");
    }
    let view: PreparedConsumption;
    let fingerprint: BoxCallFingerprint;
    let key: string;
    try {
      view = consumePrepared({
        uid: input.uid, canonicalModel: input.canonicalModel,
        canonicalBody: input.canonicalBody, prepared: input.prepared,
        trustedAuthority: input.trustedAuthority,
        allowPrepareOnce: input.prepared === undefined, replayAlias: true,
      });
      fingerprint = view.fingerprint;
      key = stream === false ? view.fallbackAlias : fingerprint.replayFingerprint;
    } catch (error) {
      if (error instanceof PreparedConsumptionError
        && (error.code === "BOX_AUTHORITY_MALFORMED" || error.code === "BOX_AUTHORITY_REJECTED"
          || error.code === "BOX_PREPARED_STALE")) {
        throw new BoxDurableJournalError(error.code);
      }
      throw new BoxDurableJournalError("BOX_REPLAY_IDENTITY_INVALID");
    }
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await lock(client, [`box:session:${input.uid}:${fingerprint.sessionId}`]);
      type Row = { request_id: string; ctx: Record<string, unknown> };
      const column = stream === false ? "boxFallbackAlias" : "boxReplayFingerprint";
      const found = await client.query<Row>(
        `SELECT request_id,ctx FROM request_finalize_journal
          WHERE user_id=$1 AND ctx->>'boxSessionId'=$2
            AND ctx->>'boxTurnKey'=$3 AND ctx->>'model'=$4
            AND ctx->>$5=$6 LIMIT 2`,
        [input.uid.toString(), fingerprint.sessionId, fingerprint.turnKey,
          input.canonicalModel, column, key]);
      if (found.rows.length > 1) throw new BoxDurableJournalError("BOX_CALL_AMBIGUOUS");
      const matched = found.rows[0];
      if (!matched) {
        await client.query("COMMIT"); committed = true; return null;
      }
      const original = matched.ctx;
      const accountId = original.boxAccountId;
      const runNonce = original.boxRunNonce;
      const leaseEpoch = original.boxLeaseEpoch;
      const mode = original.boxInvocationMode;
      const roundNo = original.boxRoundNo ?? 1;
      const spoolOffset = original.boxResumeSpoolOffset ?? 0;
      const detachedRunnerHash = original.boxDetachedRunnerHash;
      const catalogHash = original.boxCatalogHash;
      const upstreamModel = original.boxUpstreamModel;
      let resultHashes: BoxReplayIdentity["resultHashes"];
      const messagePointer = original.boxReplayMessage === undefined ? undefined
        : matchingReplayPointer(original.boxReplayMessage, { uid: input.uid,
          requestId: matched.request_id, runNonce: String(runNonce),
          leaseEpoch: String(leaseEpoch), roundNo: Number(roundNo) });
      if (original.boxInvocationRecovery !== "v1"
        || typeof accountId !== "string" || !/^[1-9][0-9]{0,19}$/.test(accountId)
        || typeof runNonce !== "string" || !/^[a-f0-9]{24}$/.test(runNonce)
        || typeof leaseEpoch !== "string" || !/^[a-f0-9]{32}$/.test(leaseEpoch)
        || (mode !== "text" && mode !== "detached_tool")
        || !Number.isSafeInteger(roundNo) || Number(roundNo) < 1
        || Number(roundNo) > BOX_TOOL_MAX_ROUNDS
        || !Number.isSafeInteger(spoolOffset) || Number(spoolOffset) < 0
        || Number(spoolOffset) > BOX_TOOL_SPOOL_MAX_BYTES
        || (original.boxReplayMessage !== undefined && !messagePointer)
        || (detachedRunnerHash !== undefined && (typeof detachedRunnerHash !== "string"
          || !/^[a-f0-9]{64}$/.test(detachedRunnerHash)))
        || (catalogHash !== undefined && (typeof catalogHash !== "string"
          || !/^[a-f0-9]{64}$/.test(catalogHash)))
        || (mode === "detached_tool" && Number(roundNo) > 1
          && (!detachedRunnerHash || !catalogHash))
        || (mode === "text" && (detachedRunnerHash !== undefined
          || original.boxLaunchPermit !== undefined)
          && (typeof upstreamModel !== "string"
            || upstreamModel !== "claude-opus-5-5"))
        || ![...ACTIVE, "terminal", "failed_stopped", "prestart_stopped"]
          .includes(String(original.boxState))) {
        throw new BoxDurableJournalError("BOX_REPLAY_EVIDENCE_INVALID");
      }
      let row = matched;
      const seen = new Set<string>();
      let priorToolUses: BoxReplayIdentity["priorToolUses"];
      let projectedNative: string | undefined;
      let nativeConflict = false;
      const noteNative = (ctx: Record<string, unknown>): void => {
        if (!Object.hasOwn(ctx, "boxNativeSessionId")) return;
        const value = ctx.boxNativeSessionId;
        if (typeof value !== "string" || !UUID_V4.test(value)) {
          nativeConflict = true;
          return;
        }
        if (projectedNative === undefined) projectedNative = value;
        else if (projectedNative !== value) nativeConflict = true;
      };
      for (let hop = 0; hop < BOX_TOOL_MAX_ROUNDS; hop++) {
        if (seen.has(row.request_id)
          || row.ctx.boxInvocationRecovery !== "v1"
          || row.ctx.boxInvocationMode !== mode
          || row.ctx.boxAccountId !== accountId
          || row.ctx.boxRunNonce !== runNonce || row.ctx.boxLeaseEpoch !== leaseEpoch
          || row.ctx.boxSessionId !== fingerprint.sessionId
          || row.ctx.boxTurnKey !== fingerprint.turnKey
          || row.ctx.model !== input.canonicalModel) {
          throw new BoxDurableJournalError("BOX_REPLAY_EVIDENCE_INVALID");
        }
        const bound = trustedIdentitiesBind({
          uid: view.prepared.uid, sessionId: fingerprint.sessionId,
          canonicalModel: view.prepared.canonicalModel, turnKey: fingerprint.turnKey,
          authority: view.prepared.authority,
        }, {
          uid: input.uid, sessionId: String(row.ctx.boxSessionId ?? ""),
          canonicalModel: String(row.ctx.model ?? ""), turnKey: String(row.ctx.boxTurnKey ?? ""),
          authority: authorityFromJournalCtx(row.ctx),
        });
        if (!bound.ok) throw new BoxDurableJournalError(bound.code);
        seen.add(row.request_id);
        noteNative(row.ctx);
        const owner = row.ctx.boxOwnerRequestId;
        if (owner === undefined) {
          await client.query("COMMIT"); committed = true;
          if (nativeConflict) projectedNative = undefined;
          return { requestId: matched.request_id, rootRequestId: row.request_id,
            uid: input.uid, accountId: BigInt(accountId), runNonce, leaseEpoch,
            invocationMode: mode, state: original.boxState as string,
             roundNo: Number(roundNo), spoolOffset: Number(spoolOffset),
             rootLaunchPermit: row.ctx.boxLaunchPermit === true,
             ...(messagePointer ? { messagePointer } : {}),
             ...(detachedRunnerHash ? { detachedRunnerHash } : {}),
             ...(catalogHash ? { catalogHash } : {}),
             ...(typeof upstreamModel === "string" ? { upstreamModel } : {}),
             ...(resultHashes ? { resultHashes } : {}),
             ...(priorToolUses ? { priorToolUses } : {}),
             ...(projectedNative ? { nativeSessionId: projectedNative } : {}) };
        }
        if (typeof owner !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) {
          throw new BoxDurableJournalError("BOX_REPLAY_EVIDENCE_INVALID");
        }
        const parent = await client.query<Row>(
          "SELECT request_id,ctx FROM request_finalize_journal WHERE request_id=$1 AND user_id=$2",
          [owner, input.uid.toString()]);
        if (parent.rowCount !== 1 || !parent.rows[0]) {
          throw new BoxDurableJournalError("BOX_REPLAY_EVIDENCE_INVALID");
        }
        if (hop === 0) {
          const parentCtx = parent.rows[0].ctx;
          const raw = parentCtx.boxResumeResultHashes;
          if (parentCtx.boxResumeRequestId !== matched.request_id
            || parentCtx.boxResumeRevision !== original.boxParentResumeRevision
            || !Array.isArray(raw) || raw.length < 1 || raw.length > 32
            || Array.from({ length: raw.length }, (_, i) => i)
              .some((i) => !Object.hasOwn(raw, i))
            || raw.some((item) => !item || typeof item !== "object"
              || Array.isArray(item)
              || Object.keys(item).sort().join(",") !== "contentHash,isError,modelToolUseId"
              || typeof item.modelToolUseId !== "string"
              || !/^toolu_[A-Za-z0-9_-]{1,120}$/.test(item.modelToolUseId)
              || typeof item.contentHash !== "string"
              || !/^[a-f0-9]{64}$/.test(item.contentHash)
              || typeof item.isError !== "boolean")
            || new Set(raw.map((item) => item.modelToolUseId)).size !== raw.length) {
            throw new BoxDurableJournalError("BOX_REPLAY_EVIDENCE_INVALID");
          }
          resultHashes = raw.map((item) => ({ modelToolUseId: item.modelToolUseId,
            contentHash: item.contentHash, isError: item.isError }));
          if (mode === "detached_tool" && Number(roundNo) > 1
            && typeof catalogHash === "string" && typeof detachedRunnerHash === "string") {
            const stored = parseBoxStoredToolHandoff(parentCtx.boxToolHandoff);
            if (stored && stored.catalogHash === catalogHash
              && stored.detachedRunnerHash === detachedRunnerHash
              && stored.roundNo + 1 === Number(roundNo)
              && stored.spoolOffset === Number(spoolOffset)) {
              priorToolUses = stored.toolUses;
            }
          }
        }
        row = parent.rows[0];
      }
      throw new BoxDurableJournalError("BOX_REPLAY_EVIDENCE_INVALID");
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  /** Background takeover of only armed, unknown detached text. This produces
   * read identity, never another admission or paid launch permission. */
  async listTextUnknownCandidates(limit = 10): Promise<BoxReplayIdentity[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new BoxDurableJournalError("BOX_TEXT_OBSERVER_LIMIT_INVALID");
    }
    const found = await this.pool.query<{ request_id: string;
      user_id: string; ctx: Record<string, unknown> }>(
      `SELECT request_id,user_id::text,ctx FROM request_finalize_journal
        WHERE state='inflight' AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='text' AND ctx->>'boxState'='unknown'
          AND ctx->>'boxLaunchPermit'='true'
          AND ctx->>'boxUpstreamModel'='claude-opus-5-5'
          AND (ctx->>'boxDetachedRunnerHash') ~ '^[a-f0-9]{64}$'
          AND (ctx->>'boxAccountId') ~ '^[1-9][0-9]{0,19}$'
          AND (ctx->>'boxRunNonce') ~ '^[a-f0-9]{24}$'
          AND (ctx->>'boxLeaseEpoch') ~ '^[a-f0-9]{32}$'
          AND NOT (ctx ? 'boxOwnerRequestId')
          AND NOT (ctx ? 'boxReplayMessage') AND NOT (ctx ? 'boxTerminalProof')
          AND (NOT (ctx ? 'boxTextObserverRetryAfterMs')
            OR (jsonb_typeof(ctx->'boxTextObserverRetryAfterMs')='number'
              AND (ctx->>'boxTextObserverRetryAfterMs') ~ '^[0-9]{13}$'
              AND (ctx->>'boxTextObserverRetryAfterMs')::bigint
                <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))
        ORDER BY CASE WHEN jsonb_typeof(ctx->'boxTextObserverLastAttemptMs')='number'
          AND (ctx->>'boxTextObserverLastAttemptMs') ~ '^[0-9]{13}$'
          THEN (ctx->>'boxTextObserverLastAttemptMs')::bigint ELSE 0 END ASC,
          updated_at ASC LIMIT $1`, [limit]);
    return found.rows.flatMap((row): BoxReplayIdentity[] => {
      const ctx = row.ctx;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(row.request_id)
        || !/^[1-9][0-9]{0,19}$/.test(row.user_id)
        || !ctx || typeof ctx.boxAccountId !== "string"
        || typeof ctx.boxRunNonce !== "string"
        || typeof ctx.boxLeaseEpoch !== "string"
        || typeof ctx.boxDetachedRunnerHash !== "string") return [];
      return [{ requestId: row.request_id, rootRequestId: row.request_id,
        uid: BigInt(row.user_id), accountId: BigInt(ctx.boxAccountId),
        runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch,
        invocationMode: "text", state: "unknown", roundNo: 1,
        spoolOffset: 0, rootLaunchPermit: true,
        detachedRunnerHash: ctx.boxDetachedRunnerHash,
        upstreamModel: "claude-opus-5-5" }];
    });
  }

  async claimTextUnknownCandidate(input: BoxReplayIdentity): Promise<boolean> {
    if (input.invocationMode !== "text" || input.state !== "unknown"
      || !input.rootLaunchPermit || input.requestId !== input.rootRequestId
      || input.roundNo !== 1 || input.uid <= 0n || input.accountId <= 0n
      || !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
      || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
      || typeof input.detachedRunnerHash !== "string"
      || !/^[a-f0-9]{64}$/.test(input.detachedRunnerHash)
      || input.upstreamModel !== "claude-opus-5-5") {
      throw new BoxDurableJournalError("BOX_TEXT_OBSERVER_IDENTITY_INVALID");
    }
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || jsonb_build_object(
            'boxTextObserverLastAttemptMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint,
            'boxTextObserverRetryAfterMs',
              (EXTRACT(EPOCH FROM NOW()+INTERVAL '1 minute')*1000)::bigint)
        WHERE request_id=$1 AND user_id=$2 AND state='inflight'
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='text' AND ctx->>'boxState'='unknown'
          AND ctx->>'boxLaunchPermit'='true'
          AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
          AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxDetachedRunnerHash'=$6
          AND ctx->>'boxUpstreamModel'=$7
          AND NOT (ctx ? 'boxOwnerRequestId')
          AND NOT (ctx ? 'boxReplayMessage') AND NOT (ctx ? 'boxTerminalProof')
          AND (NOT (ctx ? 'boxTextObserverRetryAfterMs')
            OR (jsonb_typeof(ctx->'boxTextObserverRetryAfterMs')='number'
              AND (ctx->>'boxTextObserverRetryAfterMs') ~ '^[0-9]{13}$'
              AND (ctx->>'boxTextObserverRetryAfterMs')::bigint
                <= (EXTRACT(EPOCH FROM NOW())*1000)::bigint))`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch, input.detachedRunnerHash,
        input.upstreamModel]);
    return changed.rowCount === 1;
  }

  async admit(input: BoxJournalAdmission): Promise<void> {
    goodId(input);
    const detachedText = (input.invocationMode ?? "text") === "text"
      && input.detachedRunnerHash !== undefined;
    if (detachedText ? (typeof input.detachedRunnerHash !== "string"
      || !/^[a-f0-9]{64}$/.test(input.detachedRunnerHash)
      || input.model !== "box-api-claude-opus-5-5"
      || input.upstreamModel !== "claude-opus-5-5"
      || input.catalogHash !== undefined)
      : input.upstreamModel !== undefined) {
      throw new BoxDurableJournalError("BOX_TEXT_DETACHED_BINDING_INVALID");
    }
    if (input.replayRequired === true && !input.canonicalBody) {
      throw new BoxDurableJournalError("BOX_JOURNAL_IDENTITY_INVALID");
    }
    let fallbackAlias: string | undefined;
    if (input.canonicalBody) {
      try {
        const derived = deriveBoxCallFingerprint(input.uid, input.canonicalBody);
        if (!isDeepStrictEqual(derived, input.fingerprint)
          || input.canonicalBody.model !== input.model) {
          throw new Error("fingerprint mismatch");
        }
        fallbackAlias = deriveBoxFallbackAlias(input.uid, input.canonicalBody);
      } catch { throw new BoxDurableJournalError("BOX_JOURNAL_IDENTITY_INVALID"); }
    }
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
        `SELECT 1 FROM request_finalize_journal
          WHERE ctx->>'boxReplayFingerprint' = $1
             OR ctx->>'boxFallbackAlias' = $2 LIMIT 1`,
        [input.fingerprint.replayFingerprint, fallbackAlias ?? null]);
      if (duplicate.rowCount) throw new BoxDurableJournalError("BOX_CALL_AMBIGUOUS");
      const maxRuns = this.maxAccountRuns(input.uid, input.accountId);
      if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 2) {
        throw new BoxDurableJournalError("BOX_CAPACITY_POLICY_INVALID");
      }
      // Linked HTTP rows of one tool chain share a remote run. Count remote
      // identities, not journal rows; malformed active evidence fails closed.
      const occupied = await client.query<{ user_id: string;
        session_id: string | null; account_id: string | null;
        run_nonce: string | null; lease_epoch: string | null }>(
        `SELECT user_id, ctx->>'boxSessionId' AS session_id,
           ctx->>'boxAccountId' AS account_id,
           ctx->>'boxRunNonce' AS run_nonce,
           ctx->>'boxLeaseEpoch' AS lease_epoch
         FROM request_finalize_journal
         WHERE ctx->>'boxState' = ANY($1::text[])
           AND (ctx->>'boxAccountId' = $2 OR
             (user_id = $3 AND ctx->>'boxSessionId' = $4)) LIMIT 1024`,
        [ACTIVE, input.accountId.toString(), input.uid.toString(),
          input.fingerprint.sessionId]);
      // A 128-round tool chain can itself have >128 linked HTTP rows. Bound
      // the read well above both allowed chains; overflow still fails closed.
      if ((occupied.rowCount ?? occupied.rows.length) >= 1024) {
        throw new BoxDurableJournalError("BOX_CAPACITY_HELD");
      }
      const accountRuns = new Set<string>();
      for (const row of occupied.rows) {
        if (String(row.user_id) === input.uid.toString()
          && row.session_id === input.fingerprint.sessionId) {
          throw new BoxDurableJournalError("BOX_CAPACITY_HELD");
        }
        if (row.account_id !== input.accountId.toString()) continue;
        if (!/^[a-f0-9]{24}$/.test(row.run_nonce ?? "")
          || !/^[a-f0-9]{32}$/.test(row.lease_epoch ?? "")) {
          throw new BoxDurableJournalError("BOX_CAPACITY_HELD");
        }
        accountRuns.add(`${row.run_nonce}:${row.lease_epoch}`);
      }
      if (accountRuns.size >= maxRuns) {
        throw new BoxDurableJournalError("BOX_CAPACITY_HELD");
      }
      if (native) {
        // The remote preflight happens before these locks. A pointer can expire
        // while waiting for another account/session transaction; never commit
        // a claim that the expiry reaper is now allowed to delete.
        if (!parseBoxNativePointer(native.pointer, Date.now())) {
          throw new BoxDurableJournalError("BOX_NATIVE_CLAIM_LOST");
        }
        // The candidate was read before the account/turn locks. A completed
        // intervening turn can make it stale without leaving ACTIVE capacity.
        const latest = await client.query<{ request_id: string }>(
          `SELECT request_id FROM request_finalize_journal
            WHERE user_id=$1 AND ctx->>'boxSessionId'=$2
              AND ctx->>'model'=$3 AND ctx->>'boxInvocationRecovery'='v1'
              AND request_id<>$4
            ORDER BY updated_at DESC, (ctx ? 'boxNativePointer') DESC,
              request_id DESC LIMIT 1 FOR UPDATE`,
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
        ...(input.replayRequired === true ? { boxReplayRequired: true } : {}),
        boxInvocationMode: input.invocationMode ?? "text",
        boxAccountId: input.accountId.toString(),
        boxReplayFingerprint: input.fingerprint.replayFingerprint,
        ...(fallbackAlias ? { boxFallbackAlias: fallbackAlias } : {}),
        boxRequestHash: input.fingerprint.requestHash,
        boxTurnKey: input.fingerprint.turnKey,
        boxSessionId: input.fingerprint.sessionId,
        ...(input.invocationMode === "detached_tool"
          ? { boxContextHash: input.contextHash,
            ...(input.detachedRunnerHash ? { boxDetachedRunnerHash: input.detachedRunnerHash } : {}),
            ...(input.catalogHash ? { boxCatalogHash: input.catalogHash } : {}) } : {}),
        ...(detachedText ? { boxDetachedRunnerHash: input.detachedRunnerHash,
          boxUpstreamModel: input.upstreamModel } : {}),
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
          AND NOT (ctx->>'boxInvocationMode'='text'
            AND ctx ? 'boxDetachedRunnerHash')
          AND NOT (ctx ? 'boxPrelaunchControl')`,
      [input.requestId, input.uid.toString(), input.leaseEpoch]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_START_FENCE_LOST");
  }

  /** One durable text launch permit. Once committed, a missing/ambiguous
   * detached-runner acknowledgement is unknown, never prestart cleanup. */
  async armTextLaunch(input: Pick<BoxJournalAdmission, "requestId" | "uid" |
    "accountId" | "runNonce" | "leaseEpoch"> &
    { detachedRunnerHash: string; upstreamModel: string }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || input.accountId <= 0n || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
      || !/^[a-f0-9]{64}$/.test(input.detachedRunnerHash)
      || input.upstreamModel !== "claude-opus-5-5") {
      throw new BoxDurableJournalError("BOX_TEXT_LAUNCH_IDENTITY_INVALID");
    }
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx=ctx || '{"boxState":"running","boxLaunchPermit":true}'::jsonb,
              updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND state='inflight'
          AND ctx->>'boxAccountId'=$3 AND ctx->>'boxRunNonce'=$4
          AND ctx->>'boxLeaseEpoch'=$5
          AND ctx->>'boxInvocationMode'='text' AND ctx->>'boxState'='reserved'
          AND ctx->>'boxDetachedRunnerHash'=$6
          AND ctx->>'boxUpstreamModel'=$7
          AND NOT (ctx ? 'boxLaunchPermit')
          AND NOT (ctx ? 'boxPrelaunchControl')`,
      [input.requestId, input.uid.toString(), input.accountId.toString(),
        input.runNonce, input.leaseEpoch, input.detachedRunnerHash,
        input.upstreamModel]);
    if (changed.rowCount !== 1) {
      throw new BoxDurableJournalError("BOX_TEXT_LAUNCH_FENCE_LOST");
    }
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
          AND NOT (ctx ? 'boxPrelaunchControl')
          AND NOT (ctx ? 'boxLaunchPermit')`,
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
          AND ctx->>'boxState' = ANY($5::text[])
          AND NOT (ctx ? 'boxToolHandoff')
          AND NOT (ctx ? 'boxReplayMessage')
          AND NOT (ctx ? 'boxTerminalProof')`,
      [input.requestId, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "unknown", boxUnknownPhase: input.phase.slice(0, 80) }),
        ["reserved", "starting", "running", "linked", "resuming", "unknown"]]);
    if (changed.rowCount === 1) return;
    // A late caller abort or stream error cannot turn already-published model
    // evidence back into unknown. No UPDATE (or updated_at bump) on that path.
    const found = await this.pool.query<{ ctx: Record<string, unknown> }>(
      `SELECT ctx FROM request_finalize_journal WHERE request_id=$1 AND user_id=$2
        AND ctx->>'boxLeaseEpoch'=$3`,
      [input.requestId, input.uid.toString(), input.leaseEpoch]);
    const ctx = found.rows[0]?.ctx;
    if (found.rowCount === 1 && ctx && (
      (ctx.boxState === "handoff" && ctx.boxToolHandoff !== undefined)
      || (ctx.boxState === "terminal" && ctx.boxTerminalProof !== undefined
        && ctx.boxUsage !== undefined)
      || (ctx.boxState === "failed_stopped" && ctx.boxTerminalProof !== undefined))) return;
    throw new BoxDurableJournalError("BOX_JOURNAL_UNKNOWN_FENCE_LOST");
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
        || !stoppedRunMode(ctx)
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
          || !stoppedRunMode(linked)
          || linked.boxInvocationMode !== ctx.boxInvocationMode
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
        || !stoppedRunMode(ctx)
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
            AND ${STOP_MODE_FENCE}
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
    { proof: BoxTerminalProof; usage: BoxUsageEvidence;
      messagePointer?: BoxReplayMessagePointer }): Promise<void> {
    const u = input.usage;
    const pointer = input.messagePointer === undefined ? undefined
      : matchingReplayPointer(input.messagePointer, { uid: input.uid,
        requestId: input.requestId, runNonce: input.proof.runNonce,
        leaseEpoch: input.leaseEpoch, roundNo: 1 });
    if (input.proof.leaseEpoch !== input.leaseEpoch
      || input.proof.reason !== "worker_complete"
      || !validUsageEvidence(u)
      || (input.messagePointer !== undefined && !pointer)) {
      throw new BoxDurableJournalError("BOX_JOURNAL_EVIDENCE_INVALID");
    }
    const changed = await this.pool.query(
      `UPDATE request_finalize_journal
          SET ctx = ctx || $4::jsonb, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
           AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxRunNonce' = $5
           AND ctx->>'boxState' IN ('running', 'unknown')
           AND ($6::boolean = false OR (
             COALESCE(ctx->>'boxRoundNo','1')='1'
             AND NOT (ctx ? 'boxToolHandoff')
             AND NOT (ctx ? 'boxReplayMessage')))
           AND (ctx->>'boxReplayRequired' IS DISTINCT FROM 'true' OR $6::boolean = true)
           AND ctx ? 'billingPricing'`,
      [input.requestId, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "terminal", boxUsage: u, boxTerminalProof: input.proof,
          ...(pointer ? { boxReplayMessage: pointer } : {}) }),
        input.proof.runNonce, pointer !== undefined]);
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
       verifiedPendingToolUseIds: readonly string[];
       messagePointer?: BoxReplayMessagePointer }): Promise<BoxToolHandoffProof> {
    const candidate = input.candidate;
    const roundNo = input.roundNo ?? 1;
    const pointer = input.messagePointer === undefined ? undefined
      : matchingReplayPointer(input.messagePointer, { uid: input.uid,
        requestId: input.requestId, runNonce: input.messagePointer.runNonce,
        leaseEpoch: input.leaseEpoch, roundNo });
    const toolUses = candidate && Array.isArray(candidate.toolUses) ? candidate.toolUses : [];
    const ids = toolUses.map((use) => use?.id ?? "");
    const pending = input.verifiedPendingToolUseIds;
    const usage = { inputTokens: candidate?.inputTokens,
      outputTokens: candidate?.outputTokens,
      cacheReadTokens: candidate?.cacheReadTokens,
      cacheWriteTokens: candidate?.cacheWriteTokens };
    if (!Number.isSafeInteger(roundNo) || roundNo < 1
      || roundNo > BOX_TOOL_MAX_ROUNDS
      || (input.messagePointer !== undefined && !pointer)
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
      `UPDATE request_finalize_journal AS handoff_row
          SET ctx = handoff_row.ctx || $4::jsonb, updated_at = NOW()
        WHERE request_id = $1 AND user_id = $2 AND state = 'inflight'
           AND ctx->>'boxLeaseEpoch' = $3
           AND ($10::text IS NULL OR ctx->>'boxRunNonce' = $10)
           AND (ctx->>'boxReplayRequired' IS DISTINCT FROM 'true' OR $10::text IS NOT NULL)
           AND ctx->>'boxInvocationMode' = 'detached_tool'
          AND NOT (ctx ? 'boxCancelIntent')
           AND NOT (ctx ? 'boxToolHandoff')
           AND NOT (ctx ? 'boxReplayMessage')
           AND NOT (ctx ? 'boxTerminalProof')
           AND ((($5::int = 1) AND (ctx->>'boxState' = 'running'
             OR (ctx->>'boxState'='unknown'
               AND ctx->>'boxReplayRequired'='true'
               AND ctx->>'boxLaunchPermit'='true')))
             OR (($5::int > 1) AND (ctx->>'boxState' = 'linked'
               OR (ctx->>'boxState'='unknown'
                 AND ctx->>'boxReplayRequired'='true'
                 AND EXISTS (SELECT 1 FROM request_finalize_journal root
                   WHERE root.user_id=$2
                     AND root.ctx->>'boxRunNonce'=handoff_row.ctx->>'boxRunNonce'
                     AND root.ctx->>'boxLeaseEpoch'=$3
                     AND root.ctx->>'boxAccountId'=handoff_row.ctx->>'boxAccountId'
                     AND root.ctx->>'boxSessionId'=handoff_row.ctx->>'boxSessionId'
                     AND root.ctx->>'boxTurnKey'=handoff_row.ctx->>'boxTurnKey'
                     AND root.ctx->>'boxLaunchPermit'='true'
                     AND NOT (root.ctx ? 'boxOwnerRequestId'))))
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
           boxToolHandoff: frozen,
           ...(pointer ? { boxReplayMessage: pointer } : {}) }), roundNo, input.catalogHash,
         input.detachedRunnerHash, candidate.messageId, input.spoolOffset,
         pointer?.runNonce ?? null]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_TOOL_HANDOFF_FENCE_LOST");
    return { durableRevision, journaledToolUseIds: ids,
      verifiedPendingToolUseIds: pendingIds };
  }

  /** Claim the next HTTP request against a previous model tool message.
   * This transaction runs BEFORE any pending result file is published. If its
   * outcome is ambiguous, no tool result or model call is automatically retried. */
  async decideToolResume(input: { requestId: string; uid: bigint;
    canonicalModel: string; canonicalBody: ProxyBody;
    trustedAuthority?: AuthorityProjection;
    prepared?: PreparedContinuation }): Promise<BoxResumeDecision> {
    try {
      return { kind: "new_claim", claim: await this.claimToolResume(input) };
    } catch (error) {
      if (error instanceof BoxDurableJournalError && isContinuationConflict(error.code)) {
        const kind = error.code === "BOX_CALL_AMBIGUOUS" || error.code === "BOX_RESUME_IN_PROGRESS"
          ? "in_progress_or_unknown" : "reject";
        return { kind, code: error.code };
      }
      throw error;
    }
  }

  async claimToolResume(input: { requestId: string; uid: bigint;
    canonicalModel: string; canonicalBody: ProxyBody;
    trustedAuthority?: AuthorityProjection;
    prepared?: PreparedContinuation }): Promise<BoxToolResumeClaim> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
      || input.uid <= 0n || input.canonicalBody.model !== input.canonicalModel) {
      throw new BoxDurableJournalError("BOX_TOOL_RESUME_IDENTITY_INVALID");
    }
    let view: PreparedConsumption;
    try {
      view = consumePrepared({
        uid: input.uid, canonicalModel: input.canonicalModel,
        canonicalBody: input.canonicalBody, prepared: input.prepared,
        trustedAuthority: input.trustedAuthority,
        allowPrepareOnce: input.prepared === undefined,
      });
    } catch (error) {
      if (error instanceof PreparedConsumptionError) {
        throw new BoxDurableJournalError(error.code === "BOX_PREPARED_REJECT"
          ? "BOX_TOOL_RESUME_IDENTITY_INVALID" : error.code);
      }
      throw new BoxDurableJournalError("BOX_TOOL_RESUME_IDENTITY_INVALID");
    }
    if (view.prepared.classification === "reject") {
      throw new BoxDurableJournalError(view.prepared.rejectCode ?? "BOX_PREPARED_REJECT");
    }
    if (view.prepared.classification !== "continuation_candidate" || !view.catalog
      || view.assistantContent == null || !view.priorContextHash || !view.nextContextHash
      || !view.effectiveBody) {
      throw new BoxDurableJournalError("BOX_PREPARED_REJECT");
    }
    const fingerprint = view.fingerprint;
    const fallbackAlias = view.fallbackAlias;
    const priorContextHash = view.priorContextHash;
    const nextContextHash = view.nextContextHash;
    const boundCatalog = view.catalog;
    const assistantContent = view.assistantContent;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await lock(client, [`box:fingerprint:${fingerprint.replayFingerprint}`,
        `box:session:${input.uid}:${fingerprint.sessionId}`]);
      const duplicate = await client.query(
        `SELECT 1 FROM request_finalize_journal
          WHERE ctx->>'boxReplayFingerprint'=$1
             OR ctx->>'boxFallbackAlias'=$2 LIMIT 1`,
        [fingerprint.replayFingerprint, fallbackAlias]);
      if (duplicate.rowCount) throw new BoxDurableJournalError("BOX_CALL_AMBIGUOUS");
      if (this.resumeLookupBarrier) await this.resumeLookupBarrier();
      const owners = await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
        `SELECT request_id,ctx FROM request_finalize_journal
          WHERE user_id=$1 AND ctx->>'boxSessionId'=$2 AND ctx->>'boxTurnKey'=$3
            AND ctx->>'boxState'='handoff' AND NOT (ctx ? 'boxCancelIntent')
            AND state IN ('inflight','finalizing','committed') FOR UPDATE`,
        [input.uid.toString(), fingerprint.sessionId, fingerprint.turnKey]);
      if (owners.rows.length !== 1) {
        const consumed = await client.query(
          `SELECT 1 FROM request_finalize_journal
            WHERE user_id=$1 AND ctx->>'boxSessionId'=$2 AND ctx->>'boxTurnKey'=$3
              AND ctx->>'model'=$4
              AND ctx->>'boxState' IN ('resuming','unknown','linked')
            LIMIT 1`,
          [input.uid.toString(), fingerprint.sessionId, fingerprint.turnKey,
            input.canonicalModel]);
        if (consumed.rowCount) throw new BoxDurableJournalError("BOX_RESUME_IN_PROGRESS");
        throw new BoxDurableJournalError("BOX_TOOL_OWNER_UNKNOWN");
      }
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
      if (handoff.roundNo >= BOX_TOOL_MAX_ROUNDS) {
        throw new BoxDurableJournalError("BOX_TOOL_ROUND_LIMIT");
      }
      const priorIds = ctx.boxPriorMessageIds === undefined ? [] : ctx.boxPriorMessageIds;
      if (!Array.isArray(priorIds) || priorIds.length !== handoff.roundNo - 1
        || new Set(priorIds).size !== priorIds.length
        || priorIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 128)
        || Array.from({ length: priorIds.length }, (_, i) => i)
          .some((i) => !Object.hasOwn(priorIds, i))
        || priorIds.includes(handoff.messageId)) {
        throw new BoxDurableJournalError("BOX_TOOL_OWNER_INVALID");
      }
      if (boundCatalog.bindingSha256 !== handoff.catalogHash) {
        throw new BoxDurableJournalError("BOX_TOOL_CATALOG_CHANGED");
      }
      if (ctx.boxContextHash !== priorContextHash) {
        throw new BoxDurableJournalError("BOX_TOOL_CONTEXT_CHANGED");
      }
      const effectiveBody = view.effectiveBody!;
      const digests = handoff.toolUses;
      let results: readonly BoxMatchedToolResult[];
      try { results = matchPreparedToolResults({ effectiveBody },
        digests, boundCatalog); }
      catch { throw new BoxDurableJournalError("BOX_TOOL_RESULT_MISMATCH"); }
      try {
        const compared = comparableAssistantContent(assistantContent, digests, boundCatalog);
        if (!incomingAssistantAccepted(compared, handoff)) {
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
      const child = await client.query<{ ctx: Record<string, unknown> }>(
        `SELECT ctx FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
        [input.requestId, input.uid.toString()]);
      const childCtx = child.rows[0]?.ctx;
      if (child.rowCount !== 1 || !childCtx) {
        throw new BoxDurableJournalError("BOX_TOOL_RESUME_JOURNAL_INVALID");
      }
      const preparedIdentity = {
        uid: view.prepared.uid, sessionId: fingerprint.sessionId,
        canonicalModel: view.prepared.canonicalModel, turnKey: fingerprint.turnKey,
        authority: view.prepared.authority,
      };
      const ownerBound = trustedIdentitiesBind(preparedIdentity, {
        uid: input.uid, sessionId: String(ctx.boxSessionId ?? ""),
        canonicalModel: String(ctx.model ?? ""), turnKey: String(ctx.boxTurnKey ?? ""),
        authority: authorityFromJournalCtx(ctx),
      });
      if (!ownerBound.ok) throw new BoxDurableJournalError(ownerBound.code);
      const childBilling = parseBoxBillingContext(childCtx.boxBillingContext);
      if (!childBilling?.sessionId || !childBilling.turnKey) {
        throw new BoxDurableJournalError("BOX_TOOL_RESUME_JOURNAL_INVALID");
      }
      const childBound = trustedIdentitiesBind(preparedIdentity, {
        uid: input.uid, sessionId: childBilling.sessionId,
        canonicalModel: String(childCtx.model ?? ""), turnKey: childBilling.turnKey,
        authority: authorityFromJournalCtx(childCtx),
      });
      if (!childBound.ok) throw new BoxDurableJournalError(childBound.code);
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
             boxFallbackAlias: fallbackAlias,
             ...(ctx.boxReplayRequired === true ? { boxReplayRequired: true } : {}),
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
    { proof: BoxTerminalProof; usage: BoxUsageEvidence;
      messagePointer?: BoxReplayMessagePointer }): Promise<void> {
    const usage = input.usage;
    const pointer = input.messagePointer === undefined ? undefined
      : parseBoxReplayMessagePointer(input.messagePointer);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)
      || !validUsageEvidence(usage)
      || (input.messagePointer !== undefined && (!pointer
        || pointer.uid !== input.uid.toString()
        || pointer.requestId !== input.requestId
        || pointer.runNonce !== input.proof.runNonce
        || pointer.leaseEpoch !== input.leaseEpoch))) {
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
        if (rows.length >= BOX_TOOL_MAX_ROUNDS || seen.has(cursor)) {
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
        || Number(roundNo) > BOX_TOOL_MAX_ROUNDS || rows.length !== roundNo
        || (pointer && pointer.roundNo !== roundNo)
        || (basis.boxReplayRequired === true && !pointer)
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
          || ctx.boxReplayRequired !== basis.boxReplayRequired
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
             boxUsage: usage,
             ...(pointer ? { boxReplayMessage: pointer } : {}) })]);
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
        if (rows.length >= BOX_TOOL_MAX_ROUNDS || seen.has(cursor)) {
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
        || Number(roundNo) > BOX_TOOL_MAX_ROUNDS || rows.length !== roundNo
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
          AND ${STOP_MODE_FENCE}
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
          AND ${STOP_MODE_FENCE}
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

  /** Read-only chain evidence for one already selected unknown leaf.
   * Does not admit, launch, or copy prompt bytes. resultHashes come from the
   * direct parent row, never from the leaf. */
  async readDetachedUnknownRecovery(input: BoxStoppedFailureProbeCandidate):
    Promise<{ ok: true; evidence: BoxDetachedUnknownRecovery }
      | { ok: false; reason: BoxRecoveryRejectReason }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || input.uid <= 0n
      || input.accountId <= 0n || !/^[a-f0-9]{24}$/.test(input.runNonce)
      || !/^[a-f0-9]{32}$/.test(input.leaseEpoch)) {
      return { ok: false, reason: "BOX_RECOVERY_EVIDENCE_MISSING" };
    }
    type Row = { request_id: string; state: string; ctx: Record<string, unknown> };
    const load = async (requestId: string): Promise<Row | null> => {
      const found = await this.pool.query<Row>(
        `SELECT request_id,state,ctx FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=$2`,
        [requestId, input.uid.toString()]);
      return found.rowCount === 1 ? found.rows[0] ?? null : null;
    };
    const leaf = await load(input.requestId);
    if (!leaf?.ctx) return { ok: false, reason: "BOX_RECOVERY_NOT_UNKNOWN_LEAF" };
    const ctx = leaf.ctx;
    if (ctx.boxAccountId !== input.accountId.toString()
      || ctx.boxRunNonce !== input.runNonce || ctx.boxLeaseEpoch !== input.leaseEpoch) {
      return { ok: false, reason: "BOX_RECOVERY_CHAIN_INVALID" };
    }
    if (leaf.state !== "inflight" || ctx.boxInvocationMode !== "detached_tool"
      || ctx.boxState !== "unknown" || ctx.boxInvocationRecovery !== "v1"
      || ctx.boxResumeRequestId !== undefined || ctx.boxToolHandoff !== undefined
      || ctx.boxReplayMessage !== undefined || ctx.boxTerminalProof !== undefined) {
      return { ok: false, reason: "BOX_RECOVERY_NOT_UNKNOWN_LEAF" };
    }
    if (ctx.model !== "box-api-claude-opus-5-5"
      || (ctx.boxUpstreamModel !== undefined && ctx.boxUpstreamModel !== "claude-opus-5-5")) {
      return { ok: false, reason: "BOX_RECOVERY_MODEL_UNMAPPED" };
    }
    if (typeof ctx.boxSessionId !== "string" || ctx.boxSessionId.length < 1
      || typeof ctx.boxTurnKey !== "string" || !/^[a-f0-9]{64}$/.test(ctx.boxTurnKey)
      || typeof ctx.boxCatalogHash !== "string" || !/^[a-f0-9]{64}$/.test(ctx.boxCatalogHash)
      || typeof ctx.boxDetachedRunnerHash !== "string"
      || !/^[a-f0-9]{64}$/.test(ctx.boxDetachedRunnerHash)) {
      return { ok: false, reason: "BOX_RECOVERY_EVIDENCE_MISSING" };
    }
    const rows: Row[] = [];
    const seen = new Set<string>();
    let cursor: string | null = leaf.request_id;
    while (cursor !== null) {
      if (rows.length >= BOX_TOOL_MAX_ROUNDS || seen.has(cursor)) {
        return { ok: false, reason: "BOX_RECOVERY_CHAIN_INVALID" };
      }
      seen.add(cursor);
      const row: Row | null = cursor === leaf.request_id ? leaf : await load(cursor);
      if (!row?.ctx || row.ctx.boxInvocationRecovery !== "v1"
        || row.ctx.boxInvocationMode !== "detached_tool"
        || row.ctx.boxAccountId !== ctx.boxAccountId
        || row.ctx.boxRunNonce !== ctx.boxRunNonce
        || row.ctx.boxLeaseEpoch !== ctx.boxLeaseEpoch
        || row.ctx.boxSessionId !== ctx.boxSessionId
        || row.ctx.boxTurnKey !== ctx.boxTurnKey
        || row.ctx.model !== "box-api-claude-opus-5-5"
        || (row.ctx.boxUpstreamModel !== undefined
          && row.ctx.boxUpstreamModel !== "claude-opus-5-5")) {
        return { ok: false, reason: row?.ctx?.model !== undefined
          && row.ctx.model !== "box-api-claude-opus-5-5"
          ? "BOX_RECOVERY_MODEL_UNMAPPED" : "BOX_RECOVERY_CHAIN_INVALID" };
      }
      rows.push(row);
      const owner: unknown = row.ctx.boxOwnerRequestId;
      if (owner === undefined) cursor = null;
      else if (typeof owner === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(owner)) cursor = owner;
      else return { ok: false, reason: "BOX_RECOVERY_CHAIN_INVALID" };
    }
    const root = rows[rows.length - 1]!;
    if (root.ctx.boxLaunchPermit !== true) {
      return { ok: false, reason: "BOX_RECOVERY_ROOT_PERMIT_MISSING" };
    }
    const roundNo = ctx.boxRoundNo === undefined
      ? (rows.length === 1 ? 1 : Number.NaN) : ctx.boxRoundNo;
    if (!Number.isSafeInteger(roundNo) || Number(roundNo) < 1
      || Number(roundNo) > BOX_TOOL_MAX_ROUNDS || rows.length !== Number(roundNo)) {
      return { ok: false, reason: "BOX_RECOVERY_CHAIN_INVALID" };
    }
    const spoolOffset = Number(roundNo) === 1 ? 0 : ctx.boxResumeSpoolOffset;
    if (!Number.isSafeInteger(spoolOffset) || Number(spoolOffset) < 0
      || Number(spoolOffset) > BOX_TOOL_SPOOL_MAX_BYTES
      || (Number(roundNo) === 1 && spoolOffset !== 0)
      || (Number(roundNo) > 1 && Number(spoolOffset) < 1)) {
      return { ok: false, reason: "BOX_RECOVERY_EVIDENCE_MISSING" };
    }
    let resultHashes: BoxDetachedUnknownRecovery["resultHashes"] = null;
    if (Number(roundNo) > 1) {
      const parent = rows[1]!;
      const parsed = parseRecoveryResultHashes(parent.ctx.boxResumeResultHashes);
      if (!parsed) return { ok: false, reason: "BOX_RECOVERY_PARENT_HASHES_MISSING" };
      resultHashes = parsed;
    }
    for (let index = 1; index < rows.length; index++) {
      const child = rows[index - 1]!, parent = rows[index]!;
      const handoff = parseBoxStoredToolHandoff(parent.ctx.boxToolHandoff);
      if (!handoff || handoff.roundNo !== Number(roundNo) - index
        || handoff.catalogHash !== ctx.boxCatalogHash
        || handoff.detachedRunnerHash !== ctx.boxDetachedRunnerHash) {
        return { ok: false, reason: "BOX_RECOVERY_CHAIN_INVALID" };
      }
      if (parent.ctx.boxResumeRequestId !== child.request_id
        || typeof parent.ctx.boxResumeRevision !== "string"
        || typeof child.ctx.boxParentResumeRevision !== "string"
        || parent.ctx.boxResumeRevision !== child.ctx.boxParentResumeRevision) {
        return { ok: false, reason: "BOX_RECOVERY_REVISION_MISMATCH" };
      }
    }
    return { ok: true, evidence: {
      requestId: leaf.request_id, uid: input.uid, accountId: input.accountId,
      runNonce: input.runNonce, leaseEpoch: input.leaseEpoch,
      sessionId: ctx.boxSessionId as string, turnKey: ctx.boxTurnKey as string,
      model: "box-api-claude-opus-5-5", upstreamModel: "claude-opus-5-5",
      roundNo: Number(roundNo), spoolOffset: Number(spoolOffset),
      catalogHash: ctx.boxCatalogHash as string,
      detachedRunnerHash: ctx.boxDetachedRunnerHash as string,
      rootRequestId: root.request_id, rootLaunchPermit: true, resultHashes } };
  }

  /** Same-identity reread after a lost CAS. Not a second admission.
   * request_finalize_journal.state is settlement, not the Box terminal. */
  async readRecoveryWinner(input: Pick<BoxDetachedUnknownRecovery,
    "requestId" | "uid" | "accountId" | "runNonce" | "leaseEpoch"
    | "sessionId" | "turnKey" | "model" | "roundNo">):
    Promise<BoxRecoveryWinner | null> {
    const found = await this.pool.query<{ state: string; ctx: Record<string, unknown> }>(
      `SELECT state,ctx FROM request_finalize_journal
        WHERE request_id=$1 AND user_id=$2`,
      [input.requestId, input.uid.toString()]);
    const row = found.rows[0];
    if (found.rowCount !== 1 || !row?.ctx
      || row.ctx.boxAccountId !== input.accountId.toString()
      || row.ctx.boxRunNonce !== input.runNonce
      || row.ctx.boxLeaseEpoch !== input.leaseEpoch
      || row.ctx.boxSessionId !== input.sessionId
      || row.ctx.boxTurnKey !== input.turnKey
      || row.ctx.model !== input.model
      || input.model !== "box-api-claude-opus-5-5"
      || row.ctx.boxInvocationRecovery !== "v1"
      || row.ctx.boxInvocationMode !== "detached_tool") return null;
    const storedRound = row.ctx.boxRoundNo === undefined ? 1 : row.ctx.boxRoundNo;
    if (storedRound !== input.roundNo) return null;
    let proofReason: string | null = null;
    if (row.ctx.boxTerminalProof !== undefined) {
      try {
        proofReason = parseBoxTerminalProof(
          JSON.stringify(row.ctx.boxTerminalProof) + "\n",
          { runNonce: input.runNonce, leaseEpoch: input.leaseEpoch }).reason;
      } catch { proofReason = null; }
    }
    const boxState = typeof row.ctx.boxState === "string" ? row.ctx.boxState : "";
    return { state: row.state, boxState, proofReason };
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
          AND ${STOP_MODE_FENCE}
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
          AND ${STOP_MODE_FENCE}
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
          AND ${CLEANUP_MODE_FENCE}
           AND ${CLEANUP_STATE_FENCE} AND ctx ? 'boxTerminalProof'
           AND ${CLEANUP_REPLAY_FENCE}
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
              AND ${CLEANUP_MODE_FENCE}
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
          AND ${CLEANUP_MODE_FENCE}
           AND ${CLEANUP_PROOF_FENCE} AND ctx ? 'boxTerminalProof'
           AND ${CLEANUP_REPLAY_FENCE}
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
          AND ${CLEANUP_MODE_FENCE}
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
          AND ${CLEANUP_MODE_FENCE}
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
          AND ${CLEANUP_MODE_FENCE}
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
          AND ${CLEANUP_MODE_FENCE}
          AND ctx->'boxTerminalProof'->>'runNonce'=$4
          AND ctx->'boxTerminalProof'->>'leaseEpoch'=$5
          AND ctx->'boxTerminalProof'=$6::jsonb
          AND ctx->'boxNativePointer' IS NOT DISTINCT FROM $7::jsonb
          AND ctx->>'boxRemoteCleanup'='done'`, params);
    if (already.rowCount !== 1) throw new BoxDurableJournalError("BOX_CLEANUP_FENCE_LOST");
  }
}
