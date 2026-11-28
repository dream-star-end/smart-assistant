import {
  AUTOMATIC_TURN_RETRY_MAX,
  isClientMessageId,
  normalizeTurnErrorCode,
} from "@openclaude/protocol/browser";
import type { AckWire, OutboundMessageWire, RecoveryDecisionWire } from "../frames";
import type { ChatSession } from "../model";
import {
  friendlyBridgeErrorMessage,
  isRecoveryControlUserTurn,
  problemCardPresentation,
  REPORT_EXEMPT_TURN_ERR_CODES,
} from "../pure";
import { recoverySkippedNotice } from "../recoveryNotices.js";
import {
  paintDeferredTerminalError,
  type ProblemCardMaterializeCause,
  type ProblemCardReport,
} from "../reducer";
import { rememberRetryStatus } from "../retryStatus";
import {
  RECOVERY_ADOPTION_GRACE_MS,
  type PendingRecoveryErrorEntry,
  type SocketCtx,
} from "./types";

export function problemCardRootCmid(
  sess: ChatSession,
  cmid: string | undefined,
): string | undefined {
  if (!cmid) return undefined;
  const source = sess.messages.find((m) => m.role === "user" && m.id === cmid);
  const root = source?._automaticRecoveryRootClientMessageId;
  return typeof root === "string" && root.length > 0 ? root : cmid;
}

export function stashProblemCardSourceCodeInSocket(
  ctx: SocketCtx,
  sessId: string,
  cmid: string | undefined,
  code: string,
): void {
  if (!cmid || !code) return;
  ctx.problemCardSourceCodes.set(`${sessId}:${cmid}`, code);
  const sess = ctx.sessions.get(sessId);
  const root = sess ? problemCardRootCmid(sess, cmid) : undefined;
  if (root && root !== cmid) ctx.problemCardSourceCodes.set(`${sessId}:${root}`, code);
}

function lookupProblemCardSourceCode(
  ctx: SocketCtx,
  sess: ChatSession,
  sourceCmid: string,
  rootCmid: string,
): string | undefined {
  const cardFor = (cmid: string): string | undefined => {
    const card = sess.messages.find(
      (m) =>
        m.role === "assistant" &&
        m._clientMessageId === cmid &&
        typeof m._errorCode === "string" &&
        Boolean(m._errorCode),
    );
    return card?._errorCode;
  };
  return (
    cardFor(sourceCmid) ??
    cardFor(rootCmid) ??
    ctx.problemCardSourceCodes.get(`${sess.id}:${sourceCmid}`) ??
    ctx.problemCardSourceCodes.get(`${sess.id}:${rootCmid}`)
  );
}

function isProblemCardErrorFinal(
  sess: ChatSession,
  frame: OutboundMessageWire,
  clientMessageId?: string,
): boolean {
  if ((frame as { isError?: boolean }).isError === true) return true;
  if (typeof frame.meta?.interrupted === "string" && frame.meta.interrupted.length > 0) return true;
  const blocks = frame.blocks;
  if (
    Array.isArray(blocks) &&
    blocks.length === 1 &&
    blocks[0]?.kind === "text" &&
    typeof (blocks[0] as { text?: unknown }).text === "string" &&
    (blocks[0] as { text: string }).text.startsWith("[error]")
  ) {
    return true;
  }
  if (!clientMessageId) return false;
  return sess.messages.some(
    (m) => m.role === "assistant" && m._clientMessageId === clientMessageId && Boolean(m._errorCode),
  );
}

export function reportProblemCardInSocket(
  ctx: SocketCtx,
  sessId: string,
  p: ProblemCardReport,
): void {
  const code = normalizeTurnErrorCode(p.code);
  if (!code || REPORT_EXEMPT_TURN_ERR_CODES.has(code)) return;
  if (code === "stopped" || code === "user_cancelled" || !p.rootCmid) return;
  const key = `${sessId}:${p.rootCmid}:${p.outcome}:${p.path}`;
  if (ctx.reportedProblemCards.has(key)) return;
  ctx.reportedProblemCards.add(key);
  const reason =
    typeof p.reason === "string" && /^[a-z0-9_]{1,48}$/.test(p.reason) ? p.reason : undefined;
  const validAttempts =
    typeof p.attempts === "number" &&
    Number.isSafeInteger(p.attempts) &&
    p.attempts >= 1 &&
    p.attempts <= 32;
  ctx.deps.reportProblemCard?.({
    sessionId: sessId,
    rootCmid: p.rootCmid,
    code,
    outcome: p.outcome,
    path: p.path,
    presentation: p.presentation,
    ...(reason ? { reason } : {}),
    ...(validAttempts ? { attempts: p.attempts } : {}),
    ...(p.traceId ? { traceId: p.traceId } : {}),
  });
}

export function reportRecoveredProblemCardInSocket(
  ctx: SocketCtx,
  sess: ChatSession,
  frame: OutboundMessageWire,
  clientMessageId?: string,
): void {
  const cmid = clientMessageId ?? frame.clientMessageId;
  if (!cmid) return;
  const user = sess.messages.find((m) => m.role === "user" && m.id === cmid);
  if (!user || user._automaticRecovery !== true || typeof user._recoveryOfClientMessageId !== "string") {
    return;
  }
  if (isProblemCardErrorFinal(sess, frame, cmid)) return;
  const sourceCmid = user._recoveryOfClientMessageId;
  const rootCmid =
    typeof user._automaticRecoveryRootClientMessageId === "string" &&
    user._automaticRecoveryRootClientMessageId.length > 0
      ? user._automaticRecoveryRootClientMessageId
      : sourceCmid;
  const code = lookupProblemCardSourceCode(ctx, sess, sourceCmid, rootCmid);
  if (!code) return;
  const attempts =
    typeof user._automaticRecoveryAttempt === "number" &&
    Number.isSafeInteger(user._automaticRecoveryAttempt) &&
    user._automaticRecoveryAttempt >= 1
      ? user._automaticRecoveryAttempt
      : 1;
  reportProblemCardInSocket(ctx, sess.id, {
    rootCmid,
    code,
    outcome: "recovered",
    path: "recovery_adopted",
    presentation: "soft",
    attempts,
  });
}

export function applyRecoveryDecisionFrame(ctx: SocketCtx, frame: RecoveryDecisionWire): void {
  const sessId = frame.peer?.id;
  if (!sessId) return;
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  rememberRetryStatus(sess, frame, frame.retryStatus, frame.ts);
  const pending = ctx.pendingRecoveryErrors.get(sessId);
  const matchesPending =
    Boolean(pending) &&
    (!pending?.clientMessageId || pending.clientMessageId === frame.sourceClientMessageId);
  if (frame.scheduled) {
    if (matchesPending && pending) {
      clearTimeout(pending.timer);
      pending.decided = true;
      pending.timer = setTimeout(
        () => ctx.verifyDeferredRecovery(sessId, "adoption_timeout"),
        RECOVERY_ADOPTION_GRACE_MS,
      );
    }
    if (
      sess._sendingInFlight &&
      (matchesPending || sess._activeClientMessageId === frame.sourceClientMessageId)
    ) {
      const attempt =
        Number.isSafeInteger(frame.attempt) && frame.attempt >= 1
          ? Math.min(frame.attempt, AUTOMATIC_TURN_RETRY_MAX)
          : 1;
      sess._turnStatus = {
        kind: "retrying",
        attempt,
        max: AUTOMATIC_TURN_RETRY_MAX,
        retryAt: Date.now(),
      };
      ctx.scheduleNotify();
    }
    return;
  }
  sess._automaticRecoveryDecisions = {
    ...(sess._automaticRecoveryDecisions ?? {}),
    [frame.sourceClientMessageId]: true,
  };
  ctx.deps.persistSession?.(sessId);
  if (matchesPending) {
    const reason =
      typeof frame.reason === "string" && /^[a-z0-9_]{1,48}$/.test(frame.reason)
        ? frame.reason
        : undefined;
    ctx.materializePendingRecoveryError(sessId, "decision_declined", reason);
  }
}

export function settlePendingRecoveryErrorInSocket(
  ctx: SocketCtx,
  sessId: string,
  sourceClientMessageId: string | undefined,
  outcome: "adopted" | "declined",
  cause?: ProblemCardMaterializeCause,
  reason?: string,
): void {
  const pending = ctx.pendingRecoveryErrors.get(sessId);
  if (!pending) return;
  if (
    pending.clientMessageId &&
    sourceClientMessageId &&
    pending.clientMessageId !== sourceClientMessageId
  ) {
    return;
  }
  if (outcome === "declined") {
    ctx.materializePendingRecoveryError(sessId, cause ?? "recovery_skipped", reason);
    return;
  }
  stashProblemCardSourceCodeInSocket(ctx, sessId, pending.clientMessageId, pending.paint.normalized);
  clearTimeout(pending.timer);
  ctx.pendingRecoveryErrors.delete(sessId);
  const sess = ctx.sessions.get(sessId);
  if (sess) sess._deferredTerminalErrorClientMessageId = undefined;
}

export function discardDeferredTerminalErrorInSocket(
  ctx: SocketCtx,
  sessId: string,
  clientMessageId?: string,
): void {
  const pending = ctx.pendingRecoveryErrors.get(sessId);
  if (!pending) return;
  if (pending.clientMessageId && clientMessageId && pending.clientMessageId !== clientMessageId) {
    return;
  }
  clearTimeout(pending.timer);
  ctx.pendingRecoveryErrors.delete(sessId);
  const sess = ctx.sessions.get(sessId);
  if (sess && (!clientMessageId || sess._deferredTerminalErrorClientMessageId === clientMessageId)) {
    sess._deferredTerminalErrorClientMessageId = undefined;
  }
}

export function verifyDeferredRecoveryTimeout(
  ctx: SocketCtx,
  sessId: string,
  cause: "decision_timeout" | "adoption_timeout",
): void {
  const pending = ctx.pendingRecoveryErrors.get(sessId);
  if (!pending) return;
  if (!ctx.deps.readSessionSnapshot) {
    ctx.materializePendingRecoveryError(sessId, cause);
    return;
  }
  void ctx.fetchSessionSnapshot(sessId, { verifyOnly: true }).then((snap) => {
    if (ctx.pendingRecoveryErrors.get(sessId) !== pending) return;
    const d = snap?.dispatch;
    const childRunning =
      Boolean(d) &&
      d?.clientMessageId !== pending.clientMessageId &&
      (d?.status === "admitted" || d?.status === "accepted" || d?.status === "rejecting");
    if (snap === undefined || childRunning) {
      pending.timer = setTimeout(
        () => ctx.verifyDeferredRecovery(sessId, cause),
        RECOVERY_ADOPTION_GRACE_MS,
      );
      return;
    }
    ctx.materializePendingRecoveryError(sessId, cause);
  });
}

function materializeStopFencedRecovery(
  ctx: SocketCtx,
  sessId: string,
  sess: ChatSession,
  pending: PendingRecoveryErrorEntry,
  wasActive: boolean,
): void {
  if (wasActive) {
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
    sess._turnStatus = null;
    ctx.kickQueuedDrainIfIdle();
  }
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
  const rootCmid = problemCardRootCmid(sess, pending.clientMessageId);
  if (rootCmid) {
    reportProblemCardInSocket(ctx, sessId, {
      rootCmid,
      code: pending.paint.normalized,
      outcome: "cancelled",
      path: "stop_fenced",
      presentation: "soft",
      traceId: pending.paint.traceId,
    });
  }
}

export function materializePendingRecoveryErrorInSocket(
  ctx: SocketCtx,
  sessId: string,
  cause: ProblemCardMaterializeCause,
  reason?: string,
): void {
  const pending = ctx.pendingRecoveryErrors.get(sessId);
  if (!pending) return;
  clearTimeout(pending.timer);
  ctx.pendingRecoveryErrors.delete(sessId);
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  sess._deferredTerminalErrorClientMessageId = undefined;
  const wasActive =
    sess._sendingInFlight === true &&
    (!pending.clientMessageId || sess._activeClientMessageId === pending.clientMessageId);
  if (cause === "stop_fenced") {
    materializeStopFencedRecovery(ctx, sessId, sess, pending, wasActive);
    return;
  }
  const painted = paintDeferredTerminalError(sess, pending.paint, ctx.effects());
  if (wasActive && !sess._sendingInFlight) {
    ctx.kickQueuedDrainIfIdle();
  }
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
  if (!painted) return;
  const code = pending.paint.normalized;
  const rootCmid = problemCardRootCmid(sess, pending.clientMessageId);
  if (!rootCmid) return;
  reportProblemCardInSocket(ctx, sessId, {
    rootCmid,
    code,
    outcome: "failed",
    path: cause,
    presentation: problemCardPresentation(code, false),
    ...(reason ? { reason } : {}),
    traceId: pending.paint.traceId,
  });
}

function restoreFailedSourceAfterSkippedRecovery(
  sess: ChatSession,
  sourceClientMessageId: string | undefined,
): void {
  if (!sourceClientMessageId) return;
  const sourceUser = sess.messages.find(
    (message) => message.role === "user" && message.id === sourceClientMessageId,
  );
  if (!sourceUser || sourceUser.status !== "sent" || sourceUser._automaticRecoveryAttempted !== true) {
    return;
  }
  const childLeft = sess.messages.some(
    (message) =>
      message.role === "user" &&
      message._automaticRecovery === true &&
      (message._recoveryOfClientMessageId === sourceClientMessageId ||
        message._continuationOfClientMessageId === sourceClientMessageId),
  );
  if (childLeft) return;
  const failed = sess.messages.some(
    (message) =>
      message.role === "assistant" &&
      message._clientMessageId === sourceClientMessageId &&
      Boolean(message._errorCode),
  );
  if (failed) sourceUser.status = "error";
}

function attachSkippedNoticeToErrorRows(
  sess: ChatSession,
  sourceClientMessageId: string,
  skipNotice: string,
): boolean {
  let attached = false;
  for (const message of sess.messages) {
    if (
      message.role !== "assistant" ||
      !message._errorCode ||
      message._clientMessageId !== sourceClientMessageId
    ) {
      continue;
    }
    message._recoverySkippedNotice = skipNotice;
    if (typeof message._errorCode === "string" && message._errorCode.trim()) {
      sess._recoveryRejectedNotices = {
        ...(sess._recoveryRejectedNotices ?? {}),
        [sourceClientMessageId]: {
          code: normalizeTurnErrorCode(message._errorCode),
          notice: skipNotice,
        },
      };
    }
    attached = true;
  }
  return attached;
}

function repaintSourceErrorIfUncommitted(
  ctx: SocketCtx,
  sess: ChatSession,
  sourceClientMessageId: string | undefined,
  attachedToError: boolean,
  hadCommittedCard: boolean,
): void {
  if (!attachedToError || hadCommittedCard || !sourceClientMessageId) return;
  const source = sess.messages.find(
    (message) =>
      message.role === "assistant" &&
      message._clientMessageId === sourceClientMessageId &&
      Boolean(message._errorCode),
  );
  if (!source) return;
  paintDeferredTerminalError(
    sess,
    {
      normalized: normalizeTurnErrorCode(source._errorCode),
      text: source.text || friendlyBridgeErrorMessage(source._errorCode),
      clientMessageId: sourceClientMessageId,
    },
    ctx.effects(),
  );
}

export function reconcileSkippedRecoveryAck(ctx: SocketCtx, frame: AckWire): boolean {
  const sessId = frame.peer?.id;
  const clientMessageId = frame.clientMessageId;
  if (!sessId || !clientMessageId) return false;
  const sess = ctx.sessions.get(sessId);
  if (!sess) return false;
  const sourceClientMessageId = isClientMessageId(frame.sourceClientMessageId)
    ? frame.sourceClientMessageId
    : undefined;
  const skipNotice = recoverySkippedNotice(frame.recoverySkippedReason);
  const hadCommittedCard = sourceClientMessageId
    ? sess.messages.some(
        (message) =>
          message.role === "assistant" &&
          message._clientMessageId === sourceClientMessageId &&
          message._errorCardSnapshot?.disposition === "card",
      )
    : false;
  const pendingPaint = ctx.pendingRecoveryErrors.get(sessId);
  if (
    !hadCommittedCard &&
    pendingPaint &&
    (!pendingPaint.clientMessageId || pendingPaint.clientMessageId === sourceClientMessageId)
  ) {
    pendingPaint.paint = { ...pendingPaint.paint, displayMessage: skipNotice };
  }
  ctx.settlePendingRecoveryError(sessId, sourceClientMessageId, "declined", "recovery_skipped");
  if (sourceClientMessageId) {
    sess._automaticRecoveryDecisions = {
      ...(sess._automaticRecoveryDecisions ?? {}),
      [sourceClientMessageId]: true,
    };
  }
  const attachedToError = sourceClientMessageId
    ? attachSkippedNoticeToErrorRows(sess, sourceClientMessageId, skipNotice)
    : false;
  if (!attachedToError) {
    ctx.transientNotices.set(sessId, { text: skipNotice, ts: Date.now() });
  }
  const userIndex = sess.messages.findIndex(
    (message) => message.id === clientMessageId && isRecoveryControlUserTurn(message),
  );
  if (userIndex < 0) {
    restoreFailedSourceAfterSkippedRecovery(sess, sourceClientMessageId);
    ctx.deps.persistSession?.(sessId);
    ctx.scheduleNotify();
    return sourceClientMessageId !== undefined;
  }
  ctx.finishDispatch(sessId, clientMessageId);
  if (sess._activeClientMessageId === clientMessageId) {
    ctx.clearSendingState(sess, { persist: false });
  }
  sess.messages = sess.messages.filter(
    (message, index) =>
      index !== userIndex && message._genPlaceholder?.afterUserMsgId !== clientMessageId,
  );
  repaintSourceErrorIfUncommitted(
    ctx,
    sess,
    sourceClientMessageId,
    attachedToError,
    hadCommittedCard,
  );
  restoreFailedSourceAfterSkippedRecovery(sess, sourceClientMessageId);
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
  return true;
}
