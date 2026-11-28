import { WebSocket, type RawData } from "ws";
import { readTotalSpendableBalance } from "../../billing/preCheck.js";
import { bindAuthorityTurnDispatch } from "../../billing/verificationSponsorship.js";
import type { ClaimedRecoveryJob } from "../../dispatch/turnRecoveryStore.js";
import type { Logger } from "../../logging/logger.js";
import type { PromptQueueDispatchRequest } from "../promptQueueDispatchTypes.js";
import {
  createLocalFallbackWireTracker,
  prepareBridgeLocalFallbackTransport,
  type FallbackWireOutcomeHandler,
} from "../userChatBridgeLocalFallbackTransport.js";
import type { LocalFallbackCommittedHandle } from "../userChatBridgeRemotePoolSeal.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import {
  resolveAuthorityExecOrReject,
  sealAuthorityFieldsOrReject as sealAuthorityFieldsOrRejectImpl,
} from "./connectionAuthority.js";
import {
  expireCodexRouteToken,
  isCurrentCodexTurnState,
  releaseCodexTurnState,
  retryPendingGrokLeaseRelease,
} from "./connectionCodexState.js";
import {
  dispatchAuthorityField as dispatchAuthorityFieldImpl,
  failDispatchPreForward,
  lookupAdmittedDispatch as lookupAdmittedDispatchImpl,
  trackSealedMigration,
} from "./connectionDispatch.js";
import { CLOSE_BRIDGE } from "./constants.js";
import { needsServerBillingRequestId } from "./enginePolicy.js";
import { attachMasterTurnState } from "./masterTurnState.js";
import type {
  AdmittedDispatch,
  BridgeConnectionCtx,
  EnrichmentDispatchState,
  InboundTurnIdentity,
  ResolvedTurnExecution,
} from "./types.js";
import {
  closeWsSafely,
  codexPeerKey,
  ensureRequestIdServerSide,
} from "./wireHelpers.js";

export type ForwardPreparedFrameFn = (
  frameData: RawData,
  frameIsBinary: boolean,
  frameLength: number,
  dispatchRecord?: AdmittedDispatch,
  onWireOutcome?: FallbackWireOutcomeHandler,
) => boolean | Promise<boolean>;

export interface AnnotatedImageLaneArgs {
  ctx: BridgeConnectionCtx;
  inboundParsedCapture: Record<string, unknown> | null;
  turnTraceIdCapture: string | null;
  turnLogCapture: Logger | null;
  authorityModelCapture: string | null;
  annotatedTurnIdentity: InboundTurnIdentity;
  persistUserRow: boolean;
  recoveryJob: ClaimedRecoveryJob | undefined;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  rejectPromptQueueDispatch: (code: string) => void;
  forwardPreparedFrame: ForwardPreparedFrameFn;
}

async function sealAndForwardAnnotatedFrame(
  args: AnnotatedImageLaneArgs,
  enrichedParsed: Record<string, unknown>,
  dispatchRecordA: AdmittedDispatch | undefined,
  authorityExec: ResolvedTurnExecution | null,
): Promise<void> {
  const { ctx, turnLogCapture, annotatedTurnIdentity, rejectPromptQueueDispatch } = args;
  const requestId = dispatchRecordA ? dispatchRecordA.billingRequestId : ensureRequestIdServerSide();
  let authorityFields: Record<string, unknown> = {};
  if (authorityExec !== null) {
    const sealed = await sealAuthorityFieldsOrRejectImpl(ctx, {
      exec: authorityExec,
      billingRequestId: requestId,
      log: turnLogCapture,
      onReject: rejectPromptQueueDispatch,
      turn: annotatedTurnIdentity,
    });
    if (sealed === null) {
      failDispatchPreForward(ctx, dispatchRecordA, "authority_seal_rejected");
      return;
    }
    authorityFields = sealed;
  }
  if (ctx.cleaned) {
    failDispatchPreForward(ctx, dispatchRecordA, "bridge_cleaned");
    return;
  }
  const rewrittenStr = JSON.stringify({
    ...enrichedParsed,
    requestId,
    traceId: args.turnTraceIdCapture,
    ...authorityFields,
    ...dispatchAuthorityFieldImpl(ctx, dispatchRecordA),
  });
  const rewrittenLen = Buffer.byteLength(rewrittenStr);
  const maxFrameBytes = ctx.shared.config.maxFrameBytes;
  if (rewrittenLen > maxFrameBytes) {
    rejectPromptQueueDispatch("ERR_FRAME_TOO_BIG");
    failDispatchPreForward(ctx, dispatchRecordA, "ERR_FRAME_TOO_BIG");
    turnLogCapture?.error("user-chat-bridge: rewritten annotated image frame too big", {
      rewrittenLen, max: maxFrameBytes,
    });
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(ctx.userWs, "ERR_FRAME_TOO_BIG", `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`, annotatedTurnIdentity);
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_BIG, "frame too big");
    }
    return;
  }
  await args.forwardPreparedFrame(
    Buffer.from(rewrittenStr, "utf8"), false, rewrittenLen, dispatchRecordA,
  );
}

export async function executeAnnotatedImageTurnLane(
  args: AnnotatedImageLaneArgs,
): Promise<AdmittedDispatch | undefined> {
  const { ctx, turnLogCapture, annotatedTurnIdentity, rejectPromptQueueDispatch } = args;
  let dispatchRecordA: AdmittedDispatch | undefined;
  try {
    if (args.turnTraceIdCapture === null || args.inboundParsedCapture === null) {
      rejectPromptQueueDispatch("ERR_INTERNAL");
      ctx.bridgeLog?.error("user-chat-bridge: annotated image frame missing trace invariant");
      if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
        sendErrorFrame(ctx.userWs, "ERR_INTERNAL", "trace invariant violated", annotatedTurnIdentity);
        closeWsSafely(ctx.userWs, CLOSE_BRIDGE.INTERNAL, "trace invariant");
      }
      return undefined;
    }
    const enrichedParsed = await attachMasterTurnState(
      ctx, args.inboundParsedCapture, turnLogCapture, args.turnTraceIdCapture,
      args.persistUserRow, rejectPromptQueueDispatch, args.authorityModelCapture,
      args.recoveryJob, args.pretrackedEnrichment, true,
    );
    if (enrichedParsed === null) return undefined;
    dispatchRecordA = lookupAdmittedDispatchImpl(ctx, enrichedParsed);
    if (ctx.cleaned) {
      failDispatchPreForward(ctx, dispatchRecordA, "bridge_cleaned");
      return dispatchRecordA;
    }
    let authorityExec: ResolvedTurnExecution | null = null;
    if (ctx.authorityOn) {
      authorityExec = await resolveAuthorityExecOrReject(ctx, {
        model: args.authorityModelCapture, classifiedCodex: true,
        log: turnLogCapture, onReject: rejectPromptQueueDispatch, turn: annotatedTurnIdentity,
      });
      if (authorityExec === null) {
        failDispatchPreForward(ctx, dispatchRecordA, "authority_rejected");
        return dispatchRecordA;
      }
    }
    await sealAndForwardAnnotatedFrame(args, enrichedParsed, dispatchRecordA, authorityExec);
    return dispatchRecordA;
  } catch (err) {
    ctx.bridgeLog?.error("user-chat-bridge: annotated image IIFE unexpected error", { err });
    rejectPromptQueueDispatch("ERR_INTERNAL");
    failDispatchPreForward(ctx, dispatchRecordA, "annotated_image_unexpected_exception");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(ctx.userWs, "ERR_INTERNAL", "internal error", annotatedTurnIdentity);
    }
    return dispatchRecordA;
  }
}

export interface CcbLaneArgs {
  ctx: BridgeConnectionCtx;
  inboundParsedCapture: Record<string, unknown>;
  turnTraceIdCapture: string;
  turnLogCapture: Logger | null;
  authorityModelCapture: string | null;
  classifiedCodexCapture: boolean;
  classifiedRemoteNativeCapture: boolean;
  ccbTurnIdentity: InboundTurnIdentity;
  agentIdCapture: string | null;
  persistUserRow: boolean;
  dispatchRequest: PromptQueueDispatchRequest | undefined;
  recoveryJob: ClaimedRecoveryJob | undefined;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  rejectPromptQueueDispatch: (code: string) => void;
  forwardPreparedFrame: ForwardPreparedFrameFn;
}

function makeCcbLocalFallbackOption(
  args: CcbLaneArgs,
  authorityExec: ResolvedTurnExecution,
  enrichedParsed: Record<string, unknown>,
  dispatchRecordC: AdmittedDispatch | undefined,
  fallbackBox: { current: LocalFallbackCommittedHandle | null },
) {
  const { ctx } = args;
  if (authorityExec.placement !== "remote_pool" || ctx.containerId === undefined) return {};
  const cid = ctx.containerId;
  const { deps, adapters } = ctx.shared;
  return {
    prepareLocalFallbackTransport: (p: {
      readonly localExec: ResolvedTurnExecution;
      readonly billingRequestId?: string;
      readonly authorityTurnId?: string;
    }) =>
      prepareBridgeLocalFallbackTransport({
        ...p,
        uid: ctx.uid,
        containerId: cid,
        peerId: args.ccbTurnIdentity.peerId,
        clientMessageId: args.ccbTurnIdentity.clientMessageId,
        promptQueueGrantId: args.dispatchRequest?.grantId ?? null,
        agentId: args.agentIdCapture,
        traceId: args.turnTraceIdCapture,
        parsedCapture: args.inboundParsedCapture,
        enrichedParsed,
        dispatchRecord: dispatchRecordC,
        recoveryJob: args.recoveryJob,
        containerHasCodexSpeedTiers: ctx.containerHasCodexSpeedTiers,
        codexBillingEnabled: ctx.shared.codexBillingEnabled,
        sessionMaxMs: adapters.readCodexSessionMaxMs(),
        pgPool: deps.pgPool,
        preCheckRedis: deps.preCheckRedis,
        pricing: deps.pricing,
        codexBinding: deps.codexBinding,
        createCodexRoute: deps.createCodexRoute,
        admitAntigravityTurn: deps.admitAntigravityTurn,
        expireAntigravityRoute: deps.expireAntigravityRoute,
        activeCodexTurnsByPeer: ctx.activeCodexTurnsByPeer,
        inflightCodexTurns: ctx.inflightCodexTurns,
        pendingAntigravityRelays: ctx.pendingAntigravityRelays,
        codexPeerKey,
        isCurrentCodexTurnState: (s) => isCurrentCodexTurnState(ctx, s),
        releaseCodexTurnState: (s, r, e, pSlot) => releaseCodexTurnState(ctx, s, r, e, pSlot),
        expireCodexRouteToken: (t, r) => expireCodexRouteToken(ctx, t, r),
        retryPendingGrokLeaseRelease: (reqId) => retryPendingGrokLeaseRelease(ctx, reqId),
        modelCheckerHandle: ctx.modelCheckerHandle,
        catalogSnapshot: ctx.authorityDeps?.catalog.peek() ?? null,
        isCleaned: () => ctx.cleaned,
        log: args.turnLogCapture,
      }),
    onLocalFallbackCommitted: (h: LocalFallbackCommittedHandle) => {
      fallbackBox.current = h;
      if (dispatchRecordC) dispatchRecordC.remoteLane = false;
    },
  };
}

export async function executeCcbTurnLane(args: CcbLaneArgs): Promise<AdmittedDispatch | undefined> {
  const { ctx, turnLogCapture, ccbTurnIdentity, rejectPromptQueueDispatch } = args;
  const lookupAdmittedDispatch = (frameObj: Record<string, unknown>) =>
    lookupAdmittedDispatchImpl(ctx, frameObj);
  const signer = ctx.authorityDeps?.signer;
  let dispatchRecordC: AdmittedDispatch | undefined;
  try {
    let authorityExec: ResolvedTurnExecution | null = null;
    if (ctx.authorityOn) {
      authorityExec = await resolveAuthorityExecOrReject(ctx, {
        model: args.authorityModelCapture,
        classifiedCodex: args.classifiedCodexCapture,
        allowRemotePlacement: true,
        classifiedRemoteNative: args.classifiedRemoteNativeCapture,
        log: turnLogCapture,
        onReject: rejectPromptQueueDispatch,
        turn: ccbTurnIdentity,
      });
      if (authorityExec === null) return undefined;
    }
    const enrichedParsed = await attachMasterTurnState(
      ctx,
      args.inboundParsedCapture,
      turnLogCapture,
      args.turnTraceIdCapture,
      args.persistUserRow,
      rejectPromptQueueDispatch,
      args.authorityModelCapture,
      args.recoveryJob,
      args.pretrackedEnrichment,
    );
    if (enrichedParsed === null) return undefined;
    dispatchRecordC = lookupAdmittedDispatch(enrichedParsed);
    if (dispatchRecordC !== undefined) {
      if (typeof ccbTurnIdentity.sessionKey === "string" && ccbTurnIdentity.sessionKey) {
        dispatchRecordC.engineSessionKey = ccbTurnIdentity.sessionKey;
      }
      dispatchRecordC.remoteLane = authorityExec?.placement === "remote_pool";
    }
    const authorityTurnId =
      authorityExec === null || !signer ? undefined : signer.mintAuthorityTurnId();
    const codexFrameRequestId =
      authorityExec !== null && needsServerBillingRequestId(authorityExec.engine)
        ? (dispatchRecordC?.billingRequestId ?? ensureRequestIdServerSide())
        : undefined;
    await sealBindAndForwardCcbTurn({
      lane: args,
      authorityExec,
      enrichedParsed,
      dispatchRecordC,
      authorityTurnId,
      codexFrameRequestId,
    });
    return dispatchRecordC;
  } catch (err) {
    ctx.bridgeLog?.error("user-chat-bridge: ccb inbound IIFE unexpected error", { err });
    rejectPromptQueueDispatch("ERR_INTERNAL");
    failDispatchPreForward(ctx, dispatchRecordC, "ccb_inbound_unexpected_exception");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(ctx.userWs, "ERR_INTERNAL", "internal error", ccbTurnIdentity);
    }
    return dispatchRecordC;
  }
}

async function sealBindAndForwardCcbTurn(args: {
  lane: CcbLaneArgs;
  authorityExec: ResolvedTurnExecution | null;
  enrichedParsed: Record<string, unknown>;
  dispatchRecordC: AdmittedDispatch | undefined;
  authorityTurnId: string | undefined;
  codexFrameRequestId: string | undefined;
}): Promise<void> {
  const { lane, authorityExec, enrichedParsed, dispatchRecordC, authorityTurnId, codexFrameRequestId } = args;
  const { ctx, turnLogCapture, ccbTurnIdentity, rejectPromptQueueDispatch } = lane;
  const sealAuthorityFieldsOrReject = sealAuthorityFieldsOrRejectImpl;
  const authorityBillingRequestId = codexFrameRequestId ?? dispatchRecordC?.billingRequestId;
  let authorityFields: Record<string, unknown> = {};
  const fallbackBox: { current: LocalFallbackCommittedHandle | null } = { current: null };
  const wireTracker = createLocalFallbackWireTracker({
    getHandle: () => fallbackBox.current,
    log: turnLogCapture,
    onWireConfirmed: (fh) => {
      if (lane.dispatchRequest) {
        ctx.promptQueueDispatchCancellations.set(lane.dispatchRequest.grantId, {
          request: lane.dispatchRequest,
          cancel: async (c) => { await fh.compensate(`prompt_queue_${c}`); },
        });
      }
    },
  });
  let forwardAttempted = false;
  let fallbackAbortReason = "local_fallback_not_forwarded";
  try {
    if (authorityExec !== null) {
      const sealed = await sealAuthorityFieldsOrReject(ctx, {
        exec: authorityExec,
        ...(authorityBillingRequestId === undefined ? {} : { billingRequestId: authorityBillingRequestId }),
        ...(authorityTurnId === undefined ? {} : { authorityTurnId }),
        log: turnLogCapture,
        onReject: rejectPromptQueueDispatch,
        turn: ccbTurnIdentity,
        ...(ccbTurnIdentity.peerId ? { sessionId: ccbTurnIdentity.peerId } : {}),
        historicalMessages: Array.isArray(enrichedParsed._masterHistoricalMessages)
          ? (enrichedParsed._masterHistoricalMessages as readonly unknown[])
          : undefined,
        ...(ccbTurnIdentity.clientMessageId ? { excludeClientMessageId: ccbTurnIdentity.clientMessageId } : {}),
        enableCrossPoolCheckpoint: true,
        ...makeCcbLocalFallbackOption(lane, authorityExec, enrichedParsed, dispatchRecordC, fallbackBox),
      });
      if (sealed === null) {
        failDispatchPreForward(ctx, dispatchRecordC, "authority_seal_rejected");
        return;
      }
      authorityFields = sealed;
      trackSealedMigration(ctx, dispatchRecordC, ccbTurnIdentity.sessionKey, sealed);
    }
    if (authorityTurnId !== undefined && dispatchRecordC !== undefined && authorityExec !== null) {
      const bound = await bindCcbTurnDispatch({
        lane, authorityExec, authorityFields, enrichedParsed, dispatchRecordC, authorityTurnId,
      });
      if (!bound) {
        fallbackAbortReason = "authority_turn_dispatch_unavailable";
        return;
      }
    }
    if (ctx.cleaned) {
      fallbackAbortReason = "bridge_disconnect_before_forward";
      failDispatchPreForward(ctx, dispatchRecordC, "bridge_cleaned");
      return;
    }
    const res = await encodeAndForwardCcbFrame({
      lane, enrichedParsed, authorityFields, dispatchRecordC, codexFrameRequestId, fallbackBox, wireTracker,
    });
    if (res.forwarded) forwardAttempted = true;
    if (res.abortReason) fallbackAbortReason = res.abortReason;
  } finally {
    if (!forwardAttempted) await wireTracker.onPreForwardAbort(fallbackAbortReason);
  }
}

async function bindCcbTurnDispatch(args: {
  lane: CcbLaneArgs;
  authorityExec: ResolvedTurnExecution;
  authorityFields: Record<string, unknown>;
  enrichedParsed: Record<string, unknown>;
  dispatchRecordC: AdmittedDispatch;
  authorityTurnId: string;
}): Promise<boolean> {
  const { lane, authorityExec, authorityFields, enrichedParsed, dispatchRecordC, authorityTurnId } = args;
  const { ctx, turnLogCapture, ccbTurnIdentity, rejectPromptQueueDispatch } = lane;
  try {
    if (!ctx.shared.deps.pgPool) throw new Error("authority turn dispatch binding requires pgPool");
    const finalCanonicalModel =
      typeof authorityFields.model === "string" && authorityFields.model.length > 0
        ? authorityFields.model
        : authorityExec.canonicalModel;
    await bindAuthorityTurnDispatch(ctx.shared.deps.pgPool, {
      authorityTurnId,
      dispatchId: dispatchRecordC.dispatchId,
      userId: ctx.uid,
      sessionId: dispatchRecordC.sessionId,
      dispatchModel: typeof enrichedParsed.model === "string" ? enrichedParsed.model : null,
      canonicalModel: finalCanonicalModel,
      attemptNo: dispatchRecordC.attemptNo,
      ownerId: dispatchRecordC.leaseOwnerId,
      leaseEpoch: dispatchRecordC.leaseEpoch,
      ...(ctx.containerId !== undefined
        ? { agentContainerId: ctx.containerId, runtimeKind: ctx.endpoint.desktop ? "desktop" : "docker" }
        : {}),
    });
    return true;
  } catch (err) {
    turnLogCapture?.error("user-chat-bridge: authority turn dispatch binding failed", {
      err, dispatchId: dispatchRecordC.dispatchId,
    });
    rejectPromptQueueDispatch("DURABLE_DISPATCH_UNAVAILABLE");
    failDispatchPreForward(ctx, dispatchRecordC, "authority_turn_dispatch_unavailable");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(
        ctx.userWs, "DURABLE_DISPATCH_UNAVAILABLE",
        "durable dispatch attribution unavailable, retry this turn shortly", ccbTurnIdentity,
      );
    }
    return false;
  }
}

async function encodeAndForwardCcbFrame(args: {
  lane: CcbLaneArgs;
  enrichedParsed: Record<string, unknown>;
  authorityFields: Record<string, unknown>;
  dispatchRecordC: AdmittedDispatch | undefined;
  codexFrameRequestId: string | undefined;
  fallbackBox: { current: LocalFallbackCommittedHandle | null };
  wireTracker: ReturnType<typeof createLocalFallbackWireTracker>;
}): Promise<{ forwarded: boolean; abortReason?: string }> {
  const { lane, enrichedParsed, authorityFields, dispatchRecordC, codexFrameRequestId, fallbackBox, wireTracker } = args;
  const { ctx, turnLogCapture, ccbTurnIdentity, forwardPreparedFrame } = lane;
  const uid = ctx.uid;
  const dispatchAuthorityField = (rec: AdmittedDispatch | undefined) => dispatchAuthorityFieldImpl(ctx, rec);
  let ccbSpendable: bigint | null = null;
  if (ctx.shared.deps.pgPool && fallbackBox.current === null) {
    try {
      ccbSpendable = await readTotalSpendableBalance(uid);
    } catch (err) {
      turnLogCapture?.warn("user-chat-bridge: ccb spendable lookup failed, fail-open", { err });
    }
  }
  const rewrittenObj = {
    ...enrichedParsed,
    ...(codexFrameRequestId !== undefined ? { requestId: codexFrameRequestId } : {}),
    traceId: lane.turnTraceIdCapture,
    ...(ccbSpendable !== null ? { _creditBudget: ccbSpendable.toString() } : {}),
    ...authorityFields,
    ...dispatchAuthorityField(dispatchRecordC),
  };
  const rewrittenStr = JSON.stringify(rewrittenObj);
  const rewrittenLen = Buffer.byteLength(rewrittenStr);
  const maxFrameBytes = ctx.shared.config.maxFrameBytes;
  if (rewrittenLen > maxFrameBytes) {
    turnLogCapture?.error("user-chat-bridge: rewritten inbound frame too big", { rewrittenLen, max: maxFrameBytes });
    failDispatchPreForward(ctx, dispatchRecordC, "ERR_FRAME_TOO_BIG");
    if (!ctx.cleaned && ctx.userWs.readyState === WebSocket.OPEN) {
      sendErrorFrame(ctx.userWs, "ERR_FRAME_TOO_BIG", `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`, ccbTurnIdentity);
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_BIG, "frame too big");
    }
    return { forwarded: false, abortReason: "rewritten_frame_too_big" };
  }
  const accepted = await forwardPreparedFrame(
    Buffer.from(rewrittenStr, "utf8"),
    false,
    rewrittenLen,
    dispatchRecordC,
    fallbackBox.current ? wireTracker.onWireOutcome : undefined,
  );
  await wireTracker.onSyncForwardResult(accepted, "container_forward_rejected");
  return { forwarded: accepted };
}
