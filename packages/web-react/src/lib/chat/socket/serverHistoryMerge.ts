import { supportsAutomaticTurnRecovery } from "@openclaude/protocol/browser";
import {
  applyServerIncremental,
  detectServerTerminalTurns,
  mergeArchivedHistory,
  mergeFullServerWins,
  reconcileLateDelegateAgentGroups,
  reconcileTimelineBashTailAuxiliaries,
  type ServerTurnTerminal,
} from "../../persist";
import { reconcileOrphanControlPending } from "../controlReceipts";
import { confirmSnapshotDelivery } from "../deliveryConfirm";
import { type ChatMessage, type ChatSession, rebuildIndexes } from "../model";
import { repairPostFinalProcessOrder } from "../order";
import {
  applyPermissionSnapshot,
  expireGenPlaceholdersAgainstServerRows,
  normalizeDelegateCards,
  normalizeGoalCards,
} from "../reducer";
import { carryLegacySizeRequestReferences, freezeErrorCardSnapshots } from "../render";
import { applyRejectedNoticeMetadata } from "../socketRecoveryHelpers";
import type { ServerMessagesArchive, SocketCtx } from "./types";

function filterIncomingServerRows(
  msgs: ChatMessage[],
  hasTimelineGeneration: boolean,
): ChatMessage[] | null {
  if (!hasTimelineGeneration && msgs.some((message) => message?._turnTapeProcess === true)) {
    return null;
  }
  return msgs.filter(
    (message) =>
      message?._turnTapeProcess !== true &&
      !message?.id?.startsWith("projection-") &&
      !message?.id?.startsWith("oc-dispatch-err:"),
  );
}

function mergeUnifiedTimelineUnits(
  existingMessages: ChatMessage[],
  incomingMsgs: ChatMessage[],
): ChatMessage[] {
  const byUnit = new Map<string, ChatMessage>();
  for (const message of existingMessages) {
    if (message._timelineRecord !== true) continue;
    const key = message._timelineUnitKey ?? `id:${message.id}`;
    byUnit.set(key, message);
  }
  for (const message of incomingMsgs) {
    const key = message._timelineUnitKey ?? `id:${message.id}`;
    const previous = byUnit.get(key);
    const keepLoadedFrom = previous?._historyPageLoadedFrom && !message._historyPageLoadedFrom;
    byUnit.set(
      key,
      keepLoadedFrom
        ? {
            ...message,
            _historyPageLoadedFrom: previous._historyPageLoadedFrom,
            _historyPageKey: previous._historyPageKey,
          }
        : message,
    );
  }
  return [...byUnit.values()];
}

function claimOpenDispatchOnSync(
  s: ChatSession,
  msgs: ChatMessage[],
  openDispatch: ServerMessagesArchive["openDispatch"],
): void {
  if (!openDispatch?.clientMessageId || s._sendingInFlight) return;
  s._sendingInFlight = true;
  s._activeClientMessageId = openDispatch.clientMessageId;
  s._activeAgentId = s._activeAgentId || s.agentId;
  if (!s._turnStartedAt) {
    const userRow = msgs.find((m) => m.role === "user" && m.id === openDispatch.clientMessageId);
    s._turnStartedAt =
      typeof userRow?.ts === "number" && Number.isFinite(userRow.ts) ? userRow.ts : Date.now();
  }
}

function applyTimelineCursorWatermarks(
  s: ChatSession,
  archive: ServerMessagesArchive,
  timelineGenerationChanged: boolean,
): void {
  if (typeof archive.timelineGeneration !== "number") return;
  const hadOlderPages = (s._historyPageSerial ?? 0) > 0 && !timelineGenerationChanged;
  s._timelineGeneration = archive.timelineGeneration;
  if (!hadOlderPages) {
    s._timelineCursor = typeof archive.timelineCursor === "string" ? archive.timelineCursor : null;
    s._timelineHasMore = archive.timelineHasMore === true;
  }
  if (timelineGenerationChanged) s._historyPageSerial = 0;
  if (
    typeof archive.timelineSnapshotMaxSeq === "number" &&
    Number.isSafeInteger(archive.timelineSnapshotMaxSeq)
  ) {
    s._timelineSnapshotMaxSeq = archive.timelineSnapshotMaxSeq;
  }
}

function applyTimelineAndSeqWatermarks(
  s: ChatSession,
  maxSeq: number | undefined,
  archivedThroughSeq: number,
  archive: ServerMessagesArchive | undefined,
  hasTimelineGeneration: boolean,
  timelineGenerationChanged: boolean,
): void {
  const serverUpdatedAt = archive?.serverUpdatedAt;
  if (typeof serverUpdatedAt === "number" && Number.isFinite(serverUpdatedAt)) {
    s._lastServerSyncUpdatedAt = serverUpdatedAt;
  }
  const rev = archive?.historyRevision;
  if (typeof rev === "number" && Number.isSafeInteger(rev) && rev >= 0) {
    s._historyRevision = rev;
  }
  if (hasTimelineGeneration && archive) {
    applyTimelineCursorWatermarks(s, archive, timelineGenerationChanged);
  }
  if (archivedThroughSeq > 0) s._archivedThroughSeq = archivedThroughSeq;
  if (typeof archive?.archivedCount === "number" && Number.isFinite(archive.archivedCount)) {
    s._archivedCount = archive.archivedCount;
  }
  if (typeof maxSeq === "number" && (s._maxSeq === undefined || maxSeq > s._maxSeq)) {
    s._maxSeq = maxSeq;
  }
}

function mergePreparedServerMessages(
  s: ChatSession,
  authoritativeMessages: ChatMessage[],
  rawMsgs: ChatMessage[],
  full: boolean,
  archivedThroughSeq: number,
  archive: ServerMessagesArchive | undefined,
  terminalTurns: Map<string, ServerTurnTerminal>,
  flags: {
    hasVersion: boolean;
    adoptingUnifiedTimeline: boolean;
    timelineGenerationChanged: boolean;
  },
): boolean {
  const sendingCmid = s._sendingInFlight ? s._activeClientMessageId : undefined;
  const activeClientMessageId =
    sendingCmid && terminalTurns.has(sendingCmid) ? undefined : sendingCmid;
  const unpublishedCompleted =
    typeof archive?.completedClientMessageId === "string" &&
    rawMsgs.some(
      (message) =>
        message._clientMessageId === archive.completedClientMessageId &&
        message._displayDegradeReason === "records_unpublished",
    );
  const completedCmid = unpublishedCompleted ? undefined : archive?.completedClientMessageId;
  const invalidateHistoryCache =
    flags.adoptingUnifiedTimeline ||
    flags.timelineGenerationChanged ||
    (full && archive?.invalidateHistoryCache === true);
  s.messages = full
    ? mergeFullServerWins(authoritativeMessages, s.messages, archivedThroughSeq, completedCmid, {
        deletionAuthority: flags.hasVersion,
        activeClientMessageId,
        invalidateHistoryCache,
        adoptUnifiedTimeline: flags.adoptingUnifiedTimeline,
      })
    : applyServerIncremental(s.messages, authoritativeMessages, completedCmid, {
        activeClientMessageId,
      });
  s.messages = reconcileTimelineBashTailAuxiliaries(s.messages);
  s.messages = reconcileLateDelegateAgentGroups(s.messages);
  return Boolean(sendingCmid && terminalTurns.has(sendingCmid));
}

function refreshIndexesAfterServerMerge(
  s: ChatSession,
  msgs: ChatMessage[],
  settlingActiveTurn: boolean,
  openDispatch: ServerMessagesArchive["openDispatch"],
): void {
  const preserveStreaming =
    Boolean(s._sendingInFlight) &&
    typeof s._activeClientMessageId === "string" &&
    !msgs.some(
      (message) =>
        message && (message as { _clientMessageId?: unknown })._clientMessageId === s._activeClientMessageId,
    );
  if (!preserveStreaming) {
    s._streamingAssistant = null;
    s._streamingThinking = null;
  }
  s._blockIdToMsgId = new Map();
  s._agentGroups = new Map();
  rebuildIndexes(s);
  normalizeDelegateCards(s);
  normalizeGoalCards(s);
  confirmSnapshotDelivery(s, openDispatch);
  if (!s._sendingInFlight || settlingActiveTurn) {
    s.messages = repairPostFinalProcessOrder(s.messages);
  }
}

export function mergeServerHistoryPreliminary(
  ctx: SocketCtx,
  sessId: string,
  agentId: string,
  rawMsgs: ChatMessage[],
  full: boolean,
  maxSeq: number | undefined,
  archive: ServerMessagesArchive | undefined,
): {
  session: ChatSession;
  acceptedMsgs: ChatMessage[];
  terminalTurns: Map<string, ServerTurnTerminal>;
} | null {
  const s = ctx.ensureSession(sessId, agentId || ctx.deps.defaultAgentId || "main");
  const incomingTimelineGen = archive?.timelineGeneration;
  const hasTimelineGeneration =
    typeof incomingTimelineGen === "number" &&
    Number.isSafeInteger(incomingTimelineGen) &&
    incomingTimelineGen >= 1;
  const filtered = filterIncomingServerRows(rawMsgs, hasTimelineGeneration);
  if (!filtered) return null;
  const serverUpdatedAt = archive?.serverUpdatedAt;
  const hasVersion = typeof serverUpdatedAt === "number" && Number.isFinite(serverUpdatedAt);
  if (hasVersion && serverUpdatedAt < (s._lastServerSyncUpdatedAt ?? 0)) return null;

  let msgs = applyRejectedNoticeMetadata(s, filtered);
  msgs = carryLegacySizeRequestReferences(msgs, s.messages);
  if (typeof archive?.modelId === "string" && archive.modelId) s._selectedModelId = archive.modelId;
  claimOpenDispatchOnSync(s, msgs, archive?.openDispatch);

  const terminalTurns = detectServerTerminalTurns(msgs);
  const timelineGenerationChanged =
    hasTimelineGeneration &&
    s._timelineGeneration !== undefined &&
    incomingTimelineGen !== s._timelineGeneration;
  const adoptingUnifiedTimeline = hasTimelineGeneration && s._timelineGeneration === undefined;
  const authoritativeMessages =
    hasTimelineGeneration && !timelineGenerationChanged
      ? mergeUnifiedTimelineUnits(s.messages, msgs)
      : msgs;
  const archivedThroughSeq =
    typeof archive?.archivedThroughSeq === "number" && Number.isFinite(archive.archivedThroughSeq)
      ? archive.archivedThroughSeq
      : 0;

  const settlingActiveTurn = mergePreparedServerMessages(
    s,
    authoritativeMessages,
    msgs,
    full,
    archivedThroughSeq,
    archive,
    terminalTurns,
    { hasVersion, adoptingUnifiedTimeline, timelineGenerationChanged },
  );
  applyTimelineAndSeqWatermarks(
    s,
    maxSeq,
    archivedThroughSeq,
    archive,
    hasTimelineGeneration,
    timelineGenerationChanged,
  );
  refreshIndexesAfterServerMerge(s, msgs, settlingActiveTurn, archive?.openDispatch);
  return { session: s, acceptedMsgs: msgs, terminalTurns };
}

function updateUserRowStatusOnConverge(
  s: ChatSession,
  userRow: ChatMessage,
  cmid: string,
  kind: ServerTurnTerminal,
): void {
  if (kind === "completed") {
    userRow.status = "replied";
    return;
  }
  if (userRow.status === "replied") return;
  if (kind === "error") {
    const automaticChild = s.messages.some(
      (m) =>
        m.role === "user" &&
        m._automaticRecovery === true &&
        (m._recoveryOfClientMessageId === cmid || m._continuationOfClientMessageId === cmid),
    );
    userRow.status = automaticChild ? "sent" : "error";
    return;
  }
  userRow.status = "sent";
}

export function convergeTerminalTurnsInSession(
  ctx: SocketCtx,
  s: ChatSession,
  terminalTurns: Map<string, ServerTurnTerminal>,
): void {
  if (terminalTurns.size === 0) return;
  for (const [cmid, kind] of terminalTurns) {
    if (s._deferredTerminalErrorClientMessageId === cmid) continue;
    const userRow = s.messages.find((m) => m.role === "user" && m.id === cmid);
    if (userRow) updateUserRowStatusOnConverge(s, userRow, cmid, kind);
    if (s._sendingInFlight && s._activeClientMessageId === cmid) {
      ctx.clearSendingState(s);
    }
    const stopSettlement = s._stopSettlement;
    if (stopSettlement?.clientMessageId === cmid && stopSettlement.controlId) {
      ctx.settleControl(stopSettlement.controlId, "terminal");
    }
    ctx.finishDispatch(s.id, cmid);
  }
}

export function finalizeServerMessagesTail(
  ctx: SocketCtx,
  s: ChatSession,
  archive: ServerMessagesArchive | undefined,
  terminalTurns: Map<string, ServerTurnTerminal>,
  adoptFromHistory: (ctx: SocketCtx, sess: ChatSession) => void,
): void {
  freezeErrorCardSnapshots(
    s.messages,
    s._deferredTerminalErrorClientMessageId,
    new Set(Object.keys(s._cancelledAutomaticRecoveryIds ?? {})),
  );
  expireGenPlaceholdersAgainstServerRows(s);
  if (archive?.permissionPrompts) {
    const lookupIds = applyPermissionSnapshot(s, archive.permissionPrompts);
    if (lookupIds.length > 0) ctx.deps.lookupPermissionPrompts?.(s.id, lookupIds);
  }
  reconcileOrphanControlPending(s, ctx.controlQueue);
  convergeTerminalTurnsInSession(ctx, s, terminalTurns);
  if (!s._sendingInFlight) ctx.clearLiveJournalDegraded(s);
  ctx.reconcileUnpublishedTapeRetry(s.id);
  ctx.scheduleNotify();

  const tailRecoverableError = [...s.messages].reverse().find(
    (message) =>
      message.role === "assistant" &&
      typeof message._errorCode === "string" &&
      Boolean(message._errorCode) &&
      (message._source === "server" || Boolean(message._turnTapeId)) &&
      supportsAutomaticTurnRecovery(message._errorCode),
  );
  const recoveryDecisionKey = tailRecoverableError?._clientMessageId ?? "tail";
  if (
    !ctx.masterOwnsAutomaticRecovery &&
    tailRecoverableError &&
    ctx.pendingRecoveryErrors.get(s.id)?.masterOwned !== true &&
    s._automaticRecoveryDecisions?.[recoveryDecisionKey] !== true
  ) {
    setTimeout(
      () => void ctx.autoRecoverTerminalTurn(s.id, tailRecoverableError._clientMessageId),
      0,
    );
  }
  if (ctx.masterOwnsAutomaticRecovery) adoptFromHistory(ctx, s);
  ctx.subscribeSession(s.id);
}

export function prependArchivedMessagesToSession(
  ctx: SocketCtx,
  sessId: string,
  msgs: ChatMessage[],
): void {
  const s = ctx.sessions.get(sessId);
  if (!s || !Array.isArray(msgs) || msgs.length === 0) return;
  const next = mergeArchivedHistory(s.messages, msgs);
  if (next === s.messages) return;
  s.messages = next;
  s._blockIdToMsgId = new Map();
  s._agentGroups = new Map();
  rebuildIndexes(s);
  normalizeDelegateCards(s);
  normalizeGoalCards(s);
  s.messages = repairPostFinalProcessOrder(s.messages);
  freezeErrorCardSnapshots(
    s.messages,
    s._deferredTerminalErrorClientMessageId,
    new Set(Object.keys(s._cancelledAutomaticRecoveryIds ?? {})),
  );
  ctx.scheduleNotify();
}

function isBashOutputTailRuntimeRecord(message: ChatMessage): boolean {
  if (message.role !== "runtime-event") return false;
  const event = message._runtimeEvent;
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const raw = event as Record<string, unknown>;
  return (
    raw.type === "system" &&
    raw.subtype === "bash_output_tail" &&
    typeof raw.tool_use_id === "string" &&
    raw.tool_use_id.length > 0
  );
}

export function resolveTimelineAuxiliaryInSession(
  ctx: SocketCtx,
  sessId: string,
  unitKey: string,
  records: ChatMessage[],
): void {
  const s = ctx.sessions.get(sessId);
  if (!s) return;
  const index = s.messages.findIndex(
    (message) =>
      message._timelineUnitKey === unitKey &&
      message._timelineAuxiliary === "bash-tail" &&
      message._payloadDeferred === true,
  );
  if (index < 0) return;
  const locator = s.messages[index]!;
  const exact = records.find(isBashOutputTailRuntimeRecord);
  const next = [...s.messages];
  if (!exact) {
    next.splice(index, 1);
  } else {
    next[index] = {
      ...exact,
      _source: "server",
      _orderSeq: locator._orderSeq,
      _seq: locator._seq,
      _turnTapeId: locator._turnTapeId,
      _turnTapeOrdinal: locator._turnTapeOrdinal,
      _recordOrdinal: locator._recordOrdinal,
      _turnTapeSha256: locator._turnTapeSha256,
      _turnTapeComplete: true,
      _turnKey: locator._turnKey,
      _dispatchOutcome: locator._dispatchOutcome,
      _clientMessageId: exact._clientMessageId ?? locator._clientMessageId,
      _timelineRecord: true,
      _timelineAuxiliary: "bash-tail",
      _timelineUnitKey: unitKey,
      _historyPageLoadedFrom: locator._historyPageLoadedFrom,
      _historyPageKey: locator._historyPageKey,
      _payloadDeferred: undefined,
      _payloadBytes: undefined,
      _payloadSha256: undefined,
    };
  }
  s.messages = reconcileTimelineBashTailAuxiliaries(next);
  s.messages = reconcileLateDelegateAgentGroups(s.messages);
  s._blockIdToMsgId = new Map();
  s._agentGroups = new Map();
  rebuildIndexes(s);
  ctx.scheduleNotify();
}

export function computeArchiveBeforeSeq(
  sessions: ReadonlyMap<string, ChatSession>,
  sessId: string,
): number {
  const s = sessions.get(sessId);
  if (!s) return 0;
  let min: number | null = null;
  for (const m of s.messages) {
    const orderSeq = typeof m._orderSeq === "number" ? m._orderSeq : m._seq;
    if (typeof orderSeq === "number" && Number.isFinite(orderSeq) && (min === null || orderSeq < min)) {
      min = orderSeq;
    }
  }
  if (min !== null) return min;
  return typeof s._archivedThroughSeq === "number" && s._archivedThroughSeq > 0
    ? s._archivedThroughSeq + 1
    : 0;
}
