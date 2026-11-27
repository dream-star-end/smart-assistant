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
import {
  CUTOVER_FENCING_ERROR_CODE,
  createCutoverInFlightTracker,
  defaultCutoverInFlightTracker,
  rejectIfCutoverFencing,
  type CutoverInFlightSnapshot,
  type CutoverInFlightTracker,
  type NonSurvivableKind,
} from "../logging/cutoverInFlight.js";
import type { ControlListener } from "./controlListener.js";
import type { DesiredWatch, Slot } from "./deployState.js";
import type { LeadershipStatus } from "./leaderLease.js";

export {
  CUTOVER_FENCING_ERROR_CODE,
  createCutoverInFlightTracker,
  defaultCutoverInFlightTracker,
  rejectIfCutoverFencing,
  type CutoverInFlightSnapshot,
  type CutoverInFlightTracker,
  type NonSurvivableKind,
};

export const DEPLOY_REFRESH_DESIRED_PATH = "/internal/v5/deploy/refresh-desired";
export const CUTOVER_READINESS_PATH = "/internal/v5/cutover-readiness";
export const CUTOVER_FENCE_PATH = "/internal/v5/cutover-fence";
export const DRAIN_WS_PATH = "/internal/v5/drain-ws";

const MAX_FENCE_BODY_BYTES = 4_096;

export interface RemoteRelayReadinessSnapshot {
  readonly external: boolean;
  readonly healthy: boolean;
  readonly disabled?: boolean;
  readonly slot: "A" | "B" | null;
  readonly instanceId: string | null;
  readonly activeCount: number;
}

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
  /** Optional live readiness probe for the standalone external remote-relay daemon. */
  probeRemoteRelayReadiness?: () => Promise<RemoteRelayReadinessSnapshot>;
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

    const defaultRelay: RemoteRelayReadinessSnapshot = {
      external: false,
      healthy: false,
      disabled: false,
      slot: null,
      instanceId: null,
      activeCount: 0,
    };
    const buildReadinessBody = (relay: RemoteRelayReadinessSnapshot): Record<string, unknown> => {
      const snap = tracker.snapshot();
      const activeBrowserWs = Math.max(0, deps.getActiveBrowserWs?.() ?? 0);
      const leadership = deps.getLeadership();
      return {
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
        remoteRelayExternal: relay.external,
        remoteRelayHealthy: relay.healthy,
        remoteRelayDisabled: Boolean(relay.disabled),
        remoteRelaySlot: relay.slot,
        remoteRelayInstanceId: relay.instanceId,
        remoteRelayActiveCount: Math.max(0, relay.activeCount),
      };
    };

    const probe = deps.probeRemoteRelayReadiness;
    if (!probe) {
      sendJson(res, 200, buildReadinessBody(defaultRelay));
      return true;
    }

    void (async () => {
      let relay: RemoteRelayReadinessSnapshot = defaultRelay;
      try {
        const probed = await probe();
        const external = Boolean(probed.external);
        const disabled = external && Boolean(probed.disabled);
        const slot = probed.slot === "A" || probed.slot === "B" ? probed.slot : null;
        const instanceId =
          typeof probed.instanceId === "string" && probed.instanceId.length > 0
            ? probed.instanceId
            : null;
        const activeCount =
          typeof probed.activeCount === "number" && Number.isFinite(probed.activeCount)
            ? Math.max(0, probed.activeCount)
            : 0;
        relay = {
          external,
          healthy: external && !disabled && Boolean(probed.healthy) && instanceId !== null,
          disabled,
          slot,
          instanceId,
          activeCount: disabled ? 0 : activeCount,
        };
      } catch {
        relay = defaultRelay;
      }
      sendJson(res, 200, buildReadinessBody(relay));
    })();
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
