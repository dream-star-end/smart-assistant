export type HistorySurface =
  | "skeleton"
  | "error"
  | "empty"
  | "messages";

export type SubstantiveHistoryCandidate = {
  role?: string;
  _resolved?: boolean;
  _controlPending?: boolean;
  _askUserExpiresAt?: unknown;
} | null | undefined;

/**
 * Whether a locally hydrated message represents real transcript history or an
 * active user prompt. Settled `permission` cards and client `system` /
 * `runtime-event` rows remain in IndexedDB after `_timelineRecord` stripping;
 * an orphan card alone must not suppress the cold-load skeleton or error view.
 */
export function isSubstantiveHistoryMessage(
  message: SubstantiveHistoryCandidate,
  nowMs: number = Date.now(),
): boolean {
  const role = message?.role;
  if (typeof role !== "string" || role.length === 0) return false;
  if (role === "permission") {
    if (message?._controlPending === true) return true;
    if (message?._resolved === true) return false;
    const expiresAt = message?._askUserExpiresAt;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= nowMs) {
      return false;
    }
    return true;
  }
  if (role === "system" || role === "runtime-event") return false;
  return true;
}

export function countSubstantiveHistoryMessages(
  messages: ReadonlyArray<SubstantiveHistoryCandidate>,
  nowMs: number = Date.now(),
): number {
  let count = 0;
  for (const message of messages) {
    if (isSubstantiveHistoryMessage(message, nowMs)) count += 1;
  }
  return count;
}

/** Canonical GET failure must never look like a brand-new empty session. */
export function sessionHistorySurface(input: {
  gated?: boolean;
  loadingHistory: boolean;
  hasMessages: boolean;
  sending?: boolean;
  knownNonEmpty: boolean;
  historyError: boolean;
}): HistorySurface {
  if (input.gated) return "empty";
  if (input.loadingHistory && !input.hasMessages && !input.sending) return "skeleton";
  if (input.historyError && input.knownNonEmpty && !input.hasMessages) return "error";
  if (!input.hasMessages && !input.sending) return "empty";
  return "messages";
}
