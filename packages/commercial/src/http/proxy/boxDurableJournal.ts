/** Box invocation fence on the existing request_finalize_journal.ctx JSONB.
 * No schema change. This is deliberately stricter than HTTP idempotency: an
 * identical body in one signed turn remains ambiguous and is never re-run. */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BoxCallFingerprint } from "./boxCallFingerprint.js";
import type { BoxTerminalProof } from "./boxTerminalProof.js";
import { parseBillingPricing } from "../../billing/persistedBillingPricing.js";
import { parseBoxBillingContext } from "./boxBillingContext.js";
import type { BoxToolHandoffCandidate, BoxToolHandoffProof } from "./boxCliToolHandoff.js";
import { deriveBoxCallFingerprint } from "./boxCallFingerprint.js";
import { matchBoxToolResults, type BoxMatchedToolResult } from "./boxToolResultMatcher.js";
import { hashBoxToolInput, type BoxToolUseDigest } from "./boxToolInputHash.js";
import type { ProxyBody } from "./shared.js";
import { parseBoxStoredToolHandoff } from "./boxStoredToolHandoff.js";

const ACTIVE = ["reserved", "starting", "running", "unknown", "handoff", "resuming"];

export class BoxDurableJournalError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxDurableJournalError"; }
}

export interface BoxUsageEvidence {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

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
  readonly detachedRunnerHash: string;
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
      spoolOffset: number;
      detachedRunnerHash: string;
      verifiedPendingToolUseIds: readonly string[] }): Promise<BoxToolHandoffProof>;
  claimToolResume?(input: { requestId: string; uid: bigint;
    canonicalModel: string; canonicalBody: ProxyBody }): Promise<BoxToolResumeClaim>;
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
      || Object.values(u).some((n) => !Number.isSafeInteger(n) || n < 0)) {
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
      spoolOffset: number;
      detachedRunnerHash: string;
      verifiedPendingToolUseIds: readonly string[] }): Promise<BoxToolHandoffProof> {
    const candidate = input.candidate;
    const toolUses = candidate && Array.isArray(candidate.toolUses) ? candidate.toolUses : [];
    const ids = toolUses.map((use) => use?.id ?? "");
    const pending = input.verifiedPendingToolUseIds;
    const usage = { inputTokens: candidate?.inputTokens,
      outputTokens: candidate?.outputTokens,
      cacheReadTokens: candidate?.cacheReadTokens,
      cacheWriteTokens: candidate?.cacheWriteTokens };
    if (!candidate || typeof candidate.messageId !== "string"
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
    const frozen = { version: 1, roundNo: 1, messageId: candidate.messageId,
      spoolOffset: input.spoolOffset,
      detachedRunnerHash: input.detachedRunnerHash,
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
          AND ctx->>'boxLeaseEpoch' = $3 AND ctx->>'boxState' = 'running'
          AND ctx ? 'billingPricing' AND ctx ? 'boxBillingContext'`,
      [input.requestId, input.uid.toString(), input.leaseEpoch,
        JSON.stringify({ boxState: "handoff", boxHandoffRevision: durableRevision,
          boxToolHandoff: frozen })]);
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
            boxDetachedRunnerHash: handoff.detachedRunnerHash,
            boxSessionId: fingerprint.sessionId,
            boxReplayFingerprint: fingerprint.replayFingerprint,
            boxRequestHash: fingerprint.requestHash, boxResumeRevision: durableRevision })]);
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
        spoolOffset: handoff.spoolOffset, durableRevision, results,
        detachedRunnerHash: handoff.detachedRunnerHash,
        toolUses: digests };
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
}
