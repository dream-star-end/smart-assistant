import { WebSocket, type RawData } from "ws";
import { closePendingZcodeAudits, zcodeCleanupTerminal } from "../../billing/zcodeExternalAudit.js";
import { hasBrowserActivity } from "../containerLinkPolicy.js";
import { registerBridgeTransport } from "../containerLinkTransport.js";
import { fetchActiveSelectionsForRebind } from "../sessionRepoBindBridge.js";
import type { FallbackWireOutcomeHandler } from "../userChatBridgeLocalFallbackTransport.js";
import type { BridgeCloseCause } from "../userChatBridgeTypes.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import { failAttestation } from "./connectionAuthority.js";
import { releaseCodexTurnState, tryAutoRebindFlush } from "./connectionCodexState.js";
import {
  beginEnrichmentTransfer,
  completeEnrichmentTransfer,
  failDispatchPreForward,
  hasOpenDispatchStreams,
  hasPendingDispatchWork,
  hasPreTransferDispatchWork,
  recordBillingRecovery,
  settleCronOriginClaim,
  terminalizeAllEnriching,
  terminalizeEnrichmentDispatch,
} from "./connectionDispatch.js";
import {
  ACTIVITY_REFRESH_INTERVAL_MS,
  CLOSE_BRIDGE,
  DEFAULT_ATTEST_TIMEOUT_MS,
  GRANTS_REFRESH_INTERVAL_MS,
} from "./constants.js";
import { isGrokEngineKind } from "./enginePolicy.js";
import type {
  AdmittedDispatch,
  BridgeConnectionCtx,
  EnrichmentDispatchState,
} from "./types.js";
import {
  closeWsSafely,
  readWsCloseMeta,
  sanitizeCloseCode,
  sendJsonSafely,
  terminateWsSafely,
} from "./wireHelpers.js";

export function retainOutboundPersistQueueKey(ctx: BridgeConnectionCtx, key: string): void {
  if (ctx.userDetached || ctx.retainedOutboundPersistQueueKeys.has(key)) return;
  ctx.shared.outboundPersistQueues.retain(key);
  ctx.retainedOutboundPersistQueueKeys.add(key);
}

export function sendToContainer(
  ctx: BridgeConnectionCtx,
  data: RawData,
  isBinary: boolean,
  len: number,
  transfer: EnrichmentDispatchState | null = null,
  dispatchRecord?: AdmittedDispatch,
  onWireOutcome?: FallbackWireOutcomeHandler,
): boolean {
  try {
    ctx.containerWs.send(data, { binary: isBinary }, (err) => {
      const complete = (): void => {
        if (err) {
          ctx.bridgeLog?.warn("user-chat-bridge: container send error", { err });
          onWireOutcome?.({ wireSent: false, reason: "container_send_error" });
          if (transfer) {
            terminalizeEnrichmentDispatch(ctx, transfer, "container_forward_rejected");
            ctx.cleanup("container_error", true);
          } else if (
            err instanceof Error &&
            /hello|beforeReplay/i.test(err.message) &&
            ctx.userWs.readyState === WebSocket.OPEN
          ) {
            closeWsSafely(ctx.userWs, CLOSE_BRIDGE.INTERNAL, "container hello failed");
          }
          return;
        }
        if (dispatchRecord) {
          dispatchRecord.wireSent = true;
          ctx.linkHandle?.markDispatchSent(
            dispatchRecord.sessionId,
            dispatchRecord.clientMessageId,
          );
        }
        onWireOutcome?.({ wireSent: true, reason: "wire_sent" });
        completeEnrichmentTransfer(ctx, transfer);
      };
      if (ctx.shared.deps.deferContainerSendCompletionForTest) {
        ctx.shared.deps.deferContainerSendCompletionForTest(complete);
      } else {
        complete();
      }
    });
    ctx.bytesUC += len;
    ctx.shared.metrics.onUserFrame?.(ctx.uid, len, isBinary);
    return true;
  } catch (err) {
    ctx.bridgeLog?.warn("user-chat-bridge: container send threw", { err });
    if (transfer) terminalizeEnrichmentDispatch(ctx, transfer, "container_forward_rejected");
    closeWsSafely(ctx.userWs, CLOSE_BRIDGE.INTERNAL, "agent send failed");
    ctx.cleanup("container_error", true);
    return false;
  }
}

export function forwardInboundFrame(
  ctx: BridgeConnectionCtx,
  data: RawData,
  isBinary: boolean,
  len: number,
  dispatchRecord?: AdmittedDispatch,
  onWireOutcome?: FallbackWireOutcomeHandler,
): boolean {
  if (ctx.cleaned) {
    failDispatchPreForward(ctx, dispatchRecord, "bridge_cleaned_before_physical_forward");
    return false;
  }
  const markActivity = ctx.shared.deps.markContainerActivity;
  if (
    markActivity &&
    ctx.containerId !== undefined &&
    hasBrowserActivity(ctx.userDetached, ctx.userWs.readyState)
  ) {
    const now = Date.now();
    if (now - ctx.lastActivityRefreshAt >= ACTIVITY_REFRESH_INTERVAL_MS) {
      ctx.lastActivityRefreshAt = now;
      try {
        markActivity(ctx.containerId);
      } catch (err) {
        void err;
      }
    }
  }
  if (ctx.containerWs.readyState === WebSocket.CONNECTING) {
    if (ctx.bufferedUC + len > ctx.shared.config.maxBufferedBytes) {
      closeWsSafely(ctx.userWs, CLOSE_BRIDGE.TOO_BIG, "backpressure");
      ctx.cleanup("backpressure", true);
      return false;
    }
    ctx.bufferedUC += len;
    ctx.shared.metrics.onBufferedBytes?.(ctx.uid, "user_to_container", ctx.bufferedUC);
    ctx.preopenQueue.push({ data, isBinary, len, dispatchRecord, onWireOutcome });
    onWireOutcome?.({ wireSent: false, handedOff: true, reason: "transport_handoff" });
    return true;
  }
  if (ctx.containerWs.readyState !== WebSocket.OPEN) {
    failDispatchPreForward(ctx, dispatchRecord, "container_forward_rejected");
    return false;
  }
  const transfer = beginEnrichmentTransfer(ctx, dispatchRecord);
  if (dispatchRecord !== undefined && transfer === null) return false;
  if (dispatchRecord) ctx.linkHandle?.bindDispatch(dispatchRecord);
  const sent = ctx.sendToContainer(data, isBinary, len, transfer, dispatchRecord, onWireOutcome);
  if (sent) onWireOutcome?.({ wireSent: false, handedOff: true, reason: "transport_handoff" });
  return sent;
}

function isUserSideDrainCause(cause: BridgeCloseCause): boolean {
  return cause === "client_close" || cause === "backpressure" || cause === "internal_error";
}

function isTransportTerminalCause(cause: BridgeCloseCause): boolean {
  return cause === "container_close" || cause === "container_error" || cause === "shutdown";
}

function clearTimersOnDetach(ctx: BridgeConnectionCtx): void {
  if (ctx.heartbeatTimer !== null) {
    clearInterval(ctx.heartbeatTimer);
    ctx.heartbeatTimer = null;
  }
  if (!ctx.linkHandle && ctx.modelCheckerRefreshTimer !== null) {
    clearInterval(ctx.modelCheckerRefreshTimer);
    ctx.modelCheckerRefreshTimer = null;
  }
  if (ctx.activityKeepaliveTimer !== null) {
    clearInterval(ctx.activityKeepaliveTimer);
    ctx.activityKeepaliveTimer = null;
  }
  if (ctx.attestTimer !== null) {
    clearTimeout(ctx.attestTimer);
    ctx.attestTimer = null;
  }
  ctx.attestQueue.length = 0;
  ctx.attestQueuedBytes = 0;
  if (ctx.connectTimer !== null) {
    clearTimeout(ctx.connectTimer);
    ctx.connectTimer = null;
  }
}

export function detachUserSide(ctx: BridgeConnectionCtx, triggerCause: BridgeCloseCause): void {
  if (ctx.userDetached) return;
  ctx.userDetached = true;
  ctx.linkHandle?.detach();
  for (const key of ctx.retainedOutboundPersistQueueKeys) {
    ctx.shared.outboundPersistQueues.release(key);
  }
  ctx.retainedOutboundPersistQueueKeys.clear();
  clearTimersOnDetach(ctx);
  if (
    triggerCause !== "client_close" &&
    ctx.userWs.readyState !== WebSocket.CLOSED &&
    ctx.userWs.readyState !== WebSocket.CLOSING
  ) {
    terminateWsSafely(ctx.userWs);
  }
  ctx.unregister();
  ctx.shared.unregisterUserWsSessions(ctx.userWs);
  const uidKey = ctx.uid.toString();
  const userSet = ctx.shared.uidToUserWs.get(uidKey);
  if (userSet) {
    userSet.delete(ctx.userWs);
    if (userSet.size === 0) ctx.shared.uidToUserWs.delete(uidKey);
  }
  const containerSet = ctx.shared.uidToContainerWs.get(uidKey);
  if (containerSet) {
    containerSet.delete(ctx.containerWs);
    if (containerSet.size === 0) ctx.shared.uidToContainerWs.delete(uidKey);
  }
  if (!ctx.linkHandle) ctx.cronOriginExecutor = null;
}

function clearPendingStateOnFinalCleanup(
  ctx: BridgeConnectionCtx,
  finalCause: BridgeCloseCause,
): void {
  const { deps } = ctx.shared;
  const inflightCodexTurns = ctx.inflightCodexTurns;
  const pendingAntigravityRelays = ctx.pendingAntigravityRelays;
  const admittedDispatches = ctx.admittedDispatches;
  for (const m of ctx.preopenQueue.splice(0)) {
    m.onWireOutcome?.({ wireSent: false, reason: "bridge_closed_before_wire_send" });
  }
  if (inflightCodexTurns.size > 0) {
    ctx.bridgeLog?.info(
      "user-chat-bridge: bridge closed with surviving codex turns — journal left inflight (cross-bridge settle / reconciler will adjudicate)",
      { finalCause, leftover: inflightCodexTurns.size, requestIds: [...inflightCodexTurns.keys()] },
    );
  }
  inflightCodexTurns.clear();
  if (ctx.pendingZcodeRelays.size > 0) {
    for (const relay of ctx.pendingZcodeRelays.values()) deps.expireZcodeRoute?.(relay.token);
    ctx.pendingZcodeRelays.clear();
  }
  pendingAntigravityRelays.clear();
  for (const dispatchId of [...ctx.cronOriginClaimWaiters.keys()]) {
    settleCronOriginClaim(ctx, dispatchId, { kind: "delivery_unknown" });
  }
  const { pendingZcodeRequestIds } = ctx;
  if (deps.pgPool && pendingZcodeRequestIds.size > 0) {
    ctx.shared.ensureZcodeStaleReconcile();
    const leftover = [...pendingZcodeRequestIds];
    ctx.shared.trackZcodeAuditWork(
      closePendingZcodeAudits(deps.pgPool, {
        userId: ctx.uid,
        requestIds: leftover,
        terminalCode: zcodeCleanupTerminal(finalCause),
        pending: pendingZcodeRequestIds,
      }).then(() => undefined),
    );
  }
  admittedDispatches.clear();
  ctx.pendingMigrationInstalls.clear();
}

export function finalCleanup(ctx: BridgeConnectionCtx, finalCause: BridgeCloseCause): void {
  if (ctx.cleaned) return;
  ctx.cleaned = true;
  ctx.shared.drainingChecks.delete(ctx.checkDrainComplete);
  ctx.cause = finalCause;
  if (ctx.drainTimer !== null) {
    clearTimeout(ctx.drainTimer);
    ctx.drainTimer = null;
  }
  if (ctx.dispatchHeartbeatTimer !== null) {
    clearInterval(ctx.dispatchHeartbeatTimer);
    ctx.dispatchHeartbeatTimer = null;
  }
  if (ctx.modelCheckerRefreshTimer !== null) {
    clearInterval(ctx.modelCheckerRefreshTimer);
    ctx.modelCheckerRefreshTimer = null;
  }
  ctx.authorityCensus?.drop(ctx.connId);
  detachUserSide(ctx, finalCause);
  ctx.unregisterExecutors?.();
  ctx.unregisterExecutors = null;
  ctx.recoveryExecutor = null;
  ctx.cronOriginExecutor = null;
  const unactivated = [...ctx.promptQueueDispatchCancellations.values()];
  ctx.promptQueueDispatchCancellations.clear();
  for (const registered of unactivated) {
    ctx.shared.trackPromptQueueCompensation(registered.cancel("BRIDGE_CLOSED_BEFORE_ACTIVATION"));
  }
  clearPendingStateOnFinalCleanup(ctx, finalCause);
  const billingChannelDead = finalCause === "container_close";
  for (const state of [...ctx.activeCodexTurnsByPeer.values()]) {
    const preserveGrokSlot =
      isGrokEngineKind(state.engine) && state.turnForwarded && !billingChannelDead;
    releaseCodexTurnState(ctx, state, "bridge_cleanup", !state.turnForwarded, preserveGrokSlot);
  }
  try {
    ctx.connectAbort.abort();
  } catch (err) {
    void err;
  }
  if (ctx.containerWs.readyState !== WebSocket.CLOSED) {
    terminateWsSafely(ctx.containerWs);
  }
  const { closeCode, closeReason } = readWsCloseMeta(ctx.userWs);
  const durationMs = Date.now() - ctx.startedAt;
  ctx.shared.metrics.onClose?.({
    uid: ctx.uid,
    connId: ctx.connId,
    durationMs,
    closeCode,
    closeReason,
    bytesUserToContainer: ctx.bytesUC,
    bytesContainerToUser: ctx.bytesCU,
    cause: finalCause,
  });
  ctx.bridgeLog?.info("user-chat-bridge: closed", {
    durationMs,
    bytesUC: ctx.bytesUC,
    bytesCU: ctx.bytesCU,
    cause: finalCause,
  });
}

function expireDrain(ctx: BridgeConnectionCtx, message: string): void {
  ctx.bridgeLog?.warn(message, {
    leftover: ctx.inflightCodexTurns.size,
    admittedLeftover: ctx.admittedDispatches.size,
    preparationLeftover: ctx.preparationInFlight,
    openStreamLeftover: ctx.linkHandle?.streams.size ?? 0,
  });
  for (const [requestId, snap] of ctx.inflightCodexTurns) {
    recordBillingRecovery(ctx, requestId, "failed", snap);
  }
  terminalizeAllEnriching(ctx);
  finalCleanup(ctx, ctx.drainCause ?? "client_close");
}

export function checkDrainComplete(ctx: BridgeConnectionCtx): void {
  if (
    ctx.userDetached &&
    ctx.linkHandle &&
    !hasOpenDispatchStreams(ctx) &&
    ctx.drainTimer === null &&
    !ctx.cleaned &&
    (ctx.inflightCodexTurns.size > 0 || hasPendingDispatchWork(ctx))
  ) {
    cleanup(ctx, ctx.drainCause ?? "client_close");
  }
  const inDrain = ctx.drainTimer !== null || (ctx.userDetached && ctx.linkHandle !== undefined);
  if (
    inDrain &&
    ctx.inflightCodexTurns.size === 0 &&
    !hasPendingDispatchWork(ctx) &&
    !hasOpenDispatchStreams(ctx) &&
    !ctx.linkHandle?.keepAlive
  ) {
    if (ctx.drainTimer !== null) clearTimeout(ctx.drainTimer);
    ctx.drainTimer = null;
    finalCleanup(ctx, ctx.drainCause ?? "client_close");
  }
}

function enterBridgeDrain(ctx: BridgeConnectionCtx, triggerCause: BridgeCloseCause): void {
  ctx.drainCause = triggerCause;
  ctx.shared.drainingChecks.add(ctx.checkDrainComplete);
  detachUserSide(ctx, triggerCause);
  ctx.bridgeLog?.info("user-chat-bridge: enter drain", {
    inflightCount: ctx.inflightCodexTurns.size,
    preparationCount: ctx.preparationInFlight,
    admittedCount: ctx.admittedDispatches.size,
  });
  for (const [requestId, snap] of ctx.inflightCodexTurns) {
    recordBillingRecovery(ctx, requestId, "pending", snap);
  }
  const { adapters, config } = ctx.shared;
  const drainMs =
    hasPendingDispatchWork(ctx) || hasOpenDispatchStreams(ctx)
      ? Math.max(
          adapters.readDrainBillingMs(),
          adapters.readDispatchDrainMs(),
          hasPreTransferDispatchWork(ctx) ? config.promptQueuePreparationTimeoutMs : 0,
        )
      : adapters.readDrainBillingMs();
  ctx.drainTimer = setTimeout(() => {
    if (!ctx.shared.shuttingDown && hasOpenDispatchStreams(ctx)) {
      if (ctx.drainTimer !== null) clearTimeout(ctx.drainTimer);
      ctx.drainTimer = null;
      return;
    }
    expireDrain(ctx, "user-chat-bridge: drain timeout");
  }, drainMs);
  ctx.drainTimer.unref?.();
}

export function cleanup(
  ctx: BridgeConnectionCtx,
  triggerCause: BridgeCloseCause,
  force = false,
): void {
  if (ctx.cleaned) return;
  const keepOpenStreams = hasOpenDispatchStreams(ctx) || ctx.linkHandle?.keepAlive;
  if (!force && !ctx.shared.shuttingDown && keepOpenStreams && isUserSideDrainCause(triggerCause)) {
    ctx.drainCause = triggerCause;
    if (ctx.drainTimer !== null) {
      clearTimeout(ctx.drainTimer);
      ctx.drainTimer = null;
    }
    ctx.shared.drainingChecks.add(ctx.checkDrainComplete);
    detachUserSide(ctx, triggerCause);
    return;
  }
  const isTerminal = force || isTransportTerminalCause(triggerCause);
  if (ctx.drainTimer !== null) {
    if (isTerminal) {
      ctx.bridgeLog?.info("user-chat-bridge: drain pre-empt", {
        triggerCause,
        leftover: ctx.inflightCodexTurns.size,
      });
      terminalizeAllEnriching(ctx);
      finalCleanup(ctx, triggerCause);
    }
    return;
  }
  if (isTerminal) terminalizeAllEnriching(ctx);
  const hasWork =
    ctx.inflightCodexTurns.size > 0 || hasPendingDispatchWork(ctx) || hasOpenDispatchStreams(ctx);
  if (force || !isUserSideDrainCause(triggerCause) || !hasWork) {
    finalCleanup(ctx, triggerCause);
    return;
  }
  enterBridgeDrain(ctx, triggerCause);
}

export function attachContainerSocketLifecycle(ctx: BridgeConnectionCtx): void {
  ctx.containerWs.on("open", () => {
    if (ctx.connectTimer !== null) {
      clearTimeout(ctx.connectTimer);
      ctx.connectTimer = null;
    }
    registerBridgeTransport(ctx.uid, ctx.containerWs, ctx.shared.uidToContainerWs);
    ctx.bridgeLog?.debug("user-chat-bridge: container connected", {
      host: ctx.endpoint.host,
      port: ctx.endpoint.port,
    });
    if (ctx.authorityOn && ctx.attestState === "pending" && ctx.attestTimer === null) {
      ctx.attestTimer = setTimeout(
        () => failAttestation(ctx, "attestation_timeout"),
        ctx.authorityDeps?.attestTimeoutMs ?? DEFAULT_ATTEST_TIMEOUT_MS,
      );
    }
    if (ctx.endpoint.coldStart === true && ctx.userWs.readyState === WebSocket.OPEN) {
      sendJsonSafely(ctx.userWs, { type: "sys.cold_start" });
    }
    if (ctx.userWs.readyState === WebSocket.OPEN) {
      sendJsonSafely(ctx.userWs, {
        type: "sys.relay_ready",
        automaticRecoveryOwner: "master-v1",
        containerId: ctx.containerId,
      });
    }
    void ctx.shared.drainDurableControlsForUser(ctx.uid);
    for (const m of ctx.preopenQueue) {
      const flushed = ctx.forwardInboundFrame(
        m.data,
        m.isBinary,
        m.len,
        m.dispatchRecord,
        m.onWireOutcome,
      );
      if (!flushed) m.onWireOutcome?.({ wireSent: false, reason: "preopen_flush_rejected" });
    }
    ctx.preopenQueue.length = 0;
    ctx.bufferedUC = 0;
    ctx.shared.metrics.onBufferedBytes?.(ctx.uid, "user_to_container", 0);
    const pgPoolBound = ctx.shared.deps.pgPool;
    if (pgPoolBound) {
      void (async () => {
        try {
          const rows = await fetchActiveSelectionsForRebind(pgPoolBound, Number(ctx.uid));
          for (const row of rows) ctx.pendingRebindMap.set(row.sessionId, row);
        } catch (err) {
          ctx.bridgeLog?.warn("user-chat-bridge: fetch active selections failed", { err });
        } finally {
          ctx.autoRebindFetchDone = true;
          tryAutoRebindFlush(ctx);
        }
      })();
    } else {
      ctx.autoRebindFetchDone = true;
    }
  });
  ctx.containerWs.on("message", (data, isBinary) => ctx.onContainerMessage(data, isBinary));
  ctx.containerWs.on("linkShutdown", () => ctx.cleanup("shutdown", true));
  ctx.containerWs.on("error", (err: Error) => {
    ctx.bridgeLog?.warn("user-chat-bridge: container ws error", { err });
    sendErrorFrame(ctx.userWs, "ERR_CONTAINER", err.message);
    closeWsSafely(ctx.userWs, CLOSE_BRIDGE.INTERNAL, "agent error");
    ctx.cleanup("container_error", true);
  });
  ctx.containerWs.on("close", (code, reason) => {
    const passCode = sanitizeCloseCode(code);
    const passReason =
      reason && reason.length > 0 && reason.length < 120 ? reason.toString("utf8") : "agent closed";
    closeWsSafely(ctx.userWs, passCode, passReason);
    ctx.cleanup("container_close", true);
  });
}

export function attachUserSocketLifecycle(ctx: BridgeConnectionCtx): void {
  const { config, deps } = ctx.shared;
  ctx.userWs.on("message", (data, isBinary) => {
    ctx.executeAdmittedTurn(data, isBinary, "browser", undefined, undefined, Date.now());
  });
  ctx.userWs.removeAllListeners("error");
  ctx.userWs.on("error", (err) => {
    ctx.bridgeLog?.warn("user-chat-bridge: user ws error", { err });
  });
  const refreshAlive = (): void => {
    ctx.lastAliveAt = Date.now();
  };
  ctx.userWs.on("pong", refreshAlive);
  ctx.userWs.on("message", refreshAlive);
  if (config.heartbeatIntervalMs > 0) {
    ctx.heartbeatTimer = setInterval(() => {
      if (ctx.userWs.readyState !== WebSocket.OPEN) return;
      const idleMs = Date.now() - ctx.lastAliveAt;
      if (idleMs > config.heartbeatTimeoutMs && Date.now() >= ctx.turnActiveUntil) {
        ctx.bridgeLog?.info("user-chat-bridge: heartbeat timeout, terminating", { idleMs });
        terminateWsSafely(ctx.userWs);
        ctx.cleanup("client_close");
        return;
      }
      try {
        ctx.userWs.ping();
      } catch (err) {
        void err;
      }
    }, config.heartbeatIntervalMs);
  }
  if (ctx.modelCheckerHandle !== null || ctx.agentModelResolverHandle !== null) {
    ctx.modelCheckerRefreshTimer = setInterval(() => {
      void ctx.modelCheckerHandle?.refresh();
      void ctx.agentModelResolverHandle?.refresh();
    }, GRANTS_REFRESH_INTERVAL_MS);
    ctx.modelCheckerRefreshTimer.unref?.();
  }
  const markActivity = deps.markContainerActivity;
  if (markActivity && ctx.containerId !== undefined && config.activityKeepaliveIntervalMs > 0) {
    const cid = ctx.containerId;
    ctx.activityKeepaliveTimer = setInterval(() => {
      if (ctx.cleaned || !hasBrowserActivity(ctx.userDetached, ctx.userWs.readyState)) return;
      const now = Date.now();
      if (now - ctx.lastActivityRefreshAt < ACTIVITY_REFRESH_INTERVAL_MS) return;
      ctx.lastActivityRefreshAt = now;
      try {
        markActivity(cid);
      } catch (err) {
        void err;
      }
    }, config.activityKeepaliveIntervalMs);
    ctx.activityKeepaliveTimer.unref?.();
  }
  ctx.userWs.on("close", (code, reason) => {
    const passCode = sanitizeCloseCode(code);
    const passReason =
      reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "client closed";
    if (
      ctx.inflightCodexTurns.size === 0 &&
      !hasPendingDispatchWork(ctx) &&
      !hasOpenDispatchStreams(ctx) &&
      !ctx.linkHandle?.keepAlive
    ) {
      const state = ctx.containerWs.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        closeWsSafely(ctx.containerWs, passCode, passReason);
      }
    }
    const closeCause = ctx.requestedCloseCause ?? "client_close";
    ctx.cleanup(closeCause, closeCause === "shutdown");
  });
}
