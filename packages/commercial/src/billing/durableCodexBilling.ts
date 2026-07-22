/**
 * Durable Codex final-usage settlement.
 *
 * The live `outbound.codex_billing` bridge frame remains the low-latency
 * path, but it is not authoritative: the bridge ring is bounded and a user
 * may reconnect after the terminal frame. The immutable paid-turn tape
 * carries the same evidence and the tape endpoint calls this routine before
 * ACKing finalize. A retry therefore either observes an already committed
 * journal or replays the exact final usage; it never invents current pricing.
 */

import type { Pool } from "pg";
import type { DurableCodexBilling } from "@openclaude/protocol";

import type { Logger } from "../logging/logger.js";
import { maybeUpdateAccountQuotaCodex } from "../account-pool/quota.js";
import { getAgentCostMultiplier, composeMultiplier } from "./agentMultiplier.js";
import type { TokenUsage } from "./calculator.js";
import {
  isPermanentCodexWaiver,
  JournalSettlementClaimLostError,
  makeCodexFinalizer,
  permanentCodexWaiverReason,
} from "./codexFinalizer.js";
import { parseVerificationSponsorshipSnapshot } from "./verificationSponsorship.js";
import { parseBillingPricing } from "./persistedBillingPricing.js";
import type { PricingCache } from "./pricing.js";
import {
  type PreCheckRedis,
  type ReservationHandle,
  releasePreCheck,
} from "./preCheck.js";
import { abortInflightJournal } from "./proxyBilling.js";
import { transitionProductFrictionEventIfPresent } from "../productFriction/events.js";

export interface DurableCodexBillingDeps {
  pgPool: Pool;
  preCheckRedis: PreCheckRedis;
  pricing: PricingCache;
  logger?: Logger;
}

export type DurableCodexBillingSettleOutcome =
  | "committed"
  | "already_committed"
  | "waived";

/** A live claimant normally settles in milliseconds. After this conservative
 * lease, an owner that vanished before writing usage may be reopened by the
 * immutable tape. The usage UNIQUE key remains the final duplicate-debit fence. */
export const DURABLE_SETTLEMENT_CLAIM_LEASE_MS = 5 * 60_000;

function usageFromFrame(frame: DurableCodexBilling): TokenUsage {
  const usage = frame.usage ?? {};
  return {
    input_tokens: BigInt(usage.input_tokens ?? 0),
    output_tokens:
      BigInt(usage.output_tokens ?? 0) + BigInt(usage.reasoning_output_tokens ?? 0),
    cache_read_tokens: BigInt(usage.cache_read_input_tokens ?? 0),
    cache_write_tokens: BigInt(usage.cache_creation_input_tokens ?? 0),
  };
}

/** Settle one validated tape billing frame. Transient or unresolved states
 * throw so the gateway's unlimited fsynced retry queue retains the finalize.
 * Irrecoverably invalid server-owned journal evidence is explicitly waived
 * (abort + reservation release) to preserve the money-safety rule. */
export async function settleDurableCodexBilling(
  deps: DurableCodexBillingDeps,
  userId: bigint,
  frame: DurableCodexBilling,
): Promise<DurableCodexBillingSettleOutcome> {
  const requestId = frame.requestId;
  const log = deps.logger?.child({ requestId, userId: userId.toString() });
  const finishRecovery = (
    outcome: DurableCodexBillingSettleOutcome,
  ): DurableCodexBillingSettleOutcome => {
    // Product telemetry is best-effort. It must never extend the critical
    // billing ACK path or keep an already-idempotent settlement in the fsynced
    // retry queue when the analytics table is slow/unavailable.
    void transitionProductFrictionEventIfPresent({
      correlation: requestId,
      surface: "ws",
      stage: "billing_recovery",
      outcome: outcome === "waived" ? "abandoned" : "recovered",
    }, deps.pgPool).catch(() => false);
    return outcome;
  };
  const repairJournalFromUsage = async (): Promise<boolean> => {
    const repaired = await deps.pgPool.query(
      `UPDATE request_finalize_journal rfj
          SET state='committed',
              usage_id=ur.id,
              ledger_id=ur.ledger_id,
              final_credits=ur.cost_credits,
              failure_code=NULL,
              error_msg=NULL,
              ctx=rfj.ctx - 'settlementClaimId',
              updated_at=NOW()
         FROM usage_records ur
        WHERE rfj.request_id=$1
          AND rfj.user_id=$2
          AND ur.request_id=rfj.request_id
          AND ur.user_id=rfj.user_id
          AND rfj.state IN ('inflight','finalizing','aborted')`,
      [requestId, userId.toString()],
    );
    return repaired.rowCount === 1;
  };
  const resolveClaimLoss = async (): Promise<DurableCodexBillingSettleOutcome> => {
    if (await repairJournalFromUsage()) return finishRecovery("already_committed");
    const decision = await deps.pgPool.query<{
      state: string;
      error_msg: string | null;
    }>(
      `SELECT state, error_msg FROM request_finalize_journal
        WHERE request_id=$1 AND user_id=$2`,
      [requestId, userId.toString()],
    );
    const current = decision.rows[0];
    if (current?.state === "committed") return finishRecovery("already_committed");
    if (current?.state === "aborted" && isPermanentCodexWaiver(current.error_msg)) {
      return finishRecovery("waived");
    }
    throw new Error(`durable codex billing settlement is still owned for ${requestId}`);
  };
  try {
  const result = await deps.pgPool.query<{
    state: string;
    user_id: string;
    ctx: unknown;
    error_msg: string | null;
  }>(
    `SELECT state, user_id::text AS user_id, ctx, error_msg
       FROM request_finalize_journal
      WHERE request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  if (!row) {
    // Journal GC can race a very delayed tape replay after a successful live
    // settle. Prove idempotency from the permanent usage row before ACKing;
    // otherwise leave the tape queued rather than silently waive unknown work.
    const settled = await deps.pgPool.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM usage_records WHERE user_id=$1 AND request_id=$2
       ) AS present`,
      [userId.toString(), requestId],
    );
    if (settled.rows[0]?.present === true) return finishRecovery("already_committed");
    throw new Error(`durable codex billing journal missing for ${requestId}`);
  }
  if (row.user_id !== userId.toString()) {
    throw new Error(`durable codex billing journal user mismatch for ${requestId}`);
  }
  let journalState = row.state;
  if (journalState === "committed") return finishRecovery("already_committed");
  // A usage row is permanent financial truth. Repair any lagging journal
  // state before deciding whether the immutable tape can be ACKed.
  if (await repairJournalFromUsage()) return finishRecovery("already_committed");
  if (journalState === "finalizing") {
    // Fresh ownership may still be actively settling: never steal or ACK it.
    // A stale owner with no usage proof can be reopened; if the old transaction
    // later commits, the usage UNIQUE key + repair path still prevent double debit.
    const reopened = await deps.pgPool.query(
      `UPDATE request_finalize_journal rfj
          SET state='inflight',
              ctx=rfj.ctx - 'settlementClaimId',
              error_msg=NULL,
              failure_code=NULL,
              final_credits=NULL,
              updated_at=NOW()
        WHERE rfj.request_id=$1
          AND rfj.user_id=$2
          AND rfj.state='finalizing'
          AND rfj.updated_at < NOW() - ($3::bigint * INTERVAL '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM usage_records ur
             WHERE ur.user_id=rfj.user_id AND ur.request_id=rfj.request_id
          )`,
      [requestId, userId.toString(), String(DURABLE_SETTLEMENT_CLAIM_LEASE_MS)],
    );
    if (reopened.rowCount !== 1) {
      throw new Error(`durable codex billing journal still finalizing for ${requestId}`);
    }
    journalState = "inflight";
    log?.warn("durable codex billing reopened stale settlement claim", { requestId });
  }
  if (journalState === "aborted") {
    // Old code used `aborted` for both permanent no-usage decisions and
    // transient settle failures. Only the explicitly marked former is safe to
    // ACK. First check permanent financial truth, then reopen an unmarked row
    // so exact immutable evidence can be settled idempotently.
    if (isPermanentCodexWaiver(row.error_msg)) return finishRecovery("waived");
    const reopened = await deps.pgPool.query(
      `UPDATE request_finalize_journal
          SET state='inflight', error_msg=NULL, failure_code=NULL,
              final_credits=NULL, updated_at=NOW()
        WHERE request_id=$1 AND user_id=$2 AND state='aborted'
          AND NOT EXISTS (
            SELECT 1 FROM usage_records ur
             WHERE ur.user_id=$2 AND ur.request_id=$1
          )`,
      [requestId, userId.toString()],
    );
    if (reopened.rowCount !== 1) {
      throw new Error(`durable codex billing could not reopen unproven aborted journal ${requestId}`);
    }
    journalState = "inflight";
    log?.warn("durable codex billing reopened unproven aborted journal", { requestId });
  }
  if (journalState !== "inflight") {
    throw new Error(`durable codex billing journal state invalid for ${requestId}`);
  }

  const ctx = (row.ctx !== null && typeof row.ctx === "object" && !Array.isArray(row.ctx)
    ? row.ctx
    : {}) as Record<string, unknown>;
  const model = typeof ctx.model === "string" ? ctx.model : null;
  const agentId = typeof ctx.agentId === "string" ? ctx.agentId : "codex";
  // 0170 durable-turn dispatch 身份:bridge 把 dispatchId(string uuid)/attemptNo(number)
  // 写进 journal ctx。legacy codex turn 无 dispatch → null,不 hard-fail(RFC §3 / §7 项 10)。
  const dispatchId = typeof ctx.dispatchId === "string" ? ctx.dispatchId : null;
  const attemptNo =
    typeof ctx.attemptNo === "number" && Number.isInteger(ctx.attemptNo) ? ctx.attemptNo : null;
  const reservation: ReservationHandle = { userId: userId.toString(), requestId };
  const waive = async (reason: string): Promise<DurableCodexBillingSettleOutcome> => {
    const markedReason = permanentCodexWaiverReason(reason);
    // Do not ACK merely because the UPDATE was attempted: a transient DB
    // failure or concurrent state transition must leave the fsynced retry
    // entry intact. Re-read and prove the durable terminal decision.
    await abortInflightJournal(deps.pgPool, requestId, markedReason, "INTERNAL_ERROR");
    const decision = await deps.pgPool.query<{
      state: string;
      error_msg: string | null;
    }>(
      `SELECT state, error_msg FROM request_finalize_journal
        WHERE request_id=$1 AND user_id=$2`,
      [requestId, userId.toString()],
    );
    const decided = decision.rows[0];
    if (decided?.state === "committed") return finishRecovery("already_committed");
    if (decided?.state !== "aborted" || decided.error_msg !== markedReason) {
      throw new Error(`durable codex billing permanent waiver was not durably recorded for ${requestId}`);
    }
    await releasePreCheck(deps.preCheckRedis, reservation).catch(() => {});
    log?.error("durable codex billing waived because journal evidence is permanently invalid", { reason });
    return finishRecovery("waived");
  };

  const journalAuthority = ctx.authorityKind === "bridge_signed";
  const authorityMetadataPresent = [
    "authorityTurnId",
    "billingRequestId",
    "executionRevision",
    "billingRevision",
    "securityEpoch",
  ].some((key) => Object.prototype.hasOwnProperty.call(ctx, key));
  if (
    (ctx.authorityKind !== undefined && !journalAuthority) ||
    (!journalAuthority && authorityMetadataPresent)
  ) {
    return waive("durable_authority_classification_invalid");
  }

  let authority: import("./proxyBilling.js").BillingAuthorityStamp | null = null;
  if (journalAuthority) {
    const bindingOk =
      typeof ctx.authorityTurnId === "string" &&
      /^[0-9a-f]{32}$/.test(ctx.authorityTurnId) &&
      ctx.billingRequestId === requestId &&
      typeof ctx.executionRevision === "string" &&
      /^[0-9a-f]{64}$/.test(ctx.executionRevision) &&
      typeof ctx.billingRevision === "string" &&
      /^[0-9a-f]{64}$/.test(ctx.billingRevision) &&
      typeof ctx.securityEpoch === "string" &&
      /^\d+$/.test(ctx.securityEpoch);
    if (!bindingOk) return waive("durable_authority_binding_invalid");
    authority = {
      executionRevision: ctx.executionRevision as string,
      projectionRevision: null,
      securityEpoch: BigInt(ctx.securityEpoch as string),
      kind: "bridge_signed",
    };
  }

  if (model === null) return waive("durable_journal_ctx_model_missing");
  let derivedPricing = parseBillingPricing(ctx.billingPricing, model);
  if (derivedPricing === null && journalAuthority) {
    return waive("durable_authority_billing_pricing_invalid");
  }
  if (derivedPricing === null && ctx.billingPricing !== undefined) {
    return waive("durable_billing_pricing_invalid");
  }
  if (derivedPricing === null) {
    // Compatibility for journals created before billingPricing existed.
    // A DB/cache failure is transient: keep the journal inflight and retry.
    const current = deps.pricing.get(model);
    if (!current) return waive("durable_pricing_missing");
    const agentMultiplier = await getAgentCostMultiplier(deps.pgPool, agentId);
    derivedPricing = {
      ...current,
      multiplier: composeMultiplier(current.multiplier, agentMultiplier),
    };
  }

  if (frame.rateLimits && typeof ctx.codexAccountId === "string" && /^\d{1,19}$/.test(ctx.codexAccountId)) {
    void maybeUpdateAccountQuotaCodex(
      deps.pgPool,
      BigInt(ctx.codexAccountId),
      frame.rateLimits,
    ).catch(() => {});
  }

  const finalizer = makeCodexFinalizer({
    pgPool: deps.pgPool,
    preCheckRedis: deps.preCheckRedis,
    userId,
    requestId,
    engineSessionId: frame.engineSessionId,
    model,
    derivedPricing,
    reservation,
    authority,
    dispatchId,
    attemptNo,
    verificationSponsorship: parseVerificationSponsorshipSnapshot(ctx.verificationSponsorship),
  });
  try {
    await finalizer.commit(usageFromFrame(frame), frame.status, {
      turnKey: frame.turnKey ?? null,
      parentTurnKey: frame.parentTurnKey ?? null,
      parentSessionId: frame.parentSessionId ?? null,
      delegateAgentId: frame.delegateAgentId ?? null,
      terminalCode: frame.terminalCode,
    });
  } catch (error) {
    if (error instanceof JournalSettlementClaimLostError) {
      return await resolveClaimLoss();
    }
    throw error;
  }
  log?.info("durable codex billing settled from immutable turn tape", {
    model,
    status: frame.status,
  });
  return finishRecovery("committed");
  } catch (error) {
    void transitionProductFrictionEventIfPresent({
      correlation: requestId,
      surface: "ws",
      stage: "billing_recovery",
      outcome: "failed",
    }, deps.pgPool).catch(() => false);
    throw error;
  }
}
