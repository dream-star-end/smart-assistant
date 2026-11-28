/**
 * Terminal turn error, deferred recovery soft-state, `resume_failed`, `cost_charged`, and `cost_waived` reducers.
 */
import {
  AUTOMATIC_TURN_RETRY_MAX,
  supportsAutomaticTurnRecovery,
} from "@openclaude/protocol/browser";
import type {
  CostChargedWire,
  CostWaivedWire,
  LegacyBridgeErrorWire,
  OutboundErrorWire,
  OutboundResumeFailedWire,
} from "../frames";
import {
  addMessage,
  type ChatMessage,
  type ChatSession,
  clearTurnTiming,
  resetReplyTracker,
} from "../model";
import {
  friendlyBridgeErrorMessage,
  isBridgeAuthControlError,
  isSilentTurnErrorCode,
  normalizeBridgeErrorCode,
  problemCardPresentation,
  REPORT_EXEMPT_TURN_ERR_CODES,
  safeBridgeErrorDetail,
} from "../pure";
import { commitErrorCardSnapshot, errorLabel } from "../render";
import { readUserError } from "../userErrorView";
import {
  acceptFrameSeq,
  advanceFrameSeqCursorTo,
  isImmutableTapeViewportRow,
  resetFrameSeqCursor,
} from "./frameSeqCursor";
import { failGenPlaceholders, resolveGenPlaceholders } from "./goalPlanGenReducer";
import type { DeferredTerminalErrorPaint, FrameEffects } from "./types";

const COST_CHARGED_LAST_FINAL_TTL_MS = 60_000;

function isCompletedTapeAssistant(m: ChatMessage): boolean {
  return m.role === "assistant" && m._turnTapeComplete === true && !m._errorCode;
}

function matchesCompletedOrRecoveredCmid(m: ChatMessage, cmid: string): boolean {
  if (m._clientMessageId === cmid && isCompletedTapeAssistant(m)) return true;
  return (
    m.role === "user" &&
    m._automaticRecovery === true &&
    m._recoveryOfClientMessageId === cmid &&
    (m._source === "server" || !!m._turnTapeId)
  );
}

/**
 * Leftover live-journal `outbound.error` after a turn (or a later turn) already
 * completed on tape. Never suppress the active in-flight turn.
 */
export function shouldSuppressStaleOutboundError(
  sess: ChatSession,
  frame: { clientMessageId?: string },
): boolean {
  const cmid =
    typeof frame.clientMessageId === "string" && frame.clientMessageId
      ? frame.clientMessageId
      : undefined;
  if (cmid) {
    if (sess._activeClientMessageId === cmid) return false;
    if (sess.messages.some((m) => matchesCompletedOrRecoveredCmid(m, cmid))) return true;
  }
  if (sess._sendingInFlight) return false;
  if (!cmid) return sess.messages.some(isCompletedTapeAssistant);
  const userIdx = sess.messages.findIndex((m) => m.role === "user" && m.id === cmid);
  if (userIdx < 0) return sess.messages.some(isCompletedTapeAssistant);
  return sess.messages
    .slice(userIdx + 1)
    .some((m) => (m.role === "user" && m.id !== cmid) || isCompletedTapeAssistant(m));
}

function settleOrphanProcesses(sess: ChatSession, ownerId: string | undefined): void {
  for (const m of sess.messages) {
    if (m._completed || m._background || isImmutableTapeViewportRow(m)) continue;
    if (ownerId && m._turnOwnerId && m._turnOwnerId !== ownerId) continue;
    if (m.role === "tool" && m._completed === false && !m.error) {
      m._completed = true;
      if (!m.output && !m.bashTail) m.cancelled = true;
    } else if (m.role === "agent-group" || m.role === "delegate-progress") {
      m._completed = true;
      m.cancelled = true;
      m.completedAt ??= Date.now();
    }
  }
}

function commitTerminalErrorRowIfNeeded(
  sess: ChatSession,
  paint: DeferredTerminalErrorPaint,
  silent: boolean,
  keepQuietStopLine: boolean,
): boolean {
  const alreadyCommitted = paint.clientMessageId
    ? sess.messages.some(
        (m) =>
          m.role === "assistant" &&
          m._clientMessageId === paint.clientMessageId &&
          m._errorCardSnapshot?.disposition === "card",
      )
    : false;
  const painted = !alreadyCommitted && (!silent || keepQuietStopLine);
  if (painted) {
    const msg = addMessage(sess, "assistant", paint.displayMessage ?? paint.text, {
      _errorCode: paint.normalized,
      _errorDetail: paint.detail,
      ...(paint.userError ? { _userError: paint.userError } : {}),
      ...(paint.clientMessageId ? { _clientMessageId: paint.clientMessageId } : {}),
      ...(paint.traceId ? { usage: { traceId: paint.traceId } } : {}),
    });
    commitErrorCardSnapshot(msg, paint.displayMessage);
  }
  return painted;
}

function teardownFailedActiveTurn(
  sess: ChatSession,
  paint: DeferredTerminalErrorPaint,
  userCancelled: boolean,
  silent: boolean,
): void {
  const ownsActiveTurn = paint.clientMessageId
    ? sess._activeClientMessageId === paint.clientMessageId
    : true;
  if (!ownsActiveTurn) return;
  settleOrphanProcesses(sess, paint.clientMessageId ?? sess._activeClientMessageId);
  sess._sendingInFlight = false;
  sess._activeClientMessageId = undefined;
  clearTurnTiming(sess);
  resetReplyTracker(sess);
  sess._localTeardownAt = sess._trackerResetAt;
  if (userCancelled || silent) resolveGenPlaceholders(sess);
  else failGenPlaceholders(sess, errorLabel(paint.normalized));
}

function markTerminalErrorUserStatus(
  sess: ChatSession,
  paint: DeferredTerminalErrorPaint,
  userCancelled: boolean,
  silent: boolean,
): void {
  if (paint.clientMessageId) {
    const exactUser = sess.messages.find(
      (m) => m?.role === "user" && m.id === paint.clientMessageId,
    );
    if (exactUser) exactUser.status = userCancelled || silent ? "sent" : "error";
    return;
  }
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const m = sess.messages[i];
    if (m?.role !== "user") continue;
    if (userCancelled) {
      if (m.status === "sending" || m.status === "queued") m.status = "sent";
      break;
    }
    if (m.status === "sending" || m.status === "sent" || m.status === "queued") {
      m.status = "error";
      break;
    }
  }
}

function paintTerminalError(
  sess: ChatSession,
  paint: DeferredTerminalErrorPaint,
  userCancelled: boolean,
): boolean {
  const silent = isSilentTurnErrorCode(paint.normalized);
  const keepQuietStopLine =
    paint.normalized === "stopped" || paint.normalized === "user_cancelled";
  const painted = commitTerminalErrorRowIfNeeded(sess, paint, silent, keepQuietStopLine);
  teardownFailedActiveTurn(sess, paint, userCancelled, silent);
  markTerminalErrorUserStatus(sess, paint, userCancelled, silent);
  return painted;
}

function releaseHeldNonAssistantErrorCards(sess: ChatSession, cmid: string): void {
  for (const m of sess.messages) {
    if (m._clientMessageId !== cmid || m._errorHeldForRecovery !== true || m.role === "assistant") {
      continue;
    }
    m._errorHeldForRecovery = undefined;
    commitErrorCardSnapshot(m);
  }
}

/**
 * 延后红卡的物化入口(socket 在 `sys.recovery_decision{scheduled:false}` 或宽限超时时调用)。
 */
export function paintDeferredTerminalError(
  sess: ChatSession,
  paint: DeferredTerminalErrorPaint,
  effects: FrameEffects = {},
): boolean {
  const cmid = paint.clientMessageId;
  if (cmid) {
    const adopted = sess.messages.some(
      (m) =>
        m.role === "user" &&
        m._automaticRecovery === true &&
        m._recoveryOfClientMessageId === cmid &&
        (m._source === "server" || !!m._turnTapeId),
    );
    if (adopted) return false;
    releaseHeldNonAssistantErrorCards(sess, cmid);
    const existing = sess.messages.find(
      (m) => m.role === "assistant" && m._clientMessageId === cmid && !!m._errorCode,
    );
    if (existing?._errorCardSnapshot?.disposition === "card") return false;
    if (existing) {
      existing._errorHeldForRecovery = undefined;
      if (paint.userError && !existing._userError) existing._userError = paint.userError;
      if (paint.displayMessage) existing.text = paint.displayMessage;
      const disposition = commitErrorCardSnapshot(existing, paint.displayMessage);
      paintTerminalError(sess, paint, false);
      effects.persistSession?.(sess.id);
      return disposition === "card";
    }
    if (sess.messages.some((m) => m._clientMessageId === cmid && isCompletedTapeAssistant(m))) {
      return false;
    }
  }
  paintTerminalError(sess, paint, false);
  effects.persistSession?.(sess.id);
  return true;
}

function problemCardRootCmid(sess: ChatSession, cmid: string | undefined): string | undefined {
  if (!cmid) return undefined;
  const source = sess.messages.find((m) => m.role === "user" && m.id === cmid);
  const root = source?._automaticRecoveryRootClientMessageId;
  if (typeof root === "string" && root.length > 0) return root;
  return cmid;
}

/** 软状态「模型繁忙,正在重试中(n/10)」:保持 `_sendingInFlight`,只把 `_turnStatus` 切到 retrying。 */
export function enterDeferredRecoverySoftState(
  sess: ChatSession,
  clientMessageId: string | undefined,
): void {
  const source = clientMessageId
    ? sess.messages.find((m) => m.role === "user" && m.id === clientMessageId)
    : undefined;
  if (source && source.status !== "replied") source.status = "sent";
  const sourceAttempt =
    typeof source?._automaticRecoveryAttempt === "number" &&
    Number.isSafeInteger(source._automaticRecoveryAttempt) &&
    source._automaticRecoveryAttempt >= 1
      ? source._automaticRecoveryAttempt
      : 0;
  const attempt = Math.min(sourceAttempt + 1, AUTOMATIC_TURN_RETRY_MAX);
  sess._sendingInFlight = true;
  if (clientMessageId && !sess._activeClientMessageId) {
    sess._activeClientMessageId = clientMessageId;
  }
  sess._streamingAssistant = null;
  sess._streamingThinking = null;
  sess._turnStatus = {
    kind: "retrying",
    attempt,
    max: AUTOMATIC_TURN_RETRY_MAX,
    retryAt: Date.now(),
  };
}

function committedErrorCard(sess: ChatSession, clientMessageId: string | undefined): boolean {
  if (!clientMessageId) return false;
  return sess.messages.some(
    (message) =>
      message.role === "assistant" &&
      message._clientMessageId === clientMessageId &&
      message._errorCardSnapshot?.disposition === "card",
  );
}

function automaticRecoveryCancelFenced(
  sess: ChatSession,
  clientMessageId: string | undefined,
): boolean {
  if (!clientMessageId) return false;
  const fence = sess._cancelledAutomaticRecoveryIds;
  if (!fence) return false;
  if (fence[clientMessageId] === true) return true;
  const root = problemCardRootCmid(sess, clientMessageId);
  return !!root && root !== clientMessageId && fence[root] === true;
}

function settleCancelFencedTerminalError(
  sess: ChatSession,
  paint: DeferredTerminalErrorPaint,
  effects: FrameEffects,
): void {
  const targetCmid = paint.clientMessageId ?? sess._activeClientMessageId;
  effects.discardDeferredTerminalError?.(sess.id, targetCmid);
  if (targetCmid && sess._deferredTerminalErrorClientMessageId === targetCmid) {
    sess._deferredTerminalErrorClientMessageId = undefined;
  }
  if (
    (targetCmid && sess._activeClientMessageId === targetCmid) ||
    (!targetCmid && sess._sendingInFlight)
  ) {
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
    clearTurnTiming(sess);
    resetReplyTracker(sess);
    sess._localTeardownAt = sess._trackerResetAt;
    resolveGenPlaceholders(sess);
  }
  const exactUser = targetCmid
    ? sess.messages.find((message) => message?.role === "user" && message.id === targetCmid)
    : undefined;
  if (exactUser && exactUser.status !== "replied") exactUser.status = "sent";
  effects.settleCancelFencedStop?.(sess, targetCmid);
  effects.persistSession?.(sess.id);
}

function emitTurnErrorTelemetry(
  sess: ChatSession,
  normalized: string,
  traceId: string | undefined,
  reportMessage: string | undefined,
  effects: FrameEffects,
): void {
  if (reportMessage !== undefined && !REPORT_EXEMPT_TURN_ERR_CODES.has(normalized)) {
    effects.reportTurnError?.({
      code: normalized,
      message: `${normalized}: ${reportMessage}`,
      traceId,
      sessionId: sess.id,
    });
  }
}

function dispatchTerminalErrorPaint(
  sess: ChatSession,
  paint: DeferredTerminalErrorPaint,
  effects: FrameEffects,
  terminalDecision: boolean,
  reportMessage?: string,
): void {
  const { normalized, clientMessageId, traceId } = paint;
  const userCancelled = normalized === "stopped" || normalized === "user_cancelled";
  const activeOrFrameCmid = clientMessageId ?? sess._activeClientMessageId;
  if (terminalDecision || isSilentTurnErrorCode(normalized)) {
    effects.discardDeferredTerminalError?.(sess.id, clientMessageId);
  }
  if (
    !userCancelled &&
    automaticRecoveryCancelFenced(sess, activeOrFrameCmid) &&
    !committedErrorCard(sess, clientMessageId)
  ) {
    settleCancelFencedTerminalError(sess, paint, effects);
    return;
  }
  const canRecover = !terminalDecision && supportsAutomaticTurnRecovery(normalized);
  if (!userCancelled && canRecover && effects.deferTerminalErrorForRecovery?.(sess.id, paint) === true) {
    sess._deferredTerminalErrorClientMessageId = activeOrFrameCmid;
    enterDeferredRecoverySoftState(sess, activeOrFrameCmid);
    effects.persistSession?.(sess.id);
    const deferredRoot = problemCardRootCmid(sess, activeOrFrameCmid);
    if (deferredRoot) {
      effects.reportProblemCard?.(sess.id, {
        rootCmid: deferredRoot,
        code: normalized,
        outcome: "pending",
        path: "deferred",
        presentation: "soft",
        attempts: 1,
        traceId,
      });
    }
    emitTurnErrorTelemetry(sess, normalized, traceId, reportMessage, effects);
    return;
  }
  const immediateRoot = problemCardRootCmid(sess, activeOrFrameCmid);
  const painted = paintTerminalError(sess, paint, userCancelled);
  effects.persistSession?.(sess.id);
  if (painted && !isSilentTurnErrorCode(normalized) && immediateRoot) {
    effects.reportProblemCard?.(sess.id, {
      rootCmid: immediateRoot,
      code: normalized,
      outcome: "failed",
      path: "immediate",
      presentation: problemCardPresentation(normalized, false),
      traceId,
    });
  }
  emitTurnErrorTelemetry(sess, normalized, traceId, reportMessage, effects);
  if (normalized === "insufficient_credits") effects.refreshBalance?.();
  if (canRecover) effects.scheduleAutomaticRecovery?.(sess.id, clientMessageId);
}

export function applyOutboundError(
  sess: ChatSession,
  frame: OutboundErrorWire,
  effects: FrameEffects = {},
): void {
  if (shouldSuppressStaleOutboundError(sess, frame)) return;
  if (typeof frame.frameSeq === "number" && frame.frameSeq > 0) {
    if (!acceptFrameSeq(sess, frame)) return;
    sess._suppressErrorBubbleAtSeq = frame.frameSeq + 1;
  }
  const normalized =
    normalizeBridgeErrorCode(frame.code) === "upstream_failed" && frame.detail === "本轮已由用户停止。"
      ? "user_cancelled"
      : normalizeBridgeErrorCode(frame.code);
  const userError = readUserError(frame.userError);
  dispatchTerminalErrorPaint(
    sess,
    {
      normalized,
      text: friendlyBridgeErrorMessage(normalized, frame.message || "出错了"),
      detail: safeBridgeErrorDetail(normalized, frame.traceId),
      ...(frame.clientMessageId ? { clientMessageId: frame.clientMessageId } : {}),
      ...(typeof frame.traceId === "string" && frame.traceId ? { traceId: frame.traceId } : {}),
      ...(userError ? { userError } : {}),
    },
    effects,
    frame.recoveryDisposition === "terminal",
    frame.message || frame.detail || "",
  );
}

export function applyLegacyBridgeError(
  sess: ChatSession,
  frame: LegacyBridgeErrorWire,
  effects: FrameEffects = {},
): void {
  if (isBridgeAuthControlError(frame.code)) {
    effects.onAuthControlError?.();
    return;
  }
  const normalized = normalizeBridgeErrorCode(frame.code);
  const userError = readUserError(frame.userError);
  dispatchTerminalErrorPaint(
    sess,
    {
      normalized,
      text: friendlyBridgeErrorMessage(frame.code, frame.message),
      detail: safeBridgeErrorDetail(frame.code, frame.traceId),
      ...(frame.clientMessageId ? { clientMessageId: frame.clientMessageId } : {}),
      ...(typeof frame.traceId === "string" && frame.traceId ? { traceId: frame.traceId } : {}),
      ...(userError ? { userError } : {}),
    },
    effects,
    false,
  );
}

export function applyResumeFailed(
  sess: ChatSession,
  frame: OutboundResumeFailedWire,
  effects: FrameEffects = {},
): void {
  const frameTo = typeof frame.to === "number" ? frame.to : 0;
  if (frameTo === 0 && frame.reason === "no_buffer") {
    resetFrameSeqCursor(sess, frame);
  } else {
    advanceFrameSeqCursorTo(sess, frame, frameTo);
  }
  effects.persistSession?.(sess.id);
  effects.forceSync?.(sess.id);
}

/** Evidence-based advisory line from the billing audit. */
export const TURN_COST_REMINDER_CREDITS = 500n;

export function safeBigIntOrZero(raw: string | null | undefined): bigint {
  try {
    return BigInt(raw || "0");
  } catch {
    return 0n;
  }
}

function parseNonNegativeBigInt(raw: string | null | undefined): bigint | null {
  if (raw === undefined || raw === null) return null;
  try {
    const parsed = BigInt(raw);
    return parsed < 0n ? null : parsed;
  } catch {
    return null;
  }
}

function applyTurnCostReminder(
  sess: ChatSession,
  requestId: string | undefined,
  actualDebit: bigint | null,
): void {
  if (!sess._sendingInFlight || !requestId || actualDebit === null || actualDebit <= 0n) return;
  const seen = sess._turnCostSeenRequestIds ?? new Set<string>();
  if (seen.has(requestId)) return;
  seen.add(requestId);
  sess._turnCostSeenRequestIds = seen;
  const cumulative = actualDebit + safeBigIntOrZero(sess._turnCostCredits);
  sess._turnCostCredits = cumulative.toString();
  if (cumulative >= TURN_COST_REMINDER_CREDITS) {
    sess._turnCostReminderCredits = cumulative.toString();
  }
}

function recordCostChargedRequestAndTurnCredits(
  sess: ChatSession,
  requestId: string | undefined,
  add: bigint | null,
): boolean {
  if (requestId && add !== null) {
    const seen = (sess._costChargedSeenRequestIds ??= new Set<string>());
    if (seen.has(requestId)) return false;
    seen.add(requestId);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
  }
  applyTurnCostReminder(sess, requestId, add);
  const activeCmid = sess._activeClientMessageId;
  if (sess._sendingInFlight && activeCmid && add !== null) {
    const previous =
      sess._turnCredits?.clientMessageId === activeCmid ? sess._turnCredits : undefined;
    const settled = add + safeBigIntOrZero(previous?.settled);
    const now = Date.now();
    sess._turnCredits = {
      clientMessageId: activeCmid,
      settled: settled.toString(),
      requests: (previous?.requests ?? 0) + 1,
      asOf: now,
      receivedAt: now,
    };
  }
  return true;
}

function findCostChargedTarget(sess: ChatSession, frame: CostChargedWire): ChatMessage | null {
  if (sess._streamingAssistant) return sess._streamingAssistant;
  const isDelegateInFlight = !!frame.parentSessionId && sess._sendingInFlight;
  if (
    !isDelegateInFlight &&
    sess._lastFinaledAssistantId &&
    sess._lastFinaledAt &&
    Date.now() - sess._lastFinaledAt < COST_CHARGED_LAST_FINAL_TTL_MS
  ) {
    return sess.messages.find((m) => m.id === sess._lastFinaledAssistantId) || null;
  }
  return null;
}

export function applyCostCharged(
  sess: ChatSession | null,
  frame: CostChargedWire,
  effects: FrameEffects = {},
): void {
  const refresh = () => {
    if (frame.balanceAfter !== undefined && frame.balanceAfter !== null) effects.refreshBalance?.();
  };
  if (!sess) {
    refresh();
    return;
  }
  const add = parseNonNegativeBigInt(frame.debitedCredits ?? frame.costCredits);
  const requestId = frame.requestId?.trim();
  if (!recordCostChargedRequestAndTurnCredits(sess, requestId, add)) {
    refresh();
    return;
  }
  const target = findCostChargedTarget(sess, frame);
  if (!target) {
    if (sess._sendingInFlight && add !== null) {
      sess._pendingCostCredits = (safeBigIntOrZero(sess._pendingCostCredits) + add).toString();
    }
    refresh();
    return;
  }
  if (!target.usage) {
    if (add !== null) {
      sess._pendingCostCredits = (safeBigIntOrZero(sess._pendingCostCredits) + add).toString();
    }
    refresh();
    return;
  }
  if (add !== null) {
    const cur = safeBigIntOrZero(target.usage.costCredits);
    target.usage = { ...target.usage, costCredits: (cur + add).toString() };
  }
  refresh();
}

export function applyCostWaived(
  sess: ChatSession | null,
  frame: CostWaivedWire,
  effects: FrameEffects = {},
): void {
  if (frame.balanceAfter !== undefined && frame.balanceAfter !== null) effects.refreshBalance?.();
  if (!sess) return;
  if (typeof frame.turnKey !== "string" || !/^[0-9a-f]{64}$/.test(frame.turnKey)) return;
  let target: ChatMessage | undefined;
  for (let index = sess.messages.length - 1; index >= 0; index--) {
    const message = sess.messages[index];
    if (message.role === "assistant" && message._turnKey === frame.turnKey) {
      target = message;
      break;
    }
  }
  if (!target) {
    effects.forceSync?.(sess.id);
    return;
  }
  target.usage = { ...target.usage, waived: true };
}
