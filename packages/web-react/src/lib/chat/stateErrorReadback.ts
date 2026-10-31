/** State errors may read authority once; this module never sends a user task. */
import { normalizeTurnErrorCode } from "@openclaude/protocol/browser";
import type { ChatSession } from "./model";
import { snapshotIsStale, type SessionSnapshot } from "./sessionSnapshot";

type StateErrorFrame = {
  code?: string; clientMessageId?: string; peer?: { id: string }; ts?: number; frameSeq?: number; sessionKey?: string;
};
const STATE_CODES = /^(?:bad_sequence|conflict|turn_(?:changed|finalized|in_flight|not_active)|active_turn)$/;
const STORAGE_CODES = /^(?:session_persist_unavailable|history_enrichment_unavailable|turn_tape_(?:state_error|state_unavailable|unavailable|visible_unavailable|retryable)|tape_not_acked)$/;
const attempted = new WeakSet<object>();
const pending = new WeakMap<ChatSession, Set<string>>();
const compatibilityFinals = new WeakMap<ChatSession, Set<string>>();
const compatKey = (frame: StateErrorFrame, cmid: string) => `${cmid}:${frame.sessionKey ?? ""}:${frame.frameSeq}`;

/** Called after the reducer accepted frameSeq and identified exact adjacent [error] text. */
export function consumeStateReadbackCompatFinal(sess: ChatSession, frame: StateErrorFrame): boolean {
  const cmid = frame.clientMessageId ?? sess._activeClientMessageId;
  return !!cmid && compatibilityFinals.get(sess)?.delete(compatKey(frame, cmid)) === true;
}

/** Only a named peer AND its exact current message can turn an error into a readback.
 * A failed/ambiguous read re-enters the original error handler with the same object. */
export function attemptStateErrorReadback<F extends StateErrorFrame>(
  sess: ChatSession,
  frame: F,
  effects: {
    accept: () => boolean;
    read: (sessionId: string) => Promise<SessionSnapshot | null | undefined>;
    current: () => boolean;
    replay: (frame: F) => void;
    changed: () => void;
  },
): boolean {
  const code = normalizeTurnErrorCode(frame.code);
  const requiresCompletion = STORAGE_CODES.test(code);
  const cmid = frame.clientMessageId;
  if (attempted.has(frame) || frame.peer?.id !== sess.id || !cmid ||
    sess._activeClientMessageId !== cmid || !sess._sendingInFlight || sess._stopSettlement ||
    (!STATE_CODES.test(code) && !requiresCompletion)) return false;
  attempted.add(frame);
  if (!effects.accept()) return true;
  const key = `${cmid}:${code}`;
  const inflight = pending.get(sess) ?? new Set<string>();
  // Reuse the reducer's exact adjacent compatibility-final fence while reading authority.
  if (typeof frame.frameSeq === "number" && frame.frameSeq > 0) {
    sess._suppressErrorBubbleAtSeq = frame.frameSeq + 1;
    const finals = compatibilityFinals.get(sess) ?? new Set<string>();
    finals.add(compatKey({ ...frame, frameSeq: frame.frameSeq + 1 }, cmid));
    compatibilityFinals.set(sess, finals);
  }
  if (inflight.has(key)) return true;
  pending.set(sess, inflight);
  inflight.add(key);
  const replay = () => {
    if (!effects.current() || sess._stopSettlement ||
      (sess._activeClientMessageId && sess._activeClientMessageId !== cmid)) return;
    const source = sess.messages.find((message) => message.role === "user" && message.id === cmid);
    if (sess._activeClientMessageId !== cmid && source?.status === "replied") return;
    // The adjacent final may already have advanced frameSeq. This is the same
    // locally held error, not a new incoming frame or a cursor rewind.
    const held = { ...frame, frameSeq: undefined };
    attempted.add(held);
    effects.replay(held);
    effects.changed();
  };
  void import("./stateErrorReadbackResult").then(({ readStateErrorResult }) =>
    readStateErrorResult({ sess, code, cmid, requiresCompletion, effects, replay,
      isStale: (snap) => snapshotIsStale(sess, snap) }),
  ).catch(replay).finally(() => inflight.delete(key));
  return true;
}
