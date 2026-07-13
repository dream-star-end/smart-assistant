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
import { makeCodexFinalizer } from "./codexFinalizer.js";
import { parseBillingPricing } from "./persistedBillingPricing.js";
import type { PricingCache } from "./pricing.js";
import {
  type PreCheckRedis,
  type ReservationHandle,
  releasePreCheck,
} from "./preCheck.js";
import { abortInflightJournal } from "./proxyBilling.js";

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
  const result = await deps.pgPool.query<{
    state: string;
    user_id: string;
    ctx: unknown;
  }>(
    `SELECT state, user_id::text AS user_id, ctx
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
    if (settled.rows[0]?.present === true) return "already_committed";
    throw new Error(`durable codex billing journal missing for ${requestId}`);
  }
  if (row.user_id !== userId.toString()) {
    throw new Error(`durable codex billing journal user mismatch for ${requestId}`);
  }
  if (row.state === "committed") return "already_committed";
  if (row.state === "finalizing") {
    throw new Error(`durable codex billing journal still finalizing for ${requestId}`);
  }
  if (row.state === "aborted") {
    log?.error("durable codex billing hit aborted journal; turn remains waived", {
      requestId,
    });
    return "waived";
  }
  if (row.state !== "inflight") {
    throw new Error(`durable codex billing journal state invalid for ${requestId}`);
  }

  const ctx = (row.ctx !== null && typeof row.ctx === "object" && !Array.isArray(row.ctx)
    ? row.ctx
    : {}) as Record<string, unknown>;
  const model = typeof ctx.model === "string" ? ctx.model : null;
  const agentId = typeof ctx.agentId === "string" ? ctx.agentId : "codex";
  const reservation: ReservationHandle = { userId: userId.toString(), requestId };
  const waive = async (reason: string): Promise<DurableCodexBillingSettleOutcome> => {
    await abortInflightJournal(deps.pgPool, requestId, reason).catch(() => {});
    await releasePreCheck(deps.preCheckRedis, reservation).catch(() => {});
    log?.error("durable codex billing waived because journal evidence is invalid", { reason });
    return "waived";
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
  });
  await finalizer.commit(usageFromFrame(frame), frame.status, frame.errorReason, {
    turnKey: frame.turnKey ?? null,
    parentTurnKey: frame.parentTurnKey ?? null,
    parentSessionId: frame.parentSessionId ?? null,
    delegateAgentId: frame.delegateAgentId ?? null,
  });
  log?.info("durable codex billing settled from immutable turn tape", {
    model,
    status: frame.status,
  });
  return "committed";
}
