import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData, WebSocket } from "ws";
import { JwtError, verifyAccess, type AccessClaims } from "../../auth/jwt.js";
import { getContainerLinkHandle } from "../containerLink.js";
import { attachContainerTransport } from "../containerLinkTransport.js";
import { parseClientTelemetryFromUserAgent, type ClientTelemetryContext } from "../turnPerformance.js";
import type { ModelCheckerHandle } from "../userChatBridgeTypes.js";
import { sendErrorFrame } from "../userErrorFrames.js";
import { BRIDGE_WS_PATH, CLOSE_BRIDGE, ContainerUnreadyError } from "./constants.js";
import type {
  AgentModelResolverHandle,
  BridgeSharedState,
  EarlyMessage,
  ResolveContainerEndpoint,
} from "./types.js";
import {
  closeWsSafely,
  encode4503Reason,
  parseWsUrl,
  rejectHttp,
  sendJsonSafely,
  terminateWsSafely,
  uidFromClaims,
} from "./wireHelpers.js";

function parseSecWebSocketBearer(header: string | string[] | undefined): string {
  if (typeof header !== "string") return "";
  const parts = header.split(",").map((part) => part.trim());
  return parts.length >= 2 && parts.includes("bearer") ? (parts[parts.length - 1] ?? "") : "";
}

function extractUpgradeBearerToken(req: IncomingMessage): string {
  const fromProtocol = parseSecWebSocketBearer(req.headers["sec-websocket-protocol"]);
  if (fromProtocol) return fromProtocol;
  const auth = req.headers.authorization;
  return typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "").trim() : "";
}

async function authenticateUpgrade(
  ws: WebSocket,
  req: IncomingMessage,
  shared: BridgeSharedState,
): Promise<{ claims: AccessClaims; uid: bigint } | null> {
  const token = extractUpgradeBearerToken(req);
  if (!token) {
    sendErrorFrame(ws, "UNAUTHORIZED", "missing token (bearer protocol or Authorization header)");
    closeWsSafely(ws, CLOSE_BRIDGE.POLICY, "unauthorized");
    return null;
  }
  let claims: AccessClaims;
  try {
    claims = await verifyAccess(token, shared.deps.jwtSecret);
  } catch (err) {
    if (err instanceof JwtError) {
      sendErrorFrame(ws, "UNAUTHORIZED", "invalid or expired token");
    } else {
      sendErrorFrame(ws, "ERR_INTERNAL", "auth failure");
      shared.log?.error("user-chat-bridge: verifyAccess threw", { err });
    }
    closeWsSafely(ws, CLOSE_BRIDGE.POLICY, "unauthorized");
    return null;
  }
  try {
    return { claims, uid: uidFromClaims(claims) };
  } catch (err) {
    shared.log?.error("user-chat-bridge: bad sub claim", { err });
    sendErrorFrame(ws, "UNAUTHORIZED", "bad uid in token");
    closeWsSafely(ws, CLOSE_BRIDGE.POLICY, "unauthorized");
    return null;
  }
}

async function verifyUpgradeUserStatusAndMaintenance(
  ws: WebSocket,
  uid: bigint,
  claims: AccessClaims,
  shared: BridgeSharedState,
): Promise<{ ok: true; modelCheckerHandle: ModelCheckerHandle | null } | { ok: false }> {
  if (shared.deps.pgPool) {
    try {
      const st = await shared.deps.pgPool.query<{ status: string }>(
        "SELECT status FROM users WHERE id = $1",
        [uid.toString()],
      );
      const status = st.rows[0]?.status;
      if (status !== undefined && status !== "active") {
        shared.log?.info("user-chat-bridge: rejected non-active user", {
          uid: uid.toString(),
          status,
        });
        sendErrorFrame(ws, "FORBIDDEN", "account is not active");
        closeWsSafely(ws, CLOSE_BRIDGE.POLICY, "account inactive");
        return { ok: false };
      }
    } catch (err) {
      shared.log?.warn("user-chat-bridge: user status check failed (fail-open)", {
        uid: uid.toString(),
        err: (err as Error).message,
      });
    }
  }
  let modelCheckerHandle: ModelCheckerHandle | null = null;
  try {
    modelCheckerHandle = await shared.loadBridgeModelChecker(uid);
  } catch (err) {
    shared.log?.error("user-chat-bridge: loadAllowedModelChecker threw", {
      uid: uid.toString(),
      err,
    });
    sendErrorFrame(ws, "ERR_INTERNAL", "authorization unavailable");
    closeWsSafely(ws, CLOSE_BRIDGE.INTERNAL, "authorization unavailable");
    return { ok: false };
  }
  if (claims.role !== "admin" && (await shared.adapters.isInMaintenance())) {
    shared.log?.info("user-chat-bridge: maintenance block", { uid: uid.toString() });
    sendErrorFrame(ws, "MAINTENANCE", "服务正在维护中,请稍后再试");
    closeWsSafely(
      ws,
      CLOSE_BRIDGE.MAINTENANCE,
      JSON.stringify({ retryAfterSec: 60, reason: "maintenance" }),
    );
    return { ok: false };
  }
  return { ok: true, modelCheckerHandle };
}

async function resolveUpgradeEndpointAndAgentResolver(
  ws: WebSocket,
  uid: bigint,
  shared: BridgeSharedState,
): Promise<{
  endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>;
  agentModelResolverHandle: AgentModelResolverHandle | null;
} | null> {
  let endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>;
  try {
    endpoint = await shared.deps.resolveContainerEndpoint(uid);
  } catch (err) {
    if (err instanceof ContainerUnreadyError) {
      shared.log?.info("user-chat-bridge: container not ready", {
        uid: uid.toString(),
        reason: err.reason,
        retryAfterSec: err.retryAfterSec,
      });
      closeWsSafely(
        ws,
        CLOSE_BRIDGE.CONTAINER_UNREADY,
        encode4503Reason(err.retryAfterSec, err.reason),
      );
      return null;
    }
    shared.log?.error("user-chat-bridge: resolveContainerEndpoint threw", {
      uid: uid.toString(),
      err,
    });
    sendErrorFrame(ws, "ERR_INTERNAL", "agent unavailable");
    closeWsSafely(ws, CLOSE_BRIDGE.INTERNAL, "agent unavailable");
    return null;
  }
  try {
    const agentModelResolverHandle = await shared.loadBridgeAgentModelResolver(
      uid,
      endpoint.bundleRev,
    );
    return { endpoint, agentModelResolverHandle };
  } catch (err) {
    shared.log?.error("user-chat-bridge: loadAgentModelResolver threw", {
      uid: uid.toString(),
      bundleRev: endpoint.bundleRev ?? null,
      err,
    });
    sendErrorFrame(ws, "ERR_INTERNAL", "authorization unavailable");
    closeWsSafely(ws, CLOSE_BRIDGE.INTERNAL, "authorization unavailable");
    return null;
  }
}

async function runUpgradePipeline(
  ws: WebSocket,
  req: IncomingMessage,
  shared: BridgeSharedState,
  pendingMessages: EarlyMessage[],
  earlyState: { closed: { code: number; reason: Buffer } | null },
  detachEarlyHandlers: () => void,
  connId: string,
  clientTelemetry: ClientTelemetryContext,
): Promise<void> {
  const auth = await authenticateUpgrade(ws, req, shared);
  if (!auth) return;
  const { claims, uid } = auth;
  const gate = await verifyUpgradeUserStatusAndMaintenance(ws, uid, claims, shared);
  if (!gate.ok) return;
  const resolved = await resolveUpgradeEndpointAndAgentResolver(ws, uid, shared);
  if (!resolved) return;
  const { endpoint, agentModelResolverHandle } = resolved;
  const connectAbort = new AbortController();
  let containerWs: WebSocket;
  try {
    containerWs = await attachContainerTransport({
      uid,
      endpoint,
      links: shared.links,
      deps: shared.deps,
      maxFrameBytes: shared.config.maxFrameBytes,
      signal: connectAbort.signal,
      connId,
    });
  } catch (err) {
    shared.log?.error("user-chat-bridge: container socket factory failed", {
      uid: uid.toString(),
      tunnel: !!endpoint.tunnel,
      hostId: endpoint.tunnel?.hostId,
      err,
    });
    sendErrorFrame(ws, "ERR_CONTAINER", "cannot connect");
    closeWsSafely(ws, CLOSE_BRIDGE.INTERNAL, "agent unavailable");
    return;
  }
  const onEarlyContainerWsError = (err: Error): void => {
    shared.log?.warn("user-chat-bridge: container ws error during connect", {
      uid: uid.toString(),
      tunnel: !!endpoint.tunnel,
      host: endpoint.host,
      port: endpoint.port,
      err: String((err as { message?: string })?.message ?? err),
    });
  };
  containerWs.on("error", onEarlyContainerWsError);
  detachEarlyHandlers();
  if (earlyState.closed !== null) {
    shared.log?.info("user-chat-bridge: client closed during ensure", { uid: uid.toString() });
    terminateWsSafely(containerWs);
    try {
      connectAbort.abort();
    } catch (err) {
      void err;
    }
    return;
  }
  containerWs.off("error", onEarlyContainerWsError);
  shared.startBridge({
    userWs: ws,
    uid,
    endpoint,
    earlyMessages: pendingMessages,
    containerId: endpoint.containerId,
    containerWs,
    connectAbort,
    modelCheckerHandle: gate.modelCheckerHandle,
    agentModelResolverHandle,
    connId,
    userRole: claims.role === "admin" ? "admin" : "user",
    originAuthzReady: true,
    clientTelemetry,
  });
  getContainerLinkHandle(containerWs)?.activate();
}

export function createHandleUpgrade(
  shared: BridgeSharedState,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  return function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = parseWsUrl(req);
    if (!url) {
      rejectHttp(
        socket,
        400,
        JSON.stringify({ error: { code: "BAD_URL", message: "cannot parse URL" } }),
      );
      return true;
    }
    if (url.pathname !== BRIDGE_WS_PATH) return false;
    shared.wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        const feBuild = shared.deps.getFrontendBuildId?.();
        if (feBuild) sendJsonSafely(ws, { type: "sys.frontend_build", build: feBuild });
      } catch (err) {
        void err;
      }
      const pendingMessages: EarlyMessage[] = [];
      const earlyState: { closed: { code: number; reason: Buffer } | null } = { closed: null };
      const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
        pendingMessages.push({ data, isBinary, receivedAtMs: Date.now() });
      };
      const onEarlyClose = (code: number, reason: Buffer): void => {
        earlyState.closed = { code, reason };
      };
      ws.on("message", onEarlyMessage);
      ws.on("close", onEarlyClose);
      ws.on("error", (err) => {
        shared.log?.warn("user-chat-bridge: early user ws error", { err });
      });
      const detachEarlyHandlers = (): void => {
        ws.off("message", onEarlyMessage);
        ws.off("close", onEarlyClose);
      };
      const connId = randomUUID();
      const clientTelemetry = parseClientTelemetryFromUserAgent(req.headers["user-agent"]);
      void runUpgradePipeline(
        ws,
        req,
        shared,
        pendingMessages,
        earlyState,
        detachEarlyHandlers,
        connId,
        clientTelemetry,
      ).catch((err: unknown) => {
        shared.log?.error("user-chat-bridge: upgrade pipeline threw", { err });
        closeWsSafely(ws, CLOSE_BRIDGE.INTERNAL, "internal error");
      });
    });
    return true;
  };
}
