import { WebSocket } from "ws";
import type { ServiceTier } from "@openclaude/protocol";
import { getAgentCostMultiplier } from "../../billing/agentMultiplier.js";
import {
  DURABLE_CODEX_RECOVERY_VERSION,
  makeCodexFinalizer,
  permanentCodexWaiverReason,
  type CodexFinalizeHandle,
} from "../../billing/codexFinalizer.js";
import {
  applyAdmittedServiceTierToFrame,
  composeCodexTurnPricing,
  extractInboundPromptText,
  resolveTakenOverCodexBilling,
} from "../../billing/codexServiceTierPricing.js";
import { serializeBillingPricing } from "../../billing/persistedBillingPricing.js";
import {
  estimateMaxCost,
  InsufficientCreditsError,
  preCheckWithCost,
  releasePreCheck,
  type ReservationHandle,
} from "../../billing/preCheck.js";
import type { ModelPricing } from "../../billing/pricing.js";
import {
  abortInflightJournal,
  readJournalForTakeover,
  startInflightJournal,
} from "../../billing/proxyBilling.js";
import {
  admitVerificationSponsorship,
  serializeVerificationSponsorshipSnapshot,
  type VerificationSponsorshipSnapshot,
} from "../../billing/verificationSponsorship.js";
import { casToManualReconcile } from "../../dispatch/turnDispatchStore.js";
import type { ClaimedRecoveryJob } from "../../dispatch/turnRecoveryStore.js";
import type { Logger } from "../../logging/logger.js";
import type { PromptQueueDispatchRequest } from "../promptQueueDispatchTypes.js";
import { sealAuthorityFieldsOrReject } from "./connectionAuthority.js";
import {
  isCurrentCodexTurnState,
  releaseCodexTurnState,
  retryPendingGrokLeaseRelease,
} from "./connectionCodexState.js";
import {
  dispatchAuthorityField,
  dropAdmittedDispatch,
  failDispatchPreForward,
  trackSealedMigration,
} from "./connectionDispatch.js";
import { CLOSE_BRIDGE, CODEX_PRECHECK_TOKEN_ESTIMATE } from "./constants.js";
import { isGrokEngineKind } from "./enginePolicy.js";
import type { ForwardPreparedFrameFn } from "./laneAnnotatedCcb.js";
import type {
  ActiveCodexTurnState,
  AdmittedDispatch,
  BridgeConnectionCtx,
  CodexApiRelayRoute,
  CodexTurnSnapshot,
  EnrichmentDispatchState,
  InboundTurnIdentity,
  ResolvedTurnExecution,
} from "./types.js";
import {
  closeWsSafely,
  codexAbandonFailureCode,
  ensureRequestIdServerSide,
} from "./wireHelpers.js";

export interface CodexLaneArgs {
  ctx: BridgeConnectionCtx;
  codexTurnState: ActiveCodexTurnState;
  turnIdentity: InboundTurnIdentity;
  peerIdForAcquire: string | null;
  effectiveModelCapture: string | null;
  inboundAgentIdCapture: string | null;
  inboundParsedCapture: Record<string, unknown> | null;
  authorityModelCapture: string | null;
  turnTraceIdCapture: string | null;
  turnLogCapture: Logger | null;
  cid: number;
  persistUserRow: boolean;
  dispatchRequest: PromptQueueDispatchRequest | undefined;
  recoveryJob: ClaimedRecoveryJob | undefined;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  rejectPromptQueueDispatch: (code: string) => void;
  forwardPreparedFrame: ForwardPreparedFrameFn;
}

export interface ResolvedCodexRouteResult {
  codexRoute: CodexApiRelayRoute | null;
  officialOAuthGroupId: string | null;
  acquired: { account_id: bigint; slotId: string } | null;
  codexRouteFrame: Record<string, unknown> | null;
  grokRouteFrame: { baseUrl: string; routeToken: string } | null;
}

export interface PreparedCodexBillingContext {
  effectiveModel: string;
  modelPricing: ModelPricing;
  agentForCharge: string;
  agentMul: string;
  derivedPricing: ModelPricing;
  turnServiceTier: ServiceTier | null;
  requestId: string;
  verificationSponsorship: VerificationSponsorshipSnapshot | null;
  authorityTurnId: string | null;
  preCheckResult: Awaited<ReturnType<typeof preCheckWithCost>>;
}

function failCodexBillingClose(
  ctx: BridgeConnectionCtx,
  sendTurnErrorFrame: (code: string, message: string) => void,
  code: string,
  message: string,
  closeCode: number,
  closeReason: string,
): void {
  if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
    sendTurnErrorFrame(code, message);
    closeWsSafely(ctx.userWs, closeCode, closeReason);
  }
}

export function createCodexTurnSnapshot(args: {
  ctx: BridgeConnectionCtx;
  codexTurnState: ActiveCodexTurnState;
  requestId: string;
  effectiveModel: string;
  accountIdForQuota: bigint;
  traceId: string;
  codexRouteToken: string | null;
  authorityExec: ResolvedTurnExecution | null;
  authorityTurnId: string | null;
  derivedPricing: ModelPricing;
  reservation: ReservationHandle;
  dispatchRecordB: AdmittedDispatch | undefined;
  verificationSponsorship: VerificationSponsorshipSnapshot | null;
}): CodexTurnSnapshot {
  const { ctx, codexTurnState, requestId, effectiveModel, derivedPricing, reservation } = args;
  const pgPool = ctx.shared.deps.pgPool!;
  const preCheckRedis = ctx.shared.deps.preCheckRedis!;
  type SnapState =
    | { kind: "handle"; handle: CodexFinalizeHandle }
    | { kind: "abandoned"; promise: Promise<void> };
  let snapState: SnapState | null = null;
  const snap: CodexTurnSnapshot = {
    requestId,
    model: effectiveModel,
    accountId: args.accountIdForQuota,
    traceId: args.traceId,
    codexRouteToken: args.codexRouteToken,
    releaseBridgeTurnState(reason: string): boolean {
      if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
        if (isGrokEngineKind(codexTurnState.engine)) retryPendingGrokLeaseRelease(ctx, requestId);
        return false;
      }
      releaseCodexTurnState(ctx, codexTurnState, reason);
      return true;
    },
    authority:
      args.authorityExec === null
        ? null
        : {
            executionRevision: args.authorityExec.executionRevision,
            projectionRevision: null,
            securityEpoch: BigInt(args.authorityExec.securityEpoch),
            kind: "bridge_signed",
          },
    authorityTurnId: args.authorityTurnId,
    getFinalizer(engineSessionIdFromFrame: string): CodexFinalizeHandle | null {
      if (snapState !== null) return snapState.kind === "handle" ? snapState.handle : null;
      const handle = makeCodexFinalizer({
        pgPool, preCheckRedis, userId: ctx.uid, requestId,
        engineSessionId: engineSessionIdFromFrame, model: effectiveModel,
        derivedPricing, reservation, authority: snap.authority,
        dispatchId: args.dispatchRecordB?.dispatchId ?? null,
        attemptNo: args.dispatchRecordB?.attemptNo ?? null,
        verificationSponsorship: args.verificationSponsorship,
      });
      snapState = { kind: "handle", handle };
      return handle;
    },
    async abandon(reason: string, failureCode = codexAbandonFailureCode(reason)): Promise<void> {
      if (snapState !== null) {
        if (snapState.kind === "handle") {
          await snapState.handle.fail(reason, failureCode);
          return;
        }
        await snapState.promise.catch((err) => { void err; });
        return;
      }
      const promise = (async (): Promise<void> => {
        try {
          await abortInflightJournal(pgPool, requestId, permanentCodexWaiverReason(reason), failureCode);
        } catch (err) {
          void err;
        } finally {
          await releasePreCheck(preCheckRedis, reservation).catch((err) => { void err; });
        }
      })();
      snapState = { kind: "abandoned", promise };
      await promise;
    },
  };
  return snap;
}

async function resolveCodexTurnPricing(
  args: CodexLaneArgs,
  preparedInbound: Record<string, unknown>,
  authorityExec: ResolvedTurnExecution | null,
  sendTurnErrorFrame: (code: string, message: string) => void,
  releaseOnFailure: () => void,
): Promise<{
  effectiveModel: string;
  modelPricing: ModelPricing;
  agentForCharge: string;
  agentMul: string;
  derivedPricing: ModelPricing;
  turnServiceTier: ServiceTier | null;
} | null> {
  const { ctx, codexTurnState, turnLogCapture } = args;
  const pgPool = ctx.shared.deps.pgPool!;
  const pricingCache = ctx.shared.deps.pricing!;
  if (args.effectiveModelCapture === null) {
    turnLogCapture?.error("user-chat-bridge: codex billing without effective model");
    failCodexBillingClose(ctx, sendTurnErrorFrame, "CODEX_BILLING", "codex billing internal", CLOSE_BRIDGE.INTERNAL, "codex billing");
    releaseOnFailure();
    return null;
  }
  const effectiveModel = authorityExec !== null ? authorityExec.canonicalModel : args.effectiveModelCapture;
  const modelPricing = authorityExec !== null ? authorityExec.pricing : pricingCache.get(effectiveModel);
  if (!modelPricing) {
    turnLogCapture?.error("user-chat-bridge: codex pricing missing", { model: effectiveModel });
    failCodexBillingClose(ctx, sendTurnErrorFrame, "CODEX_BILLING", `pricing missing for ${effectiveModel}`, CLOSE_BRIDGE.INTERNAL, "pricing missing");
    releaseOnFailure();
    return null;
  }
  const agentForCharge = args.inboundAgentIdCapture ?? "codex";
  let agentMul: string;
  try {
    agentMul = await getAgentCostMultiplier(pgPool, agentForCharge);
  } catch (err) {
    turnLogCapture?.error("user-chat-bridge: getAgentCostMultiplier failed", { agentId: agentForCharge, err });
    failCodexBillingClose(ctx, sendTurnErrorFrame, "CODEX_BILLING", "billing config unavailable", CLOSE_BRIDGE.INTERNAL, "billing config");
    releaseOnFailure();
    return null;
  }
  if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
    releaseOnFailure();
    return null;
  }
  const { pricing: derivedPricing, serviceTier: turnServiceTier } = composeCodexTurnPricing(
    modelPricing, agentMul, effectiveModel, preparedInbound.serviceTier,
    {
      agentId: args.inboundAgentIdCapture ?? "main",
      collabMode: preparedInbound.collabMode,
      advisorModel: preparedInbound.advisorModel,
      text: extractInboundPromptText(preparedInbound),
      gatewaySupportsSpeedTiers: ctx.containerHasCodexSpeedTiers,
    },
  );
  return { effectiveModel, modelPricing, agentForCharge, agentMul, derivedPricing, turnServiceTier };
}

export async function prepareCodexBillingAndPreCheck(
  args: CodexLaneArgs,
  preparedInbound: Record<string, unknown>,
  authorityExec: ResolvedTurnExecution | null,
  dispatchRecordB: AdmittedDispatch | undefined,
  sendTurnErrorFrame: (code: string, message: string) => void,
  releaseOnFailure: () => void,
): Promise<PreparedCodexBillingContext | null> {
  const { ctx, codexTurnState, turnLogCapture } = args;
  const pgPool = ctx.shared.deps.pgPool!;
  const preCheckRedis = ctx.shared.deps.preCheckRedis!;
  const priced = await resolveCodexTurnPricing(args, preparedInbound, authorityExec, sendTurnErrorFrame, releaseOnFailure);
  if (priced === null) return null;
  const requestId = dispatchRecordB ? dispatchRecordB.billingRequestId : ensureRequestIdServerSide();
  codexTurnState.billingRequestId = requestId;
  let verificationSponsorship: VerificationSponsorshipSnapshot | null;
  try {
    verificationSponsorship = await admitVerificationSponsorship(pgPool, {
      requestId, userId: ctx.uid, model: priced.effectiveModel, sessionId: args.peerIdForAcquire,
    });
  } catch (err) {
    turnLogCapture?.error("user-chat-bridge: verification sponsorship admission failed", { err });
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendTurnErrorFrame("CODEX_BILLING", "billing verification unavailable");
    }
    releaseOnFailure();
    return null;
  }
  if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
    releaseOnFailure();
    return null;
  }
  const authorityTurnId = authorityExec !== null ? ctx.authorityDeps!.signer.mintAuthorityTurnId() : null;
  let maxCost: bigint;
  try {
    maxCost = estimateMaxCost(CODEX_PRECHECK_TOKEN_ESTIMATE, priced.derivedPricing);
  } catch (err) {
    turnLogCapture?.error("user-chat-bridge: estimateMaxCost failed", { err });
    failCodexBillingClose(ctx, sendTurnErrorFrame, "CODEX_BILLING", "billing internal", CLOSE_BRIDGE.INTERNAL, "billing internal");
    releaseOnFailure();
    return null;
  }
  let preCheckResult: Awaited<ReturnType<typeof preCheckWithCost>>;
  try {
    preCheckResult = await preCheckWithCost(preCheckRedis, { userId: ctx.uid, requestId, maxCost });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      turnLogCapture?.info("user-chat-bridge: codex preCheck insufficient credits", {
        balance: err.balance.toString(), required: err.required.toString(),
      });
      failCodexBillingClose(
        ctx, sendTurnErrorFrame, "ERR_INSUFFICIENT_CREDITS",
        `insufficient credits: balance=${err.balance} required=${err.required}`,
        CLOSE_BRIDGE.BILLING_POLICY, "insufficient_credits",
      );
    } else {
      turnLogCapture?.error("user-chat-bridge: preCheckWithCost failed", { err });
      failCodexBillingClose(ctx, sendTurnErrorFrame, "CODEX_BILLING", "preCheck unavailable", CLOSE_BRIDGE.INTERNAL, "preCheck unavailable");
    }
    releaseOnFailure();
    return null;
  }
  if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
    await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch((err) => { void err; });
    releaseOnFailure();
    return null;
  }
  return { ...priced, requestId, verificationSponsorship, authorityTurnId, preCheckResult };
}

async function attemptCodexJournalTakeover(
  args: CodexLaneArgs,
  billing: PreparedCodexBillingContext,
  dispatchRecordB: AdmittedDispatch | undefined,
): Promise<{ reused: true; derivedPricing: ModelPricing; turnServiceTier: ServiceTier | null } | { reused: false }> {
  const { ctx, turnLogCapture } = args;
  const pgPool = ctx.shared.deps.pgPool!;
  if (dispatchRecordB === undefined) return { reused: false };
  const existing = await readJournalForTakeover(pgPool, billing.requestId).catch(() => null);
  const takeover = resolveTakenOverCodexBilling(
    existing,
    {
      userId: ctx.uid.toString(),
      dispatchId: dispatchRecordB.dispatchId,
      attemptNo: dispatchRecordB.attemptNo,
      model: billing.effectiveModel,
      gatewaySupportsSpeedTiers: ctx.containerHasCodexSpeedTiers,
    },
    (tier) =>
      composeCodexTurnPricing(billing.modelPricing, billing.agentMul, billing.effectiveModel, tier, {
        gatewaySupportsSpeedTiers: ctx.containerHasCodexSpeedTiers,
      }).pricing,
  );
  if (takeover.kind === "reuse") {
    turnLogCapture?.info("user-chat-bridge: journal takeover reuse", {
      requestId: billing.requestId, dispatchId: dispatchRecordB.dispatchId,
    });
    return { reused: true, derivedPricing: takeover.pricing, turnServiceTier: takeover.serviceTier };
  }
  if (takeover.kind === "aborted") {
    failDispatchPreForward(ctx, dispatchRecordB, "journal_aborted");
  } else if (takeover.kind === "capability_mismatch") {
    failDispatchPreForward(ctx, dispatchRecordB, "codex_speed_tier_capability_mismatch", {
      abortNeverExecutedJournal: true, fromStatuses: ["admitted"],
    });
  } else {
    void casToManualReconcile(pgPool, {
      dispatchId: dispatchRecordB.dispatchId, conflictReason: "journal_takeover_mismatch",
    }).catch((err) => { void err; });
    dropAdmittedDispatch(ctx, dispatchRecordB.clientMessageId);
  }
  return { reused: false };
}

export async function startOrReuseCodexInflightJournal(
  args: CodexLaneArgs,
  billing: PreparedCodexBillingContext,
  routeRes: ResolvedCodexRouteResult,
  authorityExec: ResolvedTurnExecution | null,
  dispatchRecordB: AdmittedDispatch | undefined,
  sendTurnErrorFrame: (code: string, message: string) => void,
  releaseOnFailure: () => void,
): Promise<{ derivedPricing: ModelPricing; turnServiceTier: ServiceTier | null; accountIdForQuota: bigint } | null> {
  const { ctx, codexTurnState, turnLogCapture } = args;
  const pgPool = ctx.shared.deps.pgPool!;
  const preCheckRedis = ctx.shared.deps.preCheckRedis!;
  const accountIdForQuota = routeRes.acquired !== null ? routeRes.acquired.account_id : 0n;
  let { derivedPricing, turnServiceTier } = billing;
  try {
    const admitted = await startInflightJournal(pgPool, {
      requestId: billing.requestId, userId: ctx.uid, containerId: BigInt(args.cid),
      model: billing.effectiveModel, precheckCredits: billing.preCheckResult.maxCost,
      ctxJson: {
        agentId: billing.agentForCharge,
        codexAccountId: accountIdForQuota === 0n ? null : accountIdForQuota.toString(),
        ...(isGrokEngineKind(routeRes.codexRoute?.engine) && routeRes.acquired !== null
          ? { grokAccountId: routeRes.acquired.account_id.toString(), grokSlotId: routeRes.acquired.slotId }
          : {}),
        source: "codex_bridge", durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
        billingPricing: serializeBillingPricing(derivedPricing),
        ...(turnServiceTier ? { serviceTier: turnServiceTier } : {}),
        ...(billing.verificationSponsorship === null
          ? {}
          : { verificationSponsorship: serializeVerificationSponsorshipSnapshot(billing.verificationSponsorship) }),
        traceId: args.turnTraceIdCapture!,
        ...(dispatchRecordB ? { dispatchId: dispatchRecordB.dispatchId, attemptNo: dispatchRecordB.attemptNo } : {}),
        ...(authorityExec === null
          ? {}
          : {
              authorityKind: "bridge_signed", authorityTurnId: billing.authorityTurnId,
              billingRequestId: billing.requestId, executionRevision: authorityExec.executionRevision,
              billingRevision: authorityExec.billingRevision, securityEpoch: String(authorityExec.securityEpoch),
            }),
      },
      ...(dispatchRecordB ? { dispatchId: dispatchRecordB.dispatchId, attemptNo: dispatchRecordB.attemptNo } : {}),
    });
    if (!admitted) {
      const takeover = await attemptCodexJournalTakeover(args, billing, dispatchRecordB);
      if (!takeover.reused) {
        turnLogCapture?.error("user-chat-bridge: request journal conflict", { requestId: billing.requestId });
        failCodexBillingClose(ctx, sendTurnErrorFrame, "CODEX_BILLING", "journal unavailable", CLOSE_BRIDGE.INTERNAL, "journal unavailable");
        await releasePreCheck(preCheckRedis, billing.preCheckResult.reservation).catch((err) => { void err; });
        releaseOnFailure();
        return null;
      }
      derivedPricing = takeover.derivedPricing;
      turnServiceTier = takeover.turnServiceTier;
    }
  } catch (err) {
    turnLogCapture?.error("user-chat-bridge: startInflightJournal failed", { requestId: billing.requestId, err });
    failCodexBillingClose(ctx, sendTurnErrorFrame, "CODEX_BILLING", "journal unavailable", CLOSE_BRIDGE.INTERNAL, "journal unavailable");
    await releasePreCheck(preCheckRedis, billing.preCheckResult.reservation).catch((e) => { void e; });
    releaseOnFailure();
    return null;
  }
  if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
    await abortInflightJournal(
      pgPool, billing.requestId, permanentCodexWaiverReason("bridge_disconnect_before_finalize"), "CLIENT_ABORT",
    ).catch((err) => { void err; });
    await releasePreCheck(preCheckRedis, billing.preCheckResult.reservation).catch((err) => { void err; });
    releaseOnFailure();
    return null;
  }
  return { derivedPricing, turnServiceTier, accountIdForQuota };
}

function encodeBilledCodexFrameOrReject(args: {
  lane: CodexLaneArgs;
  preparedInbound: Record<string, unknown>;
  authorityFields: Record<string, unknown>;
  dispatchRecordB: AdmittedDispatch | undefined;
  routeRes: ResolvedCodexRouteResult;
  billing: PreparedCodexBillingContext;
  turnServiceTier: ServiceTier | null;
  sendTurnErrorFrame: (code: string, message: string) => void;
}): { str: string; len: number } | null {
  const { lane, preparedInbound, authorityFields, dispatchRecordB, routeRes, billing } = args;
  const { ctx, turnLogCapture } = lane;
  const rewrittenObj = applyAdmittedServiceTierToFrame(
    {
      ...preparedInbound,
      requestId: billing.requestId,
      traceId: lane.turnTraceIdCapture!,
      _creditBudget: billing.preCheckResult.balance.toString(),
      ...(routeRes.codexRouteFrame !== null ? { __oc_codex_route: routeRes.codexRouteFrame } : {}),
      ...(routeRes.grokRouteFrame !== null ? { __oc_grok_route: routeRes.grokRouteFrame } : {}),
      ...authorityFields,
      ...dispatchAuthorityField(ctx, dispatchRecordB),
    },
    args.turnServiceTier,
  );
  const str = JSON.stringify(rewrittenObj);
  const len = Buffer.byteLength(str);
  const maxFrameBytes = ctx.shared.config.maxFrameBytes;
  if (len > maxFrameBytes) {
    turnLogCapture?.error("user-chat-bridge: rewritten codex frame too big", { rewrittenLen: len, max: maxFrameBytes });
    failCodexBillingClose(
      ctx, args.sendTurnErrorFrame, "ERR_FRAME_TOO_BIG",
      `rewritten frame ${len} > max ${maxFrameBytes}`, CLOSE_BRIDGE.TOO_BIG, "frame too big",
    );
    return null;
  }
  return { str, len };
}

export async function sealAndForwardBilledCodexTurn(args: {
  lane: CodexLaneArgs;
  preparedInbound: Record<string, unknown>;
  authorityExec: ResolvedTurnExecution | null;
  dispatchRecordB: AdmittedDispatch | undefined;
  routeRes: ResolvedCodexRouteResult;
  billing: PreparedCodexBillingContext;
  turnServiceTier: ServiceTier | null;
  snap: CodexTurnSnapshot;
  sendTurnErrorFrame: (code: string, message: string) => void;
  releaseOnFailure: () => void;
}): Promise<boolean> {
  const { lane, preparedInbound, authorityExec, dispatchRecordB, routeRes, billing, snap } = args;
  const { ctx, codexTurnState, turnLogCapture, turnIdentity } = lane;
  ctx.inflightCodexTurns.set(billing.requestId, snap);
  let forwardCommitted = false;
  let abandonReason = "codex_forward_not_committed";
  try {
    let authorityFields: Record<string, unknown> = {};
    if (authorityExec !== null) {
      const sealed = await sealAuthorityFieldsOrReject(ctx, {
        exec: authorityExec,
        billingRequestId: billing.requestId,
        ...(billing.authorityTurnId === null ? {} : { authorityTurnId: billing.authorityTurnId }),
        inboundFrame: preparedInbound,
        log: turnLogCapture,
        onReject: lane.rejectPromptQueueDispatch,
        turn: turnIdentity,
        ...(turnIdentity.peerId ? { sessionId: turnIdentity.peerId } : {}),
        historicalMessages: Array.isArray(preparedInbound._masterHistoricalMessages)
          ? (preparedInbound._masterHistoricalMessages as readonly unknown[])
          : undefined,
        ...(turnIdentity.clientMessageId ? { excludeClientMessageId: turnIdentity.clientMessageId } : {}),
        enableCrossPoolCheckpoint: true,
        compensate: (reason) => { abandonReason = reason; },
      });
      if (sealed === null) return false;
      authorityFields = sealed;
      trackSealedMigration(ctx, dispatchRecordB, turnIdentity.sessionKey, sealed);
    }
    if (!isCurrentCodexTurnState(ctx, codexTurnState)) {
      abandonReason = "bridge_disconnect_before_forward";
      return false;
    }
    const encoded = encodeBilledCodexFrameOrReject({
      lane, preparedInbound, authorityFields, dispatchRecordB, routeRes, billing,
      turnServiceTier: args.turnServiceTier, sendTurnErrorFrame: args.sendTurnErrorFrame,
    });
    if (encoded === null) {
      abandonReason = "rewritten_frame_too_big";
      return false;
    }
    forwardCommitted = await lane.forwardPreparedFrame(
      Buffer.from(encoded.str, "utf8"), false, encoded.len, dispatchRecordB,
    );
    codexTurnState.turnForwarded = forwardCommitted;
    if (!forwardCommitted) abandonReason = "container_forward_rejected";
    if (forwardCommitted && lane.dispatchRequest) {
      ctx.promptQueueDispatchCancellations.set(lane.dispatchRequest.grantId, {
        request: lane.dispatchRequest,
        cancel: async (reasonCode) => {
          ctx.inflightCodexTurns.delete(billing.requestId);
          releaseCodexTurnState(ctx, codexTurnState, `prompt_queue_${reasonCode}`);
          await snap.abandon(`prompt_queue_${reasonCode}`, "CLIENT_ABORT");
        },
      });
    }
    return forwardCommitted;
  } finally {
    if (!forwardCommitted) {
      ctx.inflightCodexTurns.delete(billing.requestId);
      await snap.abandon(abandonReason).catch((err) => {
        turnLogCapture?.error("user-chat-bridge: pre-forward billing compensation failed", {
          requestId: billing.requestId, abandonReason, err,
        });
      });
      args.releaseOnFailure();
    }
  }
}
