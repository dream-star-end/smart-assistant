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
let activeModalRequestId: string | null = null;
const listeners = new Set<() => void>();

function notifyPermissionCoordinator(): void {
  for (const listener of listeners) listener();
}

export function subscribePermissionCoordinator(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPermissionPopupCoordinator(): void {
  dismissedRequestIds.clear();
  displayedRequestIds.clear();
  openRequestBySession.clear();
  activeModalRequestId = null;
  notifyPermissionCoordinator();
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
  if (displayedRequestIds.has(opts.requestId)) return false;
  if (!isDocumentForeground()) return false;
  if (activeModalRequestId && activeModalRequestId !== opts.requestId) return false;
  return true;
}

/** Call only when the modal is open and the tab is actually visible. */
export function markPermissionDisplayed(requestId: string, sessionId?: string): void {
  if (!requestId) return;
  if (!isDocumentForeground()) return;
  const already =
    displayedRequestIds.has(requestId) && activeModalRequestId === requestId;
  displayedRequestIds.add(requestId);
  activeModalRequestId = requestId;
  if (sessionId) openRequestBySession.set(sessionId, requestId);
  if (!already) notifyPermissionCoordinator();
}

export function dismissPermissionUi(requestId: string, sessionId?: string): void {
  if (!requestId) return;
  dismissedRequestIds.add(requestId);
  if (activeModalRequestId === requestId) activeModalRequestId = null;
  if (sessionId && openRequestBySession.get(sessionId) === requestId) {
    openRequestBySession.delete(sessionId);
  }
  notifyPermissionCoordinator();
}

export function isPermissionUiDismissed(requestId: string | undefined): boolean {
  return typeof requestId === "string" && dismissedRequestIds.has(requestId);
}

export function reopenPermissionUi(requestId: string, sessionId?: string): void {
  if (!requestId) return;
  dismissedRequestIds.delete(requestId);
  displayedRequestIds.delete(requestId);
  activeModalRequestId = requestId;
  if (sessionId) openRequestBySession.set(sessionId, requestId);
  notifyPermissionCoordinator();
}

export function activeModalRequest(): string | null {
  return activeModalRequestId;
}

/** Card unmount yields the singleton slot without marking the prompt dismissed. */
export function yieldActiveModal(requestId: string): void {
  if (!requestId || activeModalRequestId !== requestId) return;
  activeModalRequestId = null;
  notifyPermissionCoordinator();
}

export function activePermissionRequest(sessionId: string): string | undefined {
  return openRequestBySession.get(sessionId);
}

type FullInputFetcher = (requestId: string) => Promise<Record<string, unknown> | null>;
let fullInputFetcher: FullInputFetcher | null = null;

export function setPermissionFullInputFetcher(fetcher: FullInputFetcher | null): void {
  fullInputFetcher = fetcher;
}

export async function fetchPermissionFullInput(
  requestId: string,
): Promise<Record<string, unknown> | null> {
  if (!requestId || !fullInputFetcher) return null;
  try {
    return await fullInputFetcher(requestId);
  } catch {
    return null;
  }
}
