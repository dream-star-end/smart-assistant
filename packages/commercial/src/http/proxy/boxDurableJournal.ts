/** Box invocation fence on the existing request_finalize_journal.ctx JSONB.
 * No schema change. This is deliberately stricter than HTTP idempotency: an
 * identical body in one signed turn remains ambiguous and is never re-run. */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BoxCallFingerprint } from "./boxCallFingerprint.js";
import { parseBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";
import { parseBillingPricing } from "../../billing/persistedBillingPricing.js";
import { parseBoxBillingContext } from "./boxBillingContext.js";
import type { BoxToolHandoffCandidate, BoxToolHandoffProof } from "./boxCliToolHandoff.js";
import { deriveBoxCallFingerprint } from "./boxCallFingerprint.js";
import { matchBoxToolResults, type BoxMatchedToolResult } from "./boxToolResultMatcher.js";
import { hashBoxToolInput, type BoxToolUseDigest } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";
import { parseBoxStoredToolHandoff } from "./boxStoredToolHandoff.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";

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
  return Object.keys(usage).sort().join(",") ===
      "cacheReadTokens,cacheWriteTokens,inputTokens,outputTokens"
    && Object.values(usage).every((n) => Number.isSafeInteger(n) && Number(n) >= 0);
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
}

export interface BoxJournalPort {
  admit(input: BoxJournalAdmission): Promise<void>;
  markRunning(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void>;
  markPrestartStopped(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch">): Promise<void>;
  markUnknown(input: Pick<BoxJournalAdmission, "requestId" | "uid" | "leaseEpoch"> &
    { phase: string }): Promise<void>;
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
    || !/^(?:box-api-)?claude-[a-z0-9-]{3,64}$/.test(input.model)) {
    throw new BoxDurableJournalError("BOX_JOURNAL_IDENTITY_INVALID");
  }
}

async function lock(client: PoolClient, keys: string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
  }
}

export class BoxDurableJournal implements BoxJournalPort {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async admit(input: BoxJournalAdmission): Promise<void> {
    goodId(input);
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
      const identity = { boxInvocationRecovery: "v1", boxState: "reserved",
        boxAccountId: input.accountId.toString(),
        boxReplayFingerprint: input.fingerprint.replayFingerprint,
        boxRequestHash: input.fingerprint.requestHash,
        boxTurnKey: input.fingerprint.turnKey,
        boxSessionId: input.fingerprint.sessionId,
        boxRunNonce: input.runNonce, boxLeaseEpoch: input.leaseEpoch };
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
          AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxState' = 'reserved'`,
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
          AND ctx->>'boxState' IN ('reserved', 'running')`,
      [input.requestId, input.uid.toString(), input.leaseEpoch]);
    if (changed.rowCount !== 1) throw new BoxDurableJournalError("BOX_JOURNAL_PRESTART_FENCE_LOST");
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
      || input.spoolOffset > 8 * 1024 * 1024
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
    try { fingerprint = deriveBoxCallFingerprint(input.uid, input.canonicalBody); }
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
            AND ctx->>'boxState'='handoff'
            AND state IN ('inflight','finalizing','committed') FOR UPDATE`,
        [input.uid.toString(), fingerprint.sessionId, fingerprint.turnKey]);
      if (owners.rows.length !== 1) throw new BoxDurableJournalError("BOX_TOOL_OWNER_UNKNOWN");
      const owner = owners.rows[0]!, ctx = owner.ctx;
      if (ctx.model !== input.canonicalModel
        || typeof ctx.boxAccountId !== "string" || !/^[1-9][0-9]{0,19}$/.test(ctx.boxAccountId)
        || typeof ctx.boxRunNonce !== "string" || !/^[a-f0-9]{24}$/.test(ctx.boxRunNonce)
        || typeof ctx.boxLeaseEpoch !== "string" || !/^[a-f0-9]{32}$/.test(ctx.boxLeaseEpoch)
        || typeof ctx.boxHandoffRevision !== "string" || ctx.boxHandoffRevision.length > 128
        || !ctx.boxToolHandoff || typeof ctx.boxToolHandoff !== "object"
        || Array.isArray(ctx.boxToolHandoff)) {
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
      const digests = handoff.toolUses;
      let results: readonly BoxMatchedToolResult[];
      try { results = matchBoxToolResults(input.canonicalBody,
        digests); }
      catch { throw new BoxDurableJournalError("BOX_TOOL_RESULT_MISMATCH"); }
      const durableRevision = randomUUID();
      const resultHashes = results.map((result) => ({
        modelToolUseId: result.modelToolUseId, contentHash: result.contentHash,
        isError: result.isError }));
      const claimedOwner = await client.query(
        `UPDATE request_finalize_journal
            SET ctx=ctx || $4::jsonb, updated_at=NOW()
          WHERE request_id=$1 AND user_id=$2
            AND ctx->>'boxState'='handoff'
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
            boxParentResumeRevision: durableRevision })]);
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
        toolUses: digests };
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
          || ctx.model !== basis.model) {
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
}
