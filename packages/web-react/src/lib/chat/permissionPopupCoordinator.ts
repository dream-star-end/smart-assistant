/**
 * Session-level permission popup coordinator (OCV5-185).
 *
 * Auto-open only in the foreground. Mark "already auto-shown" only after the
 * modal is actually displayed. Close/collapse is UI-only: it does not approve
 * or reject, and the card plus the independent pending entry can reopen it.
 */
const dismissedRequestIds = new Set<string>();
const displayedRequestIds = new Set<string>();
const openRequestBySession = new Map<string, string>();

export function resetPermissionPopupCoordinator(): void {
  dismissedRequestIds.clear();
  displayedRequestIds.clear();
  openRequestBySession.clear();
}

export function isDocumentForeground(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export function shouldAutoOpenPermission(opts: {
  requestId: string;
  livePrompt: boolean;
}): boolean {
  if (!opts.livePrompt || !opts.requestId) return false;
  if (dismissedRequestIds.has(opts.requestId)) return false;
  return isDocumentForeground();
}

/** Call only when the modal is open and the tab is actually visible. */
export function markPermissionDisplayed(requestId: string, sessionId?: string): void {
  if (!requestId) return;
  if (!isDocumentForeground()) return;
  displayedRequestIds.add(requestId);
  if (sessionId) openRequestBySession.set(sessionId, requestId);
}

export function dismissPermissionUi(requestId: string, sessionId?: string): void {
  if (!requestId) return;
  dismissedRequestIds.add(requestId);
  if (sessionId && openRequestBySession.get(sessionId) === requestId) {
    openRequestBySession.delete(sessionId);
  }
}

export function isPermissionUiDismissed(requestId: string | undefined): boolean {
  return typeof requestId === "string" && dismissedRequestIds.has(requestId);
}

export function reopenPermissionUi(requestId: string, sessionId?: string): void {
  if (!requestId) return;
  dismissedRequestIds.delete(requestId);
  if (sessionId) openRequestBySession.set(sessionId, requestId);
}

export function activePermissionRequest(sessionId: string): string | undefined {
  return openRequestBySession.get(sessionId);
}
