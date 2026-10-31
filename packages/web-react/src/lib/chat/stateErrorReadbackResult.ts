/** Snapshot evaluation is loaded only after a state error needs it.
 * Cursor claims and compatibility-final fences stay synchronous in the caller. */
import type { ChatSession } from "./model";
import { snapshotIsStale, type SessionSnapshot } from "./sessionSnapshot";

function stateErrorWasResolved(requiresCompletion: boolean, cmid: string, snap: SessionSnapshot): boolean {
  const d = snap.dispatch;
  if (d?.clientMessageId !== cmid || snap.pendingPermissions.completeness !== "complete" ||
    snap.hasMore || (snap.gap && snap.gap.reason !== "cursor_reset")) return false;
  const completed = d.status === "terminal" && d.outcome === "completed" && snap.reconcile === "turn_completed";
  return completed || (!requiresCompletion && d.status === "accepted" && d.outcome === null);
}

/** Load this module before starting HTTP so chunk latency cannot age an already-applied snapshot. */
export async function readStateErrorResult({ sess, code, cmid, requiresCompletion, effects, replay }: {
  sess: ChatSession; code: string; cmid: string; requiresCompletion: boolean;
  effects: {
    read: (sessionId: string) => Promise<SessionSnapshot | null | undefined>;
    current: () => boolean; changed: () => void;
  };
  replay: () => void;
}): Promise<void> {
  const current = () => effects.current() && !sess._stopSettlement &&
    (!sess._activeClientMessageId || sess._activeClientMessageId === cmid);
  if (!current()) return;
  const snap = await effects.read(sess.id);
  if (!current()) return;
  if (!snap || snap.sessionId !== sess.id || snapshotIsStale(sess, snap) || !stateErrorWasResolved(requiresCompletion, cmid, snap)) {
    replay();
    return;
  }
  const id = `sys-state-readback-${cmid}-${code}`;
  if (!sess.messages.some((message) => message.id === id)) sess.messages.push({
    id, role: "system", text: "已同步当前任务状态", ts: Date.now(), _source: "local", _errorDetail: code,
  });
  effects.changed();
}
