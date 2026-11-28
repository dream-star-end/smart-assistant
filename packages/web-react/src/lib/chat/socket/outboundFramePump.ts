import { appUpdate } from "../../appUpdate";
import { incidentStore } from "../../incidentStore";
import { emitStudioPush } from "../../studio/push";
import { contextRebuiltRow } from "../contextRebuilt";
import {
  reconcileOrphanControlPending,
  settleTurnStopSettlement,
} from "../controlReceipts";
import type {
  AckWire,
  ColdStartWire,
  ContextRebuiltWire,
  CostChargedWire,
  CostWaivedWire,
  GoalSnapshotWire,
  IncidentWire,
  LegacyBridgeErrorWire,
  MediaJobWire,
  OutboundCallUsageWire,
  OutboundControlReceiptWire,
  OutboundErrorWire,
  OutboundMessageWire,
  OutboundModelSwitchPreparedWire,
  OutboundPermissionRequestWire,
  OutboundPermissionSettledWire,
  OutboundResumeFailedWire,
  OutboundSessionCompactResultWire,
  OutboundSessionSnapshotWire,
  OutboundTurnStatusWire,
  OutboundTurnUsageWire,
  OutboundWire,
  RecoveryDecisionWire,
  RecoveryStatusWire,
  RelayReadyWire,
  RepoBindErrorWire,
  RepoStatusWire,
  SessionContextPressureWire,
  StudioEventWire,
  SysContextCompactedWire,
} from "../frames";
import { addMessage, type ChatSession } from "../model";
import { COST_CHARGED_LAST_FINAL_TTL_MS, RECONNECT_BACKOFF_RESET_MS } from "../pure";
import {
  applyCallUsage,
  applyCostCharged,
  applyCostWaived,
  applyLegacyBridgeError,
  applyOutboundError,
  applyOutboundMessage,
  applyPermissionRequest,
  applyPermissionSettled,
  applyResumeFailed,
  applyTurnStatus,
  applyTurnUsage,
  currentFrameSeqAcceptOrder,
  type FrameEffects,
  resetAgentFrameSeqCursorsForSession,
} from "../reducer";
import { applyRecoveryStatusFrame, rememberRetryStatus } from "../retryStatus";
import { isSessionSnapshot } from "../sessionSnapshot";
import { applyControlReceiptFrame } from "./controlAndOfflineQueue";
import {
  applyRecoveryDecisionFrame,
  reconcileSkippedRecoveryAck,
  reportProblemCardInSocket,
  reportRecoveredProblemCardInSocket,
} from "./problemCardAndDeferredError";
import {
  adoptCronOriginTurnInSocket,
  adoptMasterAutomaticRecoveryTurn,
} from "./recoveryController";
import { TAPE_COMMIT_FINAL_GRACE_MS, type SocketCtx } from "./types";

function clearSessionFromReconnectSet(ctx: SocketCtx, sessId: string): void {
  if (!ctx.reconnectInFlightSet) return;
  ctx.reconnectInFlightSet.delete(sessId);
  if (ctx.reconnectInFlightSet.size === 0 && ctx.reconnectInFlightTimer) {
    clearTimeout(ctx.reconnectInFlightTimer);
    ctx.reconnectInFlightTimer = null;
    ctx.reconnectInFlightSet = null;
  }
}

function handleFinalFrameEffect(
  ctx: SocketCtx,
  sess: ChatSession,
  frame: OutboundMessageWire,
  isCronOrHeartbeat: boolean,
  clientMessageId: string | undefined,
): void {
  if (!isCronOrHeartbeat) {
    reportRecoveredProblemCardInSocket(ctx, sess, frame, clientMessageId);
    ctx.clearLiveJournalDegraded(sess);
    settleTurnStopSettlement(sess, frame.clientMessageId ?? clientMessageId, (id, s) =>
      ctx.settleControl(id, s),
    );
    ctx.finishDispatch(sess.id, clientMessageId);
    ctx.kickQueuedDrainIfIdle();
    ctx.dismissStaleRestoreBanner();
  }
  ctx.clearTransientNotice(sess.id);
  clearSessionFromReconnectSet(ctx, sess.id);
  ctx.deps.persistSession?.(sess.id);

  const shouldSyncAfterFinal =
    !ctx.durableHydrationStates.has(sess.id) &&
    !isCronOrHeartbeat &&
    frame.meta?.reconcile !== "turn_completed" &&
    frame.meta?.reconcile !== "interrupted" &&
    (sess._stopSettlement?.phase === "sync" || !frame.meta?.interrupted);
  if (!shouldSyncAfterFinal) return;

  const context = clientMessageId ? { clientMessageId } : undefined;
  if (sess._stopSettlement?.phase === "sync") {
    ctx.syncSessionAndSettleStop(sess.id, context);
  } else {
    void ctx.deps.syncSession?.(sess.id, context);
  }
}

export function deferTapeCommitFinalTimer(
  ctx: SocketCtx,
  sessId: string,
  frame: OutboundMessageWire,
): boolean {
  const clientMessageId = frame.clientMessageId;
  if (!clientMessageId) return false;
  const prev = ctx.tapeCommitFinalTimers.get(sessId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    ctx.tapeCommitFinalTimers.delete(sessId);
    const sess = ctx.sessions.get(sessId);
    if (!sess || !sess._sendingInFlight || sess._activeClientMessageId !== clientMessageId) return;
    const { reconcileSource: _source, ...meta } = frame.meta ?? {};
    applyOutboundMessage(sess, { ...frame, meta }, ctx.effects());
    ctx.scheduleNotify();
  }, TAPE_COMMIT_FINAL_GRACE_MS);
  ctx.tapeCommitFinalTimers.set(sessId, timer);
  return true;
}

export function createSocketFrameEffects(ctx: SocketCtx): FrameEffects {
  return {
    onFinal: (sess, frame, isCronOrHeartbeat, clientMessageId) =>
      handleFinalFrameEffect(ctx, sess, frame, isCronOrHeartbeat, clientMessageId),
    onLiveFrame: (sess) => {
      if (!sess._sendingInFlight) return;
      ctx.clearTransientNotice(sess.id);
      if (!ctx.durableHydrationStates.has(sess.id)) ctx.clearLiveJournalDegraded(sess);
    },
    scheduleAutoContinue: (sessId, targetMsgId, cls) => {
      setTimeout(() => ctx.autoContinueEmptyTurn(sessId, targetMsgId, cls), 0);
    },
    scheduleAutomaticRecovery: (sessId, clientMessageId) => {
      if (!ctx.masterOwnsAutomaticRecovery) {
        setTimeout(() => void ctx.autoRecoverTerminalTurn(sessId, clientMessageId), 0);
      }
    },
    deferTerminalErrorForRecovery: (sessId, paint) =>
      ctx.deferTerminalErrorForRecovery(sessId, paint),
    discardDeferredTerminalError: (sessId, clientMessageId) =>
      ctx.discardDeferredTerminalError(sessId, clientMessageId),
    settleCancelFencedStop: (sess, clientMessageId) => {
      const settled = settleTurnStopSettlement(sess, clientMessageId, (id, s) =>
        ctx.settleControl(id, s),
      );
      if (!settled) return;
      if (ctx.deps.syncSession) {
        ctx.syncSessionAndSettleStop(sess.id, clientMessageId ? { clientMessageId } : undefined);
      } else {
        sess._stopSettlement = undefined;
      }
    },
    refreshBalance: () => ctx.deps.refreshBalance?.(),
    reportTurnError: (p) =>
      ctx.deps.reportClientError?.({
        type: "turn_error",
        code: p.code,
        traceId: p.traceId,
        sessionId: p.sessionId,
      }),
    deferTapeCommitFinal: (sessId, frame) => deferTapeCommitFinalTimer(ctx, sessId, frame),
    forceSync: (sessId, context) => {
      if (ctx.sessions.get(sessId)?._stopSettlement?.phase === "sync") {
        ctx.syncSessionAndSettleStop(sessId, context);
      } else {
        ctx.syncHistory(sessId, context);
      }
    },
    resyncSwarmUnits: (sessId, clientMessageId) => ctx.resyncSwarmUnits(sessId, clientMessageId),
    syncMissingTurnUser: (sessId, clientMessageId) => ctx.syncHistory(sessId, { clientMessageId }),
    persistSession: (sessId) => ctx.deps.persistSession?.(sessId),
    onAuthControlError: () => {
      /* close(1008) handles token refresh */
    },
    reportProblemCard: (sessId, p) => reportProblemCardInSocket(ctx, sessId, p),
  };
}

export function bufferStampedFrameDuringDurableHydration(ctx: SocketCtx, f: OutboundWire): boolean {
  const frame = f as OutboundWire & {
    peer?: { id?: unknown };
    sessionKey?: unknown;
    frameSeq?: unknown;
  };
  const sessId =
    frame.peer && typeof frame.peer === "object" && typeof frame.peer.id === "string"
      ? frame.peer.id
      : null;
  if (
    sessId === null ||
    typeof frame.sessionKey !== "string" ||
    typeof frame.frameSeq !== "number" ||
    !Number.isSafeInteger(frame.frameSeq) ||
    frame.frameSeq <= 0
  ) {
    return false;
  }
  const state = ctx.durableHydrationStates.get(sessId);
  if (!state) return false;
  state.buffered.push(f);
  return true;
}

function uniquePreAdmissionInFlightSession(ctx: SocketCtx): ChatSession | null {
  const candidates: ChatSession[] = [];
  for (const sess of ctx.sessions.values()) {
    if (!sess._sendingInFlight) continue;
    const admittedId = ctx.dispatchSlots.get(sess.id);
    if (admittedId !== undefined && admittedId === sess._activeClientMessageId) continue;
    candidates.push(sess);
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function costTargetSession(sessions: ReadonlyMap<string, ChatSession>): ChatSession | null {
  const now = Date.now();
  let only: ChatSession | null = null;
  let count = 0;
  for (const s of sessions.values()) {
    const recentlyFinaled =
      Boolean(s._lastFinaledAssistantId) &&
      Boolean(s._lastFinaledAt) &&
      now - (s._lastFinaledAt ?? 0) < COST_CHARGED_LAST_FINAL_TTL_MS;
    if (Boolean(s._streamingAssistant) || s._sendingInFlight || recentlyFinaled) {
      count += 1;
      only = s;
      if (count > 1) return null;
    }
  }
  return count === 1 ? only : null;
}

function reconcileDeduplicatedTurnAck(ctx: SocketCtx, frame: AckWire): boolean {
  const sessId = frame.peer?.id;
  const clientMessageId = frame.clientMessageId;
  if (!sessId || !clientMessageId) return false;
  const sess = ctx.sessions.get(sessId);
  if (!sess) return false;
  const owns =
    sess._activeClientMessageId === clientMessageId ||
    ctx.offlineQueue.some((item) => item.sessId === sessId && item.msgId === clientMessageId);
  if (!owns) return false;
  ctx.finishDispatch(sessId, clientMessageId);
  ctx.clearSendingState(sess);
  const user = sess.messages.find((m) => m.role === "user" && m.id === clientMessageId);
  if (user) user.status = "sent";
  void ctx.deps.syncSession?.(sessId, { clientMessageId });
  ctx.scheduleNotify();
  return true;
}

function handleOutboundAckFrame(ctx: SocketCtx, frame: AckWire): void {
  if (frame.recoverySkipped) {
    reconcileSkippedRecoveryAck(ctx, frame);
    return;
  }
  if (frame.admitted && frame.peer?.id && frame.clientMessageId) {
    if (frame.recovery?.automatic === true) {
      adoptMasterAutomaticRecoveryTurn(ctx, frame.peer.id, frame.clientMessageId, frame.recovery);
      const sess = ctx.sessions.get(frame.peer.id);
      if (sess) {
        rememberRetryStatus(
          sess,
          { ...frame.recovery, clientMessageId: frame.clientMessageId },
          frame.retryStatus,
        );
      }
    } else if (frame.cronOrigin) {
      adoptCronOriginTurnInSocket(ctx, frame.peer.id, frame.clientMessageId, frame.cronOrigin);
    }
    ctx.confirmDispatchAdmission(frame.peer.id, frame.clientMessageId, frame.accepted === true);
  }
  if (frame.accepted && !frame.admitted && frame.peer?.id && frame.clientMessageId) {
    ctx.confirmDispatchAdmission(frame.peer.id, frame.clientMessageId);
  }
  if (frame.deduplicated) {
    const reconciled = reconcileDeduplicatedTurnAck(ctx, frame);
    if (!reconciled && typeof frame.idempotencyKey === "string" && frame.idempotencyKey.startsWith("autocont-")) {
      ctx.clearAutoContinueInFlight(frame.idempotencyKey);
    }
  }
}

function handleRelayReadyFrame(ctx: SocketCtx, relay: RelayReadyWire): void {
  ctx.masterOwnsAutomaticRecovery = relay.automaticRecoveryOwner === "master-v1";
  if (
    typeof relay.containerId === "number" &&
    Number.isSafeInteger(relay.containerId) &&
    relay.containerId > 0
  ) {
    ctx.relayContainerId = relay.containerId;
    ctx.relayContainerBoundOrder = currentFrameSeqAcceptOrder();
    for (const sess of ctx.sessions.values()) ctx.reconcileContainerForSession(sess);
  }
  ctx.relayReady = true;
  if (ctx.reconnectAttempts > 0 && !ctx.backoffResetTimer) {
    ctx.backoffResetTimer = setTimeout(() => {
      ctx.backoffResetTimer = null;
      if (ctx.ws?.readyState === 1 && ctx.relayReady) ctx.reconnectAttempts = 0;
    }, RECONNECT_BACKOFF_RESET_MS);
  }
  ctx.kickDispatchPump();
  ctx.kickControlPump();
  ctx.maybePromoteToConnected();
  ctx.flushAllRepoBinds();
}

function dispatchTurnStreamFrame(ctx: SocketCtx, f: OutboundWire): boolean {
  switch (f.type) {
    case "outbound.message": {
      const frame = f as OutboundMessageWire;
      const sess = frame.peer?.id ? ctx.sessions.get(frame.peer.id) : undefined;
      if (!sess) return true;
      if (frame.clientMessageId) {
        ctx.confirmDispatchAdmission(sess.id, frame.clientMessageId, !frame.meta?.reconcile);
      }
      applyOutboundMessage(sess, frame, ctx.effects());
      return true;
    }
    case "outbound.turn_status": {
      const frame = f as OutboundTurnStatusWire;
      const sess = ctx.sessions.get(frame.peer?.id);
      if (sess) {
        if (frame.clientMessageId) {
          ctx.confirmDispatchAdmission(sess.id, frame.clientMessageId, !frame.meta?.detached);
        }
        applyTurnStatus(sess, frame);
      }
      return true;
    }
    case "outbound.turn_usage": {
      const frame = f as OutboundTurnUsageWire;
      const sess = ctx.sessions.get(frame.peer?.id);
      if (sess) {
        ctx.confirmDispatchAdmission(sess.id, frame.clientMessageId);
        applyTurnUsage(sess, frame);
      }
      return true;
    }
    case "outbound.call_usage": {
      const frame = f as OutboundCallUsageWire;
      const sess = ctx.sessions.get(frame.peer?.id);
      if (sess) {
        ctx.confirmDispatchAdmission(sess.id, frame.clientMessageId);
        applyCallUsage(sess, frame);
      }
      return true;
    }
    default:
      return false;
  }
}

function dispatchTurnErrorFrame(ctx: SocketCtx, f: OutboundWire): boolean {
  if (f.type === "outbound.error") {
    const frame = f as OutboundErrorWire;
    const sess = ctx.sessions.get(frame.peer?.id);
    if (sess) {
      const activeCmid = sess._activeClientMessageId;
      const ownsActive = !frame.clientMessageId || activeCmid === frame.clientMessageId;
      applyOutboundError(sess, frame, ctx.effects());
      if (!sess._sendingInFlight) ctx.clearLiveJournalDegraded(sess);
      ctx.finishDispatch(sess.id, frame.clientMessageId ?? (ownsActive ? activeCmid : undefined));
      ctx.dismissStaleRestoreBanner();
    }
    return true;
  }
  if (f.type === "error") {
    const frame = f as LegacyBridgeErrorWire;
    const sess = frame.peer?.id
      ? (ctx.sessions.get(frame.peer.id) ?? null)
      : uniquePreAdmissionInFlightSession(ctx);
    if (sess) {
      const activeCmid = sess._activeClientMessageId;
      const ownsActive = !frame.clientMessageId || activeCmid === frame.clientMessageId;
      applyLegacyBridgeError(sess, frame, ctx.effects());
      if (!sess._sendingInFlight) ctx.clearLiveJournalDegraded(sess);
      ctx.finishDispatch(sess.id, frame.clientMessageId ?? (ownsActive ? activeCmid : undefined));
      ctx.dismissStaleRestoreBanner();
      ctx.deps.persistSession?.(sess.id);
    }
    return true;
  }
  return false;
}

function dispatchBillingFrame(ctx: SocketCtx, f: OutboundWire): boolean {
  if (f.type === "outbound.cost_charged") {
    const frame = f as CostChargedWire;
    const sess =
      (frame.parentSessionId ? ctx.sessions.get(frame.parentSessionId) : undefined) ??
      (frame.sessionId ? ctx.sessions.get(frame.sessionId) : undefined) ??
      costTargetSession(ctx.sessions);
    applyCostCharged(sess, frame, ctx.effects());
    return true;
  }
  if (f.type === "outbound.cost_waived") {
    const frame = f as CostWaivedWire;
    const sess =
      (frame.sessionId ? ctx.sessions.get(frame.sessionId) : undefined) ??
      costTargetSession(ctx.sessions);
    applyCostWaived(sess, frame, ctx.effects());
    ctx.deps.refreshInbox?.();
    return true;
  }
  return false;
}

function dispatchPermissionAndSnapshotFrame(ctx: SocketCtx, f: OutboundWire): boolean {
  switch (f.type) {
    case "outbound.permission_request": {
      const frame = f as OutboundPermissionRequestWire;
      const sess = ctx.sessions.get(frame.peer?.id);
      if (sess) {
        applyPermissionRequest(sess, frame);
        reconcileOrphanControlPending(sess, ctx.controlQueue);
        sess._recoveryStatus = { kind: "needs-confirmation" };
        ctx.deps.persistSession?.(sess.id);
      }
      return true;
    }
    case "outbound.permission_settled": {
      const frame = f as OutboundPermissionSettledWire;
      const sess = ctx.sessions.get(frame.peer?.id);
      if (sess) {
        applyPermissionSettled(sess, frame);
        const pending = ctx.controlQueue.find(
          (item) => item.controlKind === "permission" && item.requestId === frame.requestId,
        );
        if (pending) ctx.settleControl(pending.controlId, "terminal");
        else sess._recoveryStatus = { kind: "resumed" };
        ctx.deps.persistSession?.(sess.id);
      }
      return true;
    }
    case "outbound.session_snapshot": {
      const frame = f as OutboundSessionSnapshotWire;
      if (typeof frame.peer?.id === "string" && isSessionSnapshot(frame.snapshot)) {
        const asked = ctx.helloAskedCmid.get(frame.peer.id);
        ctx.helloAskedCmid.delete(frame.peer.id);
        const sent = ctx.helloSentAt.get(frame.peer.id);
        ctx.helloSentAt.delete(frame.peer.id);
        void ctx.applySessionSnapshot(frame.peer.id, frame.snapshot, {
          via: "ws",
          requestedAt: sent?.at ?? Date.now(),
          requestedOrder: sent?.order,
          asked,
        });
      }
      return true;
    }
    case "outbound.resume_failed": {
      const frame = f as OutboundResumeFailedWire;
      const sess = frame.peer?.id ? ctx.sessions.get(frame.peer.id) : null;
      if (sess) {
        if (frame.to === 0 && frame.reason === "no_buffer") {
          ctx.noteAuthoritativeFrameSeqReset(sess, frame);
        }
        applyResumeFailed(sess, frame, ctx.effects());
      }
      return true;
    }
    default:
      return false;
  }
}

function dispatchSysRuntimeFrame(ctx: SocketCtx, f: OutboundWire): boolean {
  switch (f.type) {
    case "sys.cold_start": {
      const cold = f as ColdStartWire;
      const firstSess = ctx.sessions.values().next().value;
      const sess = (cold.peer?.id ? ctx.sessions.get(cold.peer.id) : undefined) ?? firstSess;
      if (sess) {
        sess._isFirstTurnAfterReady = true;
        resetAgentFrameSeqCursorsForSession(sess, {
          onResetKey: (sessionKey) => ctx.noteAuthoritativeFrameSeqReset(sess, { sessionKey }),
        });
        ctx.deps.persistSession?.(sess.id);
      }
      return true;
    }
    case "sys.frontend_build":
      appUpdate.onServerBuild((f as { build?: unknown }).build);
      return true;
    case "sys.incident":
      incidentStore.ingest(f as IncidentWire);
      return true;
    case "sys.muse_result": {
      const sessionId = (f as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && ctx.sessions.has(sessionId)) {
        void Promise.resolve(ctx.deps.syncSession?.(sessionId)).catch((err) => {
          void err;
        });
      }
      return true;
    }
    case "sys.media_job":
      ctx.deps.onMediaJob?.(f as MediaJobWire);
      return true;
    case "sys.studio_event": {
      const frame = f as StudioEventWire;
      if (typeof frame.projectId === "string") emitStudioPush(frame.projectId);
      return true;
    }
    case "sys.relay_ready":
      handleRelayReadyFrame(ctx, f as RelayReadyWire);
      return true;
    default:
      return false;
  }
}

function dispatchSysContextAndControlFrame(ctx: SocketCtx, f: OutboundWire): void {
  switch (f.type) {
    case "sys.recovery_decision":
      applyRecoveryDecisionFrame(ctx, f as RecoveryDecisionWire);
      return;
    case "sys.recovery_status": {
      const frame = f as RecoveryStatusWire;
      const sess = ctx.sessions.get(frame.peer?.id);
      if (sess && applyRecoveryStatusFrame(sess, frame)) ctx.scheduleNotify();
      return;
    }
    case "sys.context_rebuilt": {
      const frame = f as ContextRebuiltWire;
      const sess = frame.peer?.id ? ctx.sessions.get(frame.peer.id) : undefined;
      if (!sess) return;
      const row = contextRebuiltRow(sess, frame);
      if (!row) return;
      addMessage(sess, "system", row.text, { id: row.id, _source: "local" });
      ctx.deps.persistSession?.(sess.id);
      ctx.scheduleNotify();
      return;
    }
    case "session.context_pressure":
      ctx.contextCompact.handleContextPressure(f as SessionContextPressureWire);
      return;
    case "sys.context_compacted":
      ctx.contextCompact.handleContextCompacted(f as SysContextCompactedWire);
      return;
    case "outbound.session_compact_result":
      ctx.contextCompact.handleCompactResult(f as OutboundSessionCompactResultWire);
      return;
    case "sys.goal_snapshot": {
      const frame = f as GoalSnapshotWire;
      ctx.setGoalState(frame.goal.sessionId, frame.goal);
      return;
    }
    case "outbound.ack":
      handleOutboundAckFrame(ctx, f as AckWire);
      return;
    case "outbound.model_switch.prepared":
      ctx.contextCompact.handleModelSwitchPrepared(f as OutboundModelSwitchPreparedWire);
      return;
    case "outbound.control.receipt":
      applyControlReceiptFrame(ctx, f as OutboundControlReceiptWire);
      return;
    case "outbound.control.session_repo_status": {
      const frame = f as RepoStatusWire;
      ctx.maybeClearPendingRepoBind(frame.sessionId, frame.selectionVersion);
      ctx.deps.onRepoStatus?.(frame);
      return;
    }
    case "outbound.control.session_repo_bind_error": {
      const frame = f as RepoBindErrorWire;
      ctx.maybeClearPendingRepoBind(frame.sessionId, frame.selectionVersion);
      ctx.deps.onRepoBindError?.(frame);
      return;
    }
    default:
      return;
  }
}

export function dispatchOutboundFrame(ctx: SocketCtx, f: OutboundWire): void {
  if (dispatchTurnStreamFrame(ctx, f)) return;
  if (dispatchTurnErrorFrame(ctx, f)) return;
  if (dispatchBillingFrame(ctx, f)) return;
  if (dispatchPermissionAndSnapshotFrame(ctx, f)) return;
  if (dispatchSysRuntimeFrame(ctx, f)) return;
  dispatchSysContextAndControlFrame(ctx, f);
}
