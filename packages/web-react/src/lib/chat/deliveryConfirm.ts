import type { ChatSession } from "./model";

/** Only the first admission opens the cost window; later delivery evidence is
 * monotone and must not erase debits that arrived while the engine was running. */
export function confirmDispatchDelivery(sess: ChatSession, clientMessageId: string, accepted: boolean): boolean {
  const user = sess.messages.find((m) => m.role === "user" && m.id === clientMessageId);
  if (!user) return false;
  const first = sess._admittedClientMessageId !== clientMessageId && user._deliveryState === undefined;
  sess._admittedClientMessageId = clientMessageId;
  const state = accepted ? "accepted" : user._deliveryState ?? "admitted";
  const changed = user._deliveryState !== state;
  user._deliveryState = state;
  if (first && !accepted) {
    const now = Date.now();
    sess._turnStartedAt = now;
    sess._turnCostCredits = "0";
    sess._turnCostSeenRequestIds = new Set();
    sess._turnCostReminderCredits = undefined;
    sess._turnCredits = { clientMessageId, settled: "0", requests: 0, asOf: now, receivedAt: now };
  }
  if (user.status !== "read" && user.status !== "replied" && user.status !== "sent") {
    user.status = "sent";
    return true;
  }
  return changed;
}

/** Snapshot/history acceptance does not initialize or revive a local turn. */
export function confirmSnapshotDelivery(
  sess: ChatSession | undefined,
  dispatch: { clientMessageId: string; acceptedAt?: number | null } | null | undefined,
): void {
  if (!sess || dispatch?.acceptedAt == null) return;
  const user = sess.messages.find((m) => m.role === "user" && m.id === dispatch.clientMessageId);
  if (user) user._deliveryState = "accepted";
}
