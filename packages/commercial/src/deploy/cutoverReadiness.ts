/**
 * Master dual-slot cutover readiness tracker, admission fence & private control-port handlers (OCV5-854).
 *
 * Exposes four authenticated private-port endpoints (x-oc-egress-secret):
 *   - POST /internal/v5/deploy/refresh-desired
 *   - GET  /internal/v5/cutover-readiness
 *   - POST /internal/v5/cutover-fence
 *   - POST /internal/v5/drain-ws
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlListener } from "./controlListener.js";
import type { DesiredWatch, Slot } from "./deployState.js";
import type { LeadershipStatus } from "./leaderLease.js";

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

export const DEPLOY_REFRESH_DESIRED_PATH = "/internal/v5/deploy/refresh-desired";
export const CUTOVER_READINESS_PATH = "/internal/v5/cutover-readiness";
export const CUTOVER_FENCE_PATH = "/internal/v5/cutover-fence";
export const DRAIN_WS_PATH = "/internal/v5/drain-ws";

const MAX_FENCE_BODY_BYTES = 4_096;

export interface CutoverControlDeps {
  slot: Slot;
  secret: string | undefined;
  verifySecret: (presented: string, expected: string) => boolean;
  getLeadership: () => LeadershipStatus;
  getControlListener: () => Pick<ControlListener, "status" | "isVipOwner"> | undefined;
  desiredWatch?: Pick<DesiredWatch, "current" | "refreshNow" | "pollNow">;
  tracker?: CutoverInFlightTracker;
  getActiveBrowserWs?: () => number;
  drainBrowserWebSockets?: () => number;
  /** Real runtime ContainerLink capability (links !== null on userChatBridge). */
  getContainerLinkEnabled?: () => boolean;
  /** Optional extra hook invoked after desiredWatch refreshes. */
  onDesiredRefreshed?: () => Promise<void> | void;
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function authorizePrivateControl(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Pick<CutoverControlDeps, "secret" | "verifySecret">,
): boolean {
  if (!deps.secret) {
    sendJson(res, 503, { ok: false, error: "EGRESS_SECRET_UNSET" });
    return false;
  }
  const presented = req.headers["x-oc-egress-secret"];
  if (typeof presented !== "string" || !deps.verifySecret(presented, deps.secret)) {
    sendJson(res, 401, { ok: false, error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

function isVipOwned(deps: CutoverControlDeps): boolean {
  const listener = deps.getControlListener();
  if (!listener) return false;
  return typeof listener.isVipOwner === "function"
    ? listener.isVipOwner()
    : listener.status().vipBound === true;
}

async function readSmallJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_FENCE_BODY_BYTES) return null;
    chunks.push(buf);
  }
  if (total === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Dispatch the four cutover private-control endpoints.
 * Returns true if the request path was matched and handled (or is being handled asynchronously).
 */
export function handleCutoverControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CutoverControlDeps,
): boolean {
  const urlPath = (req.url ?? "").split("?")[0];
  if (
    urlPath !== DEPLOY_REFRESH_DESIRED_PATH &&
    urlPath !== CUTOVER_READINESS_PATH &&
    urlPath !== CUTOVER_FENCE_PATH &&
    urlPath !== DRAIN_WS_PATH
  ) {
    return false;
  }

  const tracker = deps.tracker ?? defaultCutoverInFlightTracker;

  if (urlPath === CUTOVER_READINESS_PATH) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    if (!authorizePrivateControl(req, res, deps)) return true;
    const snap = tracker.snapshot();
    const activeBrowserWs = Math.max(0, deps.getActiveBrowserWs?.() ?? 0);
    const leadership = deps.getLeadership();
    sendJson(res, 200, {
      ok: true,
      slot: deps.slot,
      role: leadership.state,
      vipOwner: isVipOwned(deps),
      fencing: snap.fencing,
      containerLinkEnabled: Boolean(deps.getContainerLinkEnabled?.()),
      activeExternalApi: snap.activeExternalApi,
      activeCursorExternal: snap.activeCursorExternal,
      activeChatgptProxy: snap.activeChatgptProxy,
      activeMuse: snap.activeMuse,
      activeBrowserWs,
      nonSurvivableInFlight: snap.nonSurvivableInFlight,
    });
    return true;
  }

  if (urlPath === CUTOVER_FENCE_PATH) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    if (!authorizePrivateControl(req, res, deps)) return true;
    void readSmallJsonObject(req)
      .then((body) => {
        if (!body || typeof body.enabled !== "boolean") {
          sendJson(res, 400, { ok: false, error: "INVALID_FENCE_BODY" });
          return;
        }
        tracker.setFencing(body.enabled);
        sendJson(res, 200, {
          ok: true,
          slot: deps.slot,
          fencing: tracker.isFencing(),
        });
      })
      .catch(() => {
        sendJson(res, 400, { ok: false, error: "INVALID_FENCE_BODY" });
      });
    return true;
  }

  if (urlPath === DRAIN_WS_PATH) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    if (!authorizePrivateControl(req, res, deps)) return true;
    const closedCount = Math.max(0, deps.drainBrowserWebSockets?.() ?? 0);
    sendJson(res, 200, {
      ok: true,
      slot: deps.slot,
      closedCount,
    });
    return true;
  }

  // POST /internal/v5/deploy/refresh-desired
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  if (!authorizePrivateControl(req, res, deps)) return true;

  void (async () => {
    let snap = deps.desiredWatch?.current() ?? null;
    if (deps.desiredWatch) {
      if (typeof deps.desiredWatch.refreshNow === "function") {
        snap = await deps.desiredWatch.refreshNow();
      } else if (typeof deps.desiredWatch.pollNow === "function") {
        await deps.desiredWatch.pollNow();
        snap = deps.desiredWatch.current();
      }
    }
    if (deps.onDesiredRefreshed) {
      await deps.onDesiredRefreshed();
    }
    const leadership = deps.getLeadership();
    sendJson(res, 200, {
      ok: true,
      slot: deps.slot,
      activeSlot: snap?.activeSlot ?? null,
      desiredLeaderSlot: snap?.desiredLeaderSlot ?? null,
      desiredControlSlot: snap?.desiredControlSlot ?? null,
      role: leadership.state,
      vipOwner: isVipOwned(deps),
    });
  })().catch((err) => {
    sendJson(res, 500, {
      ok: false,
      error: "REFRESH_DESIRED_FAILED",
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return true;
}
