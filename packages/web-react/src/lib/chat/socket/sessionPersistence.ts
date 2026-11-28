import { AUTOMATIC_TURN_RETRY_MAX, isClientMessageId } from "@openclaude/protocol/browser";
import type { StoredPendingDispatch, StoredSession } from "../../persist";
import { hydrateStoredControls, stripTransientControlFlags } from "../controlReceipts";
import { type ChatMessage, type ChatSession, createSession, rebuildIndexes } from "../model";
import { repairPostFinalProcessOrder } from "../order";
import {
  type DeferredTerminalErrorPaint,
  isSettledPermissionRequestId,
  normalizeDelegateCards,
  normalizeGoalCards,
} from "../reducer";
import { carryLegacySizeRequestReferences } from "../render";
import {
  deferredTerminalErrorPaintForStore,
  restoreRejectedNoticeMetadata,
  validRecoveryRejectedNotices,
} from "../socketRecoveryHelpers";
import { normalizeRetiredRouting } from "./pureHelpers";
import {
  RECOVERY_DECISION_GRACE_MS,
  type PendingRecoveryErrorEntry,
  type SocketCtx,
} from "./types";

function shouldStripMessageForStore(message: ChatMessage): boolean {
  if (message._genPlaceholder) return true;
  if (message._timelineRecord === true || message._turnTapeProcess === true) return true;
  if (typeof message._turnTapeProcessLoadedFrom === "string") return true;
  if (typeof message._historyPageLoadedFrom === "string") return true;
  if (typeof message.id === "string") {
    if (message.id.startsWith("projection-") || message.id.startsWith("oc-dispatch-err:")) {
      return true;
    }
  }
  return Boolean((message as ChatMessage & { _historyProjection?: unknown })._historyProjection);
}

function stripLocalSrcFromMedia(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m._media?.some((r) => r.localSrc))) return messages;
  return messages.map((m) => {
    if (!m._media?.some((r) => r.localSrc)) return m;
    return {
      ...m,
      _media: m._media.map((r) => {
        if (!r.localSrc) return r;
        const { localSrc: _localSrc, ...rest } = r;
        void _localSrc;
        return rest;
      }),
    };
  });
}

function stripExpandedAndPaintTransientFields(messages: ChatMessage[]): ChatMessage[] {
  let result = messages;
  if (result.some((message) => message._turnTapeProcessExpanded)) {
    result = result.map((message) => {
      if (!message._turnTapeProcessExpanded) return message;
      const {
        _turnTapeProcessExpanded: _expanded,
        _turnTapeProcessCursor: _cursor,
        ...clean
      } = message;
      void _expanded;
      void _cursor;
      return clean;
    });
  }
  if (result.some((message) => message._firstTextPaintProbe !== undefined)) {
    result = result.map((message) => {
      if (message._firstTextPaintProbe === undefined) return message;
      const { _firstTextPaintProbe: _probe, ...clean } = message;
      void _probe;
      return clean;
    });
  }
  return result;
}

export function prepareMessagesForStoredSession(rawMessages: ChatMessage[]): ChatMessage[] {
  let messages = rawMessages.some(shouldStripMessageForStore)
    ? rawMessages.filter((message) => !shouldStripMessageForStore(message))
    : rawMessages;
  messages = stripExpandedAndPaintTransientFields(messages);
  messages = stripLocalSrcFromMedia(messages);
  return stripTransientControlFlags(messages);
}

export function buildStoredSessionPreDecisionFields(s: ChatSession): Partial<StoredSession> {
  const validContainerId =
    typeof s._frameSeqContainerId === "number" &&
    Number.isSafeInteger(s._frameSeqContainerId) &&
    s._frameSeqContainerId > 0;
  return {
    _lastFrameSeqByKey: s._lastFrameSeqByKey ? { ...s._lastFrameSeqByKey } : undefined,
    _lastFrameSeq: s._lastFrameSeq,
    ...(validContainerId ? { _frameSeqContainerId: s._frameSeqContainerId } : {}),
    ...(s._snapshotStream ? { _snapshotStream: { ...s._snapshotStream } } : {}),
    ...(s._sendingInFlight ? { _sendingInFlight: true } : {}),
    ...(s._sendingInFlight && isClientMessageId(s._activeClientMessageId)
      ? { _activeClientMessageId: s._activeClientMessageId }
      : {}),
    ...(s._sendingInFlight && s._activeAgentId ? { _activeAgentId: s._activeAgentId } : {}),
    ...(s._dispatchPaused ? { _dispatchPaused: true } : {}),
    ...(s._cancelledAutomaticRecoveryIds
      ? { _cancelledAutomaticRecoveryIds: { ...s._cancelledAutomaticRecoveryIds } }
      : {}),
    ...(s._settledPermissionRequestIds
      ? { _settledPermissionRequestIds: { ...s._settledPermissionRequestIds } }
      : {}),
  };
}

function buildStoredSessionTimeAndCursorFields(s: ChatSession): Partial<StoredSession> {
  return {
    ...(typeof s._turnStartedAt === "number" ? { _turnStartedAt: s._turnStartedAt } : {}),
    ...(typeof s._lastFrameAt === "number" ? { _lastFrameAt: s._lastFrameAt } : {}),
    _maxSeq: s._maxSeq,
    ...(typeof s._historyRevision === "number" ? { _historyRevision: s._historyRevision } : {}),
    ...(typeof s._archivedThroughSeq === "number" ? { _archivedThroughSeq: s._archivedThroughSeq } : {}),
    ...(typeof s._archivedCount === "number" ? { _archivedCount: s._archivedCount } : {}),
    _trackerResetAt: typeof s._trackerResetAt === "number" ? s._trackerResetAt : undefined,
    _trackerResetServerTs:
      typeof s._trackerResetServerTs === "number" ? s._trackerResetServerTs : undefined,
    _localTeardownAt: typeof s._localTeardownAt === "number" ? s._localTeardownAt : undefined,
    _agentSwitchedAt:
      typeof s._agentSwitchedAt === "number" ? s._agentSwitchedAt : s._agentSwitchedAt ?? undefined,
  };
}

export function buildStoredSessionPostDecisionFields(
  s: ChatSession,
  pendingDeferred: PendingRecoveryErrorEntry | undefined,
): Partial<StoredSession> {
  const pendingDeferredId = pendingDeferred?.clientMessageId;
  const deferredTerminalErrorId = isClientMessageId(s._deferredTerminalErrorClientMessageId)
    ? s._deferredTerminalErrorClientMessageId
    : isClientMessageId(pendingDeferredId)
      ? pendingDeferredId
      : undefined;
  const deferredTerminalErrorPaint = deferredTerminalErrorPaintForStore(pendingDeferred?.paint);
  return {
    ...(s._recoveryRejectedNotices
      ? { _recoveryRejectedNotices: validRecoveryRejectedNotices(s._recoveryRejectedNotices) }
      : {}),
    ...(deferredTerminalErrorId ? { _deferredTerminalErrorClientMessageId: deferredTerminalErrorId } : {}),
    ...(deferredTerminalErrorId && deferredTerminalErrorPaint
      ? { _deferredTerminalErrorPaint: deferredTerminalErrorPaint }
      : {}),
    ...buildStoredSessionTimeAndCursorFields(s),
    ...(s._lastRouting ? { _lastRouting: { ...s._lastRouting } } : {}),
    ...(s._selectedModelId ? { _selectedModelId: s._selectedModelId } : {}),
    ...(s._preparedModelSwitch ? { _preparedModelSwitch: { ...s._preparedModelSwitch } } : {}),
  };
}

function mergeStoredIntoExistingSession(
  ctx: SocketCtx,
  existing: ChatSession,
  stored: StoredSession,
): void {
  let changed = restoreRejectedNoticeMetadata(existing, stored);
  const referenced = carryLegacySizeRequestReferences(existing.messages, stored.messages ?? []);
  if (referenced !== existing.messages) {
    existing.messages = referenced;
    changed = true;
  }
  const raw = stored._automaticRecoveryDecisions;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const decisions = Object.fromEntries(
      Object.entries(raw).filter(([source, value]) => isClientMessageId(source) && value === true),
    );
    if (Object.keys(decisions).some((key) => existing._automaticRecoveryDecisions?.[key] !== true)) {
      existing._automaticRecoveryDecisions = {
        ...(existing._automaticRecoveryDecisions ?? {}),
        ...decisions,
      };
      changed = true;
    }
  }
  const storedRows = Array.isArray(stored.messages) ? stored.messages : [];
  const attempted = new Set(
    storedRows
      .filter((row) => row?.role === "user" && isClientMessageId(row.id) && row._automaticRecoveryAttempted === true)
      .map((row) => row.id),
  );
  for (const row of existing.messages) {
    if (row.role === "user" && attempted.has(row.id) && row._automaticRecoveryAttempted !== true) {
      row._automaticRecoveryAttempted = true;
      changed = true;
    }
  }
  const hydratedControls = hydrateStoredControls(
    existing,
    stored._pendingControls,
    isSettledPermissionRequestId,
    (item) => ctx.enqueueControl(item, true),
  );
  if (hydratedControls) changed = true;
  if (changed) {
    ctx.deps.persistSession?.(stored.id);
    ctx.scheduleNotify();
  }
}

function sanitizeStoredMessagesOnLoad(rawMessages: unknown): ChatMessage[] {
  if (!Array.isArray(rawMessages)) return [];
  const filtered = (rawMessages as ChatMessage[])
    .filter(
      (message) =>
        !(typeof message.id === "string" && message.id.startsWith("projection-")) &&
        !(typeof message.id === "string" && message.id.startsWith("oc-dispatch-err:")) &&
        message._timelineRecord !== true &&
        message._turnTapeProcess !== true &&
        typeof message._historyPageLoadedFrom !== "string" &&
        !(message as ChatMessage & { _historyProjection?: unknown })._historyProjection,
    )
    .map((message) => {
      const routing = normalizeRetiredRouting(message._routing);
      return routing !== message._routing ? { ...message, _routing: routing } : message;
    });
  return stripTransientControlFlags(filtered);
}

function extractValidStoredDispatches(stored: StoredSession): StoredPendingDispatch[] {
  if (!Array.isArray(stored._pendingDispatches)) return [];
  return stored._pendingDispatches.filter(
    (item) =>
      Boolean(item) &&
      isClientMessageId(item.msgId) &&
      item.payload?.type === "inbound.message" &&
      item.payload.clientMessageId === item.msgId &&
      item.payload.peer?.id === stored.id,
  );
}

function applyStoredCursorsAndInFlight(
  s: ChatSession,
  stored: StoredSession,
  restoredExactInFlight: boolean,
): void {
  s.lastAt = typeof stored.lastAt === "number" ? stored.lastAt : s.lastAt;
  s.updatedAt = stored.updatedAt;
  s._lastFrameSeqByKey = stored._lastFrameSeqByKey ? { ...stored._lastFrameSeqByKey } : {};
  s._lastFrameSeq = stored._lastFrameSeq;
  if (
    typeof stored._frameSeqContainerId === "number" &&
    Number.isSafeInteger(stored._frameSeqContainerId) &&
    stored._frameSeqContainerId > 0
  ) {
    s._frameSeqContainerId = stored._frameSeqContainerId;
  }
  if (
    typeof stored._snapshotStream?.streamKey === "string" &&
    typeof stored._snapshotStream.agentId === "string"
  ) {
    s._snapshotStream = { ...stored._snapshotStream };
  }
  s._maxSeq = stored._maxSeq;
  s._historyRevision = stored._historyRevision;
  if (typeof stored._archivedThroughSeq === "number") s._archivedThroughSeq = stored._archivedThroughSeq;
  if (typeof stored._archivedCount === "number") s._archivedCount = stored._archivedCount;
  s._streamingAssistant = null;
  s._streamingThinking = null;
  s._sendingInFlight = restoredExactInFlight;
  if (restoredExactInFlight) {
    s._activeClientMessageId = stored._activeClientMessageId;
    s._activeAgentId =
      typeof stored._activeAgentId === "string" && stored._activeAgentId
        ? stored._activeAgentId
        : undefined;
    s._turnStartedAt = typeof stored._turnStartedAt === "number" ? stored._turnStartedAt : Date.now();
    s._lastFrameAt = typeof stored._lastFrameAt === "number" ? stored._lastFrameAt : undefined;
  }
}

function applyStoredFencesAndRouting(s: ChatSession, stored: StoredSession): void {
  s._dispatchPaused = stored._dispatchPaused === true;
  s._cancelledAutomaticRecoveryIds =
    stored._cancelledAutomaticRecoveryIds && typeof stored._cancelledAutomaticRecoveryIds === "object"
      ? { ...stored._cancelledAutomaticRecoveryIds }
      : undefined;
  s._settledPermissionRequestIds =
    stored._settledPermissionRequestIds && typeof stored._settledPermissionRequestIds === "object"
      ? { ...stored._settledPermissionRequestIds }
      : undefined;
  restoreRejectedNoticeMetadata(s, stored);
  s._automaticRecoveryDecisions =
    stored._automaticRecoveryDecisions && typeof stored._automaticRecoveryDecisions === "object"
      ? { ...stored._automaticRecoveryDecisions }
      : undefined;
  s._trackerResetAt = typeof stored._trackerResetAt === "number" ? stored._trackerResetAt : undefined;
  s._trackerResetServerTs =
    typeof stored._trackerResetServerTs === "number" ? stored._trackerResetServerTs : undefined;
  s._localTeardownAt = typeof stored._localTeardownAt === "number" ? stored._localTeardownAt : undefined;
  s._agentSwitchedAt = typeof stored._agentSwitchedAt === "number" ? stored._agentSwitchedAt : null;
  const restoredRouting = normalizeRetiredRouting(stored._lastRouting);
  s._lastRouting = restoredRouting ? { ...restoredRouting } : undefined;
  if (typeof stored._selectedModelId === "string" && stored._selectedModelId) {
    s._selectedModelId = stored._selectedModelId;
  }
  if (
    stored._preparedModelSwitch &&
    typeof stored._preparedModelSwitch.id === "string" &&
    typeof stored._preparedModelSwitch.targetModel === "string"
  ) {
    s._preparedModelSwitch = { ...stored._preparedModelSwitch };
  }
}

function isValidStoredDeferredPaint(
  cmid: unknown,
  paint: StoredSession["_deferredTerminalErrorPaint"],
): cmid is string {
  if (!isClientMessageId(cmid) || !paint) return false;
  if (typeof paint.normalized !== "string" || typeof paint.text !== "string") return false;
  if (paint.normalized.length === 0 || paint.normalized.length > 64) return false;
  return paint.text.length > 0 && paint.text.length <= 4000;
}

export function restoreDeferredTerminalErrorFromStored(
  ctx: SocketCtx,
  s: ChatSession,
  stored: StoredSession,
): void {
  const cmid = stored._deferredTerminalErrorClientMessageId;
  const paint = stored._deferredTerminalErrorPaint;
  if (!isValidStoredDeferredPaint(cmid, paint) || !paint) return;
  if (s._cancelledAutomaticRecoveryIds?.[cmid] === true) return;
  if (s._automaticRecoveryDecisions?.[cmid] === true) return;
  s._deferredTerminalErrorClientMessageId = cmid;
  if (!s._sendingInFlight) {
    s._sendingInFlight = true;
    s._activeClientMessageId = cmid;
  }
  const source = s.messages.find((message) => message.role === "user" && message.id === cmid);
  const validSourceAttempt =
    typeof source?._automaticRecoveryAttempt === "number" &&
    Number.isSafeInteger(source._automaticRecoveryAttempt) &&
    source._automaticRecoveryAttempt >= 1;
  const sourceAttempt = validSourceAttempt ? source!._automaticRecoveryAttempt! : 0;
  s._turnStatus = {
    kind: "retrying",
    attempt: Math.min(sourceAttempt + 1, AUTOMATIC_TURN_RETRY_MAX),
    max: AUTOMATIC_TURN_RETRY_MAX,
    retryAt: Date.now(),
  };
  const restored: DeferredTerminalErrorPaint = {
    normalized: paint.normalized,
    text: paint.text,
    ...(typeof paint.detail === "string" ? { detail: paint.detail } : {}),
    ...(typeof paint.displayMessage === "string" ? { displayMessage: paint.displayMessage } : {}),
    clientMessageId: isClientMessageId(paint.clientMessageId) ? paint.clientMessageId : cmid,
    ...(typeof paint.traceId === "string" ? { traceId: paint.traceId } : {}),
  };
  const timer = setTimeout(
    () => ctx.verifyDeferredRecovery(s.id, "decision_timeout"),
    RECOVERY_DECISION_GRACE_MS,
  );
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  ctx.pendingRecoveryErrors.set(s.id, {
    paint: restored,
    clientMessageId: cmid,
    timer,
    decided: false,
  });
}

export function loadStoredSessionIntoSocket(ctx: SocketCtx, stored: StoredSession): void {
  if (!stored?.id) return;
  const existing = ctx.sessions.get(stored.id);
  if (existing) {
    mergeStoredIntoExistingSession(ctx, existing, stored);
    return;
  }
  const s = createSession({
    id: stored.id,
    agentId: stored.agentId || ctx.deps.defaultAgentId || "main",
    title: stored.title,
    createdAt: stored.createdAt,
  });
  s.messages = sanitizeStoredMessagesOnLoad(stored.messages);
  const storedPending = extractValidStoredDispatches(stored);
  const restoredExactInFlight =
    storedPending.length === 0 &&
    stored._sendingInFlight === true &&
    isClientMessageId(stored._activeClientMessageId);
  applyStoredCursorsAndInFlight(s, stored, restoredExactInFlight);
  applyStoredFencesAndRouting(s, stored);
  for (const pending of storedPending) {
    ctx.offlineQueue.push({
      sessId: stored.id,
      payload: pending.payload,
      msgId: pending.msgId,
      enqueuedAt: Number.isFinite(pending.enqueuedAt) ? pending.enqueuedAt : pending.payload.ts,
      state: "queued",
    });
    const user = s.messages.find((message) => message.role === "user" && message.id === pending.msgId);
    if (user) user.status = "queued";
  }
  ctx.offlineQueue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  rebuildIndexes(s);
  normalizeDelegateCards(s);
  normalizeGoalCards(s);
  let repairedStoredOrder = false;
  if (!restoredExactInFlight) {
    const repairedStoredMessages = repairPostFinalProcessOrder(s.messages);
    repairedStoredOrder = repairedStoredMessages !== s.messages;
    if (repairedStoredOrder) s.messages = repairedStoredMessages;
  }
  ctx.sessions.set(stored.id, s);
  ctx.reconcileContainerForSession(s);
  restoreDeferredTerminalErrorFromStored(ctx, s, stored);
  hydrateStoredControls(s, stored._pendingControls, isSettledPermissionRequestId, (item) =>
    ctx.enqueueControl(item, true),
  );
  if (repairedStoredOrder) ctx.deps.persistSession?.(stored.id);
  if (restoredExactInFlight) ctx.armSnapshotWatchdog();
  if (storedPending.length > 0 && !s._dispatchPaused) ctx.kickDispatchPump();
  ctx.scheduleNotify();
}

export function pruneProblemCardStateForSession(ctx: SocketCtx, sessId: string): void {
  const prefix = `${sessId}:`;
  for (const key of ctx.reportedProblemCards) {
    if (key.startsWith(prefix)) ctx.reportedProblemCards.delete(key);
  }
  for (const key of ctx.problemCardSourceCodes.keys()) {
    if (key.startsWith(prefix)) ctx.problemCardSourceCodes.delete(key);
  }
}

export function removeSessionState(ctx: SocketCtx, sessId: string): void {
  ctx.serverSessionEnsured.delete(sessId);
  ctx.serverSessionInflight.delete(sessId);
  ctx.dispatchSlots.delete(sessId);
  const removed = ctx.offlineQueue.filter((item) => item.sessId === sessId);
  ctx.offlineQueue = ctx.offlineQueue.filter((item) => item.sessId !== sessId);
  for (const item of removed) {
    void ctx.deps.deletePendingDispatch?.(sessId, item.msgId).catch((err) => {
      void err;
    });
  }
  const removedControls = ctx.controlQueue.filter((item) => item.sessId === sessId);
  ctx.controlQueue = ctx.controlQueue.filter((item) => item.sessId !== sessId);
  for (const item of removedControls) {
    const retryTimer = ctx.controlPersistRetryTimers.get(item.controlId);
    if (retryTimer) clearTimeout(retryTimer);
    ctx.controlPersistRetryTimers.delete(item.controlId);
    void ctx.deps.deletePendingControl?.(sessId, item.controlId).catch((err) => {
      void err;
    });
  }
  ctx.clearUnpublishedTapeRetry(sessId);
  ctx.degradedJournalRetries.clear(sessId);
  ctx.durableLiveJournalCheckpoints.delete(sessId);
  const safeId = String(sessId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffix = `:webchat:dm:${safeId}`;
  for (const key of ctx.authoritativeFrameSeqResetEpochBySessionKey.keys()) {
    if (key === `peer:${sessId}` || key.endsWith(suffix)) {
      ctx.authoritativeFrameSeqResetEpochBySessionKey.delete(key);
    }
  }
  ctx.maybePromoteToConnected();
  ctx.pendingRepoBind.delete(sessId);
  ctx.contextCompact.cancelCompactsForSession(sessId);
  ctx.transientNotices.delete(sessId);
  const pendingRecoveryError = ctx.pendingRecoveryErrors.get(sessId);
  if (pendingRecoveryError) {
    clearTimeout(pendingRecoveryError.timer);
    ctx.pendingRecoveryErrors.delete(sessId);
  }
  pruneProblemCardStateForSession(ctx, sessId);
  ctx.lastSyncAt.delete(sessId);
  ctx.subscribedSessions.delete(sessId);
  ctx.snapshotAckAt.delete(sessId);
  ctx.wsSnapshotAt.delete(sessId);
  ctx.helloAskedCmid.delete(sessId);
  ctx.metaTracker.removeSession(sessId);
  if (ctx.sessions.delete(sessId)) ctx.scheduleNotify();
}

export function resetAllSessionsState(ctx: SocketCtx): void {
  ctx.lifecycleEpoch += 1;
  ctx.serverSessionEnsured.clear();
  ctx.serverSessionInflight.clear();
  ctx.dispatchSlots.clear();
  ctx.offlineQueue = [];
  ctx.controlQueue = [];
  ctx.pendingRepoBind.clear();
  ctx.transientNotices.clear();
  ctx.firstTextPaintTraceIds.clear();
  ctx.lastSyncAt.clear();
  ctx.durableLiveJournalCheckpoints.clear();
  ctx.durableHydrationStates.clear();
  ctx.durableHydrationTails.clear();
  ctx.snapshotHttpInFlight.clear();
  ctx.swarmResyncInFlight.clear();
  ctx.restoreBannerOwners = null;
  ctx.automaticRecoveryPending.clear();
  ctx.authoritativeFrameSeqResetEpochBySessionKey.clear();
  for (const state of ctx.unpublishedTapeRetries.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  ctx.unpublishedTapeRetries.clear();
  ctx.degradedJournalRetries.clearAll();
  for (const timer of ctx.controlPersistRetryTimers.values()) clearTimeout(timer);
  ctx.controlPersistRetryTimers.clear();
  for (const pending of ctx.pendingRecoveryErrors.values()) clearTimeout(pending.timer);
  ctx.pendingRecoveryErrors.clear();
  ctx.reportedProblemCards.clear();
  ctx.problemCardSourceCodes.clear();
  ctx.subscribedSessions.clear();
  ctx.helloSentAt.clear();
  ctx.snapshotAckAt.clear();
  ctx.wsSnapshotAt.clear();
  ctx.helloAskedCmid.clear();
  ctx.metaTracker.reset();
  ctx.activeSessionId = undefined;
  if (ctx.sessions.size === 0) return;
  ctx.sessions.clear();
  ctx.scheduleNotify();
}
