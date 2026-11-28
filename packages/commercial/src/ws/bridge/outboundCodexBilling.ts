import type { Pool } from "pg";
import { maybeUpdateAccountQuotaCodex } from "../../account-pool/quota.js";
import { getAgentCostMultiplier } from "../../billing/agentMultiplier.js";
import type { TokenUsage } from "../../billing/calculator.js";
import {
  ENGINE_SESSION_ID_RE,
  isPermanentCodexWaiver,
  makeCodexFinalizer,
  permanentCodexWaiverReason,
} from "../../billing/codexFinalizer.js";
import { composeCodexTurnPricing } from "../../billing/codexServiceTierPricing.js";
import { parseBillingPricing } from "../../billing/persistedBillingPricing.js";
import { releasePreCheck, type PreCheckRedis, type ReservationHandle } from "../../billing/preCheck.js";
import type { ModelPricing, PricingCache } from "../../billing/pricing.js";
import {
  abortInflightJournal,
  loadUsageAttributionCredits,
  type BillingAuthorityStamp,
} from "../../billing/proxyBilling.js";
import { parseVerificationSponsorshipSnapshot } from "../../billing/verificationSponsorship.js";
import type { Logger } from "../../logging/logger.js";
import { boundedSetAdd } from "../outboundFrameDecode.js";
import { expireCodexRouteToken, retryPendingGrokLeaseRelease } from "./connectionCodexState.js";
import { recordBillingRecovery } from "./connectionDispatch.js";
import type {
  BridgeConnectionCtx,
  CodexTurnSnapshot,
  ParsedCodexBillingFrame,
} from "./types.js";
import { codexAbandonFailureCode, safeTokenBigInt } from "./wireHelpers.js";

function resolveCodexTerminalCode(
  rawCode: unknown,
  codexStatus: "success" | "error",
  rawErrorReason: unknown,
): "USER_CANCELLED" | "CODEX_ERROR" | undefined {
  if (rawCode === "USER_CANCELLED" || rawCode === "CODEX_ERROR") return rawCode;
  if (codexStatus !== "error") return undefined;
  return rawErrorReason === "codex turn interrupted" ? "USER_CANCELLED" : "CODEX_ERROR";
}

export function parseCodexBillingFrame(
  parsedBilling: Record<string, unknown>,
): ParsedCodexBillingFrame | null {
  const requestId = typeof parsedBilling.requestId === "string" ? parsedBilling.requestId : null;
  if (requestId === null) return null;
  const hex64 = (v: unknown): string | null =>
    typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
  const parentSessionId =
    typeof parsedBilling.parentSessionId === "string" &&
    parsedBilling.parentSessionId.length > 0 &&
    parsedBilling.parentSessionId.length <= 256
      ? parsedBilling.parentSessionId
      : null;
  const delegateAgentId =
    typeof parsedBilling.delegateAgentId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(parsedBilling.delegateAgentId)
      ? parsedBilling.delegateAgentId
      : null;
  const engineSidRaw = parsedBilling.engineSessionId;
  const engineSid =
    typeof engineSidRaw === "string" && ENGINE_SESSION_ID_RE.test(engineSidRaw)
      ? engineSidRaw
      : null;
  const codexStatus: "success" | "error" = parsedBilling.status === "error" ? "error" : "success";
  const terminalCode = resolveCodexTerminalCode(
    parsedBilling.terminalCode,
    codexStatus,
    parsedBilling.errorReason,
  );
  const u = (parsedBilling.usage ?? {}) as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    reasoning_output_tokens?: unknown;
  };
  return {
    requestId,
    engineSid,
    engineSidRaw,
    codexStatus,
    terminalCode,
    usage: {
      input_tokens: safeTokenBigInt(u.input_tokens),
      output_tokens: safeTokenBigInt(u.output_tokens) + safeTokenBigInt(u.reasoning_output_tokens),
      cache_read_tokens: safeTokenBigInt(u.cache_read_input_tokens),
      cache_write_tokens: safeTokenBigInt(u.cache_creation_input_tokens),
    },
    billingRl: parsedBilling.rateLimits,
    turnKey: hex64(parsedBilling.turnKey),
    parentTurnKey: hex64(parsedBilling.parentTurnKey),
    parentSessionId,
    delegateAgentId,
  };
}

async function persistAndBroadcastCodexCharge(args: {
  ctx: BridgeConnectionCtx;
  billingLog: Logger | null;
  persistErrorLogMsg: string;
  requestId: string;
  traceId: string | null;
  model: string;
  engineSid: string;
  frame: ParsedCodexBillingFrame;
  result: {
    attributionCredits?: bigint | null;
    debitedCredits: bigint | null;
    costCredits: bigint;
    balanceAfter: bigint | null;
    clamped: boolean;
  };
}): Promise<void> {
  const { ctx, billingLog, requestId, frame, result } = args;
  const persistedUsageCredits =
    result.attributionCredits !== null && result.attributionCredits !== undefined
      ? result.attributionCredits
      : result.debitedCredits !== null && result.debitedCredits > 0n
        ? result.debitedCredits
        : null;
  if (persistedUsageCredits !== null && ctx.shared.deps.appendCostCredits) {
    try {
      await ctx.shared.deps.appendCostCredits(
        requestId,
        ctx.uid.toString(),
        persistedUsageCredits.toString(),
        args.engineSid,
        frame.parentSessionId,
        frame.delegateAgentId,
        frame.turnKey,
        frame.parentTurnKey,
      );
    } catch (err) {
      billingLog?.warn(args.persistErrorLogMsg, { err: (err as Error)?.message });
    }
  }
  if (result.debitedCredits !== null && result.debitedCredits > 0n) {
    ctx.shared.broadcastToUser(ctx.uid, {
      type: "outbound.cost_charged",
      requestId,
      traceId: args.traceId,
      model: args.model,
      costCredits: result.costCredits.toString(),
      debitedCredits: result.debitedCredits.toString(),
      balanceAfter: result.balanceAfter !== null ? result.balanceAfter.toString() : null,
      clamped: result.clamped,
    });
  }
}

async function recoverSettledJournalAttribution(
  ctx: BridgeConnectionCtx,
  pgPool: Pool,
  frame: ParsedCodexBillingFrame,
  rowState: string,
): Promise<void> {
  let attributionRepaired = false;
  try {
    const recoveredCredits = await loadUsageAttributionCredits(pgPool, ctx.uid, frame.requestId);
    if (recoveredCredits !== null && ctx.shared.deps.appendCostCredits) {
      await ctx.shared.deps.appendCostCredits(
        frame.requestId,
        ctx.uid.toString(),
        recoveredCredits.toString(),
        frame.engineSid,
        frame.parentSessionId,
        frame.delegateAgentId,
        frame.turnKey,
        frame.parentTurnKey,
      );
      attributionRepaired = true;
    }
  } catch (err) {
    ctx.bridgeLog?.warn("user-chat-bridge: settled journal goal attribution recovery failed", {
      requestId: frame.requestId,
      state: rowState,
      err: (err as Error)?.message,
    });
  }
  ctx.bridgeLog?.info(
    attributionRepaired
      ? "user-chat-bridge: codex_billing for already-settled journal — attribution refreshed"
      : "user-chat-bridge: settled journal attribution not yet visible — replay remains eligible",
    { requestId: frame.requestId, state: rowState },
  );
  if (attributionRepaired) boundedSetAdd(ctx.locallySettledCodexTurns, frame.requestId, 512);
}

async function handleAbortedJournalRow(
  ctx: BridgeConnectionCtx,
  pgPool: Pool,
  requestId: string,
  errorMsg: string | null,
): Promise<boolean> {
  const settled = await pgPool.query<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM usage_records WHERE user_id=$1 AND request_id=$2
     ) AS present`,
    [ctx.uid.toString(), requestId],
  );
  if (settled.rows[0]?.present === true) {
    boundedSetAdd(ctx.locallySettledCodexTurns, requestId, 512);
    return false;
  }
  if (isPermanentCodexWaiver(errorMsg)) {
    ctx.bridgeLog?.info(
      "user-chat-bridge: codex_billing hit proven permanent waiver — idempotent ignore",
      { requestId },
    );
    return false;
  }
  const reopened = await ctx.shared.adapters.reopenUnprovenAbortedJournal(
    pgPool,
    requestId,
    ctx.uid.toString(),
  );
  if (!reopened) {
    ctx.bridgeLog?.warn(
      "user-chat-bridge: codex_billing could not reopen unproven aborted journal — immutable tape will retry",
      { requestId },
    );
    return false;
  }
  ctx.bridgeLog?.warn(
    "user-chat-bridge: reopened unproven aborted journal for exact billing replay",
    { requestId },
  );
  return true;
}

async function parseCrossBridgeAuthorityStamp(args: {
  ctx: BridgeConnectionCtx;
  pgPool: Pool;
  preCheckRedis: PreCheckRedis;
  reservation: ReservationHandle;
  requestId: string;
  journalCtx: Record<string, unknown>;
  billingLog: Logger | null;
  waive: (reason: string) => Promise<void>;
}): Promise<{ ok: true; authority: BillingAuthorityStamp | null; journalAuthority: boolean } | { ok: false }> {
  const { journalCtx, requestId, billingLog } = args;
  const journalAuthority = journalCtx.authorityKind === "bridge_signed";
  const authorityMetadataPresent = [
    "authorityTurnId",
    "billingRequestId",
    "executionRevision",
    "billingRevision",
    "securityEpoch",
  ].some((key) => Object.prototype.hasOwnProperty.call(journalCtx, key));
  if ((journalCtx.authorityKind !== undefined && !journalAuthority) || (!journalAuthority && authorityMetadataPresent)) {
    billingLog?.error("user-chat-bridge: cross-bridge journal authority classification invalid — waiving turn", {
      authorityKind: journalCtx.authorityKind,
    });
    await args.waive("cross_bridge_authority_classification_invalid");
    return { ok: false };
  }
  if (!journalAuthority) return { ok: true, authority: null, journalAuthority: false };
  const bindingOk =
    typeof journalCtx.authorityTurnId === "string" &&
    /^[0-9a-f]{32}$/.test(journalCtx.authorityTurnId) &&
    journalCtx.billingRequestId === requestId &&
    typeof journalCtx.executionRevision === "string" &&
    /^[0-9a-f]{64}$/.test(journalCtx.executionRevision) &&
    typeof journalCtx.billingRevision === "string" &&
    /^[0-9a-f]{64}$/.test(journalCtx.billingRevision) &&
    typeof journalCtx.securityEpoch === "string" &&
    /^\d+$/.test(journalCtx.securityEpoch);
  if (!bindingOk) {
    args.ctx.bridgeLog?.error("user-chat-bridge: cross-bridge journal authority binding invalid — waiving turn", {
      requestId,
    });
    await abortInflightJournal(
      args.pgPool,
      requestId,
      permanentCodexWaiverReason("cross_bridge_authority_binding_invalid"),
      "INTERNAL_ERROR",
    ).catch((err) => {
      void err;
    });
    await releasePreCheck(args.preCheckRedis, args.reservation).catch((err) => {
      void err;
    });
    return { ok: false };
  }
  return {
    ok: true,
    journalAuthority: true,
    authority: {
      executionRevision: journalCtx.executionRevision as string,
      projectionRevision: null,
      securityEpoch: BigInt(journalCtx.securityEpoch as string),
      kind: "bridge_signed",
    },
  };
}

async function resolveCrossBridgePricing(args: {
  pgPool: Pool;
  pricingCache: PricingCache;
  journalCtx: Record<string, unknown>;
  model: string;
  agentId: string;
  journalAuthority: boolean;
  billingLog: Logger | null;
  waive: (reason: string) => Promise<void>;
}): Promise<ModelPricing | null> {
  const { journalCtx, model, billingLog } = args;
  const parsed = parseBillingPricing(journalCtx.billingPricing, model);
  if (parsed !== null) return parsed;
  if (args.journalAuthority) {
    billingLog?.error("user-chat-bridge: cross-bridge authority billing pricing invalid — waiving turn", {
      model,
      billingRevision: journalCtx.billingRevision,
    });
    await args.waive("cross_bridge_authority_billing_pricing_invalid");
    return null;
  }
  if (journalCtx.billingPricing !== undefined) {
    billingLog?.error("user-chat-bridge: cross-bridge persisted billing pricing invalid — waiving turn", {
      model,
    });
    await args.waive("cross_bridge_billing_pricing_invalid");
    return null;
  }
  const modelPricing = args.pricingCache.get(model);
  if (!modelPricing) {
    billingLog?.error("user-chat-bridge: cross-bridge codex_billing pricing missing — waiving turn", {
      model,
    });
    await args.waive("cross_bridge_pricing_missing");
    return null;
  }
  let agentMul: string;
  try {
    agentMul = await getAgentCostMultiplier(args.pgPool, args.agentId);
  } catch (err) {
    billingLog?.error(
      "user-chat-bridge: cross-bridge getAgentCostMultiplier failed — journal left inflight for reconciler",
      { agentId: args.agentId, err: (err as Error)?.message },
    );
    return null;
  }
  return composeCodexTurnPricing(modelPricing, agentMul, model, journalCtx.serviceTier).pricing;
}

function maybeUpdateCrossBridgeQuota(
  pgPool: Pool,
  billingRl: unknown,
  journalCtx: Record<string, unknown>,
  billingLog: Logger | null,
): void {
  if (!billingRl || typeof billingRl !== "object") return;
  const accStr = typeof journalCtx.codexAccountId === "string" ? journalCtx.codexAccountId : null;
  if (accStr === null || !/^[0-9]{1,19}$/.test(accStr)) return;
  void maybeUpdateAccountQuotaCodex(
    pgPool,
    BigInt(accStr),
    billingRl as { util5h?: number; reset5h?: string; util7d?: number; reset7d?: string },
  ).catch((err) => {
    billingLog?.debug("user-chat-bridge: cross-bridge codex quota write failed", {
      err: (err as Error)?.message,
    });
  });
}

async function commitAndPublishCrossBridgeTurn(args: {
  ctx: BridgeConnectionCtx;
  pgPool: Pool;
  preCheckRedis: PreCheckRedis;
  frame: ParsedCodexBillingFrame;
  engineSid: string;
  model: string;
  derivedPricing: ModelPricing;
  reservation: ReservationHandle;
  authority: BillingAuthorityStamp | null;
  journalCtx: Record<string, unknown>;
  ctxTraceId: string | null;
  billingLog: Logger | null;
}): Promise<void> {
  const { ctx, frame, model, journalCtx, ctxTraceId, billingLog } = args;
  const finalizer = makeCodexFinalizer({
    pgPool: args.pgPool,
    preCheckRedis: args.preCheckRedis,
    userId: ctx.uid,
    requestId: frame.requestId,
    engineSessionId: args.engineSid,
    model,
    derivedPricing: args.derivedPricing,
    reservation: args.reservation,
    authority: args.authority,
    verificationSponsorship: parseVerificationSponsorshipSnapshot(journalCtx.verificationSponsorship),
    dispatchId: typeof journalCtx.dispatchId === "string" ? journalCtx.dispatchId : null,
    attemptNo:
      typeof journalCtx.attemptNo === "number" && Number.isInteger(journalCtx.attemptNo)
        ? journalCtx.attemptNo
        : null,
  });
  const result = await finalizer.commit(frame.usage, frame.codexStatus, {
    turnKey: frame.turnKey,
    parentTurnKey: frame.parentTurnKey,
    parentSessionId: frame.parentSessionId,
    delegateAgentId: frame.delegateAgentId,
    terminalCode: frame.terminalCode,
  });
  boundedSetAdd(ctx.locallySettledCodexTurns, frame.requestId, 512);
  recordBillingRecovery(ctx, frame.requestId, "recovered", { model, traceId: ctxTraceId ?? frame.requestId }, 2);
  billingLog?.info("user-chat-bridge: codex cross-bridge settle done (recovered turn billing)", {
    model,
    debitedCredits: result.debitedCredits?.toString() ?? null,
    costCredits: result.costCredits.toString(),
  });
  await persistAndBroadcastCodexCharge({
    ctx, billingLog,
    persistErrorLogMsg: "user-chat-bridge: cross-bridge persist costCredits threw",
    requestId: frame.requestId, traceId: ctxTraceId, model, engineSid: args.engineSid, frame, result,
  });
}

async function settleInflightCrossBridgeJournal(
  ctx: BridgeConnectionCtx,
  pgPool: Pool,
  preCheckRedisBound: PreCheckRedis,
  pricingCache: PricingCache,
  frame: ParsedCodexBillingFrame,
  journalCtx: Record<string, unknown>,
): Promise<void> {
  const { requestId } = frame;
  const model = typeof journalCtx.model === "string" ? journalCtx.model : null;
  const agentId = typeof journalCtx.agentId === "string" ? journalCtx.agentId : "codex";
  const ctxTraceId = typeof journalCtx.traceId === "string" ? journalCtx.traceId : null;
  const reservation: ReservationHandle = { userId: ctx.uid.toString(), requestId };
  const billingLog =
    ctx.bridgeLog?.child({ ...(ctxTraceId !== null ? { traceId: ctxTraceId } : {}), requestId }) ??
    null;
  const waive = async (reason: string): Promise<void> => {
    await abortInflightJournal(
      pgPool, requestId, permanentCodexWaiverReason(reason), codexAbandonFailureCode(reason),
    ).catch((err) => { void err; });
    await releasePreCheck(preCheckRedisBound, reservation).catch((err) => { void err; });
  };
  const authRes = await parseCrossBridgeAuthorityStamp({
    ctx, pgPool, preCheckRedis: preCheckRedisBound, reservation, requestId, journalCtx, billingLog, waive,
  });
  if (!authRes.ok) return;
  if (frame.engineSid === null) {
    billingLog?.error(
      "user-chat-bridge: cross-bridge codex_billing engineSessionId missing/invalid — waiving turn (fail-closed)",
      { engineSessionId: typeof frame.engineSidRaw === "string" ? frame.engineSidRaw.slice(0, 80) : typeof frame.engineSidRaw },
    );
    await waive("codex_billing_engine_session_id_invalid");
    return;
  }
  if (model === null) {
    billingLog?.error("user-chat-bridge: cross-bridge codex_billing journal ctx missing model — waiving turn");
    await waive("cross_bridge_journal_ctx_model_missing");
    return;
  }
  const derivedPricing = await resolveCrossBridgePricing({
    pgPool, pricingCache, journalCtx, model, agentId, journalAuthority: authRes.journalAuthority, billingLog, waive,
  });
  if (derivedPricing === null) return;
  maybeUpdateCrossBridgeQuota(pgPool, frame.billingRl, journalCtx, billingLog);
  await commitAndPublishCrossBridgeTurn({
    ctx, pgPool, preCheckRedis: preCheckRedisBound, frame, engineSid: frame.engineSid,
    model, derivedPricing, reservation, authority: authRes.authority, journalCtx, ctxTraceId, billingLog,
  });
}

function handleCrossBridgeCodexBilling(
  ctx: BridgeConnectionCtx,
  frame: ParsedCodexBillingFrame,
): void {
  const { requestId } = frame;
  if (!ctx.shared.codexBillingEnabled) {
    ctx.bridgeLog?.info("user-chat-bridge: codex_billing for unknown turn (billing disabled)", {
      requestId,
    });
    return;
  }
  if (!/^[0-9a-f]{32}$/.test(requestId)) {
    ctx.bridgeLog?.warn(
      "user-chat-bridge: codex_billing unknown turn with malformed requestId — dropped",
      { requestId: requestId.slice(0, 64) },
    );
    return;
  }
  if (ctx.pendingJournalSettles.has(requestId)) {
    ctx.bridgeLog?.info(
      "user-chat-bridge: codex_billing duplicate while cross-bridge settle in flight — dropped",
      { requestId },
    );
    return;
  }
  ctx.pendingJournalSettles.add(requestId);
  const pgPool = ctx.shared.deps.pgPool!;
  const preCheckRedisBound = ctx.shared.deps.preCheckRedis!;
  const pricingCache = ctx.shared.deps.pricing!;
  void (async (): Promise<void> => {
    try {
      const res = await pgPool.query<{
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
      const row = res.rows[0];
      if (row === undefined) {
        ctx.bridgeLog?.warn(
          "user-chat-bridge: codex_billing for unknown turn — no journal row, dropped",
          { requestId },
        );
        return;
      }
      if (row.user_id !== ctx.uid.toString()) {
        ctx.bridgeLog?.error(
          "user-chat-bridge: codex_billing journal user mismatch — refusing settle",
          { requestId, journalUserId: row.user_id },
        );
        return;
      }
      const journalCtx = (
        row.ctx !== null && typeof row.ctx === "object" ? row.ctx : {}
      ) as Record<string, unknown>;
      if (Object.hasOwn(journalCtx, "remoteNativeBillingRecovery")) return;
      const grokAccountId =
        typeof journalCtx.grokAccountId === "string" && /^[1-9]\d*$/.test(journalCtx.grokAccountId)
          ? BigInt(journalCtx.grokAccountId)
          : null;
      const grokSlotId =
        typeof journalCtx.grokSlotId === "string" && journalCtx.grokSlotId.length > 0
          ? journalCtx.grokSlotId
          : null;
      if (grokAccountId !== null && grokSlotId !== null && ctx.shared.deps.releaseGrokRouteLease) {
        await ctx.shared.deps.releaseGrokRouteLease(grokAccountId, grokSlotId);
      }
      if (row.state === "committed" || row.state === "finalizing") {
        await recoverSettledJournalAttribution(ctx, pgPool, frame, row.state);
        return;
      }
      if (row.state === "aborted") {
        const canSettle = await handleAbortedJournalRow(ctx, pgPool, requestId, row.error_msg);
        if (!canSettle) return;
      }
      await settleInflightCrossBridgeJournal(
        ctx,
        pgPool,
        preCheckRedisBound,
        pricingCache,
        frame,
        journalCtx,
      );
    } catch (err) {
      ctx.bridgeLog?.error("user-chat-bridge: codex cross-bridge settle failed", {
        requestId,
        err: (err as Error)?.message,
      });
      recordBillingRecovery(ctx, requestId, "failed", undefined, 2);
    } finally {
      ctx.pendingJournalSettles.delete(requestId);
    }
  })();
}

function settleLocalCodexSnapshot(
  ctx: BridgeConnectionCtx,
  frame: ParsedCodexBillingFrame,
  snap: CodexTurnSnapshot,
): void {
  const { requestId, engineSid } = frame;
  const billingLog = ctx.bridgeLog?.child({ traceId: snap.traceId, requestId }) ?? null;
  if (frame.billingRl && typeof frame.billingRl === "object" && ctx.shared.deps.pgPool) {
    void maybeUpdateAccountQuotaCodex(
      ctx.shared.deps.pgPool,
      snap.accountId,
      frame.billingRl as { util5h?: number; reset5h?: string; util7d?: number; reset7d?: string },
    ).catch((err) => {
      billingLog?.debug("user-chat-bridge: codex quota write failed", {
        err: (err as Error)?.message,
      });
    });
  }
  if (engineSid === null) {
    billingLog?.error(
      "user-chat-bridge: codex_billing engineSessionId missing/invalid — waiving turn (fail-closed)",
      { engineSessionId: typeof frame.engineSidRaw === "string" ? frame.engineSidRaw.slice(0, 80) : typeof frame.engineSidRaw },
    );
    void (async () => {
      try {
        await snap.abandon("codex_billing_engine_session_id_invalid");
      } catch (err) {
        billingLog?.error("user-chat-bridge: codex abandon threw", { err: (err as Error)?.message });
      } finally {
        if (ctx.drainCause !== null) recordBillingRecovery(ctx, requestId, "abandoned", snap, 2);
        expireCodexRouteToken(ctx, snap.codexRouteToken, "billing_engine_session_id_invalid");
        ctx.checkDrainComplete();
      }
    })();
    return;
  }
  void (async () => {
    try {
      const finalizer = snap.getFinalizer(engineSid);
      if (finalizer === null) {
        billingLog?.error("user-chat-bridge: codex billing after abandon — skip settle");
        return;
      }
      const result = await finalizer.commit(frame.usage, frame.codexStatus, {
        turnKey: frame.turnKey,
        parentTurnKey: frame.parentTurnKey,
        parentSessionId: frame.parentSessionId,
        delegateAgentId: frame.delegateAgentId,
        terminalCode: frame.terminalCode,
      });
      if (ctx.drainCause !== null) recordBillingRecovery(ctx, requestId, "recovered", snap, 2);
      await persistAndBroadcastCodexCharge({
        ctx,
        billingLog,
        persistErrorLogMsg: "user-chat-bridge: codex persist costCredits threw",
        requestId,
        traceId: snap.traceId,
        model: snap.model,
        engineSid,
        frame,
        result,
      });
    } catch (err) {
      if (ctx.drainCause !== null) recordBillingRecovery(ctx, requestId, "failed", snap, 2);
      billingLog?.error("user-chat-bridge: codex finalizer commit threw", {
        err: (err as Error)?.message,
      });
    } finally {
      expireCodexRouteToken(ctx, snap.codexRouteToken, "billing_settled");
      ctx.checkDrainComplete();
    }
  })();
}

export function handleCodexBillingFrame(
  ctx: BridgeConnectionCtx,
  parsedBilling: Record<string, unknown>,
): void {
  const frame = parseCodexBillingFrame(parsedBilling);
  if (frame === null) {
    ctx.bridgeLog?.warn("user-chat-bridge: codex_billing missing requestId");
    return;
  }
  const snap = ctx.inflightCodexTurns.get(frame.requestId);
  if (snap === undefined) {
    if (ctx.locallySettledCodexTurns.has(frame.requestId)) {
      const retryingGrokLease = ctx.pendingGrokLeaseReleases.has(frame.requestId);
      if (retryingGrokLease) retryPendingGrokLeaseRelease(ctx, frame.requestId);
      ctx.bridgeLog?.info(
        retryingGrokLease
          ? "user-chat-bridge: duplicate terminal billing retries pending durable Grok lease release"
          : "user-chat-bridge: codex_billing duplicate for locally settled turn — dropped",
        { requestId: frame.requestId },
      );
      return;
    }
    handleCrossBridgeCodexBilling(ctx, frame);
    return;
  }
  ctx.inflightCodexTurns.delete(frame.requestId);
  boundedSetAdd(ctx.locallySettledCodexTurns, frame.requestId, 512);
  snap.releaseBridgeTurnState?.("turn_billing_terminal");
  settleLocalCodexSnapshot(ctx, frame, snap);
}
