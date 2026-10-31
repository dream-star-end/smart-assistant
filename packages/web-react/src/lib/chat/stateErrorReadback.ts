/** State errors may read authority once; this module never sends a user task. */
import { normalizeTurnErrorCode } from "@openclaude/protocol/browser";
import type { ChatSession } from "./model";
import { snapshotIsStale, type SessionSnapshot } from "./sessionSnapshot";

type StateErrorFrame = {
  code?: string; clientMessageId?: string; peer?: { id: string }; ts?: number; frameSeq?: number; sessionKey?: string;
};
// The sole capture distinguishes storage errors, which require completed authority.
const READBACK_CODES = /^(?:bad_sequence|conflict|turn_(?:changed|finalized|in_flight|not_active)|active_turn|(session_persist_unavailable|history_enrichment_unavailable|turn_tape_(?:state_error|state_unavailable|unavailable|visible_unavailable|retryable)|tape_not_acked))$/;
const attempted = new WeakSet<object>();
// Separate key prefixes keep pending reads and adjacent finals disjoint in one session set.
const readbacks = new WeakMap<ChatSession, Set<string>>();
const compatKey = (cmid: string, sessionKey: string | undefined, seq: number | undefined) => `f:${cmid}:${sessionKey ?? ""}:${seq}`;

/** Called after the reducer accepted frameSeq and identified exact adjacent [error] text. */
export function consumeStateReadbackCompatFinal(sess: ChatSession, frame: StateErrorFrame): boolean {
  const cmid = frame.clientMessageId ?? sess._activeClientMessageId;
  return !!cmid && readbacks.get(sess)?.delete(compatKey(cmid, frame.sessionKey, frame.frameSeq)) === true;
}

/** Only a named peer AND its exact current message can turn an error into a readback.
 * A failed/ambiguous read re-enters the original error handler with the same object. */
export function attemptStateErrorReadback<F extends StateErrorFrame>(
  sess: ChatSession,
  frame: F,
  effects: {
    accept: () => boolean;
    read: (sessionId: string) => Promise<SessionSnapshot | null | undefined>;
    /** Same lifecycle/session and no Stop or newer active turn. */
    current: () => boolean;
    replay: (frame: F) => void;
    changed: () => void;
  },
): boolean {
  const code = normalizeTurnErrorCode(frame.code);
  const policy = READBACK_CODES.exec(code);
  const cmid = frame.clientMessageId;
  if (attempted.has(frame) || frame.peer?.id !== sess.id || !cmid ||
    sess._activeClientMessageId !== cmid || !sess._sendingInFlight || sess._stopSettlement ||
    !policy) return false;
  attempted.add(frame);
  if (!effects.accept()) return true;
  const key = `r:${cmid}:${code}`;
  const inflight = readbacks.get(sess) ?? new Set<string>();
  readbacks.set(sess, inflight);
  // Reuse the reducer's exact adjacent compatibility-final fence while reading authority.
  if (typeof frame.frameSeq === "number" && frame.frameSeq > 0) {
    const finalSeq = frame.frameSeq + 1;
    sess._suppressErrorBubbleAtSeq = finalSeq;
    inflight.add(compatKey(cmid, frame.sessionKey, finalSeq));
  }
  if (inflight.has(key)) return true;
  inflight.add(key);
  const replay = () => {
    if (!effects.current() || (sess._activeClientMessageId !== cmid &&
      sess.messages.find((message) => message.role === "user" && message.id === cmid)?.status === "replied")) return;
    // The adjacent final may already have advanced frameSeq. This is the same
    // locally held error, not a new incoming frame or a cursor rewind.
    const held = { ...frame, frameSeq: undefined };
    attempted.add(held);
    effects.replay(held);
    effects.changed();
  };
  void import("./stateErrorReadbackResult").then(({ readStateErrorResult }) =>
    readStateErrorResult({ sess, code, cmid, requiresCompletion: !!policy[1], effects, replay,
      isStale: snapshotIsStale }),
  ).catch(replay).finally(() => inflight.delete(key));
  return true;
}
