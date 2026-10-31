/** State errors may read authority once; this module never sends a user task. */
import { normalizeTurnErrorCode } from "@openclaude/protocol/browser";
import type { ChatSession } from "./model";
import type { SessionSnapshot } from "./sessionSnapshot";

type StateErrorFrame = {
  code?: string; clientMessageId?: string; peer?: { id: string }; ts?: number;
};
const STATE_CODES = new Set(["bad_sequence", "conflict", "turn_changed", "turn_finalized",
  "turn_in_flight", "turn_not_active", "active_turn"]);
const STORAGE_CODES = new Set(["session_persist_unavailable", "history_enrichment_unavailable",
  "turn_tape_state_error", "turn_tape_state_unavailable", "turn_tape_unavailable",
  "turn_tape_visible_unavailable", "tape_not_acked", "turn_tape_retryable"]);
const attempted = new WeakSet<object>();
const pending = new WeakMap<ChatSession, Set<string>>();

export function stateErrorWasResolved(code: string, cmid: string, snap: SessionSnapshot): boolean {
  const d = snap.dispatch;
  if (d?.clientMessageId !== cmid || snap.pendingPermissions.completeness !== "complete" ||
    snap.hasMore || (snap.gap && snap.gap.reason !== "cursor_reset")) return false;
  const completed = d.status === "terminal" && d.outcome === "completed" && snap.reconcile === "turn_completed";
  if (STORAGE_CODES.has(code)) return completed;
  return STATE_CODES.has(code) && (completed || (d.status === "accepted" && d.outcome === null));
}

/** Only a named peer AND its exact current message can turn an error into a readback.
 * A failed/ambiguous read re-enters the original error handler with the same object. */
export function attemptStateErrorReadback(
  sess: ChatSession,
  frame: StateErrorFrame,
  effects: {
    read: (sessionId: string) => Promise<SessionSnapshot | null | undefined>;
    current: () => boolean;
    replay: () => void;
    changed: () => void;
  },
): boolean {
  const code = normalizeTurnErrorCode(frame.code);
  const cmid = frame.clientMessageId;
  if (attempted.has(frame) || frame.peer?.id !== sess.id || !cmid ||
    sess._activeClientMessageId !== cmid || !sess._sendingInFlight || sess._stopSettlement ||
    (!STATE_CODES.has(code) && !STORAGE_CODES.has(code))) return false;
  attempted.add(frame);
  const key = `${cmid}:${code}`;
  const inflight = pending.get(sess) ?? new Set<string>();
  if (inflight.has(key)) return true;
  pending.set(sess, inflight);
  inflight.add(key);
  void effects.read(sess.id).then((snap) => {
    if (!effects.current()) return;
    const latest = [...sess.messages].reverse().find((message) => message.role === "user");
    if (latest?.id !== cmid) return;
    if (!snap || snap.sessionId !== sess.id || !stateErrorWasResolved(code, cmid, snap)) {
      effects.replay();
      return;
    }
    const id = `sys-state-readback-${cmid}-${code}`;
    if (!sess.messages.some((message) => message.id === id)) sess.messages.push({
      id, role: "system", text: "已同步当前任务状态", ts: Date.now(), _source: "local",
    });
    effects.changed();
  }, () => { if (effects.current()) effects.replay(); }).finally(() => inflight.delete(key));
  return true;
}
