import {
  AUTOMATIC_TURN_RETRY_MAX,
  isClientMessageId,
  normalizeServiceTierForModel,
} from "@openclaude/protocol/browser";
import { readSessionServiceTier } from "../../sessionServiceTier";
import type { AckWire, InboundMessage } from "../frames";
import {
  addMessage,
  type ChatMessage,
  type ChatRoutingSnapshot,
  type ChatSession,
  isServerAuthoredRow,
} from "../model";
import {
  AUTO_CONTINUE_DISPLAY,
  AUTOMATIC_RECOVERY_CHECKPOINT_DISPLAY,
  AUTOMATIC_RECOVERY_REPLAY_DISPLAY,
  type EmptyTurnDecision,
  emptyTurnNoticeText,
  INTERRUPTED_CONTINUE_DISPLAY,
  INTERRUPTED_CONTINUE_PROMPT,
  shouldAutoContinueEmptyTurn,
} from "../pure";
import { AUTO_CONTINUE_PROMPT } from "../reducer";
import { problemCardRootCmid } from "./problemCardAndDeferredError";
import {
  automaticTurnRecoveryTarget,
  exactUserReplayPayload,
  interruptedContinuationTarget,
  normalizeRetiredRouting,
  routingWireFields,
} from "./pureHelpers";
import type { InterruptedContinuationTarget, SocketCtx } from "./types";

function isLineageCancelledForAdoption(
  sess: ChatSession,
  recovery: NonNullable<AckWire["recovery"]>,
  clientMessageId: string,
): boolean {
  const cancelled = sess._cancelledAutomaticRecoveryIds;
  if (!cancelled) return false;
  if (cancelled[recovery.sourceClientMessageId] === true) return true;
  if (isClientMessageId(recovery.rootClientMessageId) && cancelled[recovery.rootClientMessageId] === true) {
    return true;
  }
  return cancelled[clientMessageId] === true;
}

export function adoptMasterAutomaticRecoveryTurn(
  ctx: SocketCtx,
  sessId: string,
  clientMessageId: string,
  recovery: NonNullable<AckWire["recovery"]>,
): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess || !isClientMessageId(recovery.sourceClientMessageId)) return;
  if (isLineageCancelledForAdoption(sess, recovery, clientMessageId)) return;

  ctx.settlePendingRecoveryError(sessId, recovery.sourceClientMessageId, "adopted");
  const attempt =
    Number.isSafeInteger(recovery.attempt) && recovery.attempt >= 1
      ? Math.min(recovery.attempt, AUTOMATIC_TURN_RETRY_MAX)
      : 1;
  const rootClientMessageId = isClientMessageId(recovery.rootClientMessageId)
    ? recovery.rootClientMessageId
    : recovery.sourceClientMessageId;
  const source = sess.messages.find(
    (message) => message.role === "user" && message.id === recovery.sourceClientMessageId,
  );
  if (source) {
    source._automaticRecoveryAttempted = true;
    if (source.status === "error") source.status = "sent";
  }
  const { modelSwitchId: _dropSwitchId, ...baseRouting } =
    source?._routing ?? sess._lastRouting ?? {};
  void _dropSwitchId;
  const routing: ChatRoutingSnapshot = {
    ...baseRouting,
    ...(recovery.model ? { model: recovery.model } : {}),
  };
  const displayText =
    recovery.displayText ||
    (recovery.mode === "checkpoint"
      ? AUTOMATIC_RECOVERY_CHECKPOINT_DISPLAY
      : AUTOMATIC_RECOVERY_REPLAY_DISPLAY);
  const existing = sess.messages.find(
    (message) => message.role === "user" && message.id === clientMessageId,
  );
  if (!existing) {
    addMessage(sess, "user", displayText, {
      id: clientMessageId,
      status: "sent",
      _source: "server",
      _isAutoRetry: true,
      _routing: routing,
      _continuationOfClientMessageId: recovery.sourceClientMessageId,
      _recoveryOfClientMessageId: recovery.sourceClientMessageId,
      _recoveryMode: recovery.mode,
      _automaticRecovery: true,
      _automaticRecoveryRootClientMessageId: rootClientMessageId,
      _automaticRecoveryAttempt: attempt,
      _automaticRecoveryMax: AUTOMATIC_TURN_RETRY_MAX,
    });
  } else if (existing.status !== "sent") {
    existing.status = "sent";
  }
  if (!sess._sendingInFlight || sess._activeClientMessageId !== clientMessageId) {
    ctx.beginTurn(sess, clientMessageId, recovery.agentId);
  }
  ctx.dispatchSlots.set(sessId, clientMessageId);
  sess._turnStatus = {
    kind: "retrying",
    attempt,
    max: AUTOMATIC_TURN_RETRY_MAX,
    retryAt: Date.now(),
  };
  sess._lastRouting = { ...routing };
  ctx.clearTransientNotice(sessId);
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
}

export function adoptCronOriginTurnInSocket(
  ctx: SocketCtx,
  sessId: string,
  clientMessageId: string,
  cronOrigin: NonNullable<AckWire["cronOrigin"]>,
): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  const ts =
    typeof cronOrigin.ts === "number" && Number.isFinite(cronOrigin.ts)
      ? cronOrigin.ts
      : Date.now();
  const { modelSwitchId: _dropCronSwitchId, ...baseCronRouting } = sess._lastRouting ?? {};
  void _dropCronSwitchId;
  const routing: ChatRoutingSnapshot = {
    ...baseCronRouting,
    ...(cronOrigin.model ? { model: cronOrigin.model } : {}),
  };
  const existing = sess.messages.find(
    (message) => message.role === "user" && message.id === clientMessageId,
  );
  if (!existing) {
    addMessage(sess, "user", cronOrigin.text, {
      id: clientMessageId,
      status: "sent",
      ts,
      _source: "server",
      _systemCallback: true,
      _routing: routing,
    });
  } else {
    existing._systemCallback = true;
    if (existing.status !== "sent") existing.status = "sent";
  }
  if (!sess._sendingInFlight || sess._activeClientMessageId !== clientMessageId) {
    ctx.beginTurn(sess, clientMessageId, cronOrigin.agentId, ts);
  }
  ctx.dispatchSlots.set(sessId, clientMessageId);
  ctx.subscribeSession(sessId);
  ctx.clearTransientNotice(sessId);
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
}

function findTrailingUnsettledRecoveryUser(messages: readonly ChatMessage[]): ChatMessage | undefined {
  let terminalAfterUser = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      return terminalAfterUser ? undefined : message;
    }
    const isServerOrTape = message._source === "server" || Boolean(message._turnTapeId);
    const hasTerminalEvidence =
      Boolean(message._errorCode) ||
      (typeof message.text === "string" && message.text.trim().length > 0);
    if (message.role === "assistant" && isServerOrTape && hasTerminalEvidence) {
      terminalAfterUser = true;
    }
  }
  return undefined;
}

export function adoptPendingAutomaticRecoveryFromHistory(ctx: SocketCtx, sess: ChatSession): void {
  if (sess._sendingInFlight) return;
  const lastUser = findTrailingUnsettledRecoveryUser(sess.messages);
  if (
    !lastUser ||
    lastUser._automaticRecovery !== true ||
    !isClientMessageId(lastUser._recoveryOfClientMessageId) ||
    !isClientMessageId(lastUser.id) ||
    (lastUser._source !== "server" && !lastUser._turnTapeId)
  ) {
    return;
  }
  const attempt =
    typeof lastUser._automaticRecoveryAttempt === "number" &&
    Number.isSafeInteger(lastUser._automaticRecoveryAttempt) &&
    lastUser._automaticRecoveryAttempt >= 1
      ? lastUser._automaticRecoveryAttempt
      : 1;
  adoptMasterAutomaticRecoveryTurn(ctx, sess.id, lastUser.id, {
    automatic: true,
    mode: lastUser._recoveryMode === "replay" ? "replay" : "checkpoint",
    sourceClientMessageId: lastUser._recoveryOfClientMessageId,
    rootClientMessageId: isClientMessageId(lastUser._automaticRecoveryRootClientMessageId)
      ? lastUser._automaticRecoveryRootClientMessageId
      : lastUser._recoveryOfClientMessageId,
    attempt,
    max: AUTOMATIC_TURN_RETRY_MAX,
    ...(lastUser._routing?.model ? { model: lastUser._routing.model } : {}),
  });
}

function resolveRecoveryTurnRouting(
  sess: ChatSession,
  baseRouting: ChatRoutingSnapshot,
  automatic: boolean,
): ChatRoutingSnapshot {
  if (automatic) return baseRouting;
  const selectedModel = sess._selectedModelId;
  const preparedSwitch =
    selectedModel && sess._preparedModelSwitch?.targetModel === selectedModel
      ? sess._preparedModelSwitch
      : undefined;
  const manualContinuationTier =
    normalizeServiceTierForModel(
      selectedModel ?? baseRouting.model,
      readSessionServiceTier(sess.id),
    ) ?? undefined;
  if (selectedModel && selectedModel !== baseRouting.model) {
    return {
      ...baseRouting,
      model: selectedModel,
      modelSwitchId: preparedSwitch?.id,
      modelSwitchConsent: undefined,
      serviceTier: manualContinuationTier,
    };
  }
  return { ...baseRouting, serviceTier: manualContinuationTier };
}

function buildRecoveryMessageContent(
  target: InterruptedContinuationTarget,
  replay: ReturnType<typeof exactUserReplayPayload> | null,
  automatic: boolean,
): { content: InboundMessage["content"]; modelText: string; displayText: string } {
  const modelText = replay?.text ?? INTERRUPTED_CONTINUE_PROMPT;
  const displayText = automatic
    ? target.mode === "checkpoint"
      ? AUTOMATIC_RECOVERY_CHECKPOINT_DISPLAY
      : AUTOMATIC_RECOVERY_REPLAY_DISPLAY
    : INTERRUPTED_CONTINUE_DISPLAY;
  const recovery: InboundMessage["content"]["recovery"] = automatic
    ? {
        sourceClientMessageId: target.user.id,
        mode: target.mode,
        automatic: true,
        rootClientMessageId: target.rootClientMessageId!,
        attempt: target.attempt!,
        max: AUTOMATIC_TURN_RETRY_MAX,
      }
    : {
        sourceClientMessageId: target.user.id,
        mode: target.mode,
        automatic: false,
      };
  return {
    modelText,
    displayText,
    content: {
      text: modelText,
      displayText,
      ...(replay?.media ? { media: replay.media } : {}),
      ...(replay?.imageEdit ? { imageEdit: replay.imageEdit } : {}),
      ...(replay?.replyTo ? { replyTo: replay.replyTo } : {}),
      recovery,
    },
  };
}

export function dispatchTurnRecoveryMessage(
  ctx: SocketCtx,
  sess: ChatSession,
  target: InterruptedContinuationTarget,
  agentId: string,
  automatic: boolean,
  dispatchPayload: (sess: ChatSession, userMsg: ChatMessage, payload: InboundMessage) => void,
  ensureGenPlaceholder: (
    sess: ChatSession,
    imageEdit: NonNullable<InboundMessage["content"]>["imageEdit"] | undefined,
    reuse: boolean,
    anchorUserMsgId?: string,
  ) => void,
): boolean {
  if (sess._sendingInFlight) return false;
  if (automatic && sess._cancelledAutomaticRecoveryIds?.[target.user.id] === true) {
    return false;
  }
  const baseRouting = normalizeRetiredRouting(target.user._routing);
  if (!baseRouting) return false;
  const routing = resolveRecoveryTurnRouting(sess, baseRouting, automatic);
  const resolvedAgentId = sess.agentId || agentId;
  void ctx.ensureServerSessionOnce(sess, resolvedAgentId);
  const replay = target.mode === "replay" ? exactUserReplayPayload(target.user) : null;
  const { content, modelText, displayText } = buildRecoveryMessageContent(target, replay, automatic);
  const payload: InboundMessage = {
    type: "inbound.message",
    idempotencyKey: target.idempotencyKey,
    channel: "webchat",
    peer: { id: sess.id, kind: "dm" },
    agentId: resolvedAgentId,
    content,
    ...(replay?.replyTo ? { replyToId: replay.replyTo.messageId } : {}),
    ...routingWireFields(routing, true),
    ts: Date.now(),
    clientMessageId: target.clientMessageId,
  };
  if (automatic) target.user._automaticRecoveryAttempted = true;
  const userMsg = addMessage(sess, "user", displayText, {
    id: target.clientMessageId,
    status: "sending",
    _isAutoRetry: true,
    _modelText: modelText,
    ...(replay?.media ? { _media: replay.media } : {}),
    ...(replay?.imageEdit ? { _imageEdit: replay.imageEdit } : {}),
    ...(replay?.replyTo ? { _replyTo: replay.replyTo } : {}),
    _idem: target.idempotencyKey,
    _routing: { ...routing },
    _continuationOfClientMessageId: target.user.id,
    _recoveryOfClientMessageId: target.user.id,
    _recoveryMode: target.mode,
    _automaticRecovery: automatic,
    ...(automatic
      ? {
          _automaticRecoveryRootClientMessageId: target.rootClientMessageId,
          _automaticRecoveryAttempt: target.attempt,
          _automaticRecoveryMax: AUTOMATIC_TURN_RETRY_MAX,
        }
      : {}),
  });
  if (automatic && target.attempt) {
    sess._turnStatus = {
      kind: "retrying",
      attempt: target.attempt,
      max: AUTOMATIC_TURN_RETRY_MAX,
      retryAt: Date.now(),
    };
  }
  sess._lastRouting = { ...routing };
  if (replay?.imageEdit) ensureGenPlaceholder(sess, replay.imageEdit, true, userMsg.id);
  dispatchPayload(sess, userMsg, payload);
  return true;
}

function declinePendingAutoRecovery(
  ctx: SocketCtx,
  sessId: string,
  clientMessageId: string | undefined,
  ownsPending: () => boolean,
): void {
  if (!ownsPending()) return;
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  if (clientMessageId) {
    sess._automaticRecoveryDecisions = {
      ...(sess._automaticRecoveryDecisions ?? {}),
      [clientMessageId]: true,
    };
  }
  const root = problemCardRootCmid(sess, clientMessageId);
  const cancelled =
    (Boolean(clientMessageId) && sess._cancelledAutomaticRecoveryIds?.[clientMessageId!] === true) ||
    (Boolean(root) && sess._cancelledAutomaticRecoveryIds?.[root!] === true);
  ctx.materializePendingRecoveryError(sessId, cancelled ? "stop_fenced" : "decision_declined");
}

function checkPreSyncAutoRecoverySuperseded(
  ctx: SocketCtx,
  sessId: string,
  clientMessageId: string | undefined,
  decline: () => void,
): boolean {
  const beforeSync = ctx.sessions.get(sessId);
  if (beforeSync?._automaticRecoveryDecisions?.[clientMessageId ?? "tail"] === true) return true;
  if (!beforeSync || !clientMessageId) return false;
  const sourceUserIndex = beforeSync.messages.findIndex(
    (message) => message.role === "user" && message.id === clientMessageId,
  );
  const hasLaterUser =
    sourceUserIndex >= 0 &&
    beforeSync.messages.slice(sourceUserIndex + 1).some((message) => message.role === "user");
  if (!hasLaterUser) return false;
  beforeSync._automaticRecoveryDecisions = {
    ...(beforeSync._automaticRecoveryDecisions ?? {}),
    [clientMessageId]: true,
  };
  decline();
  ctx.deps.persistSession?.(sessId);
  return true;
}

function executePostSyncAutoRecovery(
  ctx: SocketCtx,
  sess: ChatSession,
  sessId: string,
  clientMessageId: string | undefined,
  ownsPending: () => boolean,
  decline: () => void,
  dispatchRecovery: (
    sess: ChatSession,
    target: InterruptedContinuationTarget,
    agentId: string,
    automatic: boolean,
  ) => boolean,
): void {
  const ownsSoftTurn =
    ownsPending() &&
    (!sess._activeClientMessageId || sess._activeClientMessageId === clientMessageId);
  if (sess._sendingInFlight && !ownsSoftTurn) return;
  const error = [...sess.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        Boolean(message._errorCode) &&
        isServerAuthoredRow(message) &&
        (clientMessageId === undefined || message._clientMessageId === clientMessageId),
    );
  if (!error) {
    if (ownsPending()) ctx.syncHistory(sessId, { clientMessageId });
    return;
  }
  if (sess._dispatchPaused) {
    decline();
    return;
  }
  const target = automaticTurnRecoveryTarget(sess.messages, error, sess.id);
  if (!target) {
    decline();
    return;
  }
  if (sess._cancelledAutomaticRecoveryIds?.[target.user.id] === true) return;
  if (sess._automaticRecoveryDecisions?.[target.user.id] === true) return;
  sess._automaticRecoveryDecisions = {
    ...(sess._automaticRecoveryDecisions ?? {}),
    [target.user.id]: true,
  };
  if (ownsSoftTurn) {
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
  }
  const dispatched = dispatchRecovery(
    sess,
    target,
    sess.agentId || ctx.deps.defaultAgentId || "main",
    true,
  );
  if (dispatched) ctx.settlePendingRecoveryError(sessId, clientMessageId, "adopted");
  else decline();
  ctx.deps.persistSession?.(sess.id);
}

export async function autoRecoverTerminalTurnFlow(
  ctx: SocketCtx,
  sessId: string,
  clientMessageId: string | undefined,
  dispatchRecovery: (
    sess: ChatSession,
    target: InterruptedContinuationTarget,
    agentId: string,
    automatic: boolean,
  ) => boolean,
): Promise<void> {
  if (ctx.masterOwnsAutomaticRecovery) return;
  const expected = ctx.pendingRecoveryErrors.get(sessId);
  if (expected?.masterOwned) return;
  const ownsPending = () => Boolean(expected) && ctx.pendingRecoveryErrors.get(sessId) === expected;
  const decline = () => declinePendingAutoRecovery(ctx, sessId, clientMessageId, ownsPending);
  if (checkPreSyncAutoRecoverySuperseded(ctx, sessId, clientMessageId, decline)) return;

  const pendingKey = `${sessId}\0${clientMessageId ?? "tail"}`;
  if (ctx.automaticRecoveryPending.has(pendingKey)) return;
  ctx.automaticRecoveryPending.add(pendingKey);
  try {
    const synced = await ctx.deps.syncSession?.(sessId, {
      ...(clientMessageId ? { clientMessageId } : {}),
      isCurrent: () => !expected || ownsPending(),
    });
    if (synced === false) {
      if (ownsPending()) ctx.syncHistory(sessId, { clientMessageId });
      return;
    }
    if (expected && !ownsPending()) return;
    const sess = ctx.sessions.get(sessId);
    if (!sess) return;
    executePostSyncAutoRecovery(
      ctx,
      sess,
      sessId,
      clientMessageId,
      ownsPending,
      decline,
      dispatchRecovery,
    );
  } catch {
    if (ownsPending()) ctx.syncHistory(sessId, { clientMessageId });
  } finally {
    ctx.automaticRecoveryPending.delete(pendingKey);
  }
}

export function continueInterruptedTurnFlow(
  ctx: SocketCtx,
  p: { sessId: string; errorMessageId: string; agentId: string },
  dispatchRecovery: (
    sess: ChatSession,
    target: InterruptedContinuationTarget,
    agentId: string,
    automatic: boolean,
  ) => boolean,
): void {
  const sess = ctx.sessions.get(p.sessId);
  if (!sess || sess._sendingInFlight) return;
  sess._dispatchPaused = false;
  const error = sess.messages.find(
    (message) => message.id === p.errorMessageId && message.role === "assistant",
  );
  if (!error) return;
  const target = interruptedContinuationTarget(sess.messages, error, sess.id);
  if (!target) return;
  dispatchRecovery(sess, target, p.agentId, false);
}

export function autoContinueEmptyTurnFlow(
  ctx: SocketCtx,
  sessId: string,
  targetMsgId: string,
  cls: EmptyTurnDecision,
  dispatchPayload: (sess: ChatSession, userMsg: ChatMessage, payload: InboundMessage) => void,
): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess || sess._sendingInFlight || sess._dispatchPaused) return;
  const idx = sess.messages.findIndex((m) => m && m.id === targetMsgId);
  if (idx < 0) return;
  const target = sess.messages[idx]!;
  if (
    target._clientMessageId &&
    sess._cancelledAutomaticRecoveryIds?.[target._clientMessageId] === true
  ) {
    return;
  }
  if (!shouldAutoContinueEmptyTurn({ messages: sess.messages, targetMsgId, stopReason: "end_turn" })) {
    return;
  }
  const hasQueued = ctx.offlineQueue.some((item) => item.sessId === sess.id);
  if (!(ctx.ws && ctx.ws.readyState === 1 && ctx.relayReady) || hasQueued) {
    const last = sess.messages[sess.messages.length - 1];
    if (last?._emptyTurn && last._emptyTurnTargetMsgId === targetMsgId) return;
    addMessage(
      sess,
      "assistant",
      cls.insert ? cls.text : emptyTurnNoticeText("end_turn", false),
      {
        _emptyTurn: true,
        _emptyTurnSoft: cls.insert ? cls.soft : true,
        _emptyTurnStopReason: "end_turn",
        _emptyTurnTargetMsgId: targetMsgId,
      },
    );
    ctx.scheduleNotify();
    return;
  }

  const idem = `autocont-${sessId}-${targetMsgId}`;
  const payload: InboundMessage = {
    type: "inbound.message",
    idempotencyKey: idem,
    channel: "webchat",
    peer: { id: sess.id, kind: "dm" },
    agentId: sess.agentId || ctx.deps.defaultAgentId || "main",
    content: { text: AUTO_CONTINUE_PROMPT },
    ...routingWireFields(sess._lastRouting, false),
    ts: Date.now(),
  };
  const userMsg = addMessage(sess, "user", AUTO_CONTINUE_DISPLAY, {
    status: "sending",
    _isAutoRetry: true,
    _automaticRecovery: true,
    ...(target._clientMessageId
      ? {
          _recoveryOfClientMessageId: target._clientMessageId,
          _continuationOfClientMessageId: target._clientMessageId,
        }
      : {}),
    _modelText: AUTO_CONTINUE_PROMPT,
    _idem: idem,
  });
  payload.clientMessageId = userMsg.id;
  dispatchPayload(sess, userMsg, payload);
}

export function clearAutoContinueInFlightByIdem(ctx: SocketCtx, idem: string): void {
  for (const sess of ctx.sessions.values()) {
    if (!sess.messages.some((m) => m?._isAutoRetry && m._idem === idem)) continue;
    if (!sess._sendingInFlight) return;
    ctx.finishDispatch(sess.id, sess._activeClientMessageId);
    ctx.clearSendingState(sess, { clearTiming: false, resetTracker: false });
    ctx.scheduleNotify();
    return;
  }
}
