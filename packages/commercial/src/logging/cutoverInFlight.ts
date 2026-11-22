/**
 * Shared L1 cutover in-flight tracker and admission fence primitive (OCV5-854).
 *
 * Lives in commercial-logging (L1, scope master+egress) so provider/proxy/hub
 * modules can record in-flight non-survivable work and honor cutover fencing
 * without importing upward into admin-ops (deploy/).
 */
import type { ServerResponse } from "node:http";

export type NonSurvivableKind = "externalApi" | "cursorExternal" | "chatgptProxy" | "muse";

export interface CutoverInFlightSnapshot {
  activeExternalApi: number;
  activeCursorExternal: number;
  activeChatgptProxy: number;
  activeMuse: number;
  nonSurvivableInFlight: number;
  fencing: boolean;
}

export interface CutoverInFlightTracker {
  /** Increment in-flight count; returned release() is strictly idempotent. */
  begin(kind: NonSurvivableKind, res?: Pick<ServerResponse, "once">): () => void;
  /** Optional live tunnel count provider for ChatGPT CONNECT proxy. */
  setChatgptProxyTunnelsGetter(getter: (() => number) | null): void;
  /** Authoritative provider for open non-durable Muse jobs (replaces HTTP polling count). */
  setMuseJobsGetter(getter: (() => number) | null): void;
  /** Toggle cutover admission fence: rejects new non-survivable work while letting active work finish. */
  setFencing(enabled: boolean): void;
  isFencing(): boolean;
  snapshot(): CutoverInFlightSnapshot;
  reset(): void;
}

export function createCutoverInFlightTracker(): CutoverInFlightTracker {
  const counts: Record<NonSurvivableKind, number> = {
    externalApi: 0,
    cursorExternal: 0,
    chatgptProxy: 0,
    muse: 0,
  };
  let chatgptTunnelsGetter: (() => number) | null = null;
  let museJobsGetter: (() => number) | null = null;
  let fencing = false;

  return {
    begin(kind, res) {
      counts[kind] += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        counts[kind] = Math.max(0, counts[kind] - 1);
      };
      if (res) {
        res.once("finish", release);
        res.once("close", release);
      }
      return release;
    },
    setChatgptProxyTunnelsGetter(getter) {
      chatgptTunnelsGetter = getter;
    },
    setMuseJobsGetter(getter) {
      museJobsGetter = getter;
    },
    setFencing(enabled) {
      fencing = Boolean(enabled);
    },
    isFencing() {
      return fencing;
    },
    snapshot() {
      const tunnelCount = chatgptTunnelsGetter ? Math.max(0, chatgptTunnelsGetter()) : 0;
      const museJobCount = museJobsGetter ? Math.max(0, museJobsGetter()) : 0;
      const activeExternalApi = counts.externalApi;
      const activeCursorExternal = counts.cursorExternal;
      const activeChatgptProxy = counts.chatgptProxy + tunnelCount;
      const activeMuse = counts.muse + museJobCount;
      return {
        activeExternalApi,
        activeCursorExternal,
        activeChatgptProxy,
        activeMuse,
        nonSurvivableInFlight:
          activeExternalApi + activeCursorExternal + activeChatgptProxy + activeMuse,
        fencing,
      };
    },
    reset() {
      counts.externalApi = 0;
      counts.cursorExternal = 0;
      counts.chatgptProxy = 0;
      counts.muse = 0;
      chatgptTunnelsGetter = null;
      museJobsGetter = null;
      fencing = false;
    },
  };
}

/** Process-wide default tracker shared across Master in-process non-survivable listeners. */
export const defaultCutoverInFlightTracker = createCutoverInFlightTracker();

export const CUTOVER_FENCING_ERROR_CODE = "CUTOVER_FENCING_RETRY_LATER";

/**
 * Reject a new non-survivable HTTP request when cutover fencing is active.
 * Returns true if the request was rejected with 503 + Retry-After: 1.
 */
export function rejectIfCutoverFencing(
  res: ServerResponse,
  tracker: Pick<CutoverInFlightTracker, "isFencing"> = defaultCutoverInFlightTracker,
): boolean {
  if (!tracker.isFencing()) return false;
  if (!res.headersSent && !res.destroyed) {
    res.statusCode = 503;
    res.setHeader("Retry-After", "1");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: CUTOVER_FENCING_ERROR_CODE }));
  }
  return true;
}
