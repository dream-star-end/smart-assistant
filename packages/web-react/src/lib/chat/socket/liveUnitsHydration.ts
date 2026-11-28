import type { LiveUnit } from "@openclaude/protocol";
import { isUnresolvedPermissionPrompt, shouldRetainLiveProcessOnOwnerReset } from "../../persist";
import { observeTimelineShadow } from "../../timeline/shadowLifecycle";
import type { DurableLiveFrame } from "../../types";
import { isOutboundFrame } from "../frames";
import {
  applyLiveUnitsResumeStream,
  fetchSwarmResyncUnits,
  liveUnitToMessage,
  prependLiveUnitMessages,
  restoreLiveUnitStreamingState,
} from "../liveUnitsHydrate";
import { type ChatMessage, type ChatSession, rebuildIndexes } from "../model";
import { repairPostFinalProcessOrder } from "../order";
import { getFrameSeqCursor } from "../pure";
import {
  isFrozenLiveTarget,
  normalizeDelegateCards,
  normalizeGoalCards,
  planTurnStart,
  rememberSettledPermissionRequestId,
  resetFrameSeqCursor,
} from "../reducer";
import {
  liveProcessOwnersFromFrames,
  liveProcessOwnersFromUnits,
} from "../socketRecoveryHelpers";
import { applySwarmResyncUnits } from "../swarmReducer";
import {
  UNPUBLISHED_TAPE_RETRY_DELAYS_MS,
  UNPUBLISHED_TAPE_RETRY_MAX_MS,
  type DurableFrameSeqCheckpointEntry,
  type SocketCtx,
  type UnpublishedTapeRetryState,
} from "./types";

function computePreserveStreamingPointer(
  sess: ChatSession,
  owners: ReadonlySet<string>,
  incomingProcessOwners: ReadonlySet<string>,
): boolean {
  if (
    Boolean(sess._sendingInFlight) &&
    typeof sess._activeClientMessageId === "string" &&
    owners.has(sess._activeClientMessageId)
  ) {
    return true;
  }
  const streamingAssistant = sess._streamingAssistant;
  const streamingThinking = sess._streamingThinking;
  return sess.messages.some(
    (message) =>
      shouldRetainLiveProcessOnOwnerReset(message, sess.messages, incomingProcessOwners) &&
      (message === streamingAssistant || message === streamingThinking),
  );
}

function shouldKeepRowOnOwnerReset(
  sess: ChatSession,
  message: ChatMessage,
  owners: ReadonlySet<string>,
  incomingProcessOwners: ReadonlySet<string>,
  preserveStreamingPointer: boolean,
): boolean {
  if (message.role === "user") return true;
  if (message._source === "server" || Boolean(message._turnTapeId)) return true;
  if (isUnresolvedPermissionPrompt(message)) return true;
  if (message.role === "permission" && message._resolved === true) {
    rememberSettledPermissionRequestId(sess, message.requestId);
  }
  if (preserveStreamingPointer && message === sess._streamingAssistant) return true;
  if (shouldRetainLiveProcessOnOwnerReset(message, sess.messages, incomingProcessOwners)) {
    return true;
  }
  const ownedByTurn =
    (typeof message._turnOwnerId === "string" && owners.has(message._turnOwnerId)) ||
    (typeof message._clientMessageId === "string" && owners.has(message._clientMessageId));
  return !ownedByTurn;
}

export function resetOwnerLocalRowsInSession(
  sess: ChatSession,
  resetClientMessageIds: string[],
  incomingProcessOwners: ReadonlySet<string>,
): void {
  const owners = new Set(resetClientMessageIds);
  const streamingAssistant = sess._streamingAssistant;
  const streamingThinking = sess._streamingThinking;
  const preserveStreamingPointer = computePreserveStreamingPointer(
    sess,
    owners,
    incomingProcessOwners,
  );
  sess.messages = sess.messages.filter((message) =>
    shouldKeepRowOnOwnerReset(
      sess,
      message,
      owners,
      incomingProcessOwners,
      preserveStreamingPointer,
    ),
  );
  if (!preserveStreamingPointer) {
    sess._streamingAssistant =
      streamingAssistant && sess.messages.includes(streamingAssistant) ? streamingAssistant : null;
    sess._streamingThinking =
      streamingThinking && sess.messages.includes(streamingThinking) ? streamingThinking : null;
  }
  sess._blockIdToMsgId = new Map();
  sess._agentGroups = new Map();
  rebuildIndexes(sess);
}

function deduplicateLocalRowsAgainstIncomingUnits(sess: ChatSession, units: LiveUnit[]): void {
  const incomingIds = new Set<string>();
  const incomingBlockIds = new Set<string>();
  for (const unit of units) {
    if (typeof unit.id === "string" && unit.id) incomingIds.add(unit.id);
    const messageId = (unit as { messageId?: unknown }).messageId;
    if (typeof messageId === "string" && messageId) incomingIds.add(messageId);
    if (typeof unit.blockId === "string" && unit.blockId) incomingBlockIds.add(unit.blockId);
  }
  sess.messages = sess.messages.filter((message) => {
    if (message._source === "server" || typeof message._turnTapeId === "string") return true;
    if (incomingIds.has(message.id)) return false;
    if (typeof message.blockId === "string" && incomingBlockIds.has(message.blockId)) return false;
    return true;
  });
  if (sess._streamingAssistant && !sess.messages.includes(sess._streamingAssistant)) {
    sess._streamingAssistant = null;
  }
  if (sess._streamingThinking && !sess.messages.includes(sess._streamingThinking)) {
    sess._streamingThinking = null;
  }
}

export function applyLiveUnitsToSession(
  ctx: SocketCtx,
  sessId: string,
  units: LiveUnit[],
  resetClientMessageIds: string[] = [],
  resume?: { sessionKey: string; frameSeq: number; recordId: string; streamKey?: string },
  streamGeneration = 0,
): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  const preReset = sess.messages.slice();
  const generation =
    typeof streamGeneration === "number" && Number.isSafeInteger(streamGeneration)
      ? Math.max(0, streamGeneration)
      : 0;
  const mapped = units.map((unit) => liveUnitToMessage(unit, { streamGeneration: generation }));
  if (units.length === 0) {
    if (resetClientMessageIds.length > 0) {
      ctx.resetOwnerLocalRows(sess, resetClientMessageIds, liveProcessOwnersFromUnits(units));
    }
  } else {
    deduplicateLocalRowsAgainstIncomingUnits(sess, units);
  }
  sess.messages = prependLiveUnitMessages(sess.messages, mapped);
  restoreLiveUnitStreamingState(sess, units);
  applyLiveUnitsResumeStream(sess, units, resume, ctx.deps.defaultAgentId);
  rebuildIndexes(sess);
  normalizeDelegateCards(sess);
  normalizeGoalCards(sess);
  sess.messages = repairPostFinalProcessOrder(sess.messages);
  observeTimelineShadow({
    entry: "live-units",
    sessionId: sessId,
    input: [...preReset, ...mapped],
    oldOutput: sess.messages,
  });
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
}

export function prependLiveUnitsToSession(
  ctx: SocketCtx,
  sessId: string,
  units: LiveUnit[],
): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  sess.messages = prependLiveUnitMessages(
    sess.messages,
    units.map((unit) => liveUnitToMessage(unit)),
  );
  rebuildIndexes(sess);
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
}

export function resyncSwarmUnitsForSession(
  ctx: SocketCtx,
  sessId: string,
  expectedClientMessageId?: string,
): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  const expectedOwner = expectedClientMessageId || sess._activeClientMessageId;
  if (!ctx.deps.readLiveUnits) {
    ctx.syncHistory(sessId, expectedOwner ? { clientMessageId: expectedOwner } : undefined);
    return;
  }
  if (ctx.swarmResyncInFlight.has(sessId)) return;
  ctx.swarmResyncInFlight.add(sessId);
  const lifecycle = ctx.lifecycleEpoch;
  void (async () => {
    try {
      const units = await fetchSwarmResyncUnits(ctx.deps.readLiveUnits, sessId, expectedOwner);
      if (ctx.lifecycleEpoch !== lifecycle || ctx.sessions.get(sessId) !== sess) return;
      if (units.length > 0) {
        const applied = applySwarmResyncUnits(
          sess,
          units,
          expectedOwner,
          planTurnStart(sess.messages, sess.messages.length),
          isFrozenLiveTarget,
        );
        if (applied) {
          ctx.deps.persistSession?.(sessId);
          ctx.scheduleNotify();
        }
        return;
      }
      ctx.syncHistory(sessId, expectedOwner ? { clientMessageId: expectedOwner } : undefined);
    } finally {
      ctx.swarmResyncInFlight.delete(sessId);
    }
  })();
}

function resetSessionKeysForRebuildFrames(
  ctx: SocketCtx,
  sess: ChatSession,
  frames: DurableLiveFrame[],
): void {
  const resetSessionKeys = new Set<string>();
  for (const record of frames) {
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const sessionKey = (payload as { sessionKey?: unknown }).sessionKey;
    if (typeof sessionKey === "string") resetSessionKeys.add(sessionKey);
  }
  for (const sessionKey of resetSessionKeys) {
    ctx.noteAuthoritativeFrameSeqReset(sess, { sessionKey });
    resetFrameSeqCursor(sess, { sessionKey });
  }
}

function advanceDurableJournalCursorForRecord(
  ctx: SocketCtx,
  sess: ChatSession,
  rawSessionKey: string,
  frameSeq: number,
  lastDurableFrameSeqBySessionKey: Map<string, DurableFrameSeqCheckpointEntry>,
): void {
  const previousDurable = lastDurableFrameSeqBySessionKey.get(rawSessionKey);
  const authoritativeResetEpoch =
    ctx.authoritativeFrameSeqResetEpochBySessionKey.get(rawSessionKey) ?? 0;
  if (previousDurable !== undefined && frameSeq <= previousDurable.frameSeq) {
    const currentReducerSeq = getFrameSeqCursor(
      sess._lastFrameSeqByKey,
      sess._lastFrameSeq,
      rawSessionKey,
    );
    const resetAlreadyApplied =
      authoritativeResetEpoch > previousDurable.consumedAuthoritativeResetEpoch;
    if (!resetAlreadyApplied && currentReducerSeq >= previousDurable.frameSeq) {
      resetFrameSeqCursor(sess, { sessionKey: rawSessionKey });
    }
    lastDurableFrameSeqBySessionKey.set(rawSessionKey, {
      frameSeq,
      consumedAuthoritativeResetEpoch: authoritativeResetEpoch,
    });
    return;
  }
  if (previousDurable) {
    lastDurableFrameSeqBySessionKey.set(rawSessionKey, {
      ...previousDurable,
      frameSeq,
    });
    return;
  }
  lastDurableFrameSeqBySessionKey.set(rawSessionKey, {
    frameSeq,
    consumedAuthoritativeResetEpoch: authoritativeResetEpoch,
  });
}

export function applyDurableLiveFramesToSession(
  ctx: SocketCtx,
  sessId: string,
  frames: DurableLiveFrame[],
  resetClientMessageIds: string[] = [],
  lastDurableFrameSeqBySessionKey?: Map<string, DurableFrameSeqCheckpointEntry>,
): void {
  const sess = ctx.sessions.get(sessId);
  if (!sess) return;
  const preReset = sess.messages.slice();
  if (resetClientMessageIds.length > 0) {
    resetSessionKeysForRebuildFrames(ctx, sess, frames);
    ctx.resetOwnerLocalRows(sess, resetClientMessageIds, liveProcessOwnersFromFrames(frames));
  }
  for (const record of frames) {
    if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
      continue;
    }
    const raw = record.payload as Record<string, unknown>;
    const peer = raw.peer;
    if (
      !peer ||
      typeof peer !== "object" ||
      Array.isArray(peer) ||
      (peer as { id?: unknown }).id !== sessId
    ) {
      continue;
    }
    const rawSessionKey = raw.sessionKey;
    const frameSeq = raw.frameSeq;
    if (
      lastDurableFrameSeqBySessionKey &&
      typeof rawSessionKey === "string" &&
      rawSessionKey &&
      typeof frameSeq === "number" &&
      Number.isSafeInteger(frameSeq) &&
      frameSeq > 0
    ) {
      advanceDurableJournalCursorForRecord(
        ctx,
        sess,
        rawSessionKey,
        frameSeq,
        lastDurableFrameSeqBySessionKey,
      );
    }
    if (isOutboundFrame(raw)) ctx.dispatch(raw);
  }
  rebuildIndexes(sess);
  normalizeDelegateCards(sess);
  normalizeGoalCards(sess);
  sess.messages = repairPostFinalProcessOrder(sess.messages);
  observeTimelineShadow({
    entry: "durable-frames",
    sessionId: sessId,
    input: [...preReset, ...sess.messages],
    oldOutput: sess.messages,
  });
  ctx.deps.persistSession?.(sessId);
  ctx.scheduleNotify();
}

export function clearUnpublishedTapeRetryForSession(ctx: SocketCtx, sessId: string): void {
  const state = ctx.unpublishedTapeRetries.get(sessId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  ctx.unpublishedTapeRetries.delete(sessId);
}

function armUnpublishedTapeRetryTimer(
  ctx: SocketCtx,
  sessId: string,
  state: UnpublishedTapeRetryState,
  delayMs: number,
): void {
  const expectedToken = state.token;
  const isCurrent = (): boolean =>
    ctx.lifecycleEpoch === state.lifecycleEpoch &&
    ctx.sessions.get(sessId) === state.session &&
    ctx.unpublishedTapeRetries.get(sessId) === state &&
    state.token === expectedToken;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (!isCurrent()) return;
    if (!state.session.messages.some((m) => m._displayDegradeReason === "records_unpublished")) {
      clearUnpublishedTapeRetryForSession(ctx, sessId);
      return;
    }
    state.inFlight = true;
    void Promise.resolve(
      ctx.deps.syncSession?.(sessId, {
        isCurrent,
        tapeProjectionOnly: true,
      }),
    )
      .catch(() => undefined)
      .finally(() => {
        if (!isCurrent()) return;
        state.inFlight = false;
        state.attempt += 1;
        reconcileUnpublishedTapeRetryForSession(ctx, sessId);
      });
  }, delayMs);
}

export function reconcileUnpublishedTapeRetryForSession(ctx: SocketCtx, sessId: string): void {
  const session = ctx.sessions.get(sessId);
  const pending =
    session?.messages.some((message) => message._displayDegradeReason === "records_unpublished") ===
    true;
  if (!session || !pending || !ctx.deps.syncSession) {
    clearUnpublishedTapeRetryForSession(ctx, sessId);
    return;
  }
  let state = ctx.unpublishedTapeRetries.get(sessId);
  if (state && (state.session !== session || state.lifecycleEpoch !== ctx.lifecycleEpoch)) {
    clearUnpublishedTapeRetryForSession(ctx, sessId);
    state = undefined;
  }
  if (!state) {
    state = {
      session,
      lifecycleEpoch: ctx.lifecycleEpoch,
      token: Symbol(`unpublished-tape:${sessId}`),
      startedAt: Date.now(),
      attempt: 0,
      timer: null,
      inFlight: false,
    };
    ctx.unpublishedTapeRetries.set(sessId, state);
  }
  if (state.timer || state.inFlight) return;
  const elapsed = Date.now() - state.startedAt;
  if (elapsed >= UNPUBLISHED_TAPE_RETRY_MAX_MS) {
    clearUnpublishedTapeRetryForSession(ctx, sessId);
    return;
  }
  const delay =
    UNPUBLISHED_TAPE_RETRY_DELAYS_MS[
      Math.min(state.attempt, UNPUBLISHED_TAPE_RETRY_DELAYS_MS.length - 1)
    ]!;
  armUnpublishedTapeRetryTimer(
    ctx,
    sessId,
    state,
    Math.min(delay, UNPUBLISHED_TAPE_RETRY_MAX_MS - elapsed),
  );
}
