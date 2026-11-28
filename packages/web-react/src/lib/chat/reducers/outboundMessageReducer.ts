/**
 * `outbound.message` main bus lifecycle guards, reply-tracker state, and `isFinal` turn settlement.
 */
import type { OutboundContentBlock, OutboundMessageWire } from "../frames";
import {
  addMessage,
  type ChatMessage,
  type ChatSession,
  clearTurnTiming,
  isEngineStartupTurnStatus,
  isRetryingTurnStatus,
  markFrameReceived,
  rebuildIndexes,
  resetReplyTracker,
  trackServerTs,
} from "../model";
import { repairPostFinalProcessOrder } from "../order";
import {
  classifyEmptyTurn,
  countAnswerBlocks,
  MODEL_THINKING_WORKING_DETAIL,
  shouldAutoContinueEmptyTurn,
} from "../pure";
import { finalizeSwarmMessageOnTurnEnd } from "../swarmReducer";
import {
  acceptFrameSeq,
  isFrozenLiveTarget,
  isImmutableTapeViewportRow,
} from "./frameSeqCursor";
import { extractImageEditJobId, resolveGenPlaceholders } from "./goalPlanGenReducer";
import { accumulateLiveFrameEstimatedBytes } from "./liveUsageEstimator";
import { applyOutboundContentBlocks } from "./outboundBlockHandlers";
import { safeBigIntOrZero } from "./turnErrorAndCostReducer";
import type { FrameEffects } from "./types";

/** teardown 后非 final 帧的压制时间窗(客户端同域):覆盖 stop 后 server 收尾期,不无界压制多端新 turn。*/
const TEARDOWN_DROP_WINDOW_MS = 3 * 60_000;

type DeferredEmptyNotice = {
  targetMsgId: string;
  stopReason?: string;
  hadAnswerLookahead: boolean;
};

function clearActiveStreamAndInFlight(sess: ChatSession): void {
  sess._streamingAssistant = null;
  sess._streamingThinking = null;
  sess._sendingInFlight = false;
  sess._activeClientMessageId = undefined;
  clearTurnTiming(sess);
}

function checkCrossTurnMismatch(
  sess: ChatSession,
  frame: OutboundMessageWire,
  effects: FrameEffects,
): boolean {
  if (
    frame.clientMessageId &&
    sess._activeClientMessageId &&
    frame.clientMessageId !== sess._activeClientMessageId
  ) {
    if (frame.isFinal) effects.forceSync?.(sess.id, { clientMessageId: frame.clientMessageId });
    return true;
  }
  return false;
}

function handleReconcileTurnStateUnknown(
  sess: ChatSession,
  frame: OutboundMessageWire,
  effects: FrameEffects,
): boolean {
  if (frame.isFinal || frame.meta?.reconcile !== "turn_state_unknown") return false;
  markFrameReceived(sess);
  const clientMessageId = frame.clientMessageId ?? sess._activeClientMessageId;
  if (clientMessageId) effects.forceSync?.(sess.id, { clientMessageId });
  else effects.forceSync?.(sess.id);
  return true;
}

function isSuppressibleLegacyErrorTextFrame(
  sess: ChatSession,
  frame: OutboundMessageWire,
): boolean {
  if (
    sess._suppressErrorBubbleAtSeq === undefined ||
    typeof frame.frameSeq !== "number" ||
    frame.frameSeq !== sess._suppressErrorBubbleAtSeq ||
    !frame.isFinal ||
    !Array.isArray(frame.blocks) ||
    frame.blocks.length !== 1
  ) {
    return false;
  }
  const first = frame.blocks[0];
  if (first?.kind !== "text") return false;
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" && text.startsWith("[error]");
}

function resolveLegacyErrorTextSuppression(
  sess: ChatSession,
  frame: OutboundMessageWire,
  effects: FrameEffects,
): { suppressLegacyErrorText: boolean; shortCircuited: boolean } {
  const suppressLegacyErrorText = isSuppressibleLegacyErrorTextFrame(sess, frame);
  if (suppressLegacyErrorText) {
    sess._suppressErrorBubbleAtSeq = undefined;
  }
  if (
    suppressLegacyErrorText &&
    sess._deferredTerminalErrorClientMessageId !== undefined &&
    (!frame.clientMessageId ||
      frame.clientMessageId === sess._deferredTerminalErrorClientMessageId)
  ) {
    markFrameReceived(sess);
    effects.persistSession?.(sess.id);
    return { suppressLegacyErrorText, shortCircuited: true };
  }
  return { suppressLegacyErrorText, shortCircuited: false };
}

function handleServiceRestartOutOfBandSweep(
  sess: ChatSession,
  frame: OutboundMessageWire,
  effects: FrameEffects,
): boolean {
  if (!frame.isFinal || frame.meta?.interrupted !== "service_restart") return false;
  const hasQueuedUser = sess.messages.some((m) => m.role === "user" && m.status === "queued");
  const hasLiveStream =
    (!!sess._streamingAssistant && (sess._streamingAssistant.text ?? "").trim().length > 0) ||
    !!sess._streamingThinking;
  if (hasLiveStream && !hasQueuedUser) return false;

  const clientMessageId = frame.clientMessageId ?? sess._activeClientMessageId;
  clearActiveStreamAndInFlight(sess);
  resetReplyTracker(sess);
  sess.messages = repairPostFinalProcessOrder(sess.messages);
  effects.onFinal?.(sess, frame, false, clientMessageId);
  effects.scheduleAutomaticRecovery?.(sess.id, clientMessageId);
  return true;
}

function handleReconcileSyntheticFinal(
  sess: ChatSession,
  frame: OutboundMessageWire,
  effects: FrameEffects,
): boolean {
  if (
    !frame.isFinal ||
    (frame.meta?.reconcile !== "turn_completed" && frame.meta?.reconcile !== "interrupted")
  ) {
    return false;
  }
  const active = sess._activeClientMessageId;
  const frameCmid = frame.clientMessageId;
  if (frameCmid && active && frameCmid !== active) {
    effects.forceSync?.(sess.id, { clientMessageId: frameCmid });
    return true;
  }
  if (
    frame.meta?.reconcile === "turn_completed" &&
    frame.meta?.reconcileSource === "tape_commit" &&
    frameCmid &&
    frameCmid === active &&
    sess._sendingInFlight &&
    effects.deferTapeCommitFinal?.(sess.id, frame) === true
  ) {
    return true;
  }
  const clientMessageId = frameCmid ?? active;
  clearActiveStreamAndInFlight(sess);
  resetReplyTracker(sess);
  resolveGenPlaceholders(sess, extractImageEditJobId(frame));
  sess.messages = repairPostFinalProcessOrder(sess.messages);
  effects.onFinal?.(sess, frame, false, clientMessageId);
  if (clientMessageId) effects.forceSync?.(sess.id, { clientMessageId });
  else effects.forceSync?.(sess.id);
  return true;
}

function isStaleVsTrackerReset(sess: ChatSession, ts: number): boolean {
  return typeof sess._trackerResetServerTs === "number"
    ? ts <= sess._trackerResetServerTs
    : typeof sess._trackerResetAt === "number" && ts < sess._trackerResetAt;
}

function isStoppedTurnStreamSuppressed(sess: ChatSession, frame: OutboundMessageWire): boolean {
  if (frame.isFinal || frame.cronJob || !sess._stopSettlement) return false;
  return (
    !sess._stopSettlement.clientMessageId ||
    !frame.clientMessageId ||
    frame.clientMessageId === sess._stopSettlement.clientMessageId
  );
}

function shouldDropStoppedOrStaleFrame(
  sess: ChatSession,
  frame: OutboundMessageWire,
  suppressLegacyErrorText: boolean,
): boolean {
  if (isStoppedTurnStreamSuppressed(sess, frame)) return true;
  if (
    typeof frame.ts === "number" &&
    isStaleVsTrackerReset(sess, frame.ts) &&
    !suppressLegacyErrorText
  ) {
    return true;
  }
  if (
    !frame.isFinal &&
    !frame.cronJob &&
    !sess._sendingInFlight &&
    typeof sess._localTeardownAt === "number" &&
    Date.now() - sess._localTeardownAt < TEARDOWN_DROP_WINDOW_MS
  ) {
    return true;
  }
  return Boolean(
    sess._agentSwitchedAt &&
      !sess._sendingInFlight &&
      !frame.isFinal &&
      Date.now() - sess._agentSwitchedAt < 2000,
  );
}

function classifyOutboundLifecycleFrame(
  sess: ChatSession,
  frame: OutboundMessageWire,
): {
  hasBlocks: boolean;
  progressOnlyFrame: boolean;
  lifecycleSidebandFrame: boolean;
  frameTurnOwnerId: string | undefined;
} {
  let frameTurnOwnerId = frame.clientMessageId ?? sess._activeClientMessageId;
  const hasBlocks = Array.isArray(frame.blocks) && frame.blocks.length > 0;
  const nonFinalBlocks =
    !frame.isFinal && hasBlocks ? (frame.blocks as Array<{ kind?: string }>) : null;
  const tailOnlyFrame = !!nonFinalBlocks?.every((b) => b?.kind === "tool_output_tail");
  const progressOnlyFrame = !!nonFinalBlocks?.every(
    (b) => b?.kind === "delegate_progress" || b?.kind === "swarm_snapshot",
  );
  const leftoverProgressSideband =
    progressOnlyFrame &&
    (!sess._sendingInFlight || (!!sess._activeClientMessageId && !frame.clientMessageId));
  if (leftoverProgressSideband) frameTurnOwnerId = undefined;
  return {
    hasBlocks,
    progressOnlyFrame,
    lifecycleSidebandFrame: tailOnlyFrame || leftoverProgressSideband,
    frameTurnOwnerId,
  };
}

function shouldClearTurnProgressHint(
  hint: string | undefined,
  blocks: readonly OutboundContentBlock[],
): boolean {
  if (!hint) return false;
  if (hint === MODEL_THINKING_WORKING_DETAIL) {
    return blocks.some((b) => (b as { kind?: unknown }).kind !== "thinking");
  }
  if (hint.startsWith("子任务")) {
    return blocks.some((b) => {
      const k = (b as { kind?: unknown }).kind;
      return k !== "delegate_progress" && k !== "tool_output_tail";
    });
  }
  return false;
}

function activateLiveTurnAndHints(
  sess: ChatSession,
  frame: OutboundMessageWire,
  progressOnlyFrame: boolean,
  effects: FrameEffects,
): void {
  if (!frame.isFinal && !frame.cronJob && !sess._sendingInFlight) sess._sendingInFlight = true;
  if (
    !frame.isFinal &&
    !frame.cronJob &&
    !progressOnlyFrame &&
    typeof frame.clientMessageId === "string" &&
    frame.clientMessageId
  ) {
    const cmid = frame.clientMessageId;
    const isUnclaimedTurn = sess._activeClientMessageId !== cmid;
    if (!sess._activeClientMessageId) sess._activeClientMessageId = cmid;
    const hasOwnerUser = sess.messages.some(
      (m) => m.role === "user" && (m.id === cmid || m._clientMessageId === cmid),
    );
    if (isUnclaimedTurn && !hasOwnerUser && sess._missingUserSyncCmid !== cmid) {
      sess._missingUserSyncCmid = cmid;
      effects.syncMissingTurnUser?.(sess.id, cmid);
    }
  }
  if (isRetryingTurnStatus(sess._turnStatus) || isEngineStartupTurnStatus(sess._turnStatus)) {
    sess._turnStatus = null;
  }
  if (frame.blocks && shouldClearTurnProgressHint(sess._turnProgressHint, frame.blocks)) {
    sess._turnProgressHint = undefined;
  }
}

function bindAndAdvanceReplyTracker(
  sess: ChatSession,
  frame: OutboundMessageWire,
  hasBlocks: boolean,
): DeferredEmptyNotice | null {
  if (!sess._replyingToMsgId) {
    const pending = [...sess.messages]
      .reverse()
      .find((m) => m.role === "user" && m.status && m.status !== "replied" && m.status !== "queued");
    if (pending) {
      sess._replyingToMsgId = pending.id;
      sess._currentTurnAnswerCount = 0;
    }
  }
  const targetMsg = sess._replyingToMsgId
    ? sess.messages.find((m) => m.id === sess._replyingToMsgId)
    : null;
  if (sess._replyingToMsgId && !targetMsg) resetReplyTracker(sess);
  if (!targetMsg) return null;

  if (hasBlocks) {
    sess._currentTurnAnswerCount =
      (sess._currentTurnAnswerCount || 0) + countAnswerBlocks(frame.blocks);
    if (targetMsg.status !== "read" && targetMsg.status !== "replied") {
      targetMsg.status = "read";
    }
  }
  if (!frame.isFinal) return null;
  const notice: DeferredEmptyNotice = {
    targetMsgId: targetMsg.id,
    stopReason: frame.meta?.stopReason,
    hadAnswerLookahead: !!sess._currentTurnAnswerCount || !!sess._streamingAssistant,
  };
  resetReplyTracker(sess);
  return notice;
}

function settleDeferredEmptyTurnNotice(
  sess: ChatSession,
  deferredEmptyNotice: DeferredEmptyNotice,
  frameTurnOwnerId: string | undefined,
  effects: FrameEffects,
): void {
  const cls = classifyEmptyTurn({
    messages: sess.messages,
    targetMsgId: deferredEmptyNotice.targetMsgId,
    hasAnswerOutput: deferredEmptyNotice.hadAnswerLookahead || !!sess._streamingAssistant,
    stopReason: deferredEmptyNotice.stopReason,
  });
  if (!cls.insert) return;
  const autoTid = deferredEmptyNotice.targetMsgId;
  const canAuto =
    !!effects.scheduleAutoContinue &&
    shouldAutoContinueEmptyTurn({
      messages: sess.messages,
      targetMsgId: autoTid,
      stopReason: cls.stopReason,
    });
  if (canAuto) {
    effects.scheduleAutoContinue!(sess.id, autoTid, cls);
    return;
  }
  const lastMsg = sess.messages[sess.messages.length - 1];
  const dup = lastMsg && lastMsg._emptyTurn && lastMsg._emptyTurnTargetMsgId === autoTid;
  if (!dup) {
    addMessage(sess, "assistant", cls.text, {
      _emptyTurn: true,
      _emptyTurnSoft: cls.soft,
      _emptyTurnStopReason: cls.stopReason,
      _emptyTurnTargetMsgId: autoTid,
      ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
    });
  }
}

function findFinalUsageTarget(
  sess: ChatSession,
  frameTurnOwnerId: string | undefined,
): ChatMessage | undefined {
  if (sess._streamingAssistant) return sess._streamingAssistant;
  if (!frameTurnOwnerId) return undefined;
  return [...sess.messages]
    .reverse()
    .find(
      (message) =>
        message.role !== "user" &&
        message.role !== "system" &&
        message.role !== "permission" &&
        (message._clientMessageId === frameTurnOwnerId || message._turnOwnerId === frameTurnOwnerId),
    );
}

function attachFinalTurnUsageAndMeta(
  sess: ChatSession,
  frame: OutboundMessageWire,
  frameTurnOwnerId: string | undefined,
): void {
  if (!frame.meta) return;
  const usageTarget = findFinalUsageTarget(sess, frameTurnOwnerId);
  if (usageTarget) {
    const usagePatch: ChatMessage["usage"] = { ...frame.meta };
    if (typeof frame.traceId === "string" && frame.traceId) usagePatch.traceId = frame.traceId;
    try {
      const pending = BigInt(sess._pendingCostCredits || "0");
      if (pending > 0n) {
        usagePatch.costCredits = pending.toString();
        sess._pendingCostCredits = "0";
      }
    } catch {
      sess._pendingCostCredits = "0";
    }
    usageTarget.usage = { ...(usageTarget.usage || {}), ...usagePatch };
    if (usageTarget.role === "assistant") {
      sess._lastFinaledAssistantId = usageTarget.id;
      sess._lastFinaledAt = Date.now();
    }
  }
  if (!sess._tokenUsage) {
    sess._tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  }
  const meta = frame.meta;
  if (typeof meta.inputTokens === "number") sess._tokenUsage.input += meta.inputTokens;
  if (typeof meta.outputTokens === "number") sess._tokenUsage.output += meta.outputTokens;
  if (typeof meta.cacheReadTokens === "number") sess._tokenUsage.cacheRead += meta.cacheReadTokens;
  if (typeof meta.cacheCreationTokens === "number") {
    sess._tokenUsage.cacheWrite += meta.cacheCreationTokens;
  }
  if (typeof meta.cost === "number") sess._tokenUsage.cost += meta.cost;
}

function markTruncatedFinalAssistant(sess: ChatSession, stopReason: string | undefined): void {
  const truncatedReason =
    stopReason === "max_tokens" || stopReason === "pause_turn" ? stopReason : null;
  if (!truncatedReason) return;
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const m = sess.messages[i];
    if (m.role === "user") break;
    if (m.role === "assistant" && m.text?.trim()) {
      m._truncated = truncatedReason;
      break;
    }
  }
}

function finalizeLiveProcessCardsOnTurnEnd(sess: ChatSession, interrupted: boolean): void {
  for (const m of sess.messages) {
    if (isImmutableTapeViewportRow(m)) continue;
    if (m.role === "plan" && m._partial) {
      m._partial = false;
      m.completedAt = Date.now();
    }
    if (
      m.role === "tool" &&
      typeof m._completed === "boolean" &&
      !m._completed &&
      !m.error &&
      !m._background
    ) {
      m._completed = true;
      if (interrupted && !m.output && !m.bashTail) m.cancelled = true;
    }
    finalizeSwarmMessageOnTurnEnd(m, interrupted, isFrozenLiveTarget);
    if (sess._swarmSyncStale) sess._swarmSyncStale = false;
    if ((m.role === "agent-group" || m.role === "delegate-progress") && !m._completed && !m._background) {
      m._completed = true;
      if (interrupted) m.cancelled = true;
      if (m.completedAt == null) m.completedAt = Date.now();
    }
  }
}

function flushPendingCostCreditsToTurnAssistant(sess: ChatSession): void {
  const pending = safeBigIntOrZero(sess._pendingCostCredits);
  if (pending > 0n) {
    let lastAsst: ChatMessage | null = null;
    for (let k = sess.messages.length - 1; k >= 0; k--) {
      const m = sess.messages[k];
      if (m.role === "user") break;
      if (m.role === "assistant") {
        lastAsst = m;
        break;
      }
    }
    if (lastAsst) {
      const cur = safeBigIntOrZero(lastAsst.usage?.costCredits);
      lastAsst.usage = { ...(lastAsst.usage || {}), costCredits: (cur + pending).toString() };
    }
  }
  sess._pendingCostCredits = "0";
}

function finalizeOutboundTurn(
  sess: ChatSession,
  frame: OutboundMessageWire,
  deferredEmptyNotice: DeferredEmptyNotice | null,
  frameTurnOwnerId: string | undefined,
  suppressLegacyErrorText: boolean,
  isCronOrHeartbeat: boolean,
  effects: FrameEffects,
): void {
  if (deferredEmptyNotice) {
    settleDeferredEmptyTurnNotice(sess, deferredEmptyNotice, frameTurnOwnerId, effects);
  }
  attachFinalTurnUsageAndMeta(sess, frame, frameTurnOwnerId);
  if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now();
  if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now();
  const stopReason = frame.meta?.stopReason;
  markTruncatedFinalAssistant(sess, stopReason);
  const interrupted = Boolean(
    frame.meta?.interrupted || suppressLegacyErrorText || stopReason === "error",
  );
  finalizeLiveProcessCardsOnTurnEnd(sess, interrupted);
  flushPendingCostCreditsToTurnAssistant(sess);

  const clientMessageId = frame.clientMessageId ?? sess._activeClientMessageId;
  clearActiveStreamAndInFlight(sess);
  resolveGenPlaceholders(sess, extractImageEditJobId(frame));
  sess.messages = repairPostFinalProcessOrder(sess.messages);
  effects.onFinal?.(sess, frame, isCronOrHeartbeat, clientMessageId);
  if (frame.meta?.interrupted === "service_restart") {
    effects.scheduleAutomaticRecovery?.(sess.id, clientMessageId);
  }
}

function runOutboundMessagePreGuards(
  sess: ChatSession,
  frame: OutboundMessageWire,
  effects: FrameEffects,
): { allowed: false } | { allowed: true; suppressLegacyErrorText: boolean } {
  if (!acceptFrameSeq(sess, frame)) return { allowed: false };
  trackServerTs(sess, frame.ts);
  if (checkCrossTurnMismatch(sess, frame, effects)) return { allowed: false };
  if (handleReconcileTurnStateUnknown(sess, frame, effects)) return { allowed: false };

  const { suppressLegacyErrorText, shortCircuited } = resolveLegacyErrorTextSuppression(
    sess,
    frame,
    effects,
  );
  if (shortCircuited) return { allowed: false };

  if (!sess._blockIdToMsgId) rebuildIndexes(sess);
  if (handleServiceRestartOutOfBandSweep(sess, frame, effects)) return { allowed: false };
  if (handleReconcileSyntheticFinal(sess, frame, effects)) return { allowed: false };
  if (shouldDropStoppedOrStaleFrame(sess, frame, suppressLegacyErrorText)) {
    return { allowed: false };
  }
  return { allowed: true, suppressLegacyErrorText };
}

function renderOutboundMessageBlocks(
  sess: ChatSession,
  frame: OutboundMessageWire,
  frameTurnOwnerId: string | undefined,
  suppressLegacyErrorText: boolean,
  effects: FrameEffects,
): void {
  const isCronPush = !!frame.cronJob && !frame.cronJob.heartbeat;
  const blocksToRender = suppressLegacyErrorText ? [] : frame.blocks || [];
  if (!frame.isFinal && frameTurnOwnerId && blocksToRender.length > 0) {
    accumulateLiveFrameEstimatedBytes(sess, frameTurnOwnerId, blocksToRender);
  }
  applyOutboundContentBlocks(sess, blocksToRender, {
    frame,
    frameTurnOwnerId,
    isCronPush,
    effects,
  });
  sess.lastAt = Date.now();
}

/**
 * outbound.message 总线翻译。`getSession(peerId)`：未知 peer 直接丢（不创建）；
 * 调用方负责保证 session 存在（v5 webchat 每会话即 peer）。
 */
export function applyOutboundMessage(
  sess: ChatSession,
  frame: OutboundMessageWire,
  effects: FrameEffects = {},
): void {
  const guard = runOutboundMessagePreGuards(sess, frame, effects);
  if (!guard.allowed) return;

  const { hasBlocks, progressOnlyFrame, lifecycleSidebandFrame, frameTurnOwnerId } =
    classifyOutboundLifecycleFrame(sess, frame);
  if (hasBlocks || frame.isFinal) markFrameReceived(sess);

  let deferredEmptyNotice: DeferredEmptyNotice | null = null;
  if (!lifecycleSidebandFrame) {
    if (hasBlocks) activateLiveTurnAndHints(sess, frame, progressOnlyFrame, effects);
    if (sess._sendingInFlight && !frame.isFinal) effects.onLiveFrame?.(sess);
    deferredEmptyNotice = bindAndAdvanceReplyTracker(sess, frame, hasBlocks);
  }

  renderOutboundMessageBlocks(
    sess,
    frame,
    frameTurnOwnerId,
    guard.suppressLegacyErrorText,
    effects,
  );

  if (frame.isFinal) {
    finalizeOutboundTurn(
      sess,
      frame,
      deferredEmptyNotice,
      frameTurnOwnerId,
      guard.suppressLegacyErrorText,
      !!frame.cronJob,
      effects,
    );
  }
}
