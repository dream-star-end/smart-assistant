import { emitStudioPush } from "../../studio/push";
import type { RefreshOutcome } from "../../types";
import type { OutboundMessageWire, OutboundWire } from "../frames";
import {
  backoffDelay,
  classifyClose,
  KEEPALIVE_INTERVAL_MS,
  nextReconnectDelay,
  OFFLINE_LATCH_GRACE_MS,
  onopenSetInitialStatus,
  PROBE_TIMEOUT_KEEPALIVE_MS,
  PROBE_TIMEOUT_VISIBILITY_MS,
  SAFE_WS_BUFFER_BYTES,
  VISIBILITY_PROBE_GRACE_AFTER_OPEN_MS,
  VISIBILITY_RECONNECT_COOLDOWN_MS,
  WS_CLOSE_CODE_STALLED,
} from "../pure";
import { bufferStampedFrameDuringDurableHydration } from "./outboundFramePump";
import {
  attachFirstTextPaintProbe,
  createTextReplayProbe,
  prepareFirstTextPaint,
} from "./pureHelpers";
import { WS_PATH, type SocketCtx } from "./types";

export function safeWsSendOnSocket(ctx: SocketCtx, data: string): boolean {
  const ws = ctx.ws;
  if (!ws || ws.readyState !== 1) return false;
  const buffered = typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : 0;
  if (buffered >= SAFE_WS_BUFFER_BYTES) {
    try {
      ws.close(WS_CLOSE_CODE_STALLED, "bufferedAmount exceeded");
    } catch (err) {
      void err;
    }
    return false;
  }
  try {
    ws.send(data);
    return true;
  } catch (err) {
    void err;
    try {
      ws.close(WS_CLOSE_CODE_STALLED, "send failed");
    } catch (closeErr) {
      void closeErr;
    }
    return false;
  }
}

export function probeWsAliveOnSocket(
  ctx: SocketCtx,
  ws: WebSocket,
  timeoutMs: number,
  label: string,
): void {
  if (!ws || ws.readyState !== 1 || ctx.ws !== ws || ctx.pendingPing) return;
  ctx.pingNonce += 1;
  const id = ctx.pingNonce;
  if (!ctx.safeWsSend(JSON.stringify({ type: "ping", id }))) return;
  const timeoutId = setTimeout(() => {
    if (!ctx.pendingPing || ctx.pendingPing.id !== id) return;
    ctx.pendingPing = null;
    if (ctx.ws !== ws || ws.readyState !== 1) return;
    const code = label === "keepalive" ? 4001 : 4000;
    try {
      ws.close(code, `${label} ping timeout`);
    } catch (err) {
      void err;
    }
  }, timeoutMs);
  ctx.pendingPing = { id, ws, timeoutId, label };
}

export function clearReconnectTimersInSocket(ctx: SocketCtx): void {
  if (ctx.reconnectTimer) {
    clearTimeout(ctx.reconnectTimer);
    ctx.reconnectTimer = null;
  }
  if (ctx.reconnectCountdown) {
    clearInterval(ctx.reconnectCountdown);
    ctx.reconnectCountdown = null;
  }
  if (ctx.backoffResetTimer) {
    clearTimeout(ctx.backoffResetTimer);
    ctx.backoffResetTimer = null;
  }
}

export function cancelWsAuthRecoveryInSocket(ctx: SocketCtx): void {
  if (ctx.wsAuthRetryTimer) clearTimeout(ctx.wsAuthRetryTimer);
  ctx.wsAuthRetryTimer = null;
  ctx.wsAuthRefreshInFlight = false;
}

function tearDownAuthInSocket(ctx: SocketCtx, expectedEpoch: number): void {
  ctx.authEpoch += 1;
  cancelWsAuthRecoveryInSocket(ctx);
  ctx.setProvisioningBanner(false);
  ctx.deps.onAuthExpired(expectedEpoch);
  ctx.setStatus("未连接", "disconnected");
}

export function startWsAuthRecoveryInSocket(ctx: SocketCtx): void {
  if (ctx.wsAuthRefreshInFlight) return;
  ctx.wsAuthRefreshInFlight = true;
  const socketEpoch = ctx.authEpoch;
  const sessionEpoch = ctx.deps.getAuthEpoch();
  ctx.setStatus("会话续期中…", "connecting");

  const attempt = async (): Promise<void> => {
    let outcome: RefreshOutcome;
    try {
      outcome = await ctx.deps.silentRefresh(sessionEpoch);
    } catch {
      outcome = { kind: "transient", epoch: sessionEpoch, retryAfterMs: 1_000 };
    }
    if (ctx.authEpoch !== socketEpoch || ctx.deps.getAuthEpoch() !== sessionEpoch) return;
    if (outcome.kind === "success") {
      ctx.wsAuthRefreshInFlight = false;
      if (ctx.deps.getToken()) ctx.connect();
      return;
    }
    if (outcome.kind === "invalid") {
      ctx.wsAuthRefreshInFlight = false;
      tearDownAuthInSocket(ctx, outcome.epoch);
      return;
    }
    if (outcome.kind === "stale") {
      ctx.wsAuthRefreshInFlight = false;
      return;
    }
    ctx.setStatus("会话续期中…", "connecting");
    ctx.wsAuthRetryTimer = setTimeout(() => {
      ctx.wsAuthRetryTimer = null;
      void attempt();
    }, Math.max(250, outcome.retryAfterMs));
  };
  void attempt();
}

function schedulePolicyReconnectInSocket(ctx: SocketCtx, status: string): void {
  if (!ctx.deps.getToken()) return;
  clearReconnectTimersInSocket(ctx);
  const delay = backoffDelay(ctx.reconnectAttempts);
  ctx.reconnectAttempts += 1;
  ctx.policyReconnectUntilMs = Date.now() + delay;
  let remaining = Math.ceil(delay / 1000);
  ctx.setStatus(`${status} · ${remaining} 秒后重试…`, "disconnected");
  ctx.reconnectCountdown = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      ctx.setStatus(`${status} · ${remaining} 秒后重试…`, "disconnected");
    } else if (ctx.reconnectCountdown) {
      clearInterval(ctx.reconnectCountdown);
      ctx.reconnectCountdown = null;
    }
  }, 1000);
  ctx.reconnectTimer = setTimeout(() => {
    ctx.policyReconnectUntilMs = 0;
    ctx.connect();
  }, delay);
}

function armReconnectInFlightSafetyNet(ctx: SocketCtx): void {
  if (ctx.reconnectInFlightTimer) clearTimeout(ctx.reconnectInFlightTimer);
  ctx.reconnectInFlightSet = new Set();
  for (const [id, s] of ctx.sessions) {
    if (s._sendingInFlight) ctx.reconnectInFlightSet.add(id);
  }
  if (ctx.reconnectInFlightSet.size === 0) {
    ctx.reconnectInFlightSet = null;
    return;
  }
  ctx.reconnectInFlightTimer = setTimeout(() => {
    ctx.reconnectInFlightTimer = null;
    const snapped = ctx.reconnectInFlightSet;
    ctx.reconnectInFlightSet = null;
    if (!snapped) return;
    const stillWaiting = [...snapped].some((sessId) => ctx.sessions.get(sessId)?._sendingInFlight);
    if (!stillWaiting) {
      ctx.dismissStaleRestoreBanner();
      if (ctx.statusCls !== "connected" && ctx.ws?.readyState === 1) {
        const [label, cls] = onopenSetInitialStatus(ctx.offlineQueue.length);
        ctx.setStatus(label, cls);
      }
      return;
    }
    if (ctx.statusCls !== "connected") {
      ctx.restoreBannerOwners = new Set(
        [...snapped].filter((sessId) => ctx.sessions.get(sessId)?._sendingInFlight),
      );
      ctx.setStatus("正在恢复上一轮…", "connecting");
    }
  }, 30_000);
}

function refreshOpenGoalsAndStudio(ctx: SocketCtx): void {
  const goalRefreshSessions = new Set<string>();
  if (ctx.activeSessionId) goalRefreshSessions.add(ctx.activeSessionId);
  for (const sessId of ctx.reconnectInFlightSet ?? []) goalRefreshSessions.add(sessId);
  for (const sessId of goalRefreshSessions) {
    try {
      void Promise.resolve(ctx.deps.syncGoalState?.(sessId)).catch((err) => {
        void err;
      });
    } catch (err) {
      void err;
    }
  }
  try {
    emitStudioPush(null);
  } catch (err) {
    void err;
  }
}

function handleSocketOpen(ctx: SocketCtx): void {
  const reconnected = ctx.everOpened;
  ctx.isBrowserOnline = true;
  ctx.pendingBrowserOfflineAt = 0;
  ctx.everOpened = true;
  ctx.lastOpenAtMs = Date.now();
  if (ctx.reconnectCountdown) {
    clearInterval(ctx.reconnectCountdown);
    ctx.reconnectCountdown = null;
  }
  ctx.setProvisioningBanner(false);
  const [lbl, cls] = onopenSetInitialStatus(ctx.offlineQueue.length);
  ctx.setStatus(lbl, cls);

  armReconnectInFlightSafetyNet(ctx);
  try {
    ctx.sendHelloFrame();
  } catch (err) {
    void err;
  }
  ctx.armSnapshotWatchdog();
  ctx.contextCompact.flushAbandonedModelSwitches();
  ctx.flushAllRepoBinds();
  refreshOpenGoalsAndStudio(ctx);

  if (reconnected && ctx.activeSessionId) ctx.reconcileSession(ctx.activeSessionId);
  ctx.scheduleNotify();
}

function handleSocketMessage(ctx: SocketCtx, ws: WebSocket, ev: MessageEvent): void {
  if (ctx.ws !== ws) return;
  let f: OutboundWire;
  try {
    f = JSON.parse(String(ev.data)) as OutboundWire;
  } catch {
    return;
  }
  if (f.type === "pong") {
    if (
      ctx.pendingPing &&
      ctx.pendingPing.ws === ws &&
      ctx.pendingPing.id === (f as { id?: number }).id
    ) {
      clearTimeout(ctx.pendingPing.timeoutId);
      ctx.pendingPing = null;
    }
    return;
  }
  const stamped = f as { peer?: { id?: unknown }; frameSeq?: unknown };
  if (typeof stamped.peer?.id === "string" && typeof stamped.frameSeq === "number") {
    ctx.snapshotAckAt.set(stamped.peer.id, Date.now());
  }
  if (bufferStampedFrameDuringDurableHydration(ctx, f)) return;

  const firstTextPaint =
    f.type === "outbound.message"
      ? prepareFirstTextPaint(ctx.sessions, ctx.firstTextPaintTraceIds, f as OutboundMessageWire)
      : null;
  const replayProbe =
    f.type === "outbound.message"
      ? createTextReplayProbe(ctx.sessions, () => ctx.offlineQueue.length, f as OutboundMessageWire)
      : null;
  let dispatched = false;
  try {
    ctx.dispatch(f);
    dispatched = true;
  } catch (err) {
    void err;
  }
  if (dispatched && firstTextPaint) {
    attachFirstTextPaintProbe(ctx.sessions, ctx.firstTextPaintTraceIds, firstTextPaint);
  }
  if (dispatched && replayProbe && replayProbe.unchanged()) return;
  ctx.scheduleNotify();
}

function scheduleStandardReconnectOnClose(
  ctx: SocketCtx,
  decision: ReturnType<typeof classifyClose>,
): void {
  clearReconnectTimersInSocket(ctx);
  if (!ctx.deps.getToken()) return;
  if (ctx.pendingBrowserOfflineAt > 0) {
    const elapsed = Date.now() - ctx.pendingBrowserOfflineAt;
    const browserStillOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    ctx.pendingBrowserOfflineAt = 0;
    if (browserStillOffline || elapsed <= OFFLINE_LATCH_GRACE_MS) ctx.isBrowserOnline = false;
  }
  if (!ctx.isBrowserOnline) {
    ctx.setStatus("离线", "disconnected");
    return;
  }
  ctx.setProvisioningBanner(decision.provisioning);
  const { delay, nextAttempts } = nextReconnectDelay(decision, ctx.reconnectAttempts);
  ctx.reconnectAttempts = nextAttempts;
  const label = decision.closeReasonLabel;
  const bannerCls = ctx.everOpened ? "disconnected" : "connecting";
  if (delay >= 4000) {
    let remaining = Math.ceil(delay / 1000);
    const render = () => {
      const prefix = label
        ? `${label} · ${remaining} 秒后重试…`
        : ctx.everOpened
          ? `${remaining} 秒后重连…`
          : `连接中… · ${remaining} 秒后重试`;
      ctx.setStatus(prefix, bannerCls);
    };
    render();
    ctx.reconnectCountdown = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) render();
      else if (ctx.reconnectCountdown) {
        clearInterval(ctx.reconnectCountdown);
        ctx.reconnectCountdown = null;
      }
    }, 1000);
  } else if (label) {
    ctx.setStatus(label, "connecting");
  } else if (!ctx.everOpened) {
    ctx.setStatus("连接中…", "connecting");
  }
  ctx.reconnectTimer = setTimeout(() => ctx.connect(), delay);
  ctx.scheduleNotify();
}

function handleSocketClose(ctx: SocketCtx, ws: WebSocket, e: CloseEvent): void {
  if (ctx.keepAliveTimer) {
    clearInterval(ctx.keepAliveTimer);
    ctx.keepAliveTimer = null;
  }
  if (ctx.pendingPing && ctx.pendingPing.ws === ws) {
    clearTimeout(ctx.pendingPing.timeoutId);
    ctx.pendingPing = null;
  }
  if (ctx.ws !== ws) return;

  ctx.relayReady = false;
  if (ctx.backoffResetTimer) {
    clearTimeout(ctx.backoffResetTimer);
    ctx.backoffResetTimer = null;
  }
  ctx.masterOwnsAutomaticRecovery = false;
  ctx.helloSentAt.clear();
  ctx.resetControlsForReplay();
  if (ctx.reconnectInFlightTimer) {
    clearTimeout(ctx.reconnectInFlightTimer);
    ctx.reconnectInFlightTimer = null;
    ctx.reconnectInFlightSet = null;
  }
  if (ctx.everOpened) ctx.setStatus("已断线", "disconnected");
  else ctx.setStatus("连接中…", "connecting");
  ctx.resetUnadmittedDispatchesForReplay();

  const decision = classifyClose(e.code, e.reason);
  for (const sessId of new Set(ctx.offlineQueue.map((item) => item.sessId))) {
    ctx.deps.persistSession?.(sessId);
  }

  if (decision.action === "policy" && decision.policy) {
    ctx.setProvisioningBanner(false);
    const policyText = decision.policy.toast.replace(/[。.]$/, "");
    ctx.setStatus(policyText, "disconnected");
    if (decision.policy.billing) ctx.deps.refreshBalance?.();
    schedulePolicyReconnectInSocket(ctx, policyText);
    ctx.scheduleNotify();
    return;
  }
  if (decision.action === "auth_1008") {
    if (ctx.deps.getToken()) startWsAuthRecoveryInSocket(ctx);
    else tearDownAuthInSocket(ctx, ctx.deps.getAuthEpoch());
    return;
  }
  scheduleStandardReconnectOnClose(ctx, decision);
}

export function openSocketConnection(ctx: SocketCtx): void {
  if (!ctx.deps.getToken() || !ctx.gateReady || !ctx.laneReady || ctx.wsAuthRefreshInFlight) {
    return;
  }
  if (ctx.ws && ctx.ws.readyState < 2) return;
  if (!ctx.isBrowserOnline) {
    ctx.setStatus("离线", "disconnected");
    return;
  }
  if (typeof WebSocket === "undefined") {
    ctx.setStatus("未连接", "disconnected");
    return;
  }
  ctx.setStatus("连接中…", "connecting");
  ctx.relayReady = false;
  ctx.masterOwnsAutomaticRecovery = false;
  ctx.subscribedSessions.clear();
  ctx.helloSentAt.clear();
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const url = `${proto}${location.host}${WS_PATH}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, ["bearer", ctx.deps.getToken()]);
  } catch {
    ctx.setStatus("连接失败", "disconnected");
    return;
  }
  ctx.ws = ws;
  ws.onopen = () => handleSocketOpen(ctx);
  if (ctx.keepAliveTimer) clearInterval(ctx.keepAliveTimer);
  ctx.keepAliveTimer = setInterval(() => {
    probeWsAliveOnSocket(ctx, ws, PROBE_TIMEOUT_KEEPALIVE_MS, "keepalive");
  }, KEEPALIVE_INTERVAL_MS);
  ws.onmessage = (ev) => handleSocketMessage(ctx, ws, ev);
  ws.onerror = () => {
    /* close event provides code & reason */
  };
  ws.onclose = (e) => handleSocketClose(ctx, ws, e);
}

export function teardownSocketOnStop(ctx: SocketCtx): void {
  ctx.authEpoch += 1;
  ctx.lifecycleEpoch += 1;
  cancelWsAuthRecoveryInSocket(ctx);
  ctx.resetUnadmittedDispatchesForReplay();
  ctx.contextCompact.rejectPendingModelSwitches("连接已断开，未切换模型", true);
  clearReconnectTimersInSocket(ctx);
  ctx.policyReconnectUntilMs = 0;
  if (ctx.pendingPing) {
    clearTimeout(ctx.pendingPing.timeoutId);
    ctx.pendingPing = null;
  }
  if (ctx.keepAliveTimer) {
    clearInterval(ctx.keepAliveTimer);
    ctx.keepAliveTimer = null;
  }
  if (ctx.reconnectInFlightTimer) {
    clearTimeout(ctx.reconnectInFlightTimer);
    ctx.reconnectInFlightTimer = null;
  }
  if (ctx.snapshotWatchTimer) {
    clearTimeout(ctx.snapshotWatchTimer);
    ctx.snapshotWatchTimer = null;
  }
  ctx.clearNotifyTimers();
  ctx.resetNotifyFlags();
  for (const t of ctx.tapeCommitFinalTimers.values()) clearTimeout(t);
  ctx.tapeCommitFinalTimers.clear();
  ctx.durableLiveJournalCheckpoints.clear();
  ctx.durableHydrationStates.clear();
  ctx.durableHydrationTails.clear();
  ctx.snapshotHttpInFlight.clear();
  ctx.swarmResyncInFlight.clear();
  ctx.restoreBannerOwners = null;
  ctx.automaticRecoveryPending.clear();
  for (const pending of ctx.pendingRecoveryErrors.values()) clearTimeout(pending.timer);
  ctx.pendingRecoveryErrors.clear();
  for (const state of ctx.unpublishedTapeRetries.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  ctx.unpublishedTapeRetries.clear();
  ctx.degradedJournalRetries.clearAll();
  for (const t of ctx.controlPersistRetryTimers.values()) clearTimeout(t);
  ctx.controlPersistRetryTimers.clear();
  ctx.metaTracker.clearAllStopTimers();
  ctx.everOpened = false;
  ctx.lastOpenAtMs = 0;
  const ws = ctx.ws;
  ctx.ws = null;
  try {
    ws?.close(1000, "client stop");
  } catch (err) {
    void err;
  }
}

export function setGateReadyOnSocket(ctx: SocketCtx, ready: boolean): void {
  const was = ctx.gateReady;
  ctx.gateReady = ready;
  if (ready && !was) ctx.connect();
  if (!ready && was) {
    ctx.resetUnadmittedDispatchesForReplay();
    clearReconnectTimersInSocket(ctx);
    if (ctx.keepAliveTimer) {
      clearInterval(ctx.keepAliveTimer);
      ctx.keepAliveTimer = null;
    }
    if (ctx.pendingPing) {
      clearTimeout(ctx.pendingPing.timeoutId);
      ctx.pendingPing = null;
    }
    const ws = ctx.ws;
    ctx.ws = null;
    try {
      ws?.close(1000, "gate closed");
    } catch (err) {
      void err;
    }
    ctx.setStatus("未连接", "disconnected");
  }
}

export function retryConnectNowFlow(ctx: SocketCtx, label = "重新连接中…"): boolean {
  if (!ctx.deps.getToken() || ctx.wsAuthRefreshInFlight) return false;
  if (ctx.ws && ctx.ws.readyState < 2) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ctx.isBrowserOnline = false;
    ctx.setStatus("离线", "disconnected");
    return false;
  }
  ctx.isBrowserOnline = true;
  ctx.pendingBrowserOfflineAt = 0;
  ctx.reconnectAttempts = 0;
  ctx.policyReconnectUntilMs = 0;
  clearReconnectTimersInSocket(ctx);
  ctx.setStatus(label, "connecting");
  ctx.connect();
  return true;
}

export function notifyNetworkOfflineFlow(ctx: SocketCtx): void {
  if (!ctx.isBrowserOnline) return;
  if (ctx.ws && ctx.ws.readyState === 1) {
    ctx.pendingBrowserOfflineAt = Date.now();
    return;
  }
  ctx.isBrowserOnline = false;
  clearReconnectTimersInSocket(ctx);
  ctx.setProvisioningBanner(false);
  ctx.setStatus("离线", "disconnected");
}

export function notifyNetworkOnlineFlow(ctx: SocketCtx): void {
  ctx.pendingBrowserOfflineAt = 0;
  ctx.isBrowserOnline = true;
  if (!ctx.deps.getToken() || ctx.wsAuthRefreshInFlight) return;
  ctx.reconnectAttempts = 0;
  ctx.policyReconnectUntilMs = 0;
  clearReconnectTimersInSocket(ctx);
  ctx.armSnapshotWatchdog();
  if (ctx.ws && ctx.ws.readyState < 2) return;
  ctx.connect();
}

export function notifyTabVisibleFlow(ctx: SocketCtx): void {
  if (!ctx.deps.getToken() || !ctx.isBrowserOnline || ctx.wsAuthRefreshInFlight) return;
  ctx.armSnapshotWatchdog();
  if (!ctx.ws || ctx.ws.readyState >= 2) {
    const now = Date.now();
    if (ctx.policyReconnectUntilMs > now) return;
    if (now - ctx.lastVisibilityReconnectAt < VISIBILITY_RECONNECT_COOLDOWN_MS) return;
    ctx.lastVisibilityReconnectAt = now;
    clearReconnectTimersInSocket(ctx);
    ctx.connect();
    return;
  }
  const openedAgo =
    ctx.lastOpenAtMs > 0 ? Date.now() - ctx.lastOpenAtMs : Number.POSITIVE_INFINITY;
  if (
    openedAgo >= VISIBILITY_PROBE_GRACE_AFTER_OPEN_MS &&
    !ctx.contextCompact.hasPendingModelSwitches()
  ) {
    probeWsAliveOnSocket(ctx, ctx.ws, PROBE_TIMEOUT_VISIBILITY_MS, "visibility");
  }
}
