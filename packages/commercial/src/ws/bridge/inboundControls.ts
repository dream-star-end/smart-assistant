import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  DISPATCH_AUTHORITY_FIELD,
  isClientMessageId,
  MODEL_AUTHORITY_FIELD,
  stripDispatchAuthorityField,
  stripModelAuthorityField,
  SYSTEM_HELP_BOOTSTRAP_FIELD,
  takeSystemHelpBootstrap,
} from "@openclaude/protocol";
import {
  HELLO_LIVE_CATCHUP_MAX_BYTES,
  liveCatchupSendDecision,
  readOpenDispatchLiveFramePayloadsAfterSeq,
} from "../../db/liveTurnFrames.js";
import {
  admitDurableControl,
  HELLO_PENDING_PERMISSION_MAX_SESSIONS,
  pendingPermissionPromptToFrame,
  readPendingPermissionPromptsForSessions,
  selectHelloPermissionSessions,
  TurnControlConflictError,
} from "../../dispatch/turnControlStore.js";
import { isPlainRecord } from "../bridgeInputGuards.js";
import { sendHelloSessionSnapshots } from "../helloOpenDispatchSnapshot.js";
import { PROMPT_QUEUE_GRANT_FIELD } from "../promptQueueDispatchTypes.js";
import {
  enrichBindRequest,
  parseBindRequest,
  parseUnbindRequest,
} from "../sessionRepoBindBridge.js";
import { CROSS_POOL_CHECKPOINT_FIELD } from "../userChatBridgeRemotePoolSeal.js";
import { tryAutoRebindFlush } from "./connectionCodexState.js";
import { retainOutboundPersistQueueKey } from "./connectionLifecycle.js";
import {
  CLOSE_BRIDGE,
  HELLO_LIVE_CATCHUP_MAX_FRAMES,
  HELLO_LIVE_CATCHUP_MAX_SESSIONS,
  HIDDEN_REVIEWER_AGENT_ID,
  isControlId,
} from "./constants.js";
import type { BridgeConnectionCtx } from "./types.js";
import { closeWsSafely, parseLeftoverHotWsPayload, sendJsonSafely } from "./wireHelpers.js";

export function stripBinaryPrivateFields(
  data: RawData,
  len: number,
): { data: RawData; len: number } {
  try {
    const bytes =
      typeof data === "string"
        ? Buffer.from(data)
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const p = parsed as Record<string, unknown>;
      const sH = Object.prototype.hasOwnProperty.call(p, SYSTEM_HELP_BOOTSTRAP_FIELD);
      const sM = Object.prototype.hasOwnProperty.call(p, "_masterHistoricalMessages");
      const sC = Object.prototype.hasOwnProperty.call(p, CROSS_POOL_CHECKPOINT_FIELD);
      if (sH || sM || sC) {
        if (sH) takeSystemHelpBootstrap(p);
        if (sM) Reflect.deleteProperty(p, "_masterHistoricalMessages");
        if (sC) Reflect.deleteProperty(p, CROSS_POOL_CHECKPOINT_FIELD);
        const buf = Buffer.from(JSON.stringify(p), "utf8");
        return { data: buf, len: buf.byteLength };
      }
    }
  } catch (err) {
    void err;
  }
  return { data, len };
}

export function stripTextPrivateFields(
  ctx: BridgeConnectionCtx,
  parsedObj: Record<string, unknown>,
  isPromptQueueDispatch: boolean,
  isCronOriginDispatch: boolean,
): { dropped: true } | { dropped: false; rewritten: boolean } {
  let rewritten = false;
  if (
    Object.prototype.hasOwnProperty.call(parsedObj, "_goalState") ||
    Object.prototype.hasOwnProperty.call(parsedObj, "_masterHistoricalMessages") ||
    Object.prototype.hasOwnProperty.call(parsedObj, CROSS_POOL_CHECKPOINT_FIELD)
  ) {
    Reflect.deleteProperty(parsedObj, "_goalState");
    Reflect.deleteProperty(parsedObj, "_masterHistoricalMessages");
    Reflect.deleteProperty(parsedObj, CROSS_POOL_CHECKPOINT_FIELD);
    rewritten = true;
  }
  if (parsedObj.type === "inbound.goal_sync") {
    ctx.bridgeLog?.warn("user-chat-bridge: browser goal sync frame dropped");
    return { dropped: true };
  }
  if (Object.prototype.hasOwnProperty.call(parsedObj, SYSTEM_HELP_BOOTSTRAP_FIELD)) {
    takeSystemHelpBootstrap(parsedObj);
    rewritten = true;
  }
  if (Object.prototype.hasOwnProperty.call(parsedObj, MODEL_AUTHORITY_FIELD)) {
    stripModelAuthorityField(parsedObj);
    ctx.bridgeLog?.warn("user-chat-bridge: client-supplied model authority field stripped");
    rewritten = true;
  }
  if (Object.prototype.hasOwnProperty.call(parsedObj, DISPATCH_AUTHORITY_FIELD)) {
    stripDispatchAuthorityField(parsedObj);
    ctx.bridgeLog?.warn("user-chat-bridge: client-supplied dispatch authority field stripped");
    rewritten = true;
  }
  if (
    !isPromptQueueDispatch &&
    !isCronOriginDispatch &&
    Object.prototype.hasOwnProperty.call(parsedObj, PROMPT_QUEUE_GRANT_FIELD)
  ) {
    delete parsedObj[PROMPT_QUEUE_GRANT_FIELD];
    ctx.bridgeLog?.warn("user-chat-bridge: client-supplied prompt queue grant stripped");
    rewritten = true;
  }
  return { dropped: false, rewritten };
}

export function handleDurableControlFrame(
  ctx: BridgeConnectionCtx,
  controlFrame: Record<string, unknown>,
): boolean {
  const controlType = controlFrame.type;
  if (controlType !== "inbound.control.stop" && controlType !== "inbound.permission_response") {
    return false;
  }
  const pgPool = ctx.shared.deps.pgPool;
  if (!pgPool) return false;
  const peer = isPlainRecord(controlFrame.peer) ? controlFrame.peer : null;
  const sessionId = peer && typeof peer.id === "string" ? peer.id : null;
  if (sessionId === null) return true;
  const kind = controlType === "inbound.control.stop" ? "stop" : "permission";
  const controlId = isControlId(controlFrame.controlId)
    ? controlFrame.controlId
    : `control-${randomUUID()}`;
  const rootClientMessageId = isClientMessageId(controlFrame.clientMessageId)
    ? controlFrame.clientMessageId
    : null;
  const requestId =
    kind === "permission" && typeof controlFrame.requestId === "string"
      ? controlFrame.requestId
      : null;
  if (kind === "permission" && requestId === null) return true;
  const durablePayload = { ...controlFrame, controlId };
  void (async () => {
    try {
      const admission = await admitDurableControl(pgPool, {
        controlId,
        userId: ctx.uid,
        sessionId,
        rootClientMessageId,
        kind,
        requestId,
        payload: durablePayload,
      });
      ctx.shared.broadcastToUser(ctx.uid, {
        type: "outbound.control.receipt",
        controlId,
        controlKind: kind,
        status: admission.status === "terminal" ? "terminal" : "persisted",
        ...(admission.errorCode ? { errorCode: admission.errorCode } : {}),
        peer,
        ...(rootClientMessageId ? { clientMessageId: rootClientMessageId } : {}),
        ...(requestId ? { requestId } : {}),
      });
      if (admission.status === "pending" || admission.status === "leased") {
        await ctx.shared.drainDurableControlsForUser(ctx.uid);
      }
    } catch (error) {
      const conflict = error instanceof TurnControlConflictError;
      const errorCode = conflict ? error.code : "CONTROL_PERSIST_UNAVAILABLE";
      ctx.bridgeLog?.warn("user-chat-bridge: durable control admission failed", {
        controlId,
        kind,
        errorCode,
      });
      if (conflict) {
        ctx.shared.broadcastToUser(ctx.uid, {
          type: "outbound.control.receipt",
          controlId,
          controlKind: kind,
          status: "terminal",
          peer,
          ...(rootClientMessageId ? { clientMessageId: rootClientMessageId } : {}),
          ...(requestId ? { requestId } : {}),
          errorCode,
        });
      } else if (ctx.userWs.readyState === WebSocket.OPEN) {
        closeWsSafely(ctx.userWs, CLOSE_BRIDGE.SERVER_RESTART, "control_persist_unavailable");
      }
    }
  })();
  return true;
}

export function handleSessionRepoControlFrame(
  ctx: BridgeConnectionCtx,
  parsed: Record<string, unknown>,
): boolean {
  const ftype = parsed.type;
  if (ftype === "inbound.control.session_repo_bind") {
    const bindReq = parseBindRequest(parsed);
    if (bindReq === null) {
      if (ctx.userWs.readyState === WebSocket.OPEN) {
        sendJsonSafely(ctx.userWs, {
          type: "outbound.control.session_repo_bind_error",
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
          selectionVersion: 0,
          errorCode: "INVALID_BIND_PAYLOAD",
          errorMessage: "bind frame schema invalid",
        });
      }
      return true;
    }
    const pgPool = ctx.shared.deps.pgPool;
    if (!pgPool) return true;
    void (async () => {
      try {
        const result = await enrichBindRequest(pgPool, Number(ctx.uid), bindReq);
        if (result.type === "outbound.control.session_repo_bind_error") {
          if (ctx.userWs.readyState === WebSocket.OPEN) sendJsonSafely(ctx.userWs, result);
          return;
        }
        const buf = Buffer.from(JSON.stringify(result), "utf8");
        ctx.forwardInboundFrame(buf, false, buf.length);
        ctx.bridgeLog?.info("user-chat-bridge: repo_bind_forwarded", {
          sessionId: result.sessionId,
          selectionVersion: result.selectionVersion,
          agentId: result.agentId,
        });
      } catch (err) {
        ctx.bridgeLog?.warn("user-chat-bridge: enrich bind failed", { err });
        if (ctx.userWs.readyState === WebSocket.OPEN) {
          sendJsonSafely(ctx.userWs, {
            type: "outbound.control.session_repo_bind_error",
            sessionId: bindReq.sessionId,
            selectionVersion: bindReq.selectionVersion,
            errorCode: "BRIDGE_ENRICH_FAILED",
            errorMessage: "internal error during bind enrichment",
          });
        }
      }
    })();
    return true;
  }
  if (ftype === "inbound.control.session_repo_unbind") {
    return parseUnbindRequest(parsed) === null;
  }
  return false;
}

function startHelloLiveCatchup(
  ctx: BridgeConnectionCtx,
  liveCatchupSessions: Array<{ sessionId: string; afterFrameSeq: number }>,
  uidStr: string,
): void {
  const { deps, config } = ctx.shared;
  if (liveCatchupSessions.length > 0 && deps.pgPool) {
    const pgPool = deps.pgPool;
    const maxBufferedBytes = config.maxBufferedBytes;
    const userWs = ctx.userWs;
    void (async () => {
      try {
        await Promise.resolve();
        for (const { sessionId, afterFrameSeq } of liveCatchupSessions) {
          if (userWs.readyState !== WebSocket.OPEN) break;
          const backpressured = await replaySessionLiveCatchup(
            pgPool,
            userWs,
            ctx.uid,
            sessionId,
            afterFrameSeq,
            maxBufferedBytes,
          );
          if (backpressured) break;
        }
      } catch (error) {
        ctx.bridgeLog?.debug("user-chat-bridge: hello live catchup skipped", {
          uid: uidStr,
          error,
        });
      }
    })().catch((err) => {
      void err;
    });
  }
}

async function replaySessionLiveCatchup(
  pgPool: NonNullable<BridgeConnectionCtx["shared"]["deps"]["pgPool"]>,
  userWs: WebSocket,
  uid: bigint,
  sessionId: string,
  afterFrameSeq: number,
  maxBufferedBytes: number,
): Promise<boolean> {
  const catchupItems = await readOpenDispatchLiveFramePayloadsAfterSeq(pgPool, {
    uid,
    sessionId,
    afterFrameSeq,
    limit: HELLO_LIVE_CATCHUP_MAX_FRAMES,
    maxBytes: Math.min(maxBufferedBytes, HELLO_LIVE_CATCHUP_MAX_BYTES),
  });
  let catchupBackpressured = false;
  for (const item of catchupItems) {
    if (item.kind === "oversize") {
      catchupBackpressured = true;
      break;
    }
    const payload = item.payload;
    if (parseLeftoverHotWsPayload(payload)) continue;
    const decision = liveCatchupSendDecision(
      userWs.readyState,
      userWs.bufferedAmount,
      Buffer.byteLength(payload, "utf8"),
      maxBufferedBytes,
    );
    if (decision === "stop") break;
    if (decision === "backpressure") {
      catchupBackpressured = true;
      break;
    }
    try {
      userWs.send(payload);
    } catch (err) {
      void err;
      break;
    }
  }
  if (catchupBackpressured && userWs.readyState === WebSocket.OPEN) {
    closeWsSafely(userWs, CLOSE_BRIDGE.TOO_BIG, "backpressure");
  }
  return catchupBackpressured;
}

function startHelloPendingPermissionReplay(
  ctx: BridgeConnectionCtx,
  helloPermissionPeers: Array<{ peerId: string; agentId?: string; inFlight?: boolean }>,
  uidStr: string,
): void {
  const pgPool = ctx.shared.deps.pgPool;
  const scan = selectHelloPermissionSessions(helloPermissionPeers, {
    maxSessions: HELLO_PENDING_PERMISSION_MAX_SESSIONS,
  });
  if (scan.sessions.length === 0 || !pgPool) return;
  const userWs = ctx.userWs;
  void (async () => {
    try {
      await Promise.resolve();
      const pendingScan = await readPendingPermissionPromptsForSessions(pgPool, {
        userId: ctx.uid,
        sessionIds: scan.sessions.map((entry) => entry.peerId),
      });
      let hits = 0;
      for (const { peerId, sessionKey } of scan.sessions) {
        if (userWs.readyState !== WebSocket.OPEN) break;
        const rows = pendingScan.bySession.get(peerId);
        if (!rows || rows.length === 0) continue;
        let sent = 0;
        for (const row of rows) {
          if (userWs.readyState !== WebSocket.OPEN) break;
          const frame = pendingPermissionPromptToFrame(row, { sessionKey, peerId });
          if (frame === null) continue;
          if (!sendJsonSafely(userWs, frame)) break;
          sent += 1;
        }
        if (sent > 0) {
          hits += sent;
          ctx.bridgeLog?.info("user-chat-bridge: hello replayed pending permission prompts", {
            uid: uidStr,
            sessionId: peerId,
            count: sent,
          });
        }
      }
      const rowLimited = pendingScan.rowLimited === true;
      if (userWs.readyState === WebSocket.OPEN && (hits > 0 || scan.truncated || rowLimited)) {
        sendJsonSafely(userWs, {
          type: "outbound.permission_hello_scan",
          channel: "webchat",
          scanned: scan.scanned,
          omitted: scan.omitted,
          truncated: scan.truncated || rowLimited,
          sessionTruncated: scan.truncated,
          rowLimited,
          uncoveredSessionIds: pendingScan.uncoveredSessionIds,
          hits,
          ts: Date.now(),
        });
      }
    } catch (error) {
      ctx.bridgeLog?.debug("user-chat-bridge: hello pending permission replay skipped", {
        uid: uidStr,
        error,
      });
    }
  })().catch((err) => {
    void err;
  });
}

function processSingleHelloPeer(args: {
  ctx: BridgeConnectionCtx;
  rawPeer: unknown;
  uidStr: string;
  cidStr: string;
  helloPeerIds: Set<string>;
  liveCatchupSessions: Array<{ sessionId: string; afterFrameSeq: number }>;
  liveCatchupSeen: Set<string>;
  helloPermissionPeers: Array<{ peerId: string; agentId?: string; inFlight?: boolean }>;
  helloPermissionPeerSeen: Set<string>;
}): void {
  const { ctx, rawPeer, uidStr, cidStr } = args;
  if (typeof rawPeer !== "object" || rawPeer === null) return;
  const peer = rawPeer as { peerId?: unknown; agentId?: unknown; lastFrameSeq?: unknown; inFlight?: unknown };
  if (typeof peer.peerId !== "string") return;
  args.helloPeerIds.add(peer.peerId);
  ctx.shared.registerUserWsSession(ctx.userWs, uidStr, peer.peerId);
  if (
    !args.liveCatchupSeen.has(peer.peerId) &&
    args.liveCatchupSessions.length < HELLO_LIVE_CATCHUP_MAX_SESSIONS
  ) {
    args.liveCatchupSeen.add(peer.peerId);
    const afterFrameSeq =
      typeof peer.lastFrameSeq === "number" && Number.isSafeInteger(peer.lastFrameSeq)
        ? Math.max(0, peer.lastFrameSeq)
        : 0;
    args.liveCatchupSessions.push({ sessionId: peer.peerId, afterFrameSeq });
  }
  const aid = typeof peer.agentId === "string" && peer.agentId !== "" ? peer.agentId : "main";
  const safeId = peer.peerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const storeKey = `${uidStr}:${cidStr}:agent:${aid}:webchat:dm:${safeId}`;
  if (!args.helloPermissionPeerSeen.has(peer.peerId)) {
    args.helloPermissionPeerSeen.add(peer.peerId);
    args.helloPermissionPeers.push({ peerId: peer.peerId, agentId: aid, inFlight: peer.inFlight === true });
  }
  retainOutboundPersistQueueKey(ctx, storeKey);
  const cursor = typeof peer.lastFrameSeq === "number" ? peer.lastFrameSeq : 0;
  const replay = ctx.shared.outboundRing.peekReplay(storeKey, cursor);
  if (!replay.ok) return;
  for (const f of replay.sent) {
    if (parseLeftoverHotWsPayload(f.data)) continue;
    try {
      ctx.userWs.send(f.data);
    } catch (err) {
      void err;
      break;
    }
  }
}

export function handleInboundHelloFrame(
  ctx: BridgeConnectionCtx,
  parsed: Record<string, unknown>,
  passthrough: { data: RawData; len: number },
): void {
  if (ctx.containerId === undefined) return;
  const peers = Array.isArray(parsed.peers) ? parsed.peers : [];
  if (typeof parsed.clientBuild === "string" && /^[0-9a-f]{8,32}$/.test(parsed.clientBuild)) {
    ctx.clientBuildForConnection = parsed.clientBuild;
  }
  const visiblePeers = peers.filter(
    (p) => typeof p !== "object" || p === null || (p as { agentId?: unknown }).agentId !== HIDDEN_REVIEWER_AGENT_ID,
  );
  if (visiblePeers.length !== peers.length) {
    const sanitizedStr = JSON.stringify({ ...parsed, peers: visiblePeers });
    passthrough.data = Buffer.from(sanitizedStr, "utf8");
    passthrough.len = Buffer.byteLength(sanitizedStr);
  }
  const cidStr = ctx.containerId.toString();
  const uidStr = ctx.uid.toString();
  const liveCatchupSessions: Array<{ sessionId: string; afterFrameSeq: number }> = [];
  const liveCatchupSeen = new Set<string>();
  const helloPermissionPeers: Array<{ peerId: string; agentId?: string; inFlight?: boolean }> = [];
  const helloPermissionPeerSeen = new Set<string>();
  const helloPeerIds = new Set<string>();
  for (const rawPeer of visiblePeers) {
    processSingleHelloPeer({
      ctx,
      rawPeer,
      uidStr,
      cidStr,
      helloPeerIds,
      liveCatchupSessions,
      liveCatchupSeen,
      helloPermissionPeers,
      helloPermissionPeerSeen,
    });
  }
  if (ctx.lastHelloPeerIds === null) ctx.lastHelloPeerIds = helloPeerIds;
  else for (const id of helloPeerIds) ctx.lastHelloPeerIds.add(id);
  tryAutoRebindFlush(ctx);
  if (ctx.shared.deps.pgPool) {
    void sendHelloSessionSnapshots(
      ctx.shared.deps.pgPool,
      ctx.userWs,
      uidStr,
      visiblePeers,
      ctx.bridgeLog,
      ctx.connId,
      ctx.containerId,
    );
  }
  startHelloLiveCatchup(ctx, liveCatchupSessions, uidStr);
  startHelloPendingPermissionReplay(ctx, helloPermissionPeers, uidStr);
  // Fall through to forwardInboundFrame below.
}
