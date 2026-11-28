import { WebSocket, type RawData } from "ws";
import { isClientMessageId } from "@openclaude/protocol";
import {
  forwardRecoveryUnderRootFence,
  pauseRecoveryForRefusal,
  releaseRecoveryForTransportWait,
  type ClaimedRecoveryJob,
} from "../../dispatch/turnRecoveryStore.js";
import {
  _recoveryRefusalAction,
  promptQueueDispositionForCode,
} from "../modelSwitchCostGuard.js";
import { boundedMapSet } from "../outboundFrameDecode.js";
import {
  PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
  type PromptQueueDispatchRequest,
  type PromptQueueDispatchResult,
} from "../promptQueueDispatchTypes.js";
import type { FallbackWireOutcomeHandler } from "../userChatBridgeLocalFallbackTransport.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import {
  broadcastRecoveryJobRefused,
  failDispatchPreForward,
  terminalizeEnrichmentDispatch,
} from "./connectionDispatch.js";
import { CLOSE_BRIDGE } from "./constants.js";
import {
  preprocessInboundFrame,
  type ExecutionAuthorityResult,
  type InboundMessageClassification,
} from "./inboundPreprocess.js";
import {
  executeAnnotatedImageTurnLane,
  executeCcbTurnLane,
  type ForwardPreparedFrameFn,
} from "./laneAnnotatedCcb.js";
import { executeAntigravityTurnLane } from "./laneAntigravity.js";
import { executeCodexTurnLane, reserveCodexTurnSlotOrReject } from "./laneCodex.js";
import { executeCursorTurnLane } from "./laneCursor.js";
import { executeZcodeTurnLane } from "./laneZcode.js";
import type {
  AdmittedDispatch,
  BridgeConnectionCtx,
  EnrichmentDispatchState,
  TurnIngress,
} from "./types.js";
import {
  closeWsSafely,
  inboundTurnIdentityFromParsed,
  rawDataLen,
} from "./wireHelpers.js";

interface TurnControlCallbacks {
  isPromptQueueResolved: () => boolean;
  armFallbackTimer: () => void;
  rejectPromptQueueDispatch: (reasonCode: string) => void;
  forwardPreparedFrame: ForwardPreparedFrameFn;
}

function handleRecoveryJobRefusal(
  ctx: BridgeConnectionCtx,
  recoveryJob: ClaimedRecoveryJob,
  reasonCode: string,
): void {
  const pool = ctx.shared.deps.pgPool;
  if (!pool) return;
  const pause = _recoveryRefusalAction(reasonCode) === "pause";
  const hasBoundDispatch =
    [...ctx.admittedDispatches.values()].some((c) => c.recoveryJob?.jobId === recoveryJob.jobId) ||
    [...ctx.enrichmentDispatches.values()].some(
      (c) => c.record.recoveryJob?.jobId === recoveryJob.jobId,
    );
  if (pause) {
    boundedMapSet(
      ctx.refusedRecoveryJobs,
      `${recoveryJob.jobId}:${recoveryJob.leaseEpoch}`,
      reasonCode,
      512,
    );
  }
  if (hasBoundDispatch) return;
  if (pause) {
    void pauseRecoveryForRefusal(pool, recoveryJob, reasonCode)
      .then((paused) => {
        if (paused) broadcastRecoveryJobRefused(ctx, recoveryJob, reasonCode);
      })
      .catch((err) => {
        void err;
      });
  } else {
    ctx.shared.trackRecoveryPromise(releaseRecoveryForTransportWait(pool, recoveryJob));
  }
}

function emitPendingRecoveryAck(ctx: BridgeConnectionCtx, record?: AdmittedDispatch): void {
  if (!record?.pendingRecoveryAck) return;
  const ack = record.pendingRecoveryAck;
  record.pendingRecoveryAck = undefined;
  try {
    ctx.shared.broadcastToUser(ctx.uid, ack);
  } catch (err) {
    void err;
  }
}

function forwardRecoveryTurnUnderFence(args: {
  ctx: BridgeConnectionCtx;
  recoveryJob: ClaimedRecoveryJob;
  frameData: RawData;
  frameIsBinary: boolean;
  frameLength: number;
  dispatchRecord: AdmittedDispatch | undefined;
  onWireOutcome: Parameters<ForwardPreparedFrameFn>[4];
  completeForward: (accepted: boolean) => boolean;
}): boolean | Promise<boolean> {
  const { ctx, recoveryJob, frameData, frameIsBinary, frameLength, onWireOutcome, completeForward } = args;
  const record =
    args.dispatchRecord ??
    [...ctx.admittedDispatches.values()].find((c) => c.recoveryJob?.jobId === recoveryJob.jobId);
  if (!record) return false;
  if (!ctx.shared.isRecoveryJobCurrent(recoveryJob)) {
    failDispatchPreForward(ctx, record, "recovery_epoch_fenced");
    return false;
  }
  return forwardRecoveryUnderRootFence(
    ctx.shared.deps.pgPool!,
    {
      job: recoveryJob,
      dispatchId: record.dispatchId,
      dispatchAttemptNo: record.attemptNo,
      dispatchOwner: record.leaseOwnerId,
      dispatchLeaseEpoch: record.leaseEpoch,
    },
    () => {
      if (!ctx.shared.isRecoveryJobCurrent(recoveryJob)) return false;
      emitPendingRecoveryAck(ctx, record);
      return ctx.forwardInboundFrame(frameData, frameIsBinary, frameLength, record, onWireOutcome);
    },
  ).then(
    (accepted) => {
      if (!accepted) failDispatchPreForward(ctx, record, "recovery_forward_fenced");
      return completeForward(accepted);
    },
    (error) => {
      ctx.bridgeLog?.warn("user-chat-bridge: recovery forward fence failed", {
        jobId: recoveryJob.jobId, error,
      });
      failDispatchPreForward(ctx, record, "recovery_forward_fence_failed");
      return false;
    },
  );
}

function createTurnControlCallbacks(
  ctx: BridgeConnectionCtx,
  dispatchRequest: PromptQueueDispatchRequest | undefined,
  recoveryJob: ClaimedRecoveryJob | undefined,
): TurnControlCallbacks {
  let promptQueueResolved = false;
  let promptQueueFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const rejectPromptQueueDispatch = (reasonCode: string): void => {
    if (recoveryJob) handleRecoveryJobRefusal(ctx, recoveryJob, reasonCode);
    if (!dispatchRequest || promptQueueResolved) return;
    promptQueueResolved = true;
    if (promptQueueFallbackTimer !== null) clearTimeout(promptQueueFallbackTimer);
    const result: PromptQueueDispatchResult = {
      type: PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
      grantId: dispatchRequest.grantId,
      owner: dispatchRequest.owner,
      itemId: dispatchRequest.item.itemId,
      contentHash: dispatchRequest.item.contentHash,
      epoch: dispatchRequest.claim.epoch,
      claimToken: dispatchRequest.claim.claimToken,
      outcome: "rejected",
      disposition: promptQueueDispositionForCode(reasonCode),
      reasonCode,
    };
    const encoded = Buffer.from(JSON.stringify(result), "utf8");
    ctx.forwardInboundFrame(encoded, false, encoded.length);
  };
  const completeForward = (accepted: boolean): boolean => {
    if (accepted && dispatchRequest && !promptQueueResolved) {
      promptQueueResolved = true;
      if (promptQueueFallbackTimer !== null) clearTimeout(promptQueueFallbackTimer);
    }
    return accepted;
  };
  const forwardPreparedFrame: ForwardPreparedFrameFn = (
    frameData, frameIsBinary, frameLength, dispatchRecord, onWireOutcome,
  ) => {
    if (dispatchRequest && promptQueueResolved) return false;
    if (!recoveryJob || !ctx.shared.deps.pgPool) {
      emitPendingRecoveryAck(ctx, dispatchRecord);
      return completeForward(
        ctx.shared.adapters.forwardPreparedToContainer({
          frameData, frameIsBinary, frameLength, dispatchRecord, onWireOutcome,
          forwardInboundFrame: ctx.forwardInboundFrame,
        }),
      );
    }
    return forwardRecoveryTurnUnderFence({
      ctx, recoveryJob, frameData, frameIsBinary, frameLength, dispatchRecord, onWireOutcome, completeForward,
    });
  };
  return {
    isPromptQueueResolved: () => promptQueueResolved,
    armFallbackTimer: () => {
      if (!dispatchRequest) return;
      promptQueueFallbackTimer = setTimeout(
        () => rejectPromptQueueDispatch("DISPATCH_PREPARATION_TIMEOUT"),
        ctx.shared.config.promptQueuePreparationTimeoutMs,
      );
      promptQueueFallbackTimer.unref?.();
    },
    rejectPromptQueueDispatch,
    forwardPreparedFrame,
  };
}

function dispatchExternalEngineLane(args: {
  ctx: BridgeConnectionCtx;
  cls: InboundMessageClassification;
  cid: number;
  parsedCmid: string | null;
  persistUserRow: boolean;
  recoveryJob: ClaimedRecoveryJob | undefined;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  callbacks: TurnControlCallbacks;
}): boolean {
  const { ctx, cls, cid, parsedCmid, persistUserRow, recoveryJob, pretrackedEnrichment, callbacks } = args;
  const turnIdentity = { ...cls.turnIdentity, peerId: cls.peerId, clientMessageId: parsedCmid };
  const base = {
    ctx, parsedCapture: cls.parsedFrame, traceCapture: cls.traceId, logCapture: cls.turnLog,
    authorityModelCapture: cls.authorityModel, modelCapture: cls.effectiveModel,
    peerCapture: cls.peerId, cid, persistUserRow, recoveryJob, pretrackedEnrichment,
    rejectPromptQueueDispatch: callbacks.rejectPromptQueueDispatch,
    forwardPreparedFrame: callbacks.forwardPreparedFrame,
  };
  if (cls.isCursor) {
    ctx.shared.adapters.runTrackedPreparation(ctx, {
      lane: "cursorLane", recoveryJob, turnIdentity,
      run: (cursorTurnIdentity) => executeCursorTurnLane({ ...base, cursorTurnIdentity }),
    });
    return true;
  }
  if (cls.isAntigravity && !cls.isRemoteNative) {
    ctx.shared.adapters.runTrackedPreparation(ctx, {
      lane: "antigravityLane", recoveryJob, turnIdentity,
      run: (antigravityTurnIdentity) => executeAntigravityTurnLane({ ...base, antigravityTurnIdentity }),
    });
    return true;
  }
  if (cls.isZcode) {
    ctx.shared.adapters.runTrackedPreparation(ctx, {
      lane: "zcodeLane", recoveryJob, turnIdentity,
      run: (zcodeTurnIdentity) => executeZcodeTurnLane({ ...base, zcodeTurnIdentity }),
    });
    return true;
  }
  return false;
}

function dispatchClassifiedInboundTurn(args: {
  ctx: BridgeConnectionCtx;
  cls: InboundMessageClassification;
  ingress: TurnIngress;
  dispatchRequest: PromptQueueDispatchRequest | undefined;
  recoveryJob: ClaimedRecoveryJob | undefined;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  callbacks: TurnControlCallbacks;
}): void {
  const { ctx, cls, ingress, dispatchRequest, recoveryJob, pretrackedEnrichment, callbacks } = args;
  const persistUserRow = ingress !== "prompt_queue" && ingress !== "cron_origin";
  const cid = ctx.containerId;
  const parsedCmid = isClientMessageId(cls.parsedFrame.clientMessageId) ? cls.parsedFrame.clientMessageId : null;
  if (cid !== undefined && dispatchExternalEngineLane({
    ctx, cls, cid, parsedCmid, persistUserRow, recoveryJob, pretrackedEnrichment, callbacks,
  })) {
    return;
  }
  if (cls.isCodex && !cls.isRemoteNative && cls.isAnnotatedImage && cid !== undefined) {
    ctx.shared.adapters.runTrackedPreparation(ctx, {
      lane: "annotated", recoveryJob,
      run: () => executeAnnotatedImageTurnLane({
        ctx, inboundParsedCapture: cls.parsedFrame, turnTraceIdCapture: cls.traceId,
        turnLogCapture: cls.turnLog, authorityModelCapture: cls.authorityModel,
        annotatedTurnIdentity: cls.turnIdentity, persistUserRow, recoveryJob, pretrackedEnrichment,
        rejectPromptQueueDispatch: callbacks.rejectPromptQueueDispatch,
        forwardPreparedFrame: callbacks.forwardPreparedFrame,
      }),
    });
    return;
  }
  const { deps } = ctx.shared;
  if (
    cls.isCodex && !cls.isRemoteNative && cid !== undefined &&
    (deps.codexBinding !== undefined || deps.createCodexRoute !== undefined)
  ) {
    const reserved = reserveCodexTurnSlotOrReject({
      ctx, peerId: cls.peerId, parsedFrame: cls.parsedFrame, turnLog: cls.turnLog,
      isPromptQueueDispatch: ingress === "prompt_queue", dispatchRequest,
      rejectPromptQueueDispatch: callbacks.rejectPromptQueueDispatch,
    });
    if (!reserved) return;
    const turnIdentity = { ...cls.turnIdentity, peerId: cls.peerId, clientMessageId: reserved.clientMessageId };
    ctx.shared.adapters.runTrackedPreparation(ctx, {
      lane: "codex", recoveryJob,
      run: () => executeCodexTurnLane({
        ctx, codexTurnState: reserved.state, turnIdentity, peerIdForAcquire: cls.peerId,
        effectiveModelCapture: cls.effectiveModel, inboundAgentIdCapture: cls.agentId,
        inboundParsedCapture: cls.parsedFrame, authorityModelCapture: cls.authorityModel,
        turnTraceIdCapture: cls.traceId, turnLogCapture: cls.turnLog, cid, persistUserRow,
        dispatchRequest, recoveryJob, pretrackedEnrichment,
        rejectPromptQueueDispatch: callbacks.rejectPromptQueueDispatch,
        forwardPreparedFrame: callbacks.forwardPreparedFrame,
      }),
    });
    return;
  }
  ctx.shared.adapters.runTrackedPreparation(ctx, {
    lane: "ccb", recoveryJob,
    run: () => executeCcbTurnLane({
      ctx, inboundParsedCapture: cls.parsedFrame, turnTraceIdCapture: cls.traceId,
      turnLogCapture: cls.turnLog, authorityModelCapture: cls.authorityModel,
      classifiedCodexCapture: cls.isCodex || cls.isAntigravity,
      classifiedRemoteNativeCapture: cls.isRemoteNative, ccbTurnIdentity: cls.turnIdentity,
      agentIdCapture: cls.agentId, persistUserRow, dispatchRequest, recoveryJob,
      pretrackedEnrichment, rejectPromptQueueDispatch: callbacks.rejectPromptQueueDispatch,
      forwardPreparedFrame: callbacks.forwardPreparedFrame,
    }),
  });
}

function tryPeekInboundMessageForIdentity(
  data: RawData,
  isBinary: boolean,
): Record<string, unknown> | null {
  if (isBinary) return null;
  try {
    const raw = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data;
    const parsed: unknown = JSON.parse(raw.toString());
    if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "inbound.message") {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    void err;
  }
  return null;
}

function runIdentitySerializedPreparation(args: {
  ctx: BridgeConnectionCtx;
  len: number;
  ingress: TurnIngress;
  isCronOriginDispatch: boolean;
  recoveryJob: ClaimedRecoveryJob | undefined;
  pretrackedEnrichment: EnrichmentDispatchState | undefined;
  callbacks: TurnControlCallbacks;
  requestedAgentId: string | null;
  needsIdentity: boolean;
  identity: ReturnType<typeof inboundTurnIdentityFromParsed>;
  peerKey: string;
  previous: Promise<void> | undefined;
  continuePreparation: (executionAuthority: ExecutionAuthorityResult) => void;
}): void {
  const { ctx, len, ingress, isCronOriginDispatch, pretrackedEnrichment, callbacks } = args;
  if (ctx.identityPreparationBytes + len > ctx.shared.config.maxBufferedBytes) {
    callbacks.rejectPromptQueueDispatch("ERR_BACKPRESSURE");
    if (isCronOriginDispatch) {
      if (pretrackedEnrichment) terminalizeEnrichmentDispatch(ctx, pretrackedEnrichment, "backpressure");
      return;
    }
    closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_BIG, "backpressure");
    ctx.cleanup("backpressure", true);
    return;
  }
  ctx.identityPreparationBytes += len;
  const isCancelled = (): boolean =>
    ctx.cleaned ||
    callbacks.isPromptQueueResolved() ||
    (ingress === "browser" && ctx.userWs.readyState !== WebSocket.OPEN);
  const work = (async () => {
    if (args.previous) await args.previous;
    if (isCancelled()) return;
    let executionAuthority: ExecutionAuthorityResult = null;
    if (args.needsIdentity && args.requestedAgentId !== null && ctx.agentModelResolverHandle !== null) {
      try {
        executionAuthority = await ctx.agentModelResolverHandle.authorizeExecution(args.requestedAgentId);
      } catch (err) {
        if (isCancelled()) return;
        callbacks.rejectPromptQueueDispatch("UNRESOLVED_AGENT_MODEL");
        ctx.bridgeLog?.info("user-chat-bridge: fresh identity authority rejected execution", {
          agentId: args.requestedAgentId, err,
        });
        if (isCronOriginDispatch) {
          if (pretrackedEnrichment) terminalizeEnrichmentDispatch(ctx, pretrackedEnrichment, "agent_identity_unavailable");
          return;
        }
        sendErrorFrame(
          ctx.userWs, "UNRESOLVED_AGENT_MODEL",
          `agent '${args.requestedAgentId}' identity is not ready or its authority is unavailable`,
          args.identity,
        );
        closeWsSafely(ctx.userWs, CLOSE_BRIDGE.PRODUCT_POLICY, "agent_identity_unavailable");
        ctx.cleanup("client_close", true);
        return;
      }
    }
    if (isCancelled()) return;
    args.continuePreparation(executionAuthority);
  })().catch((err) => {
    callbacks.rejectPromptQueueDispatch("ERR_INTERNAL");
    if (isCronOriginDispatch && pretrackedEnrichment) {
      terminalizeEnrichmentDispatch(ctx, pretrackedEnrichment, "identity_preparation_failed");
    }
    ctx.bridgeLog?.error("user-chat-bridge: identity preparation failed", { err });
    if (!ctx.cleaned && !isCronOriginDispatch) {
      sendErrorFrame(ctx.userWs, "ERR_INTERNAL", "internal error", args.identity);
    }
  });
  ctx.identityPreparations.set(args.peerKey, work);
  ctx.shared.adapters.runTrackedPreparation(ctx, {
    lane: "identity", recoveryJob: args.recoveryJob, work, len, peerKey: args.peerKey,
  });
}

export function executeAdmittedTurn(
  ctx: BridgeConnectionCtx,
  data: RawData,
  isBinary: boolean,
  ingress: TurnIngress = "browser",
  dispatchRequest?: PromptQueueDispatchRequest,
  recoveryJob?: ClaimedRecoveryJob,
  receivedAtMs = Date.now(),
  pretrackedEnrichment?: EnrichmentDispatchState,
): void {
  const isCronOriginDispatch = ingress === "cron_origin";
  const callbacks = createTurnControlCallbacks(ctx, dispatchRequest, recoveryJob);
  if (ctx.linkHandle?.recoveryOnly && ingress !== "recovery" && !isCronOriginDispatch) {
    callbacks.rejectPromptQueueDispatch("NO_BRIDGE");
    return;
  }
  const len = rawDataLen(data);
  if (len > ctx.shared.config.maxFrameBytes) {
    callbacks.rejectPromptQueueDispatch("ERR_FRAME_TOO_BIG");
    if (isCronOriginDispatch) {
      if (pretrackedEnrichment) terminalizeEnrichmentDispatch(ctx, pretrackedEnrichment, "frame_too_big");
      return;
    }
    sendErrorFrame(ctx.userWs, "ERR_FRAME_TOO_BIG", `user frame ${len} > max ${ctx.shared.config.maxFrameBytes}`);
    closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_BIG, "frame too big");
    ctx.cleanup("frame_too_big", true);
    return;
  }
  if (ctx.authorityOn && ctx.attestState !== "ok") {
    if (ctx.attestState === "failed") return;
    if (ctx.attestQueuedBytes + len > ctx.shared.config.maxBufferedBytes) {
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_BIG, "backpressure");
      ctx.cleanup("backpressure", true);
      return;
    }
    ctx.attestQueuedBytes += len;
    ctx.attestQueue.push({ data, isBinary, ingress, dispatchRequest, recoveryJob });
    return;
  }
  callbacks.armFallbackTimer();
  const continuePreparation = (executionAuthority: ExecutionAuthorityResult): void => {
    const res = preprocessInboundFrame({
      ctx, data, isBinary, len, ingress, receivedAtMs, pretrackedEnrichment, executionAuthority,
      rejectPromptQueueDispatch: callbacks.rejectPromptQueueDispatch,
    });
    if (res.kind === "stop") return;
    if (res.kind === "inbound_message") {
      dispatchClassifiedInboundTurn({
        ctx, cls: res.classification, ingress, dispatchRequest, recoveryJob, pretrackedEnrichment, callbacks,
      });
      return;
    }
    const passthroughForward = callbacks.forwardPreparedFrame(res.data, isBinary, res.len);
    if (passthroughForward instanceof Promise) {
      if (recoveryJob) ctx.shared.trackRecoveryPromise(passthroughForward);
      else void passthroughForward;
    }
  };
  const identityFrame = tryPeekInboundMessageForIdentity(data, isBinary);
  const requestedAgentId = typeof identityFrame?.agentId === "string" ? identityFrame.agentId : null;
  const needsIdentity =
    requestedAgentId !== null && ctx.agentModelResolverHandle?.isIdentityRegistered(requestedAgentId) === true;
  const identity = inboundTurnIdentityFromParsed(identityFrame);
  const peerKey = identity.peerId ?? "__missing_peer__";
  const previous = identityFrame !== null ? ctx.identityPreparations.get(peerKey) : undefined;
  if (!needsIdentity && !previous) {
    continuePreparation(null);
    return;
  }
  runIdentitySerializedPreparation({
    ctx, len, ingress, isCronOriginDispatch, recoveryJob, pretrackedEnrichment,
    callbacks, requestedAgentId, needsIdentity, identity, peerKey, previous, continuePreparation,
  });
}
