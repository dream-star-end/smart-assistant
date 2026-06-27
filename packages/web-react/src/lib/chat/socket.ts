/**
 * v5 WS 对话引擎 —— ChatSocket。**渲染树之外的单例 service**（ref-based manager）：
 * 持有 ws + 全部连接/重连/游标/离线队列/计费归因可变状态；帧到达频率极高
 * （streaming delta 每帧一次），全部是对 `session.messages` 的就地 mutation + 去重
 * 游标推进，**绝不每帧 setState**。React 侧通过 subscribe + 批量 notify（version
 * 单调递增）订阅派生快照。
 *
 * 从现网 vanilla websocket.js / main.js 的连接、重连退避、close code 语义、
 * ping-pong watchdog、hello + 三层断点续传、safeWsSend 2MB 背压、离线队列三段式
 * drain 逐条复刻；帧翻译委托 reducer.ts（§7-§11）。
 */
import {
  applyCostCharged,
  applyLegacyBridgeError,
  applyOutboundError,
  applyOutboundMessage,
  applyPermissionRequest,
  applyPermissionSettled,
  applyResumeFailed,
  applyTurnStatus,
  AUTO_CONTINUE_PROMPT,
  type FrameEffects,
} from "./reducer";
import {
  addMessage,
  type ChatMessage,
  type ChatSession,
  clearTurnTiming,
  createSession,
  rebuildIndexes,
  resetReplyTracker,
} from "./model";
import {
  applyServerIncremental,
  mergeFullServerWins,
  type StoredSession,
} from "../persist";
import {
  AUTO_CONTINUE_DISPLAY,
  backoffDelay,
  type ChatStatusClass,
  classifyClose,
  type EmptyTurnDecision,
  emptyTurnNoticeText,
  KEEPALIVE_INTERVAL_MS,
  MAX_OFFLINE_QUEUE,
  OFFLINE_DRAIN_START_DELAY_MS,
  OFFLINE_LATCH_GRACE_MS,
  onopenSetInitialStatus,
  PROBE_TIMEOUT_KEEPALIVE_MS,
  PROBE_TIMEOUT_VISIBILITY_MS,
  RECONNECT_RECONCILE_GRACE_MS,
  SAFE_WS_BUFFER_BYTES,
  safeSessionKeyForAgent,
  shouldAutoContinueEmptyTurn,
  THINKING_SAFETY_MS,
  VISIBILITY_RECONNECT_COOLDOWN_MS,
  WS_AUTH_REFRESH_MIN_GAP_MS,
  WS_CLOSE_CODE_STALLED,
} from "./pure";
import type {
  CostChargedWire,
  InboundMessage,
  LegacyBridgeErrorWire,
  OutboundErrorWire,
  OutboundMessageWire,
  OutboundPermissionRequestWire,
  OutboundPermissionSettledWire,
  OutboundResumeFailedWire,
  OutboundTurnStatusWire,
  OutboundWire,
} from "./frames";

export type { ChatStatusClass };

export type ChatSocketDeps = {
  /** 当前内存态 access JWT（WS 子协议鉴权用）。*/
  getToken: () => string;
  /** 1008 续期：成功回新 token，失败 null（内部已 setToken 回写 AuthSession）。*/
  silentRefresh: () => Promise<string | null>;
  /** 续期失败 / token teardown → 回登录。*/
  onAuthExpired: () => void;
  /** 商业版余额刷新（cost_charged / 4506 / insufficient_credits）。*/
  refreshBalance?: () => void;
  /** 真 turn 失败自动上报（跳过预期业务态）。*/
  reportClientError?: (p: { type: string; message: string; traceId?: string; sessionId?: string }) => void;
  /** resume_failed / 重连 reconcile：强制 REST 全量 sync（最终权威源）。*/
  syncSession?: (sessId: string) => Promise<void> | void;
  /**
   * 首次发消息前在主控创建 client_sessions 行（PUT /api/sessions/:id，messages:[]）。
   * v3 commercial 持久化契约：**前端 PUT 建行 + 元数据，容器 server-authored 往该行 append
   * 消息**。web-react 此前从不调 putSession → 主控无此行 → 容器回传持久化 session_not_found
   * 无界重试风暴 + cost_charged 归因/投递链路连带失效。fire-and-forget：建行是快 REST，
   * 远早于容器跑完 LLM turn 后的 authored POST；upsertClientSession 用 baseSyncedAt=0 +
   * mergePreservingServerAuthored，已存在则 rejected_stale 空操作，绝不 clobber 历史。
   */
  ensureServerSession?: (sessId: string, agentId: string, title?: string) => void;
  /** 立即把某会话快照落 IndexedDB（resume_failed 游标推进 / isFinal turn 收尾时调）。*/
  persistSession?: (sessId: string) => void;
  defaultAgentId?: string;
};

type OfflineItem = {
  sessId: string;
  payload: InboundMessage;
  msgId: string;
  _retryCount?: number;
};

export type ChatSnapshot = {
  version: number;
  status: { label: string; cls: ChatStatusClass };
  /** 容器初始化期 banner（4503 provisioning）。*/
  provisioning: boolean;
  sessions: Map<string, ChatSession>;
};

const WS_PATH = "/ws/user-chat-bridge";

export class ChatSocket {
  private deps: ChatSocketDeps;
  readonly sessions = new Map<string, ChatSession>();
  /** 已在主控建过行的会话 id(每会话只 PUT 一次,避免重复 REST + 409 churn)。登出清。*/
  private serverSessionEnsured = new Set<string>();

  // ── 订阅 / 批量 notify ──
  private listeners = new Set<() => void>();
  private version = 0;
  private notifyScheduled = false;
  /** useSyncExternalStore 要求 getSnapshot 在未变更时返回**同一引用**；缓存于此，
   *  仅在 notify flush 时重建（version++）。*/
  private snapshot: ChatSnapshot;

  // ── 连接状态 ──
  private ws: WebSocket | null = null;
  private statusLabel = "未连接";
  private statusCls: ChatStatusClass = "disconnected";
  private provisioning = false;
  private started = false;
  private gateReady = false;

  // ── 重连退避（§1）──
  private reconnectAttempts = 0;
  private isBrowserOnline = true; // 乐观初始化，不读 navigator.onLine（§1）
  private pendingBrowserOfflineAt = 0;
  private lastVisibilityReconnectAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCountdown: ReturnType<typeof setInterval> | null = null;

  // ── 1008 续期闸门（§5）──
  private wsAuthRefreshInFlight = false;
  private lastWsAuthRefreshAt = 0;
  private authEpoch = 0;

  // ── ping watchdog（§6）──
  private pingNonce = 0;
  private pendingPing: { id: number; ws: WebSocket; timeoutId: ReturnType<typeof setTimeout>; label: string } | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  // ── thinking-safety（§6）──
  private thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── 重连 reconcile（§4）──
  private reconnectInFlightSet: Set<string> | null = null;
  private reconnectInFlightTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectReconcileTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 离线队列三段式（§10）──
  offlineQueue: OfflineItem[] = [];
  private offlineQueuePending: OfflineItem[] = [];
  private offlineDrainingCurrent: OfflineItem | null = null;
  private offlineQueueDraining = false;
  private offlineDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private drainGeneration = 0;

  // ── 生命周期事件绑定句柄 ──
  private boundOnline?: () => void;
  private boundOffline?: () => void;
  private boundVisible?: () => void;
  private boundFocus?: () => void;
  private boundBillingPaid?: () => void;
  private boundModelFixed?: () => void;

  constructor(deps: ChatSocketDeps) {
    this.deps = deps;
    this.snapshot = {
      version: 0,
      status: { label: this.statusLabel, cls: this.statusCls },
      provisioning: this.provisioning,
      sessions: this.sessions,
    };
  }

  // ═══════════════ 订阅 ═══════════════
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): ChatSnapshot => this.snapshot;

  private rebuildSnapshot(): void {
    this.snapshot = {
      version: this.version,
      status: { label: this.statusLabel, cls: this.statusCls },
      provisioning: this.provisioning,
      sessions: this.sessions,
    };
  }

  /** 批量 notify：合并同 tick 的高频帧 mutation 成一次订阅回调（不每帧 setState）。*/
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    const flush = () => {
      this.notifyScheduled = false;
      this.version++;
      this.rebuildSnapshot();
      for (const cb of this.listeners) cb();
    };
    if (typeof queueMicrotask === "function") queueMicrotask(flush);
    else Promise.resolve().then(flush);
  }

  private setStatus(label: string, cls: ChatStatusClass): void {
    if (this.statusLabel === label && this.statusCls === cls) return;
    this.statusLabel = label;
    this.statusCls = cls;
    this.scheduleNotify();
  }

  private setProvisioningBanner(visible: boolean): void {
    if (this.provisioning === visible) return;
    this.provisioning = visible;
    this.scheduleNotify();
  }

  // ═══════════════ 生命周期 ═══════════════
  start(): void {
    if (this.started) return;
    this.started = true;
    this.boundOnline = () => this.notifyNetworkOnline();
    this.boundOffline = () => this.notifyNetworkOffline();
    this.boundVisible = () => {
      if (document.visibilityState === "visible") this.notifyTabVisible();
    };
    this.boundFocus = () => this.notifyTabVisible();
    this.boundBillingPaid = () => this.retryConnectNow("充值成功，正在重新连接…");
    this.boundModelFixed = () => this.retryConnectNow("模型已切换，正在重新连接…");
    window.addEventListener("online", this.boundOnline);
    window.addEventListener("offline", this.boundOffline);
    document.addEventListener("visibilitychange", this.boundVisible);
    window.addEventListener("pageshow", this.boundFocus);
    window.addEventListener("focus", this.boundFocus);
    window.addEventListener("openclaude:billing-paid", this.boundBillingPaid);
    window.addEventListener("openclaude:model-policy-fixed", this.boundModelFixed);
  }

  stop(): void {
    this.started = false;
    if (this.boundOnline) window.removeEventListener("online", this.boundOnline);
    if (this.boundOffline) window.removeEventListener("offline", this.boundOffline);
    if (this.boundVisible) document.removeEventListener("visibilitychange", this.boundVisible);
    if (this.boundFocus) {
      window.removeEventListener("pageshow", this.boundFocus);
      window.removeEventListener("focus", this.boundFocus);
    }
    if (this.boundBillingPaid) window.removeEventListener("openclaude:billing-paid", this.boundBillingPaid);
    if (this.boundModelFixed) window.removeEventListener("openclaude:model-policy-fixed", this.boundModelFixed);
    this.clearReconnectTimers();
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.reconnectInFlightTimer) clearTimeout(this.reconnectInFlightTimer);
    if (this.reconnectReconcileTimer) clearTimeout(this.reconnectReconcileTimer);
    if (this.offlineDrainTimer) clearTimeout(this.offlineDrainTimer);
    if (this.drainTimeoutTimer) clearTimeout(this.drainTimeoutTimer);
    for (const t of this.thinkingTimers.values()) clearTimeout(t);
    this.thinkingTimers.clear();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "client stop");
    } catch {
      /* ignore */
    }
  }

  /** gate（容器 ready）是 WS 连接的硬前置（§0/§1）。ready→true 时尝试连。*/
  setGateReady(ready: boolean): void {
    const was = this.gateReady;
    this.gateReady = ready;
    if (ready && !was) this.connect();
    if (!ready && was) {
      // gate 关闭（容器休眠/订阅失效）→ 主动断开，避免对死容器烧退避。
      // 先置 this.ws=null 再 close，会让 onclose 的 stale-socket 守卫提前 return，
      // 故这里手动清掉随 ws 生命周期建立的 keepalive interval，避免泄漏。
      this.clearReconnectTimers();
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      if (this.pendingPing) {
        clearTimeout(this.pendingPing.timeoutId);
        this.pendingPing = null;
      }
      const ws = this.ws;
      this.ws = null;
      try {
        ws?.close(1000, "gate closed");
      } catch {
        /* ignore */
      }
      this.setStatus("未连接", "disconnected");
    }
  }

  // ═══════════════ safeWsSend（唯一发送入口，2MB 背压，§2）═══════════════
  private safeWsSend(data: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    const buffered = typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : 0;
    if (buffered >= SAFE_WS_BUFFER_BYTES) {
      try {
        ws.close(WS_CLOSE_CODE_STALLED, "bufferedAmount exceeded");
      } catch {
        /* ignore */
      }
      return false;
    }
    try {
      ws.send(data);
      return true;
    } catch {
      // send 抛异常 readyState 不一定切，必须主动 close 才进自愈链（§2）。
      try {
        ws.close(WS_CLOSE_CODE_STALLED, "send failed");
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  // ═══════════════ ping watchdog（§6）═══════════════
  private probeWsAlive(ws: WebSocket, timeoutMs: number, label: string): void {
    if (!ws || ws.readyState !== 1) return;
    if (this.ws !== ws) return;
    if (this.pendingPing) return; // 同时刻最多一个 ping
    const id = ++this.pingNonce;
    if (!this.safeWsSend(JSON.stringify({ type: "ping", id }))) return; // 背压已 close，不 arm
    const timeoutId = setTimeout(() => {
      if (!this.pendingPing || this.pendingPing.id !== id) return;
      this.pendingPing = null;
      if (this.ws !== ws || ws.readyState !== 1) return;
      const code = label === "keepalive" ? 4001 : 4000;
      try {
        ws.close(code, `${label} ping timeout`);
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    this.pendingPing = { id, ws, timeoutId, label };
  }

  // ═══════════════ thinking-safety（§6）═══════════════
  private resetThinkingSafety(sessId: string): void {
    const existing = this.thinkingTimers.get(sessId);
    if (existing) clearTimeout(existing);
    const tid = setTimeout(() => {
      this.thinkingTimers.delete(sessId);
      const s = this.sessions.get(sessId);
      if (s && s._sendingInFlight) {
        const sinceLastFrame = Date.now() - (s._lastFrameAt || 0);
        if (s._lastFrameAt && sinceLastFrame < THINKING_SAFETY_MS) {
          this.resetThinkingSafety(sessId); // liveness 复检：窗口内有帧 → reschedule
          return;
        }
        const timedOutMsgId = s._replyingToMsgId || null;
        this.safeWsSend(
          JSON.stringify({
            type: "inbound.control.stop",
            channel: "webchat",
            peer: { id: sessId, kind: "dm" },
            agentId: s.agentId || this.deps.defaultAgentId || "main",
          }),
        );
        s._sendingInFlight = false;
        clearTurnTiming(s);
        resetReplyTracker(s);
        const lastMsg = s.messages[s.messages.length - 1];
        const dup = lastMsg && lastMsg._emptyTurn && lastMsg._emptyTurnTargetMsgId === timedOutMsgId;
        if (!dup) {
          addMessage(s, "assistant", '约 10 分钟未收到新内容,本轮可能已中断。可重新发送,或直接说"继续"。', {
            _emptyTurn: true,
            _emptyTurnSoft: false,
            _emptyTurnTimeout: true,
            _emptyTurnTargetMsgId: timedOutMsgId,
          });
        }
        this.scheduleNotify();
      }
    }, THINKING_SAFETY_MS);
    this.thinkingTimers.set(sessId, tid);
  }

  private clearThinkingSafety(sessId: string): void {
    const t = this.thinkingTimers.get(sessId);
    if (t) {
      clearTimeout(t);
      this.thinkingTimers.delete(sessId);
    }
  }

  // ═══════════════ reducer effects ═══════════════
  private effects(): FrameEffects {
    return {
      onFinal: (sess, _frame, isCronOrHeartbeat) => {
        this.clearThinkingSafety(sess.id);
        if (this.reconnectInFlightSet) {
          this.reconnectInFlightSet.delete(sess.id);
          if (this.reconnectInFlightSet.size === 0 && this.reconnectInFlightTimer) {
            clearTimeout(this.reconnectInFlightTimer);
            this.reconnectInFlightTimer = null;
            this.reconnectInFlightSet = null;
          }
        }
        // drain 推进（§10）。
        if (this.offlineDrainingCurrent && this.offlineDrainingCurrent.sessId === sess.id && !isCronOrHeartbeat) {
          if (this.drainTimeoutTimer) {
            clearTimeout(this.drainTimeoutTimer);
            this.drainTimeoutTimer = null;
          }
          this.offlineDrainingCurrent = null;
          if (this.offlineQueuePending.length > 0) setTimeout(() => this.drainNextOfflineItem(), 500);
          else this.offlineQueueDraining = false;
          this.maybePromoteToConnected();
        }
        // turn 收尾：落地完成轮（reload 不丢；游标 + 完整 tape durable）。
        this.deps.persistSession?.(sess.id);
      },
      onLiveFrame: (sess) => {
        if (sess._sendingInFlight) this.resetThinkingSafety(sess.id);
      },
      scheduleAutoContinue: (sessId, targetMsgId, cls) => {
        setTimeout(() => this.autoContinueEmptyTurn(sessId, targetMsgId, cls), 0);
      },
      refreshBalance: () => this.deps.refreshBalance?.(),
      reportTurnError: (p) =>
        this.deps.reportClientError?.({ type: "turn_error", message: p.message, traceId: p.traceId, sessionId: p.sessionId }),
      forceSync: (sessId) => {
        void this.deps.syncSession?.(sessId);
      },
      persistSession: (sessId) => this.deps.persistSession?.(sessId),
      onAuthControlError: () => {
        // 交给 close(1008) handler 续期，不渲染。
      },
    };
  }

  // ═══════════════ connect / onopen / onclose / onmessage ═══════════════
  connect(): void {
    if (!this.deps.getToken()) return;
    if (!this.gateReady) return; // 硬前置
    if (this.wsAuthRefreshInFlight) return; // 续期中禁止用旧 token 起新连
    if (this.ws && this.ws.readyState < 2) return; // 已连/连接中
    if (!this.isBrowserOnline) {
      this.setStatus("离线", "disconnected");
      return;
    }
    if (typeof WebSocket === "undefined") {
      // 无 WebSocket 实现（SSR / jsdom 测试环境）：优雅降级，不抛。
      this.setStatus("未连接", "disconnected");
      return;
    }
    this.setStatus("连接中…", "connecting");
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const url = `${proto}${location.host}${WS_PATH}`;
    // 鉴权 = Sec-WebSocket-Protocol 子协议 ['bearer', token]（非 ?token= 非 header）。
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ["bearer", this.deps.getToken()]);
    } catch {
      this.setStatus("连接失败", "disconnected");
      return;
    }
    this.ws = ws;
    let authRefreshTried = false;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.isBrowserOnline = true;
      this.pendingBrowserOfflineAt = 0;
      if (this.reconnectCountdown) {
        clearInterval(this.reconnectCountdown);
        this.reconnectCountdown = null;
      }
      this.setProvisioningBanner(false); // onopen = WS 真可用的唯一可信信号
      const [lbl, cls] = onopenSetInitialStatus(this.offlineQueue.length);
      this.setStatus(lbl, cls);

      // 重连 mid-turn 快照 + 30s 安全网（不自动清 in-flight，只提示）。
      if (this.reconnectInFlightTimer) clearTimeout(this.reconnectInFlightTimer);
      this.reconnectInFlightSet = new Set();
      for (const [id, s] of this.sessions) if (s._sendingInFlight) this.reconnectInFlightSet.add(id);
      if (this.reconnectInFlightSet.size > 0) {
        this.reconnectInFlightTimer = setTimeout(() => {
          this.reconnectInFlightTimer = null;
          const snapped = this.reconnectInFlightSet;
          this.reconnectInFlightSet = null;
          if (!snapped) return;
          for (const sessId of snapped) {
            const s = this.sessions.get(sessId);
            if (s?._sendingInFlight && this.statusCls !== "connected") this.setStatus("正在恢复上一轮…", "connecting");
          }
        }, 30000);
      } else {
        this.reconnectInFlightSet = null;
      }

      // 发 hello（autoResume：每 peer 带 lastFrameSeq）。
      try {
        this.safeWsSend(this.buildHelloFrame());
      } catch {
        /* ignore */
      }

      // 4s grace 主动 reconcile（§4）：补 resume_failed 覆盖不到的静默丢失。
      if (this.reconnectInFlightSet && this.reconnectInFlightSet.size > 0) {
        const reconnectAt = Date.now();
        const reconcileSet = new Set(this.reconnectInFlightSet);
        if (this.reconnectReconcileTimer) clearTimeout(this.reconnectReconcileTimer);
        this.reconnectReconcileTimer = setTimeout(() => {
          this.reconnectReconcileTimer = null;
          if (this.ws !== ws || ws.readyState !== 1) return; // 按 ws 实例校验，防旧 timer 误 reconcile 新连接
          for (const sessId of reconcileSet) {
            const s = this.sessions.get(sessId);
            if (s?._sendingInFlight && (!s._lastFrameAt || s._lastFrameAt < reconnectAt)) {
              s._liveStreamBroken = true;
              void this.deps.syncSession?.(sessId);
            }
          }
        }, RECONNECT_RECONCILE_GRACE_MS);
      }

      // 延迟启动 drain（§10）：等 hello/resume isFinal 先到，避免误当 drain 响应。
      if (this.offlineDrainTimer) clearTimeout(this.offlineDrainTimer);
      if (this.offlineQueue.length > 0) {
        this.offlineDrainTimer = setTimeout(() => {
          this.offlineDrainTimer = null;
          if (!this.ws || this.ws.readyState !== 1) return;
          if (this.offlineQueue.length === 0) return;
          this.offlineQueuePending = [...this.offlineQueue];
          this.offlineQueue = [];
          this.offlineQueueDraining = true;
          this.drainGeneration++;
          this.drainNextOfflineItem();
        }, OFFLINE_DRAIN_START_DELAY_MS);
      }
      this.scheduleNotify();
    };

    // keepalive（§6）。
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      this.probeWsAlive(ws, PROBE_TIMEOUT_KEEPALIVE_MS, "keepalive");
    }, KEEPALIVE_INTERVAL_MS);

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let f: OutboundWire;
      try {
        f = JSON.parse(ev.data) as OutboundWire;
      } catch {
        return; // 解析失败：不落原文（含用户输入/payload，安全）
      }
      // pong 必须先于一切 session handler（无 peer/frameSeq）。
      if (f.type === "pong") {
        if (this.pendingPing && this.pendingPing.ws === ws && this.pendingPing.id === (f as { id?: number }).id) {
          clearTimeout(this.pendingPing.timeoutId);
          this.pendingPing = null;
        }
        return;
      }
      try {
        this.dispatch(f);
      } catch {
        /* dispatch 失败：吞掉，不落 payload */
      }
      this.scheduleNotify();
    };

    ws.onerror = () => {
      /* onclose 才带 reason；这里不可见，no-op */
    };

    ws.onclose = (e) => {
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      if (this.pendingPing && this.pendingPing.ws === ws) {
        clearTimeout(this.pendingPing.timeoutId);
        this.pendingPing = null;
      }
      if (this.ws !== ws) return; // stale socket
      if (this.offlineDrainTimer) {
        clearTimeout(this.offlineDrainTimer);
        this.offlineDrainTimer = null;
      }
      if (this.drainTimeoutTimer) {
        clearTimeout(this.drainTimeoutTimer);
        this.drainTimeoutTimer = null;
      }
      if (this.reconnectInFlightTimer) {
        clearTimeout(this.reconnectInFlightTimer);
        this.reconnectInFlightTimer = null;
        this.reconnectInFlightSet = null;
      }
      if (this.reconnectReconcileTimer) {
        clearTimeout(this.reconnectReconcileTimer);
        this.reconnectReconcileTimer = null;
      }
      this.setStatus("已断线", "disconnected");
      // 保留 per-session _sendingInFlight（重连 + hello/resume 后恢复 loading）。
      // 重排离线队列：current + pending unshift 回 offlineQueue 头部，保序（§10）。
      const requeue: OfflineItem[] = [];
      if (this.offlineDrainingCurrent) requeue.push(this.offlineDrainingCurrent);
      if (this.offlineQueuePending.length > 0) requeue.push(...this.offlineQueuePending);
      if (requeue.length > 0) this.offlineQueue.unshift(...requeue);
      this.offlineDrainingCurrent = null;
      this.offlineQueuePending = [];
      this.offlineQueueDraining = false;

      const decision = classifyClose(e.code, e.reason);

      if (decision.action === "policy" && decision.policy) {
        this.setProvisioningBanner(false);
        this.setStatus(decision.policy.status, "disconnected");
        if (decision.policy.billing) this.deps.refreshBalance?.();
        // 按 retryAfter 排程重连（这里用标准退避兜底；server 通常会再 hint）。
        this.schedulePolicyReconnect(decision.policy.status);
        this.scheduleNotify();
        return;
      }

      if (decision.action === "auth_1008") {
        const now = Date.now();
        const canRetry =
          !!this.deps.getToken() && !authRefreshTried && now - this.lastWsAuthRefreshAt > WS_AUTH_REFRESH_MIN_GAP_MS;
        if (canRetry) {
          authRefreshTried = true;
          this.lastWsAuthRefreshAt = now;
          this.wsAuthRefreshInFlight = true;
          const epochAtStart = this.authEpoch;
          this.setStatus("会话续期中…", "connecting");
          void (async () => {
            let ok: string | null = null;
            try {
              ok = await this.deps.silentRefresh().catch(() => null);
            } finally {
              this.wsAuthRefreshInFlight = false;
            }
            if (this.authEpoch !== epochAtStart) return; // 身份已变，撤退
            if (ok && this.deps.getToken()) this.connect();
            else this.tearDownAuth();
          })();
          return;
        }
        this.tearDownAuth();
        return;
      }

      // ── reconnect 分支 ──
      this.clearReconnectTimers();
      if (!this.deps.getToken()) return;
      // offline latch 提升（§5）。
      if (this.pendingBrowserOfflineAt > 0) {
        const elapsed = Date.now() - this.pendingBrowserOfflineAt;
        const browserStillOffline = typeof navigator !== "undefined" && navigator.onLine === false;
        this.pendingBrowserOfflineAt = 0;
        if (browserStillOffline || elapsed <= OFFLINE_LATCH_GRACE_MS) this.isBrowserOnline = false;
      }
      if (!this.isBrowserOnline) {
        this.setStatus("离线", "disconnected");
        return;
      }
      this.setProvisioningBanner(decision.provisioning);
      const delay = decision.serverHintedDelay > 0 ? decision.serverHintedDelay : backoffDelay(this.reconnectAttempts);
      if (decision.serverHintedDelay === 0) this.reconnectAttempts++; // server hint 不计入 client 退避（§1）
      const label = decision.closeReasonLabel;
      if (delay >= 4000) {
        let remaining = Math.ceil(delay / 1000);
        const render = () =>
          this.setStatus(label ? `${label} · ${remaining} 秒后重试…` : `${remaining} 秒后重连…`, "disconnected");
        render();
        this.reconnectCountdown = setInterval(() => {
          remaining--;
          if (remaining > 0) render();
          else if (this.reconnectCountdown) {
            clearInterval(this.reconnectCountdown);
            this.reconnectCountdown = null;
          }
        }, 1000);
      } else if (label) {
        this.setStatus(label, "connecting");
      }
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.scheduleNotify();
    };
  }

  private dispatch(f: OutboundWire): void {
    switch (f.type) {
      case "outbound.message": {
        const frame = f as OutboundMessageWire;
        const sess = this.resolveSession(frame.peer?.id);
        if (!sess) return;
        applyOutboundMessage(sess, frame, this.effects());
        return;
      }
      case "outbound.turn_status": {
        const frame = f as OutboundTurnStatusWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) applyTurnStatus(sess, frame);
        return;
      }
      case "outbound.error": {
        const frame = f as OutboundErrorWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) {
          applyOutboundError(sess, frame, this.effects());
          this.clearThinkingSafety(sess.id);
        }
        return;
      }
      case "error": {
        const frame = f as LegacyBridgeErrorWire;
        const sess = frame.peer?.id ? this.sessions.get(frame.peer.id) : this.firstSession();
        if (sess) {
          applyLegacyBridgeError(sess, frame, this.effects());
          this.clearThinkingSafety(sess.id);
        }
        return;
      }
      case "outbound.permission_request": {
        const frame = f as OutboundPermissionRequestWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) applyPermissionRequest(sess, frame);
        return;
      }
      case "outbound.permission_settled": {
        const frame = f as OutboundPermissionSettledWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) applyPermissionSettled(sess, frame);
        return;
      }
      case "outbound.resume_failed": {
        const frame = f as OutboundResumeFailedWire;
        const sess = frame.peer?.id ? this.sessions.get(frame.peer.id) : null;
        if (sess) applyResumeFailed(sess, frame, this.effects());
        return;
      }
      case "outbound.cost_charged": {
        const frame = f as CostChargedWire;
        // frame.sessionId 是 agent 内部会话 UUID(LLM metadata 口径),与前端 client peer 会话键
        // 失配,直接 get 必空。优先按 sessionId(若将来口径对齐),否则路由到在飞/刚收尾 turn 的会话。
        const sess =
          (frame.sessionId ? this.sessions.get(frame.sessionId) : undefined) ?? this.costTargetSession();
        applyCostCharged(sess, frame, this.effects());
        return;
      }
      case "sys.cold_start": {
        const sess = this.firstSession();
        if (sess) sess._isFirstTurnAfterReady = true;
        return;
      }
      case "outbound.ack": {
        const frame = f as { deduplicated?: boolean; idempotencyKey?: string };
        if (frame.deduplicated) {
          if (this.offlineDrainingCurrent) {
            this.offlineDrainingCurrent = null;
            this.nudgeDrain();
          }
          if (typeof frame.idempotencyKey === "string" && frame.idempotencyKey.startsWith("autocont-")) {
            this.clearAutoContinueInFlight(frame.idempotencyKey);
          }
        }
        return;
      }
      default:
        // pong 已先处理；其余（repo_status 等）v5 webchat 不消费。
        return;
    }
  }

  /** outbound.message 的 peer 解析：未知 peer 直接忽略（v5 每会话即 peer）。*/
  private resolveSession(peerId: string | undefined): ChatSession | null {
    if (peerId && this.sessions.has(peerId)) return this.sessions.get(peerId)!;
    return null;
  }

  private firstSession(): ChatSession | null {
    for (const s of this.sessions.values()) return s;
    return null;
  }

  /**
   * cost_charged 的路由目标会话。frame.sessionId 是 **agent 内部会话 UUID**(来自容器 LLM
   * 请求的 metadata,extractSessionId),与前端 **client peer 会话键**(sess.id=peerId)是
   * 两套口径,直接 `sessions.get(sessionId)` 必失配 → 旧实现落 null → per-response 积分永不归因
   * (只剩钱包余额刷新)。cost_charged 经 broadcastToUser 按 uid 投递、且恰在当前 turn 收尾后到,
   * 故路由到"当前在飞 / 最近收尾"的会话最稳。安全性由 applyCostCharged 内部门控兜底:它只认
   * _streamingAssistant 或 60s 内 _lastFinaledAssistantId,选错会话则 target=null 仅刷余额、不误算。
   */
  private costTargetSession(): ChatSession | null {
    let recentFinal: ChatSession | null = null;
    let recentAt = 0;
    for (const s of this.sessions.values()) {
      if (s._streamingAssistant || s._sendingInFlight) return s;
      if (s._lastFinaledAssistantId && s._lastFinaledAt && s._lastFinaledAt > recentAt) {
        recentAt = s._lastFinaledAt;
        recentFinal = s;
      }
    }
    return recentFinal ?? this.firstSession();
  }

  private buildHelloFrame(): string {
    const peers: Array<{ peerId: string; agentId: string; inFlight: boolean; lastFrameSeq: number }> = [];
    for (const [pid, s] of this.sessions) {
      const safeId = String(pid).replace(/[^a-zA-Z0-9_-]/g, "_");
      const emitted = new Set<string>();
      const pushPeer = (agentId: string, lastFrameSeq: number) => {
        const aid = agentId || s.agentId || this.deps.defaultAgentId || "main";
        if (emitted.has(aid)) return;
        emitted.add(aid);
        peers.push({ peerId: pid, agentId: aid, inFlight: !!s._sendingInFlight, lastFrameSeq: Number.isFinite(lastFrameSeq) ? lastFrameSeq : 0 });
      };
      const byKey = s._lastFrameSeqByKey;
      if (byKey && typeof byKey === "object") {
        for (const [key, seq] of Object.entries(byKey)) {
          const m = key.match(/^agent:([^:]+):webchat:dm:(.+)$/);
          if (!m || m[2] !== safeId) continue;
          pushPeer(m[1], seq);
        }
      }
      const defAgent = s.agentId || this.deps.defaultAgentId || "main";
      const defKey = safeSessionKeyForAgent(s.id, defAgent);
      pushPeer(defAgent, byKey && Number.isFinite(byKey[defKey]) ? byKey[defKey] : 0);
    }
    return JSON.stringify({ type: "inbound.hello", channel: "webchat", peers });
  }

  private tearDownAuth(): void {
    this.authEpoch++;
    this.setProvisioningBanner(false);
    this.deps.onAuthExpired();
    this.setStatus("未连接", "disconnected");
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectCountdown) {
      clearInterval(this.reconnectCountdown);
      this.reconnectCountdown = null;
    }
  }

  private schedulePolicyReconnect(status: string): void {
    if (!this.deps.getToken()) return;
    this.clearReconnectTimers();
    const delay = backoffDelay(this.reconnectAttempts);
    this.reconnectAttempts++;
    let remaining = Math.ceil(delay / 1000);
    this.setStatus(`${status} · ${remaining} 秒后重试…`, "disconnected");
    this.reconnectCountdown = setInterval(() => {
      remaining--;
      if (remaining > 0) this.setStatus(`${status} · ${remaining} 秒后重试…`, "disconnected");
      else if (this.reconnectCountdown) {
        clearInterval(this.reconnectCountdown);
        this.reconnectCountdown = null;
      }
    }, 1000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // ═══════════════ 生命周期入口（§1）═══════════════
  retryConnectNow(label = "重新连接中…"): boolean {
    if (!this.deps.getToken()) return false;
    if (this.wsAuthRefreshInFlight) return false;
    if (this.ws && this.ws.readyState < 2) return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.isBrowserOnline = false;
      this.setStatus("离线", "disconnected");
      return false;
    }
    this.isBrowserOnline = true;
    this.pendingBrowserOfflineAt = 0;
    this.reconnectAttempts = 0;
    this.clearReconnectTimers();
    this.setStatus(label, "connecting");
    this.connect();
    return true;
  }

  notifyNetworkOffline(): void {
    if (!this.isBrowserOnline) return;
    if (this.ws && this.ws.readyState === 1) {
      this.pendingBrowserOfflineAt = Date.now(); // latch only（§5）
      return;
    }
    this.isBrowserOnline = false;
    this.clearReconnectTimers();
    this.setProvisioningBanner(false);
    this.setStatus("离线", "disconnected");
  }

  notifyNetworkOnline(): void {
    this.pendingBrowserOfflineAt = 0;
    this.isBrowserOnline = true;
    if (!this.deps.getToken()) return;
    if (this.wsAuthRefreshInFlight) return;
    this.reconnectAttempts = 0;
    this.clearReconnectTimers();
    if (this.ws && this.ws.readyState < 2) return;
    this.connect();
  }

  notifyTabVisible(): void {
    if (!this.deps.getToken()) return;
    if (!this.isBrowserOnline) return;
    if (this.wsAuthRefreshInFlight) return;
    if (!this.ws || this.ws.readyState >= 2) {
      const now = Date.now();
      if (now - this.lastVisibilityReconnectAt < VISIBILITY_RECONNECT_COOLDOWN_MS) return;
      this.lastVisibilityReconnectAt = now;
      this.clearReconnectTimers();
      this.connect();
      return;
    }
    this.probeWsAlive(this.ws, PROBE_TIMEOUT_VISIBILITY_MS, "visibility");
  }

  /** 主动 bump epoch（登出/换号时由 hook 调，作废在飞续期）。*/
  bumpAuthEpoch(): void {
    this.authEpoch++;
  }

  // ═══════════════ 会话注册 ═══════════════
  ensureSession(sessId: string, agentId: string, title?: string): ChatSession {
    let s = this.sessions.get(sessId);
    if (!s) {
      s = createSession({ id: sessId, agentId, title });
      this.sessions.set(sessId, s);
      this.scheduleNotify();
    }
    return s;
  }

  removeSession(sessId: string): void {
    if (this.sessions.delete(sessId)) this.scheduleNotify();
  }

  /**
   * 清空全部内存会话（登出/换号隐私收尾，类比 P5 媒体缓存按 authKey 失效）。单例
   * service 跨登出存活，若不清，换号后旧会话残留内存。调用前 WS 应已 stop（无活跃 turn）。
   */
  resetSessions(): void {
    if (this.sessions.size === 0) return;
    this.sessions.clear();
    this.serverSessionEnsured.clear();
    this.scheduleNotify();
  }

  // ═══════════════ 本地持久 / 历史装载（P6）═══════════════

  /**
   * 序列化为可持久化的 StoredSession：只取 reducer 产出的稳定数据 + 断点续传游标，
   * 剥离流式指针 / Map / in-flight 瞬态（注水时由 rebuildIndexes 重建）。
   */
  toStored(sessId: string): StoredSession | null {
    const s = this.sessions.get(sessId);
    if (!s) return null;
    return {
      id: s.id,
      agentId: s.agentId,
      title: s.title,
      messages: s.messages,
      createdAt: s.createdAt,
      lastAt: s.lastAt,
      updatedAt: s.updatedAt,
      _lastFrameSeqByKey: s._lastFrameSeqByKey ? { ...s._lastFrameSeqByKey } : undefined,
      _lastFrameSeq: s._lastFrameSeq,
      _maxSeq: s._maxSeq,
    };
  }

  /**
   * 从 IndexedDB 注水会话（boot/登录读回）。**不发任何帧、不连 WS**——纯本地恢复，
   * 让 reload 不丢会话。已存在（live）则跳过：live 状态永远优先于磁盘快照。
   * 注水后清流式瞬态 + reset in-flight（防 reload 后卡 loading），并重建 block/agent 索引。
   */
  loadStored(stored: StoredSession): void {
    if (!stored?.id || this.sessions.has(stored.id)) return;
    const s = createSession({
      id: stored.id,
      agentId: stored.agentId || this.deps.defaultAgentId || "main",
      title: stored.title,
      createdAt: stored.createdAt,
    });
    s.messages = Array.isArray(stored.messages) ? stored.messages : [];
    s.lastAt = typeof stored.lastAt === "number" ? stored.lastAt : s.lastAt;
    s.updatedAt = stored.updatedAt;
    s._lastFrameSeqByKey = stored._lastFrameSeqByKey ? { ...stored._lastFrameSeqByKey } : {};
    s._lastFrameSeq = stored._lastFrameSeq;
    s._maxSeq = stored._maxSeq;
    s._streamingAssistant = null;
    s._streamingThinking = null;
    s._sendingInFlight = false;
    rebuildIndexes(s);
    this.sessions.set(stored.id, s);
    this.scheduleNotify();
  }

  /**
   * 合并 server canonical 历史（gateway getSession 结果）。server-wins / 按 id 幂等：
   *  - full（!isPartial）：server 整带为权威在前，仅追加本地 server 不认识的乐观尾消息。
   *  - 增量（isPartial）：在本地基础上按 id 覆盖 + 追加新增。
   * maxSeq 单调推进作下次增量游标。会话不存在则按 agentId 惰性建。
   */
  applyServerMessages(
    sessId: string,
    agentId: string,
    msgs: ChatMessage[],
    full: boolean,
    maxSeq?: number,
  ): void {
    const s = this.ensureSession(sessId, agentId || this.deps.defaultAgentId || "main");
    s.messages = full ? mergeFullServerWins(msgs, s.messages) : applyServerIncremental(s.messages, msgs);
    if (typeof maxSeq === "number" && (s._maxSeq === undefined || maxSeq > s._maxSeq)) {
      s._maxSeq = maxSeq;
    }
    s._streamingAssistant = null;
    s._streamingThinking = null;
    s._blockIdToMsgId = new Map();
    s._agentGroups = new Map();
    rebuildIndexes(s);
    this.scheduleNotify();
  }

  /**
   * 切换会话 agent（§11 跨 agent 污染守卫的写入点）。打 `_agentSwitchedAt` 戳让
   * 旧 agent 的 late frames 被 reducer drop；更新 sess.agentId 让 stop/hello/permission
   * 默认 agent 与新选一致；reset reply tracker 防旧轮答案绑到新轮。下次 send 会清掉本戳
   * （主动新发是 intentional）。沿用现网 main.js 切 agent 语义。
   */
  switchAgent(sessId: string, agentId: string): void {
    const sess = this.sessions.get(sessId);
    if (!sess || !agentId || sess.agentId === agentId) return;
    sess.agentId = agentId;
    sess._agentSwitchedAt = Date.now();
    resetReplyTracker(sess);
    this.scheduleNotify();
  }

  // ═══════════════ 发送（inbound.message 构造 + 离线路由，§7/§10）═══════════════
  sendMessage(p: {
    sessId: string;
    agentId: string;
    text: string;
    displayText?: string;
    media?: InboundMessage["content"]["media"];
    model?: string;
    effortLevel?: InboundMessage["effortLevel"];
  }): void {
    const sess = this.ensureSession(p.sessId, p.agentId);
    // 主控 session 建行(每会话一次):必须在容器跑完 turn 回传 authored 消息之前落地,
    // 否则 session_not_found 风暴。fire-and-forget,见 deps.ensureServerSession 注释。
    if (!this.serverSessionEnsured.has(sess.id)) {
      this.serverSessionEnsured.add(sess.id);
      this.deps.ensureServerSession?.(sess.id, p.agentId, sess.title);
    }
    const media = p.media && p.media.length > 0 ? p.media : undefined;
    const payload: InboundMessage = {
      type: "inbound.message",
      idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: p.agentId,
      content: { text: p.text, ...(media ? { media } : {}) },
      ...(p.effortLevel !== undefined ? { effortLevel: p.effortLevel } : {}),
      ...(p.model ? { model: p.model } : {}),
      ts: Date.now(),
    };
    const userMsg = addMessage(sess, "user", p.displayText ?? p.text, {
      status: "sending",
      _media: media,
      _modelText: p.displayText && p.displayText !== p.text ? p.text : undefined,
    });
    sess._streamingAssistant = null;
    sess._streamingThinking = null;
    sess._blockIdToMsgId = new Map();
    sess._agentSwitchedAt = null;

    const hasQueuedForSess =
      this.offlineQueue.some((i) => i.sessId === sess.id) ||
      this.offlineQueuePending.some((i) => i.sessId === sess.id) ||
      this.offlineDrainingCurrent?.sessId === sess.id;

    let sentNow = false;
    if (this.ws && this.ws.readyState === 1 && !hasQueuedForSess) {
      sentNow = this.safeWsSend(JSON.stringify(payload));
    }
    if (sentNow) {
      userMsg.status = "sent";
      sess._sendingInFlight = true;
      sess._turnStartedAt = Date.now();
      // 新 turn 开始：清跨 turn 计费归因状态（与 drain / auto-continue turn-start 一致）。
      sess._pendingCostCredits = "0";
      sess._lastFinaledAssistantId = null;
      sess._lastFinaledAt = 0;
      this.resetThinkingSafety(sess.id);
    } else {
      const enqueued = this.tryEnqueueOffline({ sessId: sess.id, payload, msgId: userMsg.id });
      if (!enqueued) {
        userMsg.status = "error";
      } else {
        userMsg.status = "queued";
      }
    }
    this.scheduleNotify();
  }

  /** offlineQueue 软上限（§10）。*/
  private tryEnqueueOffline(item: OfflineItem): boolean {
    if (this.offlineQueue.length >= MAX_OFFLINE_QUEUE) return false;
    this.offlineQueue.push(item);
    return true;
  }

  stopTurn(sessId: string): void {
    const sess = this.sessions.get(sessId);
    if (!sess) return;
    if (!this.ws || this.ws.readyState !== 1) return; // 断线时 stop 由服务端重连后恢复
    this.safeWsSend(
      JSON.stringify({
        type: "inbound.control.stop",
        channel: "webchat",
        peer: { id: sess.id, kind: "dm" },
        agentId: sess.agentId || this.deps.defaultAgentId || "main",
      }),
    );
    // 本地立即收尾（不等后端 isFinal）。
    sess._sendingInFlight = false;
    clearTurnTiming(sess);
    resetReplyTracker(sess);
    this.clearThinkingSafety(sess.id);
    this.scheduleNotify();
  }

  respondPermission(p: {
    sessId: string;
    requestId: string;
    behavior: "allow" | "deny";
    message?: string;
    updatedInput?: Record<string, unknown>;
  }): void {
    const sess = this.sessions.get(p.sessId);
    if (!sess) return;
    const payload: Record<string, unknown> = {
      type: "inbound.permission_response",
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: sess.agentId || this.deps.defaultAgentId || "main",
      requestId: p.requestId,
      behavior: p.behavior,
      message: p.message || undefined,
    };
    if (p.updatedInput && p.behavior === "allow") payload.updatedInput = p.updatedInput;
    this.safeWsSend(JSON.stringify(payload));
    const msg = sess.messages.find((m) => m.requestId === p.requestId);
    if (msg) {
      msg._resolved = true;
      msg._behavior = p.behavior;
    }
    this.scheduleNotify();
  }

  // ═══════════════ 单次 auto-continue（确定性 idempotencyKey，§7）═══════════════
  private autoContinueEmptyTurn(sessId: string, targetMsgId: string, cls: EmptyTurnDecision): void {
    const sess = this.sessions.get(sessId);
    if (!sess) return;
    if (sess._sendingInFlight) return; // 旧 final teardown 后已有新 turn → 放弃
    const idx = sess.messages.findIndex((m) => m && m.id === targetMsgId);
    if (idx < 0) return;
    if (!shouldAutoContinueEmptyTurn({ messages: sess.messages, targetMsgId, stopReason: "end_turn" })) return;

    const insertNotice = () => {
      const last = sess.messages[sess.messages.length - 1];
      if (last && last._emptyTurn && last._emptyTurnTargetMsgId === targetMsgId) return;
      addMessage(sess, "assistant", cls.insert ? cls.text : emptyTurnNoticeText("end_turn", false), {
        _emptyTurn: true,
        _emptyTurnSoft: cls.insert ? cls.soft : true,
        _emptyTurnStopReason: "end_turn",
        _emptyTurnTargetMsgId: targetMsgId,
      });
      this.scheduleNotify();
    };

    const hasQueued =
      this.offlineQueue.some((i) => i.sessId === sess.id) ||
      this.offlineQueuePending.some((i) => i.sessId === sess.id) ||
      this.offlineDrainingCurrent?.sessId === sess.id;
    if (!(this.ws && this.ws.readyState === 1) || hasQueued) {
      insertNotice();
      return;
    }

    const idem = `autocont-${sessId}-${targetMsgId}`;
    const payload: InboundMessage = {
      type: "inbound.message",
      idempotencyKey: idem,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: sess.agentId || this.deps.defaultAgentId || "main",
      content: { text: AUTO_CONTINUE_PROMPT },
      ts: Date.now(),
    };
    const userMsg = addMessage(sess, "user", AUTO_CONTINUE_DISPLAY, {
      status: "sending",
      _isAutoRetry: true,
      _modelText: AUTO_CONTINUE_PROMPT,
      _idem: idem,
    });
    const sent = this.safeWsSend(JSON.stringify(payload));
    if (!sent) {
      const ri = sess.messages.indexOf(userMsg);
      if (ri >= 0) sess.messages.splice(ri, 1);
      insertNotice();
      return;
    }
    userMsg.status = "sent";
    sess._sendingInFlight = true;
    sess._turnStartedAt = Date.now();
    sess._pendingCostCredits = "0";
    sess._lastFinaledAssistantId = null;
    sess._lastFinaledAt = 0;
    this.resetThinkingSafety(sess.id);
    this.scheduleNotify();
  }

  /** dedup ack 对账：另一 tab/replay 已跑过同一 auto-continue，清乐观 in-flight。*/
  private clearAutoContinueInFlight(idem: string): void {
    for (const sess of this.sessions.values()) {
      if (!sess.messages.some((m) => m && m._isAutoRetry && m._idem === idem)) continue;
      if (!sess._sendingInFlight) return;
      sess._sendingInFlight = false;
      this.clearThinkingSafety(sess.id);
      this.scheduleNotify();
      return;
    }
  }

  // ═══════════════ 离线 drain（§10）═══════════════
  private maybePromoteToConnected(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (this.offlineQueue.length > 0) return;
    if (this.offlineQueuePending.length > 0) return;
    if (this.offlineDrainingCurrent) return;
    if (this.offlineQueueDraining) return;
    this.setStatus("已连接", "connected");
  }

  private nudgeDrain(): void {
    if (this.drainTimeoutTimer) {
      clearTimeout(this.drainTimeoutTimer);
      this.drainTimeoutTimer = null;
    }
    if (this.offlineDrainingCurrent) return;
    if (this.offlineQueuePending.length > 0) setTimeout(() => this.drainNextOfflineItem(), 500);
    else {
      this.offlineQueueDraining = false;
      this.maybePromoteToConnected();
    }
  }

  private handleDrainTimeout(item: OfflineItem): void {
    if (this.offlineDrainingCurrent !== item) return;
    // 不再当失败判定：长任务/冷启动下静默清 in-flight 会让用户重发（§10）。
    const sess = this.sessions.get(item.sessId);
    if (sess && this.statusCls !== "connected") this.setStatus("仍在等待回复…", "connecting");
    this.drainTimeoutTimer = setTimeout(() => this.handleDrainTimeout(item), 5 * 60_000);
  }

  private drainNextOfflineItem(): void {
    const gen = this.drainGeneration;
    const queue = this.offlineQueuePending;
    if (!queue || queue.length === 0) {
      this.offlineQueueDraining = false;
      this.offlineDrainingCurrent = null;
      this.maybePromoteToConnected();
      return;
    }
    const item = queue[0];
    const targetSess = this.sessions.get(item.sessId);
    if (targetSess?._sendingInFlight) {
      item._retryCount = (item._retryCount || 0) + 1;
      if (item._retryCount > 60) {
        queue.shift();
        queue.push(item);
        item._retryCount = 0;
        const allBusy = queue.every((q) => this.sessions.get(q.sessId)?._sendingInFlight);
        if (allBusy) {
          setTimeout(() => {
            if (this.drainGeneration === gen) this.drainNextOfflineItem();
          }, 5000);
          return;
        }
        this.drainNextOfflineItem();
        return;
      }
      setTimeout(() => {
        if (this.drainGeneration === gen) this.drainNextOfflineItem();
      }, 1000);
      return;
    }
    queue.shift();
    this.offlineDrainingCurrent = item;
    if (!this.ws || this.ws.readyState !== 1) {
      this.offlineQueue.unshift(item, ...queue); // 保序
      this.offlineQueuePending = [];
      this.offlineQueueDraining = false;
      this.offlineDrainingCurrent = null;
      return;
    }
    const sent = this.safeWsSend(JSON.stringify(item.payload));
    if (!sent) {
      this.offlineQueue.unshift(item, ...queue); // 保序
      this.offlineQueuePending = [];
      this.offlineQueueDraining = false;
      this.offlineDrainingCurrent = null;
      return;
    }
    const sess = this.sessions.get(item.sessId);
    if (sess) {
      const msg = sess.messages.find((m) => m.id === item.msgId);
      if (msg) msg.status = "sent";
      sess._sendingInFlight = true;
      sess._turnStartedAt = Date.now();
      sess._pendingCostCredits = "0";
      sess._lastFinaledAssistantId = null;
      sess._lastFinaledAt = 0;
      this.resetThinkingSafety(sess.id);
    }
    this.drainTimeoutTimer = setTimeout(() => this.handleDrainTimeout(item), 120000);
    if (queue.length === 0) this.offlineQueueDraining = false;
    this.scheduleNotify();
  }
}
