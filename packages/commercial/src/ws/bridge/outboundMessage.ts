import { WebSocket, type RawData } from "ws";
import { isClientMessageId } from "@openclaude/protocol";
import { reconcileRemoteChat } from "../../account-pool/remoteLaneRecovery.js";
import {
  noteProducerFenceDrop,
  shouldForwardLiveFrameToBrowser,
} from "../../db/liveTurnFrames.js";
import { markTurnControlReceipt } from "../../dispatch/turnControlStore.js";
import { isPlainRecord } from "../bridgeInputGuards.js";
import { containerLinkSnapshotSession } from "../containerLinkHello.js";
import { createOutboundFrameAccessor, type OutboundFrameAccessor } from "../outboundFrameDecode.js";
import {
  PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE,
  PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
  PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
  PROMPT_QUEUE_GRANT_FIELD,
  type PromptQueueDispatchRequest,
} from "../promptQueueDispatchTypes.js";
import { parseAndHandleMigrationInstallReceipt } from "../userChatBridgeRemotePoolSeal.js";
import { CONTAINER_ATTEST_FRAME_TYPE } from "../userChatBridgeTypes.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import { releaseCodexTurnState } from "./connectionCodexState.js";
import { failDispatchPreForward } from "./connectionDispatch.js";
import { retainOutboundPersistQueueKey } from "./connectionLifecycle.js";
import { CLOSE_BRIDGE, isControlId } from "./constants.js";
import { handleCodexBillingFrame } from "./outboundCodexBilling.js";
import { handleExternalEngineBillingFrame } from "./outboundExternalBilling.js";
import {
  handlePermissionOutboundFrames,
  observeOutboundSideChannels,
} from "./outboundSideChannels.js";
import type { AdmittedDispatch, BridgeConnectionCtx, DurableStampedFrame } from "./types.js";
import {
  closeWsSafely,
  codexPeerKey,
  parseLeftoverHotWsPayload,
  parsePromptQueueDispatchActivated,
  parsePromptQueueDispatchCancel,
  parsePromptQueueDispatchRequest,
  rawDataLen,
  samePromptQueueDispatch,
} from "./wireHelpers.js";

const MASTER_ONLY_FRAME_TYPES = new Set<unknown>([
  "sys.incident",
  "sys.goal_snapshot",
  "sys.recovery_status",
  "sys.media_job",
  "sys.recovery_decision",
  "sys.studio_event",
  "sys.muse_result",
]);

function handleDurableControlReceiptFrame(
  ctx: BridgeConnectionCtx,
  parsedControl: Record<string, unknown>,
): boolean {
  if (
    parsedControl.type !== "outbound.control.receipt" ||
    !isControlId(parsedControl.controlId) ||
    (parsedControl.status !== "applied" && parsedControl.status !== "terminal")
  ) {
    return false;
  }
  if (!ctx.shared.deps.pgPool) return true;
  const controlId = parsedControl.controlId;
  const status = parsedControl.status;
  void markTurnControlReceipt(ctx.shared.deps.pgPool, {
    userId: ctx.uid,
    controlId,
    status,
    errorCode: typeof parsedControl.errorCode === "string" ? parsedControl.errorCode : null,
  })
    .then((committed) => {
      if (committed) ctx.shared.broadcastToUser(ctx.uid, parsedControl);
    })
    .catch((error) => {
      ctx.bridgeLog?.warn("user-chat-bridge: durable control receipt commit failed", {
        controlId,
        error,
      });
    });
  return true;
}

function cleanupRejectedAdmittedTurn(
  ctx: BridgeConnectionCtx,
  rejectedRecord: AdmittedDispatch,
  rejectedSessionId: string,
  rejectedCmid: string | null,
): void {
  const rejectedCodexState = ctx.activeCodexTurnsByPeer.get(codexPeerKey(rejectedSessionId));
  if (
    rejectedCodexState !== undefined &&
    rejectedCodexState.clientMessageId !== null &&
    rejectedCodexState.clientMessageId === rejectedCmid
  ) {
    releaseCodexTurnState(ctx, rejectedCodexState, "turn_error");
  }
  const lanePool = ctx.shared.deps.pgPool;
  const laneKey = rejectedRecord.engineSessionKey ?? null;
  const releaseRemoteLane =
    lanePool && rejectedRecord.remoteLane === true && laneKey !== null
      ? (): void => {
          void reconcileRemoteChat(lanePool, Number(ctx.uid), laneKey).catch((error) => {
            ctx.bridgeLog?.warn(
              "user-chat-bridge: remote lane release after authority rejection failed",
              { engineSessionKey: laneKey, error },
            );
          });
        }
      : undefined;
  failDispatchPreForward(ctx, rejectedRecord, "model_authority_rejected", {
    abortNeverExecutedJournal: true,
    fromStatuses: ["admitted"],
    ...(releaseRemoteLane === undefined ? {} : { onTerminal: releaseRemoteLane }),
  });
}

function handleModelAuthorityRejectedFrame(
  ctx: BridgeConnectionCtx,
  rejectedFrame: Record<string, unknown>,
): boolean {
  if (rejectedFrame.type !== "error" || rejectedFrame.code !== "MODEL_AUTHORITY_REJECTED") {
    return false;
  }
  const rejectedPeer = isPlainRecord(rejectedFrame.peer) ? rejectedFrame.peer : null;
  const rejectedPeerId =
    typeof rejectedPeer?.id === "string" && rejectedPeer.id ? rejectedPeer.id : null;
  const rejectedCmid = isClientMessageId(rejectedFrame.clientMessageId)
    ? rejectedFrame.clientMessageId
    : null;
  const rejectedRecord =
    rejectedCmid === null ? undefined : ctx.admittedDispatches.get(rejectedCmid);
  const rejectedSessionId =
    rejectedRecord !== undefined &&
    rejectedPeerId !== null &&
    rejectedRecord.sessionId === rejectedPeerId
      ? rejectedRecord.sessionId
      : null;
  const unadmittedButIdentified =
    rejectedRecord === undefined && rejectedPeerId !== null && rejectedCmid !== null;
  if (rejectedSessionId === null && !unadmittedButIdentified) {
    ctx.bridgeLog?.warn("user-chat-bridge: dropped authority rejection with unverified identity", {
      hasPeer: rejectedPeerId !== null,
      hasClientMessageId: rejectedCmid !== null,
      admitted: rejectedRecord !== undefined,
    });
    return true;
  }
  if (rejectedRecord !== undefined && rejectedSessionId !== null) {
    cleanupRejectedAdmittedTurn(ctx, rejectedRecord, rejectedSessionId, rejectedCmid);
  }
  sendErrorFrame(
    ctx.userWs,
    "MODEL_AUTHORITY_REJECTED",
    "模型执行权威拒绝了本次请求，本轮未开始也未计费，请重新选择模型后发送。",
    { peerId: rejectedSessionId ?? rejectedPeerId, clientMessageId: rejectedCmid },
  );
  return true;
}

function buildPromptQueueInboundFrame(request: PromptQueueDispatchRequest): Record<string, unknown> {
  const execution = request.item.requestedExecution;
  return {
    type: "inbound.message",
    channel: "webchat",
    peer: request.owner.peer,
    agentId: request.owner.agentId,
    clientMessageId: request.item.clientMessageId,
    idempotencyKey: `prompt-queue:${request.grantId}`,
    content: request.item.content,
    ...(execution.model !== undefined ? { model: execution.model } : {}),
    ...(execution.modelSwitchId !== undefined ? { modelSwitchId: execution.modelSwitchId } : {}),
    ...(execution.modelSwitchConsent !== undefined
      ? { modelSwitchConsent: execution.modelSwitchConsent }
      : {}),
    ...(execution.effortLevel !== undefined ? { effortLevel: execution.effortLevel } : {}),
    ...(execution.serviceTier !== undefined ? { serviceTier: execution.serviceTier } : {}),
    ...(execution.teamMode !== undefined ? { teamMode: execution.teamMode } : {}),
    ...(execution.swarmMode !== undefined ? { swarmMode: execution.swarmMode } : {}),
    ...(execution.collabMode !== undefined ? { collabMode: execution.collabMode } : {}),
    ...(execution.advisorModel !== undefined ? { advisorModel: execution.advisorModel } : {}),
    ...(execution.collabConfigVersion !== undefined
      ? { collabConfigVersion: execution.collabConfigVersion }
      : {}),
    ...(execution.contextTier !== undefined ? { contextTier: execution.contextTier } : {}),
    [PROMPT_QUEUE_GRANT_FIELD]: {
      grantId: request.grantId,
      itemId: request.item.itemId,
      contentHash: request.item.contentHash,
      epoch: request.claim.epoch,
      claimToken: request.claim.claimToken,
    },
  };
}

function handlePromptQueueContainerEnvelope(
  ctx: BridgeConnectionCtx,
  candidate: Record<string, unknown>,
): boolean {
  if (candidate.type === PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE) {
    const activated = parsePromptQueueDispatchActivated(candidate);
    if (activated === null) {
      ctx.bridgeLog?.warn("user-chat-bridge: malformed prompt queue activation acknowledgement dropped");
      return true;
    }
    const registered = ctx.promptQueueDispatchCancellations.get(activated.grantId);
    if (!registered || !samePromptQueueDispatch(activated, registered.request)) {
      ctx.bridgeLog?.warn("user-chat-bridge: stale or mismatched prompt queue activation acknowledgement dropped", {
        grantId: activated.grantId,
      });
      return true;
    }
    ctx.promptQueueDispatchCancellations.delete(activated.grantId);
    return true;
  }
  if (candidate.type === PROMPT_QUEUE_DISPATCH_CANCEL_TYPE) {
    const cancel = parsePromptQueueDispatchCancel(candidate);
    if (cancel === null) {
      ctx.bridgeLog?.warn("user-chat-bridge: malformed prompt queue dispatch cancel dropped");
      return true;
    }
    const registered = ctx.promptQueueDispatchCancellations.get(cancel.grantId);
    if (!registered || !samePromptQueueDispatch(cancel, registered.request)) {
      ctx.bridgeLog?.warn("user-chat-bridge: stale or mismatched prompt queue cancel dropped", {
        grantId: cancel.grantId,
      });
      return true;
    }
    ctx.promptQueueDispatchCancellations.delete(cancel.grantId);
    ctx.shared.trackPromptQueueCompensation(registered.cancel(cancel.reasonCode));
    return true;
  }
  if (candidate.type !== PROMPT_QUEUE_DISPATCH_REQUEST_TYPE) return false;
  const request = parsePromptQueueDispatchRequest(candidate);
  if (request === null) {
    ctx.bridgeLog?.warn("user-chat-bridge: malformed prompt queue dispatch request dropped");
    return true;
  }
  const canonicalSessionKey = `agent:${request.owner.agentId}:webchat:dm:${request.owner.peer.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (request.owner.sessionKey !== canonicalSessionKey) {
    ctx.bridgeLog?.warn("user-chat-bridge: prompt queue dispatch owner mismatch", {
      sessionKey: request.owner.sessionKey,
    });
    return true;
  }
  const inbound = buildPromptQueueInboundFrame(request);
  ctx.executeAdmittedTurn(Buffer.from(JSON.stringify(inbound), "utf8"), false, "prompt_queue", request);
  return true;
}

function handleEarlyContainerControl(
  ctx: BridgeConnectionCtx,
  frameText: string,
  frame: OutboundFrameAccessor,
): boolean {
  if (frameText.includes(`"${CONTAINER_ATTEST_FRAME_TYPE}"`)) {
    const parsed = frame.getParsedTextFrame();
    if (isPlainRecord(parsed) && parsed.type === CONTAINER_ATTEST_FRAME_TYPE) {
      ctx.onContainerAttest(parsed);
      return true;
    }
  }
  if (frameText.includes('"outbound.external_engine_billing"')) {
    const external = frame.getParsedTextFrame();
    if (isPlainRecord(external) && external.type === "outbound.external_engine_billing") {
      handleExternalEngineBillingFrame(ctx, external);
      return true;
    }
  }
  if (
    parseAndHandleMigrationInstallReceipt(frameText, {
      uid: ctx.uid,
      admittedDispatches: ctx.admittedDispatches,
      pendingMigrationInstalls: ctx.pendingMigrationInstalls,
      markPlacementMigrationInstalled: ctx.shared.deps.markPlacementMigrationInstalled,
      warn: (message, meta) => ctx.bridgeLog?.warn(message, meta),
    })
  ) {
    return true;
  }
  return ctx.shared.adapters.handleTurnDispatchReceiptFromBridge(frameText, ctx);
}

function handleInternalTextContainerControl(
  ctx: BridgeConnectionCtx,
  frameText: string,
  frame: OutboundFrameAccessor,
): boolean {
  if (handleEarlyContainerControl(ctx, frameText, frame)) return true;
  if (frameText.includes('"outbound.control.receipt"')) {
    const parsedControl = frame.getParsedTextFrame();
    if (isPlainRecord(parsedControl) && handleDurableControlReceiptFrame(ctx, parsedControl)) {
      return true;
    }
  }
  if (frameText.includes('"MODEL_AUTHORITY_REJECTED"')) {
    const rejectedFrame = frame.getParsedTextFrame();
    if (isPlainRecord(rejectedFrame) && handleModelAuthorityRejectedFrame(ctx, rejectedFrame)) {
      return true;
    }
  }
  if (ctx.shared.deps.promptQueueEnabled === true && frameText.includes("outbound.prompt_queue.")) {
    const candidate = frame.getParsedTextFrame();
    if (isPlainRecord(candidate) && handlePromptQueueContainerEnvelope(ctx, candidate)) {
      return true;
    }
  }
  if (frameText.includes('"outbound.codex_billing"')) {
    const parsedBilling = frame.getParsedTextFrame();
    if (isPlainRecord(parsedBilling) && parsedBilling.type === "outbound.codex_billing") {
      handleCodexBillingFrame(ctx, parsedBilling);
      return true;
    }
  }
  return false;
}

function forwardCommittedFrame(
  ctx: BridgeConnectionCtx,
  data: RawData,
  isBinary: boolean,
  len: number,
  durableStampedFrame: DurableStampedFrame | null,
): void {
  if (
    !shouldForwardLiveFrameToBrowser({
      sessionId: durableStampedFrame?.sessionId ?? null,
      clientMessageId: durableStampedFrame?.clientMessageId ?? null,
    })
  ) {
    noteProducerFenceDrop("bridge-forward");
    return;
  }
  if (
    durableStampedFrame !== null &&
    durableStampedFrame.clientMessageId === null &&
    parseLeftoverHotWsPayload(durableStampedFrame.payload)
  ) {
    return;
  }
  if (durableStampedFrame !== null) {
    ctx.shared.outboundRing.storeStamped(
      durableStampedFrame.storeKey,
      durableStampedFrame.frameSeq,
      Date.now(),
      durableStampedFrame.payload,
    );
  }
  const sessionId =
    durableStampedFrame?.sessionId ??
    (ctx.linkHandle ? containerLinkSnapshotSession(data, isBinary) : null);
  const recipients: WebSocket[] = [];
  const seen = new Set<WebSocket>();
  const addRecipient = (ws: WebSocket): void => {
    if (ws.readyState !== WebSocket.OPEN || seen.has(ws)) return;
    seen.add(ws);
    recipients.push(ws);
  };
  for (const ws of ctx.shared.openUserWsForSession(ctx.uid.toString(), sessionId)) addRecipient(ws);
  if (sessionId === null || recipients.length === 0) addRecipient(ctx.userWs);
  if (recipients.length === 0) return;
  const maxBufferedBytes = ctx.shared.config.maxBufferedBytes;
  for (const dest of recipients) {
    if (dest.bufferedAmount + len > maxBufferedBytes) {
      ctx.bridgeLog?.warn("user-chat-bridge: user-side backpressure", {
        buffered: dest.bufferedAmount,
        len,
      });
      closeWsSafely(dest, CLOSE_BRIDGE.TOO_BIG, "backpressure");
      if (dest === ctx.userWs) ctx.cleanup("backpressure");
      continue;
    }
    try {
      dest.send(data, { binary: isBinary }, (err) => {
        if (err) ctx.bridgeLog?.warn("user-chat-bridge: user send error", { err });
      });
      ctx.bytesCU += len;
      if (dest === ctx.userWs) ctx.bufferedCU = dest.bufferedAmount;
      ctx.shared.metrics.onContainerFrame?.(ctx.uid, len, isBinary);
      ctx.shared.metrics.onBufferedBytes?.(ctx.uid, "container_to_user", dest.bufferedAmount);
    } catch (err) {
      ctx.bridgeLog?.warn("user-chat-bridge: user send threw", { err });
      closeWsSafely(dest, CLOSE_BRIDGE.INTERNAL, "user send failed");
      if (dest === ctx.userWs) ctx.cleanup("internal_error");
    }
  }
}

function enqueueDurableOutboundFrame(args: {
  ctx: BridgeConnectionCtx;
  data: RawData;
  isBinary: boolean;
  len: number;
  durableStampedFrame: DurableStampedFrame;
  durableSessionId: string;
  permissionAuthorityCommit: (() => Promise<void>) | null;
}): void {
  const { ctx, data, isBinary, len, durableStampedFrame, durableSessionId, permissionAuthorityCommit } = args;
  if (
    !shouldForwardLiveFrameToBrowser({
      sessionId: durableSessionId,
      clientMessageId: durableStampedFrame.clientMessageId,
    })
  ) {
    noteProducerFenceDrop("bridge-enqueue");
    return;
  }
  retainOutboundPersistQueueKey(ctx, durableStampedFrame.storeKey);
  ctx.inFlightOutboundPersists += 1;
  if (ctx.linkHandle) ctx.linkHandle.pendingPersistCount += 1;
  let persistSettled = false;
  const releasePersistHold = (): void => {
    if (persistSettled) return;
    persistSettled = true;
    ctx.inFlightOutboundPersists = Math.max(0, ctx.inFlightOutboundPersists - 1);
    if (ctx.linkHandle) {
      ctx.linkHandle.pendingPersistCount = Math.max(0, ctx.linkHandle.pendingPersistCount - 1);
    }
    ctx.checkDrainComplete();
  };
  ctx.shared.outboundPersistQueues.enqueue(
    durableStampedFrame.storeKey,
    durableStampedFrame.frameSeq,
    async () => {
      try {
        if (permissionAuthorityCommit !== null) await permissionAuthorityCommit();
        await ctx.shared.deps.persistOutboundFrame!({
          uid: ctx.uid,
          sessionId: durableSessionId,
          clientMessageId: durableStampedFrame.clientMessageId,
          agentContainerId: ctx.containerId!,
          sessionKey: durableStampedFrame.sessionKey,
          frameSeq: durableStampedFrame.frameSeq,
          payload: durableStampedFrame.payload,
        });
        if (durableStampedFrame.isFinal && ctx.userDetached && !ctx.cleaned && !ctx.shared.shuttingDown) {
          await ctx.shared.drainDurableRecoveryForUser(ctx.uid);
        }
        ctx.linkHandle?.persisted(
          durableSessionId,
          durableStampedFrame.clientMessageId,
          durableStampedFrame.isFinal,
        );
        forwardCommittedFrame(ctx, data, isBinary, len, durableStampedFrame);
      } finally {
        releasePersistHold();
      }
    },
    (error) => {
      releasePersistHold();
      ctx.bridgeLog?.error("user-chat-bridge: outbound durability commit failed", {
        sessionId: durableStampedFrame.sessionId,
        clientMessageId: durableStampedFrame.clientMessageId,
        containerId: ctx.containerId,
        sessionKey: durableStampedFrame.sessionKey,
        frameSeq: durableStampedFrame.frameSeq,
        err: (error as Error)?.message ?? String(error),
      });
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.INTERNAL, "output persistence unavailable");
    },
    (error) => {
      releasePersistHold();
      ctx.bridgeLog?.error(
        "user-chat-bridge: skipping outbound frame after permanent live-stream conflict",
        {
          sessionId: durableStampedFrame.sessionId,
          clientMessageId: durableStampedFrame.clientMessageId,
          containerId: ctx.containerId,
          sessionKey: durableStampedFrame.sessionKey,
          frameSeq: durableStampedFrame.frameSeq,
          err: (error as Error)?.message ?? String(error),
        },
      );
    },
  );
}

export function onContainerMessage(
  ctx: BridgeConnectionCtx,
  data: RawData,
  isBinary: boolean,
): void {
  const len = rawDataLen(data);
  if (len > ctx.shared.config.maxFrameBytes) {
    ctx.bridgeLog?.warn("user-chat-bridge: container frame too big", {
      len,
      max: ctx.shared.config.maxFrameBytes,
    });
    sendErrorFrame(
      ctx.userWs,
      "ERR_FRAME_TOO_BIG",
      `container frame ${len} > max ${ctx.shared.config.maxFrameBytes}`,
    );
    closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_BIG, "frame too big");
    ctx.cleanup("frame_too_big", true);
    return;
  }
  const frame = createOutboundFrameAccessor(data, isBinary);
  const frameText = frame.getFrameText();
  if (frameText !== null && handleInternalTextContainerControl(ctx, frameText, frame)) return;
  const parsedMasterFrameCandidate = frame.getParsedFrame();
  const masterOnlyFrameType =
    parsedMasterFrameCandidate !== null && typeof parsedMasterFrameCandidate === "object"
      ? (parsedMasterFrameCandidate as { type?: unknown }).type
      : null;
  if (MASTER_ONLY_FRAME_TYPES.has(masterOnlyFrameType)) {
    if (!ctx.loggedRejectedContainerIncident) {
      ctx.loggedRejectedContainerIncident = true;
      ctx.bridgeLog?.warn("user-chat-bridge: rejected container-authored master-only frame", {
        type: masterOnlyFrameType,
      });
    }
    return;
  }
  const permissionAuthorityCommit =
    frameText !== null ? handlePermissionOutboundFrames(ctx, frameText, frame) : null;
  const durableStampedFrame = observeOutboundSideChannels(
    ctx,
    frameText,
    frame,
    parsedMasterFrameCandidate,
  );
  const durableSessionId = durableStampedFrame?.sessionId ?? null;
  if (durableStampedFrame !== null && durableSessionId !== null && ctx.shared.deps.persistOutboundFrame) {
    enqueueDurableOutboundFrame({
      ctx, data, isBinary, len, durableStampedFrame, durableSessionId, permissionAuthorityCommit,
    });
    return;
  }
  if (permissionAuthorityCommit !== null) {
    void permissionAuthorityCommit()
      .then(() => forwardCommittedFrame(ctx, data, isBinary, len, durableStampedFrame))
      .catch((error) => {
        ctx.bridgeLog?.error("user-chat-bridge: permission authority commit failed", {
          error: (error as Error)?.message ?? String(error),
        });
        closeWsSafely(ctx.userWs, CLOSE_BRIDGE.INTERNAL, "permission persistence unavailable");
      });
    return;
  }
  forwardCommittedFrame(ctx, data, isBinary, len, durableStampedFrame);
}
