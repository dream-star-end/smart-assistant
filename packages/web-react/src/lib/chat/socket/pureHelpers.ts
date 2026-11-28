import {
  AUTOMATIC_TURN_RETRY_MAX,
  assessTurnRecoveryTape,
  DEFAULT_CODEX_ENGINE_MODEL,
  isClientMessageId,
  maxAutomaticTurnRetryAttempt,
  type MessageReplyQuote,
  normalizeTurnErrorCode,
  shouldPauseSilentAutomaticRecovery,
  supportsAutomaticTurnRecovery,
  turnRecoveryAttemptIdentity,
  turnRecoveryIdentity,
} from "@openclaude/protocol/browser";
import {
  ensureFirstTextPaintVisibilityTracking,
  measureHiddenWindow,
} from "../firstTextPaintVisibility";
import type { InboundMessage, OutboundMessageWire } from "../frames";
import type { ChatMessage, ChatRoutingSnapshot, ChatSession } from "../model";
import {
  QUIET_REPLAY_BLOCK_KEYS,
  QUIET_REPLAY_FRAME_KEYS,
  STREAM_NOTIFY_COST_FACTOR,
  STREAM_NOTIFY_MAX_MS,
  STREAM_NOTIFY_MS,
  type InterruptedContinuationTarget,
} from "./types";

function fnv1a64Base36(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

/** Stable key for one logical browser send attempt. */
export function messageAttemptIdempotencyKey(clientMessageId: string, attempt: number): string {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  const readable = `web:${clientMessageId}:${safeAttempt}`;
  if (readable.length <= 128) return readable;
  return `webh:${fnv1a64Base36(clientMessageId)}:${safeAttempt}`;
}

export function stableControlId(kind: "stop" | "permission", identity: string): string {
  const readable = `control:${kind}:${identity}`;
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(readable)) return readable;
  return `control:${kind}:h${fnv1a64Base36(identity)}`;
}

/** Durable browser identity for exactly one continuation of an interrupted turn. */
export function interruptedContinuationIdentity(
  sessionId: string,
  interruptedClientMessageId: string,
): { clientMessageId: string; idempotencyKey: string } {
  return turnRecoveryIdentity(sessionId, interruptedClientMessageId);
}

function baseTurnRecoveryTarget(
  messages: ChatMessage[],
  error: ChatMessage,
): { user: ChatMessage; error: ChatMessage; rows: ChatMessage[] } | undefined {
  const normalizedCode = normalizeTurnErrorCode(error._errorCode);
  if (!supportsAutomaticTurnRecovery(normalizedCode)) return undefined;
  if (error._source !== "server" && !error._turnTapeId) return undefined;
  const interruptedClientMessageId = error._clientMessageId;
  if (!interruptedClientMessageId) return undefined;
  const userIndex = messages.findIndex(
    (message) => message.role === "user" && message.id === interruptedClientMessageId,
  );
  if (userIndex < 0) return undefined;
  const user = messages[userIndex]!;
  if (!user._routing) return undefined;
  const errorIndex = messages.indexOf(error);
  if (errorIndex <= userIndex) return undefined;
  if (messages.slice(userIndex + 1).some((message) => message.role === "user")) {
    return undefined;
  }
  return { user, error, rows: messages.slice(userIndex + 1, errorIndex) };
}

function recoveryIdentityAlreadyExists(
  messages: ChatMessage[],
  identity: { clientMessageId: string; idempotencyKey: string },
): boolean {
  return messages.some(
    (message) => message.id === identity.clientMessageId || message._idem === identity.idempotencyKey,
  );
}

/** Manual fallback for a durable interrupted turn. */
export function interruptedContinuationTarget(
  messages: ChatMessage[],
  error: ChatMessage,
  sessionId: string,
): InterruptedContinuationTarget | undefined {
  if (error._recoverySkippedNotice) return undefined;
  const base = baseTurnRecoveryTarget(messages, error);
  if (!base) return undefined;
  const durableRows = base.rows.filter(
    (message) => message._source === "server" || !!message._turnTapeId,
  );
  if (assessTurnRecoveryTape(durableRows).mode !== "checkpoint") return undefined;
  const identity = interruptedContinuationIdentity(sessionId, base.user.id);
  if (recoveryIdentityAlreadyExists(messages, identity)) return undefined;
  return {
    user: base.user,
    error: base.error,
    mode: "checkpoint",
    ...identity,
  };
}

function resolveRecoveryLineageRoot(user: ChatMessage): string | undefined {
  if (isClientMessageId(user._automaticRecoveryRootClientMessageId)) {
    return user._automaticRecoveryRootClientMessageId;
  }
  if (user._automaticRecovery === true && isClientMessageId(user._recoveryOfClientMessageId)) {
    return user._recoveryOfClientMessageId;
  }
  return isClientMessageId(user.id) ? user.id : undefined;
}

function resolveCurrentRecoveryAttempt(
  user: ChatMessage,
  error: ChatMessage,
  durableRows: ChatMessage[],
  rootClientMessageId: string,
): number {
  const validSourceAttempt =
    typeof user._automaticRecoveryAttempt === "number" &&
    Number.isSafeInteger(user._automaticRecoveryAttempt) &&
    user._automaticRecoveryAttempt >= 1;
  const sourceAttempt = validSourceAttempt
    ? user._automaticRecoveryAttempt!
    : user._automaticRecovery === true
      ? 1
      : 0;
  const matchesTerminal =
    error._automaticRetryRootClientMessageId === rootClientMessageId &&
    error._automaticRetryMax === AUTOMATIC_TURN_RETRY_MAX &&
    Number.isSafeInteger(error._automaticRetryAttempt);
  const terminalAttempt = matchesTerminal ? Number(error._automaticRetryAttempt) : 0;
  return Math.max(
    sourceAttempt,
    terminalAttempt,
    maxAutomaticTurnRetryAttempt(durableRows, rootClientMessageId),
  );
}

function isRecoveryAssessmentEligible(
  user: ChatMessage,
  durableRows: ChatMessage[],
  assessment: ReturnType<typeof assessTurnRecoveryTape>,
): boolean {
  const completedTape = durableRows.some(
    (message) => message._turnTapeProcess === true && message._dispatchOutcome === "completed",
  );
  if (!assessment.checkpointSafe && (assessment.mode !== "checkpoint" || !completedTape)) {
    return false;
  }
  if (assessment.mode === "replay") {
    return user._userPayloadDeferred !== true && preciseRetryEligible(user);
  }
  return true;
}

/** Automatic recovery rechecks exact durable rows and advances one shared 1..10 lineage. */
export function automaticTurnRecoveryTarget(
  messages: ChatMessage[],
  error: ChatMessage,
  sessionId: string,
): InterruptedContinuationTarget | undefined {
  const base = baseTurnRecoveryTarget(messages, error);
  if (!base || base.user._automaticRecoveryAttempted === true) return undefined;
  if (base.user._source !== "server" && !base.user._turnTapeId) return undefined;
  const durableRows = base.rows.filter(
    (message) => message._source === "server" || !!message._turnTapeId,
  );
  const assessment = assessTurnRecoveryTape(durableRows);
  if (!isRecoveryAssessmentEligible(base.user, durableRows, assessment)) return undefined;
  const rootClientMessageId = resolveRecoveryLineageRoot(base.user);
  if (!rootClientMessageId) return undefined;
  const currentAttempt = resolveCurrentRecoveryAttempt(
    base.user,
    error,
    durableRows,
    rootClientMessageId,
  );
  if (
    shouldPauseSilentAutomaticRecovery({
      errorCode: error._errorCode ?? "",
      currentAttempt,
      records: durableRows,
    }) ||
    currentAttempt >= AUTOMATIC_TURN_RETRY_MAX
  ) {
    return undefined;
  }
  const attempt = currentAttempt + 1;
  const identity = turnRecoveryAttemptIdentity(sessionId, rootClientMessageId, attempt);
  if (recoveryIdentityAlreadyExists(messages, identity)) return undefined;
  return {
    user: base.user,
    error: base.error,
    mode: assessment.mode,
    ...identity,
    rootClientMessageId,
    attempt,
    max: AUTOMATIC_TURN_RETRY_MAX,
  };
}

/** Persisted pre-cutover turns must replay on the replacement Codex model. */
export function normalizeRetiredRouting(
  routing: ChatRoutingSnapshot | undefined,
): ChatRoutingSnapshot | undefined {
  if (!routing || routing.model !== "gpt-5.5") return routing;
  return { ...routing, model: DEFAULT_CODEX_ENGINE_MODEL };
}

/** Exact retry CTA eligibility — strictly aligned with fields read by `retryMessage`. */
export function preciseRetryEligible(
  msg: Pick<
    ChatMessage,
    "_routing" | "_media" | "_retryMedia" | "_userPayloadDeferred" | "_deferredRetryEligible"
  >,
): boolean {
  if (!msg._routing) return false;
  if (msg._userPayloadDeferred === true) return msg._deferredRetryEligible === true;
  const hadAttachments = (msg._media?.length ?? 0) > 0 || (msg._retryMedia?.length ?? 0) > 0;
  if (!hadAttachments) return true;
  const source = msg._retryMedia ?? msg._media;
  if (!source || source.length === 0) return false;
  return source.every(
    (r) =>
      (typeof r.url === "string" && r.url.length > 0) ||
      (typeof r.base64 === "string" && r.base64.length > 0),
  );
}

/** Reconstruct one exact user replay body for retry and regenerate. */
export function exactUserReplayPayload(
  msg: Pick<ChatMessage, "text" | "_modelText" | "_media" | "_retryMedia" | "_imageEdit" | "_replyTo">,
): {
  text: string;
  displayText?: string;
  media?: InboundMessage["content"]["media"];
  imageEdit?: NonNullable<InboundMessage["content"]>["imageEdit"];
  replyTo?: MessageReplyQuote;
} {
  const displayText = msg.text ?? "";
  const text = msg._modelText ?? displayText;
  const sourceMedia = msg._retryMedia ?? msg._media;
  const media = sourceMedia && sourceMedia.length > 0 ? sourceMedia : undefined;
  return {
    text,
    ...(displayText !== text ? { displayText } : {}),
    ...(media ? { media } : {}),
    ...(msg._imageEdit ? { imageEdit: msg._imageEdit } : {}),
    ...(msg._replyTo ? { replyTo: msg._replyTo } : {}),
  };
}

/** Adaptive streaming render throttle window based on measured render cost. */
export function streamNotifyWindowMs(renderCostMs: number): number {
  const cost = Number.isFinite(renderCostMs) && renderCostMs > 0 ? renderCostMs : 0;
  return Math.min(
    STREAM_NOTIFY_MAX_MS,
    Math.max(STREAM_NOTIFY_MS, Math.round(cost * STREAM_NOTIFY_COST_FACTOR)),
  );
}

/** Exponential moving average of streaming render cost. */
export function nextStreamRenderCostMs(previous: number, sample: number): number {
  if (!Number.isFinite(sample) || sample < 0) return previous;
  return previous > 0 ? previous * 0.6 + sample * 0.4 : sample;
}

/** Shared helper projecting a `ChatRoutingSnapshot` onto `InboundMessage` top-level fields. */
export function routingWireFields(
  routing: ChatRoutingSnapshot | undefined,
  includeSwitchAuth = true,
): Partial<InboundMessage> {
  if (!routing) return {};
  const out: Partial<InboundMessage> = {};
  if (Object.prototype.hasOwnProperty.call(routing, "effortLevel")) {
    out.effortLevel = routing.effortLevel as InboundMessage["effortLevel"];
  }
  if (routing.model) out.model = routing.model;
  if (includeSwitchAuth && routing.modelSwitchId) out.modelSwitchId = routing.modelSwitchId;
  if (includeSwitchAuth && routing.modelSwitchConsent) {
    out.modelSwitchConsent = routing.modelSwitchConsent;
  }
  if (routing.teamMode) out.teamMode = true;
  if (routing.swarmMode) out.swarmMode = true;
  if (routing.collabMode) out.collabMode = routing.collabMode;
  if (routing.advisorModel) out.advisorModel = routing.advisorModel;
  if (routing.collabConfigVersion) out.collabConfigVersion = routing.collabConfigVersion;
  if (routing.contextTier) out.contextTier = routing.contextTier;
  if (routing.serviceTier) out.serviceTier = routing.serviceTier;
  return out;
}

function hasVisibleTextBlock(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((block) => {
    const candidate = block as { kind?: unknown; text?: unknown };
    return (
      candidate?.kind === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.trim().length > 0
    );
  });
}

export function prepareFirstTextPaint(
  sessions: ReadonlyMap<string, ChatSession>,
  firstTextPaintTraceIds: Set<string>,
  frame: OutboundMessageWire,
): NonNullable<ChatMessage["_firstTextPaintProbe"]> | null {
  const traceId = typeof frame.traceId === "string" ? frame.traceId : "";
  const sessionId = frame.peer?.id;
  const clientMessageId = frame.clientMessageId;
  if (
    !/^[0-9a-f]{32}$/.test(traceId) ||
    typeof sessionId !== "string" ||
    typeof clientMessageId !== "string" ||
    firstTextPaintTraceIds.has(traceId)
  ) {
    return null;
  }
  const sess = sessions.get(sessionId);
  if (!sess || sess._activeClientMessageId !== clientMessageId) return null;
  if (!hasVisibleTextBlock(frame.blocks)) return null;
  const alreadyVisible = sess.messages.some(
    (message) =>
      message.role === "assistant" &&
      (message._clientMessageId === clientMessageId || message._turnOwnerId === clientMessageId) &&
      message.text.trim().length > 0,
  );
  if (alreadyVisible) return null;
  const user = sess.messages.find((message) => message.role === "user" && message.id === clientMessageId);
  if (!user || !Number.isFinite(user.ts)) return null;
  const frameAt = Date.now();
  const backgroundAtFrame = typeof document !== "undefined" && document.visibilityState !== "visible";
  ensureFirstTextPaintVisibilityTracking();
  const preFrame = measureHiddenWindow(user.ts, frameAt, undefined, backgroundAtFrame);
  return {
    traceId,
    sessionId,
    clientMessageId,
    startedAt: user.ts,
    backgroundAtFrame,
    frameAt,
    hiddenBeforeFrame: preFrame.wasHidden,
  };
}

export function attachFirstTextPaintProbe(
  sessions: ReadonlyMap<string, ChatSession>,
  firstTextPaintTraceIds: Set<string>,
  probe: NonNullable<ChatMessage["_firstTextPaintProbe"]>,
): void {
  const sess = sessions.get(probe.sessionId);
  const target = sess?.messages.find(
    (message) =>
      message.role === "assistant" &&
      (message._clientMessageId === probe.clientMessageId ||
        message._turnOwnerId === probe.clientMessageId) &&
      message.text.trim().length > 0,
  );
  if (!target) return;
  if (firstTextPaintTraceIds.size >= 1024) firstTextPaintTraceIds.clear();
  firstTextPaintTraceIds.add(probe.traceId);
  target._firstTextPaintProbe = probe;
}

function isQuietReplayDeltaCandidate(frame: OutboundMessageWire): boolean {
  if (frame.isFinal || frame.meta || !Array.isArray(frame.blocks) || frame.blocks.length === 0) {
    return false;
  }
  if (!Object.keys(frame).every((key) => QUIET_REPLAY_FRAME_KEYS.has(key))) return false;
  return frame.blocks.every(
    (block) =>
      (block?.kind === "text" || block?.kind === "thinking") &&
      Object.keys(block).every((key) => QUIET_REPLAY_BLOCK_KEYS.has(key)),
  );
}

function captureReplaySessionFingerprint(sess: ChatSession, offlineQueueLen: number): unknown[] {
  let textLength = 0;
  let userStatuses = "";
  for (const message of sess.messages) {
    textLength += message.text?.length ?? 0;
    if (message.role === "user") userStatuses += `${message.status ?? ""},`;
  }
  return [
    sess.messages,
    sess.messages.length,
    textLength,
    userStatuses,
    offlineQueueLen,
    sess._preparedModelSwitch,
    sess._streamingAssistant,
    sess._streamingAssistant?.text?.length,
    sess._streamingThinking,
    sess._streamingThinking?.text?.length,
    sess._sendingInFlight,
    sess._activeClientMessageId,
    sess._turnStatus,
  ];
}

export function createTextReplayProbe(
  sessions: ReadonlyMap<string, ChatSession>,
  getOfflineQueueLength: () => number,
  frame: OutboundMessageWire,
): { unchanged: () => boolean } | null {
  if (!isQuietReplayDeltaCandidate(frame)) return null;
  const sess = frame.peer?.id ? sessions.get(frame.peer.id) : undefined;
  if (!sess) return null;
  const before = captureReplaySessionFingerprint(sess, getOfflineQueueLength());
  return {
    unchanged: () => {
      const after = captureReplaySessionFingerprint(sess, getOfflineQueueLength());
      return before.every((value, index) => Object.is(value, after[index]));
    },
  };
}
