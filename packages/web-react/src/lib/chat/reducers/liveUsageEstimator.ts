/**
 * Live token/byte usage estimator + turn_status / turn_usage / call_usage / context_pressure reducers.
 */
import { AUTOMATIC_TURN_RETRY_MAX } from "@openclaude/protocol/browser";
import {
  buildContextPressureState,
  contextCompactedRow,
  nextPressureAfterCompaction,
} from "../contextCompacted";
import type {
  OutboundCallUsageWire,
  OutboundContentBlock,
  OutboundTurnStatusWire,
  OutboundTurnUsageWire,
  SessionContextPressureWire,
  SysContextCompactedWire,
} from "../frames";
import {
  addMessage,
  type ChatSession,
  isEngineStartupTurnStatus,
  markFrameReceived,
} from "../model";
import { applyPartialJsonDelta, MODEL_THINKING_WORKING_DETAIL } from "../pure";
import { acceptFrameSeq } from "./frameSeqCursor";

type LiveTurnUsageState = NonNullable<ChatSession["_liveTurnUsage"]>;

type EstimableBlock = OutboundContentBlock & {
  runId?: string;
  phase?: string;
  block?: OutboundContentBlock;
  partialJsonDelta?: string;
  partialJsonOffset?: number;
  parentToolUseId?: string;
};

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function observableBytes(value: unknown): number {
  if (typeof value === "string") return utf8ByteLength(value);
  if (value === undefined || value === null) return 0;
  try {
    return utf8ByteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

function ensureLiveUsageEstimate(
  sess: ChatSession,
  clientMessageId: string,
): LiveTurnUsageState | null {
  const current = sess._liveTurnUsage;
  if (current?.clientMessageId === clientMessageId) {
    if (!current._observedBytes) {
      const user = sess.messages.find(
        (message) => message.role === "user" && message.id === clientMessageId,
      );
      const userBytes = observableBytes(user?._modelText || user?.text || "");
      current._observedBytes = { [`user:${clientMessageId}`]: userBytes };
      current._estimatedUtf8Bytes = 0;
    }
    return current;
  }
  const user = sess.messages.find(
    (message) => message.role === "user" && message.id === clientMessageId,
  );
  if (!user) return null;
  const userBytes = observableBytes(user._modelText || user.text || "");
  const estimatedTokens = Math.ceil(userBytes / 4);
  const state: LiveTurnUsageState = {
    clientMessageId,
    usage: { totalTokens: estimatedTokens, estimated: true },
    _estimatedUtf8Bytes: userBytes,
    _observedBytes: { [`user:${clientMessageId}`]: userBytes },
  };
  sess._liveTurnUsage = state;
  return state;
}

function addLiveEstimatedBytes(state: LiveTurnUsageState, bytes: number): void {
  if (bytes <= 0) return;
  state._estimatedUtf8Bytes = (state._estimatedUtf8Bytes ?? 0) + bytes;
  const exact = state.usage.estimated ? state._exactUsage : state.usage;
  state._exactUsage = exact
    ? {
        totalTokens: exact.totalTokens,
        ...(exact.inputTokens !== undefined ? { inputTokens: exact.inputTokens } : {}),
        ...(exact.outputTokens !== undefined ? { outputTokens: exact.outputTokens } : {}),
        ...(exact.cacheReadTokens !== undefined ? { cacheReadTokens: exact.cacheReadTokens } : {}),
        ...(exact.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: exact.cacheCreationTokens }
          : {}),
      }
    : undefined;
  state.usage = {
    ...(state._exactUsage ?? {}),
    totalTokens:
      (state._exactUsage?.totalTokens ?? 0) + Math.ceil(state._estimatedUtf8Bytes / 4),
    estimated: true,
  };
}

function observeCumulativeBytes(state: LiveTurnUsageState, key: string, value: unknown): number {
  const next = observableBytes(value);
  const previous = state._observedBytes?.[key] ?? 0;
  if (!state._observedBytes) state._observedBytes = {};
  if (next > previous) state._observedBytes[key] = next;
  return Math.max(0, next - previous);
}

function estimatedToolUseBytes(
  state: LiveTurnUsageState,
  block: Extract<EstimableBlock, { kind: "tool_use" }>,
  scope: string,
): number {
  const key = `${scope}:tool-input:${block.blockId || block.toolName || "tool"}`;
  if (typeof block.partialJsonDelta === "string") {
    const partial = applyPartialJsonDelta(state._partialJsonByBlock?.[key], block);
    if (partial.action === "set") {
      if (!state._partialJsonByBlock) state._partialJsonByBlock = {};
      state._partialJsonByBlock[key] = partial.value;
      return observeCumulativeBytes(state, key, partial.value);
    }
    if (partial.action === "drop" && state._partialJsonByBlock) {
      delete state._partialJsonByBlock[key];
    }
    return 0;
  }
  if (block.partial === false && state._partialJsonByBlock) {
    delete state._partialJsonByBlock[key];
  }
  return observeCumulativeBytes(state, key, block.inputJson ?? block.inputPreview ?? "");
}

function estimatedDelegateProgressBytes(
  state: LiveTurnUsageState,
  block: EstimableBlock,
  scope: string,
  text: string,
): number {
  const nestedScope = `${scope}:delegate:${block.runId || "unknown"}`;
  if (block.block && typeof block.block === "object") {
    return estimatedBlockBytes(state, block.block as EstimableBlock, nestedScope);
  }
  return block.phase === "text" || block.phase === "thinking" ? observableBytes(text) : 0;
}

function estimatedToolResultBytes(
  state: LiveTurnUsageState,
  block: Extract<EstimableBlock, { kind: "tool_result" }>,
  scope: string,
): number {
  const id = block.toolUseBlockId || block.blockId || block.toolName || "tool";
  const body = block.outputJson ?? block.output ?? block.preview ?? "";
  return observeCumulativeBytes(state, `${scope}:tool-result:${id}`, body);
}

function estimatedBlockBytes(
  state: LiveTurnUsageState,
  block: EstimableBlock,
  scope = "root",
): number {
  const rawText = (block as { text?: unknown }).text;
  const text = typeof rawText === "string" ? rawText : "";
  if (block.kind === "text" || block.kind === "thinking") return observableBytes(text);
  if (block.kind === "delegate_progress") {
    return estimatedDelegateProgressBytes(state, block, scope, text);
  }
  if (block.kind === "plan") {
    return observeCumulativeBytes(state, `${scope}:plan:${block.blockId || "plan"}`, {
      text: block.text,
      explanation: block.explanation,
      steps: block.steps,
    });
  }
  if (block.kind === "goal") {
    return observeCumulativeBytes(state, `${scope}:goal:${block.blockId || "goal"}`, {
      objective: block.objective,
      status: block.status,
    });
  }
  if (block.kind === "tool_use") return estimatedToolUseBytes(state, block, scope);
  if (block.kind === "tool_result") return estimatedToolResultBytes(state, block, scope);
  return 0;
}

export function accumulateLiveFrameEstimatedBytes(
  sess: ChatSession,
  frameTurnOwnerId: string,
  blocksToRender: readonly OutboundContentBlock[],
): void {
  const liveEstimate = ensureLiveUsageEstimate(sess, frameTurnOwnerId);
  if (!liveEstimate) return;
  let bytes = 0;
  for (const block of blocksToRender) {
    bytes += estimatedBlockBytes(liveEstimate, block as EstimableBlock);
  }
  addLiveEstimatedBytes(liveEstimate, bytes);
}

// ═══════════════ outbound.turn_status（§6/§7）═══════════════

function applyTurnStatusPhase(sess: ChatSession, frame: OutboundTurnStatusWire): void {
  if (frame.status === "compacting") {
    if (sess._turnStatus !== "compacting") sess._turnStatusSince = Date.now();
    sess._turnStatus = "compacting";
  } else if (
    frame.status === "waiting_for_user" ||
    frame.status === "engine_starting" ||
    frame.status === "engine_resuming"
  ) {
    sess._turnStatus = frame.status;
  } else if (frame.status === "retrying") {
    sess._turnStatus = {
      kind: "retrying",
      attempt: frame.retry.attempt,
      max: AUTOMATIC_TURN_RETRY_MAX,
      retryAt: frame.retry.retryAt,
    };
  } else if (frame.status === "working") {
    const detail = typeof frame.detail === "string" ? frame.detail.trim() : "";
    if (detail) sess._turnProgressHint = detail;
    if (detail === MODEL_THINKING_WORKING_DETAIL && isEngineStartupTurnStatus(sess._turnStatus)) {
      sess._turnStatus = null;
    }
  } else {
    sess._turnStatus = null;
    sess._turnProgressHint = undefined;
  }
  if (sess._turnStatus !== "compacting") sess._turnStatusSince = undefined;
}

function applyTurnStatusMeta(sess: ChatSession, frame: OutboundTurnStatusWire): void {
  if (frame.meta?.detached === true) {
    sess._turnDetachedAt = Date.now();
    if (sess._turnStartedAt == null && typeof frame.meta.since === "number") {
      sess._turnStartedAt = frame.meta.since;
    }
  }
  const clientMessageId = sess._activeClientMessageId;
  if (
    frame.meta?.credits &&
    clientMessageId &&
    (frame.clientMessageId === undefined || frame.clientMessageId === clientMessageId)
  ) {
    sess._turnCredits = { clientMessageId, ...frame.meta.credits, receivedAt: Date.now() };
  }
}

export function applyTurnStatus(sess: ChatSession, frame: OutboundTurnStatusWire): void {
  if (!acceptFrameSeq(sess, frame)) return;
  if (
    frame.clientMessageId &&
    sess._activeClientMessageId &&
    frame.clientMessageId !== sess._activeClientMessageId
  ) {
    return;
  }
  markFrameReceived(sess);
  applyTurnStatusPhase(sess, frame);
  applyTurnStatusMeta(sess, frame);
}

// ═══════════════ outbound.turn_usage / call_usage / context_pressure ═══════════════

export function applyTurnUsage(sess: ChatSession, frame: OutboundTurnUsageWire): void {
  if (!acceptFrameSeq(sess, frame)) return;
  if (!frame.clientMessageId || sess._activeClientMessageId !== frame.clientMessageId) return;
  markFrameReceived(sess);
  const prev =
    sess._liveTurnUsage?.clientMessageId === frame.clientMessageId
      ? sess._liveTurnUsage
      : undefined;
  sess._liveTurnUsage = {
    clientMessageId: frame.clientMessageId,
    usage: { ...frame.usage },
    ...(prev?._observedBytes ? { _observedBytes: prev._observedBytes } : {}),
    ...(prev?._partialJsonByBlock ? { _partialJsonByBlock: prev._partialJsonByBlock } : {}),
    _estimatedUtf8Bytes: 0,
  };
}

export function applyCallUsage(sess: ChatSession, frame: OutboundCallUsageWire): void {
  if (!acceptFrameSeq(sess, frame)) return;
  if (!frame.clientMessageId || sess._activeClientMessageId !== frame.clientMessageId) return;
  markFrameReceived(sess);
  for (const targetId of frame.call.targetIds) {
    const messageId = sess._blockIdToMsgId?.get(targetId) ?? targetId;
    const msg = sess.messages.find((candidate) => candidate.id === messageId);
    if (!msg) continue;
    msg._callUsage = structuredClone(frame.call);
  }
}

export function applyContextPressure(
  sess: ChatSession,
  frame: SessionContextPressureWire,
): boolean {
  if (!acceptFrameSeq(sess, frame)) return false;
  const next = buildContextPressureState(frame);
  if (!next) return false;
  markFrameReceived(sess);
  sess._contextPressure = next;
  return true;
}

export function applyContextCompacted(
  sess: ChatSession,
  frame: SysContextCompactedWire,
  now: () => number = Date.now,
): { id: string; text: string } | null {
  if (!acceptFrameSeq(sess, frame)) return null;
  markFrameReceived(sess);
  sess._compactingManual = false;
  const row = contextCompactedRow(sess, frame, now);
  if (row) {
    addMessage(sess, "system", row.text, {
      id: row.id,
      _source: "local",
      _contextCompaction: row.detail,
    });
  }
  sess._contextPressure = nextPressureAfterCompaction(sess._contextPressure, frame, now);
  return row ? { id: row.id, text: row.text } : null;
}
