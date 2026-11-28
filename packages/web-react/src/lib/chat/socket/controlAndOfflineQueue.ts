import type { StoredPendingControl } from "../../persist";
import {
  applyControlReceipt,
  type PendingControlItem,
  persistControlWithFallback,
} from "../controlReceipts";
import type { OutboundControlReceiptWire } from "../frames";
import {
  type ChatMessage,
  type ChatSession,
  clearTurnTiming,
  mintMsgId,
  resetReplyTracker,
} from "../model";
import {
  authorizeQueuedModelSwitch,
  commitAuthorizedModelSwitchDispatch,
} from "../modelSwitchCostDispatch";
import { rememberSettledPermissionRequestId } from "../reducer";
import { stableControlId } from "./pureHelpers";
import type { OfflineItem, PendingRecoveryErrorEntry, SocketCtx } from "./types";

export function tryEnqueueOfflineItem(ctx: SocketCtx, item: OfflineItem): boolean {
  if (
    ctx.offlineQueue.some(
      (candidate) => candidate.sessId === item.sessId && candidate.msgId === item.msgId,
    )
  ) {
    return true;
  }
  ctx.offlineQueue.push(item);
  ctx.offlineQueue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  return true;
}

export function resetUnadmittedDispatchesForReplayInSocket(ctx: SocketCtx): void {
  const touched = new Set<string>();
  for (const item of ctx.offlineQueue) {
    if (item.state !== "awaiting_admission") continue;
    item.state = "queued";
    touched.add(item.sessId);
    const sess = ctx.sessions.get(item.sessId);
    if (sess?._activeClientMessageId === item.msgId) {
      sess._sendingInFlight = false;
      sess._activeClientMessageId = undefined;
      clearTurnTiming(sess);
    }
  }
  if (touched.size === 0) return;
  for (const sessId of touched) ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
}

function setUserRowStatus(ctx: SocketCtx, item: OfflineItem, status: "queued" | "sending"): void {
  const user = ctx.sessions
    .get(item.sessId)
    ?.messages.find((message) => message.role === "user" && message.id === item.msgId);
  if (!user || user.status === status) return;
  user.status = status;
  ctx.scheduleNotify();
}

function sendPersistedDispatchItem(ctx: SocketCtx, item: OfflineItem): void {
  if (!ctx.offlineQueue.includes(item) || item.state !== "persisting") return;
  const transportReady = Boolean(ctx.ws && ctx.ws.readyState === 1 && ctx.relayReady);
  if (
    !transportReady ||
    ctx.dispatchSlots.get(item.sessId) !== item.msgId ||
    !ctx.safeWsSend(JSON.stringify(item.payload))
  ) {
    item.state = "queued";
    setUserRowStatus(ctx, item, "queued");
    return;
  }
  item.state = "awaiting_admission";
  const sess = ctx.sessions.get(item.sessId);
  if (!sess) return;
  sess._activeClientMessageId = item.msgId;
  sess._activeAgentId =
    typeof item.payload.agentId === "string" && item.payload.agentId
      ? item.payload.agentId
      : sess.agentId;
  if (!sess._sendingInFlight) {
    sess._sendingInFlight = true;
    sess._turnStartedAt = Date.now();
    sess._streamingAssistant = null;
    sess._streamingThinking = null;
  }
  ctx.clearTransientNotice(sess.id);
  ctx.scheduleNotify();
  ctx.deps.persistSession?.(sess.id);
}

function persistAuthorizedDispatchItem(ctx: SocketCtx, item: OfflineItem): void {
  commitAuthorizedModelSwitchDispatch(
    item,
    ctx.offlineQueue,
    () =>
      ctx.deps.persistPendingDispatch?.(item.sessId, {
        msgId: item.msgId,
        payload: item.payload,
        enqueuedAt: item.enqueuedAt,
      }),
    () => sendPersistedDispatchItem(ctx, item),
    () => {
      if (!ctx.offlineQueue.includes(item) || item.state !== "persisting") return;
      sendPersistedDispatchItem(ctx, item);
    },
  );
}

export function pumpPendingDispatchesFlow(ctx: SocketCtx): void {
  if (!ctx.ws || ctx.ws.readyState !== 1 || !ctx.relayReady) return;
  for (const item of ctx.offlineQueue) {
    if (item.state !== "queued") continue;
    const sess = ctx.sessions.get(item.sessId);
    if (!sess || sess._dispatchPaused) continue;
    const slot = ctx.dispatchSlots.get(item.sessId);
    if (slot !== undefined && slot !== item.msgId) continue;
    if (sess._sendingInFlight && sess._activeClientMessageId !== item.msgId) continue;
    ctx.dispatchSlots.set(item.sessId, item.msgId);
    item.state = "persisting";
    setUserRowStatus(ctx, item, "sending");
    if (ctx.deps.authorizeSwitch && item.payload.model && !item.payload.content.imageEdit) {
      void authorizeQueuedModelSwitch(item, ctx.deps.authorizeSwitch, {
        queue: ctx.offlineQueue,
        slots: ctx.dispatchSlots,
        sessions: ctx.sessions,
        clear: (sid, id) => ctx.clearPendingDispatch(sid, id),
        notice: (sid, text) => ctx.setTransientNotice(sid, text),
        persist: ctx.deps.persistSession,
        notify: () => ctx.scheduleNotify(),
      }).then((ok) => {
        if (ok) persistAuthorizedDispatchItem(ctx, item);
      });
    } else {
      persistAuthorizedDispatchItem(ctx, item);
    }
  }
}

export function kickDispatchPumpFlow(ctx: SocketCtx): void {
  if (ctx.dispatchPumpScheduled) return;
  ctx.dispatchPumpScheduled = true;
  try {
    pumpPendingDispatchesFlow(ctx);
  } finally {
    ctx.dispatchPumpScheduled = false;
  }
}

export function persistControlItem(ctx: SocketCtx, item: PendingControlItem): void {
  persistControlWithFallback(item, {
    queue: ctx.controlQueue,
    sessions: ctx.sessions,
    timers: ctx.controlPersistRetryTimers,
    persist: ctx.deps.persistPendingControl,
    pump: () => ctx.kickControlPump(),
    retry: (next) => persistControlItem(ctx, next),
    notify: () => ctx.scheduleNotify(),
  });
}

export function enqueueControlItem(
  ctx: SocketCtx,
  item: PendingControlItem,
  alreadyPersisted = false,
): void {
  if (ctx.controlQueue.some((candidate) => candidate.controlId === item.controlId)) return;
  ctx.controlQueue.push(item);
  ctx.controlQueue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  if (alreadyPersisted) {
    item.status = "queued";
    ctx.kickControlPump();
    return;
  }
  persistControlItem(ctx, item);
}

export function resetControlsForReplayInSocket(ctx: SocketCtx): void {
  for (const item of ctx.controlQueue) {
    if (item.status === "awaiting_receipt" || item.status === "persisted") {
      item.status = "queued";
    }
  }
}

export function kickControlPumpFlow(ctx: SocketCtx): void {
  if (ctx.controlPumpScheduled) return;
  ctx.controlPumpScheduled = true;
  try {
    if (!ctx.ws || ctx.ws.readyState !== 1 || !ctx.relayReady) return;
    for (let index = 0; index < ctx.controlQueue.length; index += 1) {
      const item = ctx.controlQueue[index]!;
      if (item.status !== "queued") continue;
      const blockedByEarlier = ctx.controlQueue
        .slice(0, index)
        .some(
          (earlier) =>
            earlier.sessId === item.sessId &&
            (earlier.status === "persisting" || earlier.status === "waiting_persist"),
        );
      if (blockedByEarlier) continue;
      item.attempt += 1;
      if (!ctx.safeWsSend(JSON.stringify(item.payload))) {
        item.attempt -= 1;
        break;
      }
      item.status = "awaiting_receipt";
      const sess = ctx.sessions.get(item.sessId);
      if (sess?._stopSettlement?.controlId === item.controlId) {
        sess._stopSettlement.phase = "awaiting_receipt";
        sess._recoveryStatus = { kind: "stopping", attempt: item.attempt };
      }
    }
    ctx.scheduleNotify();
  } finally {
    ctx.controlPumpScheduled = false;
  }
}

export function settleControlItem(
  ctx: SocketCtx,
  controlId: string,
  status: "applied" | "terminal",
): void {
  const index = ctx.controlQueue.findIndex((item) => item.controlId === controlId);
  if (index < 0) return;
  const [item] = ctx.controlQueue.splice(index, 1);
  if (!item) return;
  const retryTimer = ctx.controlPersistRetryTimers.get(controlId);
  if (retryTimer) clearTimeout(retryTimer);
  ctx.controlPersistRetryTimers.delete(controlId);
  const durableClear = ctx.deps.deletePendingControl?.(item.sessId, controlId);
  if (durableClear) {
    void durableClear.catch((err) => {
      void err;
    });
  }
  const sess = ctx.sessions.get(item.sessId);
  if (!sess) return;
  if (item.controlKind === "stop" && item.fenceOnly === true) {
    ctx.scheduleNotify();
    return;
  }
  if (item.controlKind === "stop") {
    ctx.finishDispatch(sess.id, item.clientMessageId);
    ctx.metaTracker.clearStopTimeout(sess.id);
    sess._stopSettlement = undefined;
    ctx.clearSendingState(sess);
  } else if (item.requestId) {
    rememberSettledPermissionRequestId(sess, item.requestId);
    const permission = sess.messages.find((message) => message.requestId === item.requestId);
    if (permission) {
      permission._resolved = true;
      permission._behavior = item.behavior;
      permission._controlPending = false;
    }
  }
  sess._recoveryStatus = {
    kind: item.controlKind === "permission" ? "resumed" : "completed",
  };
  ctx.deps.persistSession?.(sess.id);
  ctx.scheduleNotify();
  if (status === "applied") ctx.reconcileSession(sess.id);
}

export function applyControlReceiptFrame(ctx: SocketCtx, frame: OutboundControlReceiptWire): void {
  applyControlReceipt(frame, {
    queue: ctx.controlQueue,
    sessions: ctx.sessions,
    settle: (id, status) => ctx.settleControl(id, status),
    persist: ctx.deps.persistSession,
    notify: () => ctx.scheduleNotify(),
    sync: ctx.deps.syncSession,
    notice: (id, text) => {
      ctx.transientNotices.set(id, { text, ts: Date.now() });
      ctx.scheduleNotify();
    },
  });
}

function stopDeferredRecoverySoftState(
  ctx: SocketCtx,
  sess: ChatSession,
  deferred: PendingRecoveryErrorEntry,
): void {
  const lineageId = deferred.clientMessageId ?? sess._activeClientMessageId;
  let rootId: string | undefined;
  if (lineageId) {
    sess._cancelledAutomaticRecoveryIds = {
      ...(sess._cancelledAutomaticRecoveryIds ?? {}),
      [lineageId]: true,
    };
    const sourceUser = sess.messages.find((m) => m.role === "user" && m.id === lineageId);
    rootId =
      sourceUser?._automaticRecoveryRootClientMessageId ?? sourceUser?._recoveryOfClientMessageId;
    if (rootId) sess._cancelledAutomaticRecoveryIds[rootId] = true;
  }
  const stopAgentId = sess._activeAgentId || sess.agentId || ctx.deps.defaultAgentId || "main";
  ctx.materializePendingRecoveryError(sess.id, "stop_fenced");
  sess._recoveryStatus = { kind: "completed" };
  const fenceId = rootId ?? lineageId;
  if (fenceId) {
    const controlId = stableControlId("stop", `${fenceId}:recovery-fence`);
    if (!ctx.controlQueue.some((item) => item.controlId === controlId)) {
      ctx.enqueueControl({
        kind: "control",
        sessId: sess.id,
        controlId,
        controlKind: "stop",
        clientMessageId: fenceId,
        agentId: stopAgentId,
        fenceOnly: true,
        payload: {
          type: "inbound.control.stop",
          controlId,
          channel: "webchat",
          peer: { id: sess.id, kind: "dm" },
          agentId: stopAgentId,
          clientMessageId: fenceId,
        },
        enqueuedAt: Date.now(),
        attempt: 0,
        status: "queued",
      });
    }
  }
  ctx.deps.persistSession?.(sess.id);
  ctx.clearTransientNotice(sess.id);
  ctx.scheduleNotify();
}

function collectStopCancelledIdsAndLineage(
  sess: ChatSession,
  pending: readonly OfflineItem[],
  activeItem: OfflineItem | undefined,
  activeUser: ChatMessage | undefined,
): Set<string> {
  const cancelIds = new Set<string>();
  if (activeItem) cancelIds.add(activeItem.msgId);
  for (const item of pending) {
    const user = sess.messages.find(
      (message) => message.role === "user" && message.id === item.msgId,
    );
    if (user?._isAutoRetry === true || user?._automaticRecovery === true) {
      cancelIds.add(item.msgId);
    }
  }
  const cancelledLineageIds = new Set<string>();
  const addLineage = (user: ChatMessage | undefined) => {
    if (!user) return;
    cancelledLineageIds.add(user.id);
    if (user._recoveryOfClientMessageId) cancelledLineageIds.add(user._recoveryOfClientMessageId);
    if (user._continuationOfClientMessageId) {
      cancelledLineageIds.add(user._continuationOfClientMessageId);
    }
  };
  addLineage(activeUser);
  for (const item of pending) {
    if (!cancelIds.has(item.msgId)) continue;
    addLineage(
      sess.messages.find((message) => message.role === "user" && message.id === item.msgId),
    );
  }
  if (cancelledLineageIds.size > 0) {
    sess._cancelledAutomaticRecoveryIds = {
      ...(sess._cancelledAutomaticRecoveryIds ?? {}),
    };
    for (const id of cancelledLineageIds) sess._cancelledAutomaticRecoveryIds[id] = true;
  }
  return cancelIds;
}

function enqueueServerStopControl(
  ctx: SocketCtx,
  sess: ChatSession,
  activeClientMessageId: string | undefined,
  activeUser: ChatMessage | undefined,
  activeItem: OfflineItem | undefined,
): void {
  const existing = ctx.controlQueue.find(
    (item) =>
      item.controlKind === "stop" &&
      item.sessId === sess.id &&
      item.clientMessageId === activeClientMessageId,
  );
  if (existing) return;
  const validAttempt =
    Number.isSafeInteger(activeUser?._sendAttempt) && (activeUser?._sendAttempt ?? 0) > 0;
  const sendAttempt = validAttempt ? activeUser!._sendAttempt! : 0;
  const stopIdentity = activeClientMessageId
    ? sendAttempt > 0
      ? `${activeClientMessageId}:attempt:${sendAttempt}`
      : activeClientMessageId
    : `peer:${sess.id}:${mintMsgId()}`;
  const controlId = stableControlId("stop", stopIdentity);
  const agentId =
    sess._activeAgentId ||
    activeItem?.payload.agentId ||
    sess.agentId ||
    ctx.deps.defaultAgentId ||
    "main";
  resetReplyTracker(sess);
  sess._localTeardownAt = sess._trackerResetAt;
  sess._sendingInFlight = true;
  sess._activeClientMessageId = activeClientMessageId;
  sess._activeAgentId = agentId;
  sess._stopSettlement = {
    ...(activeClientMessageId ? { clientMessageId: activeClientMessageId } : {}),
    controlId,
    phase: "persisting",
  };
  sess._recoveryStatus = { kind: "stopping" };
  const settlement = sess._stopSettlement;
  ctx.metaTracker.armStopTimeout(sess.id, () => {
    const cur = ctx.sessions.get(sess.id);
    if (!cur || cur._stopSettlement !== settlement) return;
    const idx = ctx.controlQueue.findIndex((i) => i.controlId === controlId);
    if (idx >= 0) ctx.controlQueue.splice(idx, 1);
    void ctx.deps.deletePendingControl?.(sess.id, controlId)?.catch((err) => {
      void err;
    });
    if (activeClientMessageId) ctx.finishDispatch(sess.id, activeClientMessageId);
    cur._stopSettlement = undefined;
    ctx.clearSendingState(cur);
    cur._recoveryStatus = { kind: "completed" };
    ctx.deps.persistSession?.(sess.id);
    ctx.scheduleNotify();
    void ctx.deps.syncSession?.(sess.id);
  });
  ctx.enqueueControl({
    kind: "control",
    sessId: sess.id,
    controlId,
    controlKind: "stop",
    ...(activeClientMessageId ? { clientMessageId: activeClientMessageId } : {}),
    agentId,
    payload: {
      type: "inbound.control.stop",
      controlId,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId,
      ...(activeClientMessageId ? { clientMessageId: activeClientMessageId } : {}),
    },
    enqueuedAt: Date.now(),
    attempt: 0,
    status: "queued",
  });
  ctx.deps.persistSession?.(sess.id);
}

function markCancelledPendingUsers(
  ctx: SocketCtx,
  sess: ChatSession,
  cancelPending: readonly OfflineItem[],
): void {
  for (const item of cancelPending) {
    ctx.clearPendingDispatch(sess.id, item.msgId);
    const user = sess.messages.find((m) => m.role === "user" && m.id === item.msgId);
    if (user && user.status !== "sent") {
      user.status = "error";
      user._sendCancelled = true;
      user._errorDetail =
        user._isAutoRetry === true || user._automaticRecovery === true
          ? "自动重试已停止"
          : "发送已取消";
    }
  }
}

export function stopTurnFlow(
  ctx: SocketCtx,
  sessId: string,
  expectedClientMessageId?: string,
): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  if (expectedClientMessageId !== undefined && sess._activeClientMessageId !== expectedClientMessageId) {
    return;
  }
  const pending = ctx.offlineQueue.filter((item) => item.sessId === sessId);
  if (!sess._sendingInFlight && pending.length === 0) return;

  const deferred = ctx.pendingRecoveryErrors.get(sessId);
  if (
    deferred &&
    pending.length === 0 &&
    (!sess._activeClientMessageId || sess._activeClientMessageId === deferred.clientMessageId)
  ) {
    stopDeferredRecoverySoftState(ctx, sess, deferred);
    return;
  }

  const activeClientMessageId =
    sess._activeClientMessageId ?? ctx.dispatchSlots.get(sessId) ?? pending[0]?.msgId;
  const activeItem = activeClientMessageId
    ? pending.find((item) => item.msgId === activeClientMessageId)
    : undefined;
  const activeUser = activeClientMessageId
    ? sess.messages.find((m) => m.role === "user" && m.id === activeClientMessageId)
    : undefined;
  const cancelIds = collectStopCancelledIdsAndLineage(sess, pending, activeItem, activeUser);
  const mayHaveReachedServer = sess._sendingInFlight || activeItem?.state === "awaiting_admission";
  const cancelPending = pending.filter(
    (item) => cancelIds.has(item.msgId) && !(mayHaveReachedServer && item.msgId === activeClientMessageId),
  );
  const preservedManual = pending.filter(
    (item) => !cancelIds.has(item.msgId) && item.msgId !== activeClientMessageId,
  );
  sess._dispatchPaused = preservedManual.length > 0;
  markCancelledPendingUsers(ctx, sess, cancelPending);

  if (mayHaveReachedServer) {
    enqueueServerStopControl(ctx, sess, activeClientMessageId, activeUser, activeItem);
  } else {
    if (activeClientMessageId) ctx.finishDispatch(sess.id, activeClientMessageId);
    ctx.dispatchSlots.delete(sess.id);
    ctx.clearSendingState(sess);
    sess._recoveryStatus = { kind: "completed" };
  }
  ctx.clearTransientNotice(sess.id);
  ctx.scheduleNotify();
}

export function respondPermissionFlow(
  ctx: SocketCtx,
  p: {
    sessId: string;
    requestId: string;
    behavior: "allow" | "deny";
    message?: string;
    updatedInput?: Record<string, unknown>;
  },
): void {
  const sess = ctx.sessions.get(p.sessId);
  if (!sess) return;
  const controlId = stableControlId("permission", `${p.requestId}:${p.behavior}`);
  if (ctx.controlQueue.some((item) => item.controlId === controlId)) return;
  const agentId = sess.agentId || ctx.deps.defaultAgentId || "main";
  const payload: StoredPendingControl["payload"] = {
    type: "inbound.permission_response",
    controlId,
    channel: "webchat",
    peer: { id: sess.id, kind: "dm" },
    agentId,
    requestId: p.requestId,
    behavior: p.behavior,
    message: p.message || undefined,
    ...(p.updatedInput && p.behavior === "allow" ? { updatedInput: p.updatedInput } : {}),
  };
  const msg = sess.messages.find((m) => m.requestId === p.requestId);
  if (msg) msg._controlPending = true;
  sess._recoveryStatus = { kind: "needs-confirmation" };
  ctx.enqueueControl({
    kind: "control",
    sessId: sess.id,
    controlId,
    controlKind: "permission",
    requestId: p.requestId,
    behavior: p.behavior,
    agentId,
    payload,
    enqueuedAt: Date.now(),
    attempt: 0,
    status: "queued",
  });
  ctx.deps.persistSession?.(sess.id);
  ctx.scheduleNotify();
}

export function flushRepoBindForSession(ctx: SocketCtx, sessId: string): void {
  const entry = ctx.pendingRepoBind.get(sessId);
  if (!entry || !ctx.ws || ctx.ws.readyState !== 1) return;
  ctx.safeWsSend(
    JSON.stringify({
      type: "inbound.control.session_repo_bind",
      sessionId: sessId,
      selectionVersion: entry.version,
      peer: { id: sessId, kind: "dm" },
      agentId: entry.agentId,
      channel: "webchat",
    }),
  );
}

export function flushAllRepoBindsOnSocket(ctx: SocketCtx): void {
  if (!ctx.ws || ctx.ws.readyState !== 1) return;
  for (const sessId of ctx.pendingRepoBind.keys()) flushRepoBindForSession(ctx, sessId);
}

export function maybeClearPendingRepoBindOnSocket(
  ctx: SocketCtx,
  sessId: string | undefined,
  version: number | undefined,
): void {
  if (!sessId) return;
  const entry = ctx.pendingRepoBind.get(sessId);
  if (entry && typeof version === "number" && version >= entry.version) {
    ctx.pendingRepoBind.delete(sessId);
  }
}

export function sendRepoBindControl(
  ctx: SocketCtx,
  sessId: string,
  agentId: string,
  version: number,
): void {
  if (!sessId) return;
  ctx.pendingRepoBind.set(sessId, { agentId, version });
  ctx.ensureSession(sessId, agentId);
  if (ctx.ws && ctx.ws.readyState === 1) ctx.sendHelloFrame(false);
  flushRepoBindForSession(ctx, sessId);
}

export function sendRepoUnbindControl(ctx: SocketCtx, sessId: string, version: number): void {
  if (!sessId) return;
  ctx.pendingRepoBind.delete(sessId);
  ctx.safeWsSend(
    JSON.stringify({
      type: "inbound.control.session_repo_unbind",
      sessionId: sessId,
      selectionVersion: version,
    }),
  );
}
