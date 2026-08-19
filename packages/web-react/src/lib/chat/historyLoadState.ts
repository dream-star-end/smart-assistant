export type HistorySurface =
  | "skeleton"
  | "error"
  | "empty"
  | "messages";

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
