import { withUserError } from "@openclaude/protocol";
import { WebSocket } from "ws";
import type { Logger } from "../../logging/logger.js";
import type { BridgeSharedState } from "./types.js";

function sessionFanoutKey(userId: string, sessionId: string): string {
  return `${userId}\0${sessionId}`;
}

export function registerUserWsSession(
  shared: BridgeSharedState,
  ws: WebSocket,
  userId: string,
  sessionId: string,
): void {
  if (sessionId.length < 1 || sessionId.length > 512) return;
  const key = sessionFanoutKey(userId, sessionId);
  let subscribers = shared.sessionToUserWs.get(key);
  if (!subscribers) {
    subscribers = new Set();
    shared.sessionToUserWs.set(key, subscribers);
  }
  subscribers.add(ws);
  let owned = shared.userWsToSessionKeys.get(ws);
  if (!owned) {
    owned = new Set();
    shared.userWsToSessionKeys.set(ws, owned);
  }
  owned.add(key);
}

export function unregisterUserWsSessions(shared: BridgeSharedState, ws: WebSocket): void {
  const owned = shared.userWsToSessionKeys.get(ws);
  if (!owned) return;
  shared.userWsToSessionKeys.delete(ws);
  for (const key of owned) {
    const subscribers = shared.sessionToUserWs.get(key);
    if (!subscribers) continue;
    subscribers.delete(ws);
    if (subscribers.size === 0) shared.sessionToUserWs.delete(key);
  }
}

export function openUserWsForSession(
  shared: BridgeSharedState,
  userId: string,
  sessionId: string | null,
): WebSocket[] {
  if (sessionId === null || sessionId.length < 1) return [];
  const subscribers = shared.sessionToUserWs.get(sessionFanoutKey(userId, sessionId));
  if (!subscribers || subscribers.size === 0) return [];
  const open: WebSocket[] = [];
  for (const candidate of subscribers) {
    if (candidate.readyState === WebSocket.OPEN) open.push(candidate);
  }
  return open;
}

function sendTextToSockets(
  sockets: Iterable<WebSocket>,
  text: string,
  log: Logger | undefined,
  label: string,
  meta: Record<string, unknown>,
): number {
  let sent = 0;
  for (const ws of sockets) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      ws.send(text, { binary: false }, (err) => {
        if (err) log?.warn(`user-chat-bridge: ${label} send error`, { ...meta, err });
      });
      sent += 1;
    } catch (err) {
      log?.warn(`user-chat-bridge: ${label} send threw`, { ...meta, err });
    }
  }
  return sent;
}

export function broadcastToUser(
  shared: BridgeSharedState,
  uid: bigint,
  payload: unknown,
): number {
  const uidStr = uid.toString();
  const set = shared.uidToUserWs.get(uidStr);
  if ((payload as { type?: string } | null)?.type === "outbound.cost_charged") {
    shared.log?.info("user-chat-bridge: cost_charged broadcast", {
      uid: uidStr,
      recipients: set ? set.size : 0,
      registeredUids: shared.uidToUserWs.size,
    });
  }
  if (!set || set.size === 0) return 0;
  let text: string;
  try {
    text = JSON.stringify(withUserError(payload));
  } catch (err) {
    shared.log?.warn("user-chat-bridge: broadcastToUser stringify failed", { uid: uidStr, err });
    return 0;
  }
  return sendTextToSockets(set, text, shared.log, "broadcastToUser", { uid: uidStr });
}

export function syncGoalToContainers(
  shared: BridgeSharedState,
  uid: bigint,
  goal: unknown,
): number {
  const set = shared.uidToContainerWs.get(uid.toString());
  if (!set || set.size === 0) return 0;
  let text: string;
  try {
    text = JSON.stringify({ type: "inbound.goal_sync", goal });
  } catch (err) {
    void err;
    return 0;
  }
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      ws.send(text);
      sent += 1;
    } catch (err) {
      void err;
    }
  }
  return sent;
}

export function broadcastAll(shared: BridgeSharedState, payload: unknown): number {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch (err) {
    shared.log?.warn("user-chat-bridge: broadcastAll stringify failed", { err });
    return 0;
  }
  let sent = 0;
  for (const set of shared.uidToUserWs.values()) {
    sent += sendTextToSockets(set, text, shared.log, "broadcastAll", {});
  }
  return sent;
}

export function broadcastToUsers(
  shared: BridgeSharedState,
  uids: string[],
  payload: unknown,
): number {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch (err) {
    shared.log?.warn("user-chat-bridge: broadcastToUsers stringify failed", { err });
    return 0;
  }
  let sent = 0;
  for (const uid of uids) {
    const set = shared.uidToUserWs.get(uid);
    if (!set || set.size === 0) continue;
    sent += sendTextToSockets(set, text, shared.log, "broadcastToUsers", { uid });
  }
  return sent;
}

export function onlineUserSubset(shared: BridgeSharedState, uids: string[]): string[] {
  const out: string[] = [];
  for (const uid of new Set(uids)) {
    const set = shared.uidToUserWs.get(uid);
    if (set && [...set].some((ws) => ws.readyState === WebSocket.OPEN)) out.push(uid);
  }
  return out;
}

export function startFrontendBuildReannounceTimer(
  shared: BridgeSharedState,
): NodeJS.Timeout | null {
  try {
    shared.announcedFrontendBuild = shared.deps.getFrontendBuildId?.() ?? null;
  } catch (err) {
    void err;
  }
  if (!shared.deps.getFrontendBuildId) return null;
  const timer = setInterval(() => {
    let build: string | null = null;
    try {
      build = shared.deps.getFrontendBuildId?.() ?? null;
    } catch (err) {
      void err;
      return;
    }
    if (!build || build === shared.announcedFrontendBuild) return;
    shared.announcedFrontendBuild = build;
    const frame = JSON.stringify({ type: "sys.frontend_build", build });
    for (const client of shared.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(frame);
      } catch (err) {
        void err;
      }
    }
  }, shared.deps.frontendBuildReannounceMs ?? 15_000);
  timer.unref?.();
  return timer;
}
