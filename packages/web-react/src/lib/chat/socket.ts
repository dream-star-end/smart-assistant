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
  applyCostWaived,
  applyLegacyBridgeError,
  applyOutboundError,
  applyOutboundMessage,
  applyPermissionRequest,
  applyPermissionSettled,
  applyResumeFailed,
  applyTurnStatus,
  AUTO_CONTINUE_PROMPT,
  expireGenPlaceholdersAgainstServerRows,
  normalizeDelegateCards,
  resetAgentFrameSeqCursorsForSession,
  resetFrameSeqCursor,
  type FrameEffects,
} from "./reducer";
import {
  addMessage,
  type ChatMessage,
  type ChatRoutingSnapshot,
  type ChatSession,
  clearTurnTiming,
  createSession,
  rebuildIndexes,
  resetReplyTracker,
} from "./model";
import {
  applyServerIncremental,
  mergeArchivedHistory,
  mergeFullServerWins,
  type StoredSession,
} from "../persist";
import { appUpdate } from "../appUpdate";
import {
  AUTO_CONTINUE_DISPLAY,
  contextRebuiltNotice,
  RESTART_CONTINUE_DISPLAY,
  RESTART_CONTINUE_PROMPT,
  backoffDelay,
  type ChatStatusClass,
  classifyClose,
  COST_CHARGED_LAST_FINAL_TTL_MS,
  type EmptyTurnDecision,
  emptyTurnNoticeText,
  KEEPALIVE_INTERVAL_MS,
  LIVENESS_CONFIRM_MS,
  MAX_OFFLINE_QUEUE,
  OFFLINE_DRAIN_START_DELAY_MS,
  OFFLINE_LATCH_GRACE_MS,
  onopenSetInitialStatus,
  PROBE_TIMEOUT_KEEPALIVE_MS,
  PROBE_TIMEOUT_VISIBILITY_MS,
  RECENT_INFLIGHT_WINDOW_MS,
  RECONNECT_RECONCILE_GRACE_MS,
  SAFE_WS_BUFFER_BYTES,
  safeSessionKeyForAgent,
  shouldAutoContinueEmptyTurn,
  SYNC_DEBOUNCE_MS,
  THINKING_SAFETY_MS,
  VISIBILITY_RECONNECT_COOLDOWN_MS,
  WS_AUTH_REFRESH_MIN_GAP_MS,
  WS_CLOSE_CODE_STALLED,
} from "./pure";
import type {
  ColdStartWire,
  ContextRebuiltWire,
  CostChargedWire,
  CostWaivedWire,
  IncidentWire,
  InboundMessage,
  LegacyBridgeErrorWire,
  OutboundErrorWire,
  OutboundMessageWire,
  OutboundPermissionRequestWire,
  OutboundPermissionSettledWire,
  OutboundActiveTurnReplayStartWire,
  OutboundResumeFailedWire,
  OutboundTurnStatusWire,
  OutboundWire,
  RepoBindErrorWire,
  RepoStatusWire,
} from "./frames";
import { incidentStore } from "../incidentStore";
import { DEFAULT_CODEX_ENGINE_MODEL, isClientMessageId } from "@openclaude/protocol";

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
  syncSession?: (
    sessId: string,
    context?: { clientMessageId?: string },
  ) => Promise<void> | void;
  /**
   * 首次发消息前在主控创建 client_sessions 行（PUT /api/sessions/:id，messages:[]）。
   * v3 commercial 持久化契约：**前端 PUT 建行 + 元数据，容器 server-authored 往该行 append
   * 消息**。web-react 此前从不调 putSession → 主控无此行 → 容器回传持久化 session_not_found
   * 无界重试风暴 + cost_charged 归因/投递链路连带失效。fire-and-forget：建行是快 REST，
   * 远早于容器跑完 LLM turn 后的 authored POST；upsertClientSession 用 baseSyncedAt=0 +
   * mergePreservingServerAuthored，已存在则 rejected_stale 空操作，绝不 clobber 历史。
   * 返回**是否已确认建行**：true=PUT 200 或 409-stale（行已存在）；false=网络/5xx/401 等失败
   * （调用方据此不标 ensured、下次发送/重连重试，见 socket.ts serverSessionInflight，Codex 审 MAJOR）。
   */
  ensureServerSession?: (sessId: string, agentId: string, title?: string) => Promise<boolean> | boolean;
  /** 跨设备持久化「用户发送的消息」到 master(POST /api/sessions/:id/user-message)。
   *  带本地 client id → getSession 回带同 id,前端合并去重。best-effort。 */
  persistUserMessage?: (
    sessId: string,
    msg: { id: string; text: string; ts: number; media?: InboundMessage["content"]["media"] },
  ) => Promise<void> | void;
  /** 立即把某会话快照落 IndexedDB（resume_failed 游标推进 / isFinal turn 收尾时调）。*/
  persistSession?: (sessId: string) => void;
  /** GitHub 仓库绑定状态帧（容器→bridge→client）。由 useRepoBinding 消费（banner/pill）。*/
  onRepoStatus?: (frame: RepoStatusWire) => void;
  /** GitHub 绑定校验失败帧（bridge→client，stale / link 失效 / 内部错）。*/
  onRepoBindError?: (frame: RepoBindErrorWire) => void;
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
  /** 浏览器联网态（socket 内 latched，比裸 navigator.onLine 更权威；§5 grace）。
   *  App 三态状态条据此把「网络已断开」与「服务端重连中」区分开。*/
  browserOnline: boolean;
  sessions: Map<string, ChatSession>;
};

const WS_PATH = "/ws/user-chat-bridge";

/** Persisted pre-cutover turns must replay on the replacement Codex model. */
function normalizeRetiredRouting(
  routing: ChatRoutingSnapshot | undefined,
): ChatRoutingSnapshot | undefined {
  if (!routing || routing.model !== "gpt-5.5") return routing;
  return { ...routing, model: DEFAULT_CODEX_ENGINE_MODEL };
}

/** rAF 合并渲染的隐藏-tab 兜底间隔:rAF 在隐藏 tab 被节流到几乎不触发,用此 setTimeout
 *  保证 snapshot 仍按时刷新 + listeners 触发(避免后台积压、切前台时一致);也封顶渲染延迟。*/
const NOTIFY_FALLBACK_MS = 250;
// 流式渲染降频:turn 进行中把渲染通知从 rAF(≤60fps)夹到本间隔(~8fps)。每次通知都会
// 让活动消息全量重走 markdown 管线(remark+katex+highlight),60fps 在 10KB+ 长输出/低端机
// 上必然掉帧发热;120ms 视觉上仍是流畅"打字机"。只降"通知频率",数据仍逐帧同步应用。
const STREAM_NOTIFY_MS = 120;

export class ChatSocket {
  private deps: ChatSocketDeps;
  readonly sessions = new Map<string, ChatSession>();
  /** 已确认在主控建过行的会话 id(PUT 200 或 409-stale 才进;每会话只成功建一次)。登出清。*/
  private serverSessionEnsured = new Set<string>();
  /** 建行 PUT 在途的会话 id(防并发重复 PUT)。PUT 失败时从此移除以便下次重试(不进 ensured)。*/
  private serverSessionInflight = new Set<string>();

  // ── 订阅 / 批量 notify ──
  private listeners = new Set<() => void>();
  private version = 0;
  private notifyScheduled = false;
  /** 上次渲染通知 flush 时刻(流式降频窗口基准)。*/
  private lastNotifyAt = 0;
  /** rAF 合并渲染:scheduleNotify 排程的 rAF 句柄 + 隐藏 tab 兜底 timer(见 scheduleNotify)。*/
  private notifyRaf: number | null = null;
  private notifyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
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
  /**
   * cohort lane 就绪闸（P3 RFC D1）：与 gateReady 正交的 WS 连接前置——只有 auth 流程完成
   * lane 决策（cookie 已下发）才允许建连，防首连落错 slot 再被 cookie 纠正的抖动。
   * **默认 true**：直连 socket 的既有测试无 lane 概念，保持行为不变；生产由 useChatSocket
   * 依 useAuth.laneReady 驱动 setLaneReady（决策前置 false，达成后 true）。
   * connect 需 gateReady ∧ laneReady 双真才建连，两闸各自上升沿都尝试 connect（另一闸未就绪则
   * connect 内部 no-op），故两者到位顺序无关、无竞态。
   */
  private laneReady = true;

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
  /** 最近一次收到 pong 的时刻（连接 liveness 判定：近 45s 内有 pong = 链路确认存活）。*/
  private lastPongAt = 0;

  // ── thinking-safety（§6）──
  private thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 会话级 transient 软提示（"较长时间未收到新内容…"）。**刻意不进 s.messages、不落 IndexedDB**：
   * toStored 是显式字段白名单、从不读它 → 天然不持久化，刷新即消失，绝不与 server 恢复的真实
   * 内容同屏矛盾（旧实现把超时提示 addMessage 落库 → reload 后与真内容打架，用户报障②的一半）。
   * 渲染经 getTransientNotice 快照读回；set/clear 都 scheduleNotify 让 UI 及时更新。
   */
  private readonly transientNotices = new Map<string, { text: string; ts: number }>();

  // ── 对账（S1：切回前台 / 重连成功 → REST syncSession 追回静默丢失）──
  /** 同会话对账去抖戳（SYNC_DEBOUNCE_MS 内至多一次）。*/
  private readonly lastSyncAt = new Map<string, number>();
  /** Exact active-turn candidate sets already attempted on the current WS.
   * History can arrive after the initial shell hello; each new candidate set
   * gets one targeted registration hello, then waits for a reconnect before
   * retrying to avoid a resume_failed/sync loop. */
  private readonly activeReplayAttemptKeys = new Set<string>();
  /** 当前选中会话（App 经 setActiveSession 告知）：对账时无条件优先拉它。*/
  private activeSessionId: string | undefined;

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
  /**
   * 本连接上 direct-send(readyState===1 快路径)出去、尚未确认送达的消息(每 session 最新一条)。
   * 冷启时 bridge 先完成 WS 握手(前端 onopen)再查容器就绪,不就绪则 close(4503/provisioning);
   * 这窗口内 direct-send 的消息发给了即将被 4503 关闭的连接、relay 从未建立 → **必未送达容器**,
   * 且不在 offlineQueue 里、原 onclose re-queue 漏掉它 → 冷启首条消息丢失。onclose 若判定为
   * provisioning(4503),把这些重排回 offlineQueue 等下次连接 drain(idempotencyKey 去重,重发安全);
   * 非 provisioning 关闭(mid-turn heartbeat 等)则丢弃,由 hello/resume 续传机制处理,不重发防重复。
   * 每次 onclose 清空(连接级);同 session 再 direct-send 覆盖旧条。
   */
  private inFlightSends = new Map<string, OfflineItem>();
  /**
   * 本连接 bridge↔容器 relay 是否已确认建立(收到 sys.relay_ready 即 true)。connect/onclose 复位。
   * readiness 权威统一:冷启时 ws.onopen(握手完成)早于 relay 就绪,relay_ready 才是"可投递"的
   * 单一权威信号。收到即排空离线队列(P7.8 重排进去的冷启首条消息得以立即投递)。
   */
  private relayReady = false;

  // ── GitHub 仓库绑定待确认队列 ──
  // PUT 成功后试发 inbound.control.session_repo_bind;若 WS 未就绪/未投递,在 onopen(hello 之后)
  // 与 sys.relay_ready 时 flush 兜底。收到匹配/更新版本的 status/bind_error 帧即清。
  // unbind / removeSession / resetSessions 主动清(避免迟到 status 错配)。键=sessId。
  // 注:容器重启后 bridge 还有"自动重绑"(从 DB active selection 重发),此队列只覆盖
  // "PUT 时 WS 未就绪"与"reconnect"两场景,故省去 v3 的 30s GET 轮询。
  private pendingRepoBind = new Map<string, { agentId: string; version: number }>();

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
      browserOnline: this.isBrowserOnline,
      sessions: this.sessions,
    };
    // 版本握手 busy 探针:任一会话有在飞 turn → 软刷新推迟(governor 每 5s 重估)。
    // 在飞权威 = _sendingInFlight(团队/委派 turn 同样置位),与 hello/resume 恢复
    // loading 用的是同一字段,不另造第二真值源。
    appUpdate.registerBusyProbe(() => {
      for (const s of this.sessions.values()) if (s._sendingInFlight) return true;
      return false;
    });
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
      browserOnline: this.isBrowserOnline,
      sessions: this.sessions,
    };
  }

  /** 批量 notify：合并同 tick 的高频帧 mutation 成一次订阅回调（不每帧 setState）。*/
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    const flush = () => {
      if (!this.notifyScheduled) return; // 另一路(rAF/timer)已抢先 flush,二选一
      this.notifyScheduled = false;
      if (this.notifyRaf !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.notifyRaf);
      }
      this.notifyRaf = null;
      if (this.notifyFallbackTimer !== null) {
        clearTimeout(this.notifyFallbackTimer);
        this.notifyFallbackTimer = null;
      }
      this.version++;
      this.lastNotifyAt = Date.now();
      this.rebuildSnapshot();
      for (const cb of this.listeners) cb();
    };
    // 流式降频:turn 进行中且距上次通知不足 STREAM_NOTIFY_MS → 定时到窗口边界统一 flush
    // (跳过 rAF 路径)。完成帧最多延迟 ~120ms,可接受;非流式路径行为不变。
    // 判据必须是会话级 _sendingInFlight(turn 生命周期权威 flag,final/错误/停止都会清),
    // 不能借用 inFlightSends —— 那是"冷启窗口 direct-send 未送达"的连接级记录:turn 完成
    // 不清、drain 路径不记,拿它当 turn 信号会导致首次发送后永久降频/队列 turn 不降频。
    let turnActive = false;
    for (const s of this.sessions.values()) {
      if (s._sendingInFlight) {
        turnActive = true;
        break;
      }
    }
    if (turnActive) {
      const since = Date.now() - this.lastNotifyAt;
      if (since < STREAM_NOTIFY_MS) {
        this.notifyFallbackTimer = setTimeout(flush, STREAM_NOTIFY_MS - since);
        return;
      }
    }
    // 消费侧背压式流控:用 rAF 把"一帧内"多次状态变更(快速流式 token delta 每条 onmessage
    // 都 applyFrame+scheduleNotify)合并成**一次** re-render(≤60fps),解耦"收帧速率"与"渲染
    // 速率",避免高频流式下 React re-render storm。状态本身已在各方法里同步应用,这里只合并
    // **渲染通知**,不延迟数据。隐藏 tab 下 rAF 被浏览器节流到几乎不触发 → setTimeout 兜底,
    // 保证 snapshot 仍刷新 + listeners 触发(切回前台时状态一致)。SSR/测试(无 rAF)退回 microtask。
    if (typeof requestAnimationFrame === "function") {
      this.notifyRaf = requestAnimationFrame(flush);
      this.notifyFallbackTimer = setTimeout(flush, NOTIFY_FALLBACK_MS);
    } else if (typeof queueMicrotask === "function") {
      queueMicrotask(flush);
    } else {
      Promise.resolve().then(flush);
    }
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
    // 取消挂起的 rAF 合并渲染(避免 teardown 后再 flush + dangling timer)。
    if (this.notifyRaf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.notifyRaf);
    this.notifyRaf = null;
    if (this.notifyFallbackTimer !== null) clearTimeout(this.notifyFallbackTimer);
    this.notifyFallbackTimer = null;
    this.notifyScheduled = false;
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

  /**
   * cohort lane 就绪闸（P3 RFC D1）。gateReady 之外的第二连接前置：ready→true 且 gateReady
   * 已就绪时尝试 connect（connect 内部仍校验 gateReady，未就绪则 no-op）。
   * **lane 不就绪不主动断开**：lane 落 false 仅发生在登出/换号，此时 setGateReady(false) 已负责
   * 断开；lane 是 per-session 一次性上升沿（promote 重评只更新 cookie，不 mid-session 拉 false），
   * 无需在此重复断连逻辑。
   */
  setLaneReady(ready: boolean): void {
    const was = this.laneReady;
    this.laneReady = ready;
    if (ready && !was) this.connect();
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

  // ═══════════════ thinking-safety（§6，S3 重构）═══════════════
  //
  // 旧实现：10min 无帧 → 发 stop + clearSendingState + addMessage 一条持久"超时"消息。三重
  // 后果：① clearSendingState 关死重连 reconcile / hello inFlight / resume 补帧三条自愈路径；
  // ② 持久"超时"消息落库，刷新后与 server 恢复的真实内容同屏矛盾；③ 移动端锁屏后 WS 静默
  // 死亡、定时器解冻抢先触发，误报"本轮无响应（超时）"（用户报障②）。
  //
  // 新实现按"连接是否确认存活"分流，turn 生死交给 server 权威判定，绝不再自动 stop / 落库：
  //  (a) 连接未确认存活（锁屏静默死链）→ 不动 in-flight、不发 stop、不插消息，强制重连
  //      （重连成功后 onopen 自动走 REST 对账 S1），并重新 arm 下一轮监控；
  //  (b) 连接确认存活但 10min 无帧 → 只挂会话级 transient 软提示（不入 messages / 不落盘），
  //      继续 arm 观察。用户可继续等待或手动停止后重发。
  private resetThinkingSafety(sessId: string): void {
    const existing = this.thinkingTimers.get(sessId);
    if (existing) clearTimeout(existing);
    const tid = setTimeout(() => {
      this.thinkingTimers.delete(sessId);
      const s = this.sessions.get(sessId);
      if (!s || !s._sendingInFlight) return;
      const sinceLastFrame = Date.now() - (s._lastFrameAt || 0);
      if (s._lastFrameAt && sinceLastFrame < THINKING_SAFETY_MS) {
        this.resetThinkingSafety(sessId); // liveness 复检：窗口内有帧 → 只是慢，reschedule
        return;
      }
      // (a) 连接未确认存活 → 强制重连自愈（不误报），重新 arm。
      if (!this.isConnectionLive()) {
        this.forceReconnectForLiveness();
        this.resetThinkingSafety(sessId);
        return;
      }
      // (b) 连接活但久无帧 → 主动去抖对账服务端记录(追回 WS 静默漏掉、resume 覆盖不到的内容;
      //     若该轮其实已在服务端收尾,对账会拉回真实内容并清发送态),再挂 transient 软提示,
      //     保持 _sendingInFlight 不变、继续 arm。turn 生死仍交给 server 权威,绝不自动 stop。
      this.reconcileSession(sessId);
      this.setTransientNotice(
        sessId,
        "较长时间未收到新内容，已自动核对服务端记录；可继续等待，或停止后重新发送。",
      );
      this.resetThinkingSafety(sessId);
    }, THINKING_SAFETY_MS);
    this.thinkingTimers.set(sessId, tid);
  }

  /**
   * 连接是否"确认存活"：ws 处于 OPEN，且最近 LIVENESS_CONFIRM_MS 内收到过 pong 或任意帧。
   * 未确认存活 = 静默死链（移动端锁屏典型态：readyState 仍显 OPEN 但收发都断）。
   */
  private isConnectionLive(): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    const now = Date.now();
    if (this.lastPongAt > 0 && now - this.lastPongAt < LIVENESS_CONFIRM_MS) return true;
    for (const s of this.sessions.values()) {
      if (s._lastFrameAt && now - s._lastFrameAt < LIVENESS_CONFIRM_MS) return true;
    }
    return false;
  }

  /** 静默死链自愈：OPEN 则 close（触发 onclose→reconnect），否则直接 connect。重连成功走 S1 对账。*/
  private forceReconnectForLiveness(): void {
    const ws = this.ws;
    if (ws && ws.readyState === 1) {
      try {
        ws.close(WS_CLOSE_CODE_STALLED, "liveness reconnect");
      } catch {
        /* ignore */
      }
      return;
    }
    this.clearReconnectTimers();
    this.connect();
  }

  // ═══════════════ 上下文重建提示（context_rebuilt，热尾巴/归档）═══════════════
  /**
   * 处理 sys.context_rebuilt 帧:插入一条 client-owned 的 system 提示行(durable,持久化走既有
   * IndexedDB 通道),并设一条会话级 transient 软提示(live flash)。**幂等**:同一帧(reconnect
   * replay / 同 turn 重复)只插一条 —— 用 frameSeq/ts 派生确定性 id,已存在即跳过(id 稳定,reload
   * 后 loadStored 复原该行也能命中去重)。
   */
  private applyContextRebuilt(sess: ChatSession, frame: ContextRebuiltWire): void {
    const count =
      typeof frame.messageCount === "number" && Number.isFinite(frame.messageCount) && frame.messageCount > 0
        ? Math.floor(frame.messageCount)
        : sess.messages.length;
    // 确定性去重 id:优先 frameSeq(per-sessionKey 单调),回退 server ts,再回退时钟(极端缺省)。
    const identity =
      typeof frame.frameSeq === "number" && Number.isFinite(frame.frameSeq)
        ? `f${frame.frameSeq}`
        : typeof frame.ts === "number" && Number.isFinite(frame.ts)
          ? `t${frame.ts}`
          : `x${Date.now()}`;
    const dedupId = `sys-ctxrebuild-${sess.id}-${identity}`;
    if (sess.messages.some((m) => m.id === dedupId)) return; // 幂等:同帧只插一条
    const text = contextRebuiltNotice(count);
    addMessage(sess, "system", text, { id: dedupId, _source: "local" });
    this.setTransientNotice(sess.id, text); // 仅 turn 进行中显示的 live flash
    this.deps.persistSession?.(sess.id); // durable:落 IndexedDB
    this.scheduleNotify();
  }

  // ═══════════════ transient 软提示（会话级、非持久，S3）═══════════════
  private setTransientNotice(sessId: string, text: string): void {
    const s = this.sessions.get(sessId);
    if (!s || !s._sendingInFlight) return; // 仅在 turn 仍进行时提示
    const prev = this.transientNotices.get(sessId);
    if (prev && prev.text === text) {
      prev.ts = Date.now(); // 同文案仅刷新时间，不触发无谓重渲
      return;
    }
    this.transientNotices.set(sessId, { text, ts: Date.now() });
    this.scheduleNotify();
  }

  private clearTransientNotice(sessId: string): void {
    if (this.transientNotices.delete(sessId)) this.scheduleNotify();
  }

  /** 快照读回（useChatSocket 经 snap.version 订阅；不属于持久会话模型）。*/
  getTransientNotice(sessId: string): { text: string; ts: number } | null {
    return this.transientNotices.get(sessId) ?? null;
  }

  // ═══════════════ REST 对账（S1）═══════════════
  /** 告知当前选中会话：对账时无条件优先拉它（用户正盯着的那条）。*/
  setActiveSession(sessId: string | undefined): void {
    this.activeSessionId = sessId;
  }

  /** 对单会话触发 syncSession（去抖：同会话 SYNC_DEBOUNCE_MS 内至多一次）。*/
  private reconcileSession(sessId: string): void {
    if (!this.deps.syncSession) return;
    const now = Date.now();
    const last = this.lastSyncAt.get(sessId) || 0;
    if (now - last < SYNC_DEBOUNCE_MS) return;
    this.lastSyncAt.set(sessId, now);
    void this.deps.syncSession(sessId);
  }

  /**
   * 无条件对账"当前选中会话 + 近期有过 in-flight 的会话"（切回前台 / 重连成功后调）。
   * syncSession = REST getSession + server-wins 合并，幂等无副作用；追回锁屏/死链期间
   * WS 静默丢失、resume 覆盖不到的内容。
   */
  private reconcileVisibleAndInFlight(): void {
    const now = Date.now();
    const active = this.activeSessionId;
    if (active && this.sessions.has(active)) this.reconcileSession(active);
    for (const [id, s] of this.sessions) {
      if (id === active) continue;
      const recentInFlight =
        !!s._sendingInFlight ||
        (typeof s._turnStartedAt === "number" && s._turnStartedAt > 0 && now - s._turnStartedAt < RECENT_INFLIGHT_WINDOW_MS) ||
        (typeof s._lastFrameAt === "number" && now - s._lastFrameAt < RECENT_INFLIGHT_WINDOW_MS) ||
        (typeof s._localTeardownAt === "number" && now - s._localTeardownAt < RECENT_INFLIGHT_WINDOW_MS);
      if (recentInFlight) this.reconcileSession(id);
    }
  }

  private clearThinkingSafety(sessId: string): void {
    const t = this.thinkingTimers.get(sessId);
    if (t) {
      clearTimeout(t);
      this.thinkingTimers.delete(sessId);
    }
  }

  private clearSendingState(
    sess: ChatSession,
    opts: {
      clearTiming?: boolean;
      resetTracker?: boolean;
      clearThinking?: boolean;
      persist?: boolean;
    } = {},
  ): void {
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
    if (opts.clearTiming !== false) clearTurnTiming(sess);
    if (opts.resetTracker !== false) resetReplyTracker(sess);
    sess._localTeardownAt = typeof sess._trackerResetAt === "number" ? sess._trackerResetAt : Date.now();
    if (opts.clearThinking) this.clearThinkingSafety(sess.id);
    if (opts.persist !== false) this.deps.persistSession?.(sess.id);
    // stop / 超时 / 错误清 in-flight 后,若有生成中排队的消息 → 顺序发出。
    this.kickQueuedDrainIfIdle();
  }

  // ═══════════════ reducer effects ═══════════════
  private effects(): FrameEffects {
    return {
      onFinal: (sess, frame, isCronOrHeartbeat, clientMessageId) => {
        this.clearThinkingSafety(sess.id);
        this.clearTransientNotice(sess.id); // turn 收尾：清 transient 软提示
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
        // 生成中排队的后续消息:本轮 final 已清 _sendingInFlight → 顺序发出下一条。
        if (!isCronOrHeartbeat) this.kickQueuedDrainIfIdle();
        // turn 收尾：落地完成轮（reload 不丢；游标 + 完整 tape durable）。
        this.deps.persistSession?.(sess.id);
        // 真终态到达时 lossless tape 已完成，立即做一次精确 REST 对账，让
        // server-authored srv-* 行替换这一轮的 m-* fallback。reconcile 已在
        // forceSync 分支恰好拉一次；interrupted/cron 没有新权威 tape，均不拉。
        if (
          !isCronOrHeartbeat &&
          frame.meta?.reconcile !== "turn_completed" &&
          !frame.meta?.interrupted
        ) {
          if (clientMessageId) void this.deps.syncSession?.(sess.id, { clientMessageId });
          else void this.deps.syncSession?.(sess.id);
        }
      },
      onLiveFrame: (sess) => {
        if (sess._sendingInFlight) {
          this.resetThinkingSafety(sess.id);
          this.clearTransientNotice(sess.id); // 有新 live 帧 = 内容仍在流，清软提示
        }
      },
      scheduleAutoContinue: (sessId, targetMsgId, cls) => {
        setTimeout(() => this.autoContinueEmptyTurn(sessId, targetMsgId, cls), 0);
      },
      scheduleRestartContinue: (sessId) => {
        setTimeout(() => this.autoContinueAfterRestart(sessId), 0);
      },
      refreshBalance: () => this.deps.refreshBalance?.(),
      reportTurnError: (p) =>
        this.deps.reportClientError?.({ type: "turn_error", message: p.message, traceId: p.traceId, sessionId: p.sessionId }),
      forceSync: (sessId, context) => {
        void this.deps.syncSession?.(sessId, context);
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
    if (!this.gateReady) return; // 硬前置：容器 ready + 注水完成
    if (!this.laneReady) return; // 硬前置：cohort lane 决策达成（P3 RFC D1，防落错 slot）
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
    this.relayReady = false; // 新连接:relay 未确认,待 sys.relay_ready
    this.activeReplayAttemptKeys.clear();
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
        this.sendHelloFrame();
      } catch {
        /* ignore */
      }

      // hello 发完(peer 已注册)后补发积压的仓库绑定(reconnect 兜底,见 pendingRepoBind)。
      this.flushAllRepoBinds();

      // 4s grace 主动 reconcile（§4 + S1 无条件对账）：等 replay 先赢，再 REST 补静默丢失。
      // 恒 arm（不再仅在有 in-flight 时）——即使本次重连没有 in-flight，也要对账当前选中会话，
      // 追回锁屏/死链期间静默丢失且 resume 覆盖不到的内容（用户报障②的另一半）。
      {
        const reconnectAt = Date.now();
        const reconcileSet = this.reconnectInFlightSet ? new Set(this.reconnectInFlightSet) : new Set<string>();
        if (this.reconnectReconcileTimer) clearTimeout(this.reconnectReconcileTimer);
        this.reconnectReconcileTimer = setTimeout(() => {
          this.reconnectReconcileTimer = null;
          if (this.ws !== ws || ws.readyState !== 1) return; // 按 ws 实例校验，防旧 timer 误 reconcile 新连接
          // 断流 in-flight 会话先标 _liveStreamBroken（UI 提示），再统一走对账拉回。
          for (const sessId of reconcileSet) {
            const s = this.sessions.get(sessId);
            if (s?._sendingInFlight && (!s._lastFrameAt || s._lastFrameAt < reconnectAt)) {
              s._liveStreamBroken = true;
            }
          }
          this.reconcileVisibleAndInFlight();
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
        this.lastPongAt = Date.now(); // 连接 liveness 信号（thinking-safety 分流据此判活）
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
      this.relayReady = false; // 连接关闭:relay 失效,待下次 sys.relay_ready
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

      // 冷启 container-not-ready(4503/provisioning)关闭:relay 从未建立,本连接 direct-send 的
      // 消息必未送达容器 → 重排回 offlineQueue,reconnect 后 onopen 自动 drain(idempotencyKey
      // 去重,重发安全)。非 provisioning 关闭(mid-turn heartbeat 等)→ 丢弃,由 hello/resume
      // 续传处理,不重发防重复。inFlightSends 每次 onclose 清空(连接级)。
      if (this.inFlightSends.size > 0) {
        const lostDirect = [...this.inFlightSends.values()];
        this.inFlightSends.clear();
        if (decision.provisioning) {
          this.offlineQueue.unshift(...lostDirect);
          for (const it of lostDirect) {
            const s = this.sessions.get(it.sessId);
            if (!s) continue;
            const m = s.messages.find((mm) => mm.id === it.msgId);
            if (m && m.status === "sent") m.status = "queued";
            // 关键(Codex 审 BLOCKER):必须回退 in-flight 态,否则 drainNextOfflineItem 因
            // _sendingInFlight===true 跳过该项;冷启 4503 下 relay 未建立、无 final/resume 清此
            // flag → 重排进去的消息永久卡 queued 不 drain。把会话退回"待发"态让 drain 能真发。
            this.clearSendingState(s, { clearThinking: true });
          }
        }
      }

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
          this.deps.persistSession?.(sess.id);
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
      case "outbound.active_turn_replay_start": {
        const frame = f as OutboundActiveTurnReplayStartWire;
        const sess = frame.peer?.id ? this.sessions.get(frame.peer.id) : null;
        if (!sess || !isClientMessageId(frame.clientMessageId)) return;
        // Only this direct, server-verified boundary may move an agent-scoped
        // cursor backwards. The following replay contains exclusively frames
        // after that exact turn's server-owned baseSeq.
        resetFrameSeqCursor(sess, frame);
        sess._activeClientMessageId = frame.clientMessageId;
        sess._sendingInFlight = true;
        sess._localTeardownAt = undefined;
        sess._liveStreamBroken = false;
        this.deps.persistSession?.(sess.id);
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
        // 路由优先级(Fix B):
        //   1. frame.parentSessionId(委派成本的父**客户端**会话 web-*,= sess.id)→ 精确命中
        //      父会话,消 costTargetSession 60s 启发式在多会话并发下的误算/丢弃。
        //   2. frame.sessionId(agent 内部引擎会话 UUID,与 client peer 键失配)→ 历史字段,
        //      直接 get 今天恒空,保留以防将来口径对齐。
        //   3. costTargetSession() → 普通 chat(无 parentSessionId)的既有启发式回落。
        const sess =
          (frame.parentSessionId ? this.sessions.get(frame.parentSessionId) : undefined) ??
          (frame.sessionId ? this.sessions.get(frame.sessionId) : undefined) ??
          this.costTargetSession();
        applyCostCharged(sess, frame, this.effects());
        return;
      }
      case "outbound.cost_waived": {
        const frame = f as CostWaivedWire;
        // 同 cost_charged 的会话路由口径;免单帧到达时 turn 已结束,costTargetSession
        // 的"刚收尾"窗口(60s)通常仍能命中;都不中就退化为只刷余额。
        const sess =
          (frame.sessionId ? this.sessions.get(frame.sessionId) : undefined) ?? this.costTargetSession();
        applyCostWaived(sess, frame, this.effects());
        return;
      }
      case "sys.cold_start": {
        // 冷启帧带 peer 时按 peer 精确路由(provision 由该会话的 inbound 触发);
        // 缺省回退 firstSession(既有 v3 单会话语义,typing 文案不回退)。
        const cold = f as ColdStartWire;
        const sess = (cold.peer?.id ? this.sessions.get(cold.peer.id) : undefined) ?? this.firstSession();
        if (sess) {
          sess._isFirstTurnAfterReady = true;
          // provision 分支 = 全新容器 = outboundRing 从零计数:该会话全部 agent-scoped
          // frameSeq 游标立即归零,否则新生代帧 seq=1..旧游标 被 acceptFrameSeq 当重复帧
          // 黑洞(与 resume_failed no_buffer 同根因;此处覆盖「连接不断、容器中途回收」
          // 没有 hello 仲裁的场景,生产实证见 reducer.resetFrameSeqCursor 注释)。
          resetAgentFrameSeqCursorsForSession(sess);
          this.deps.persistSession?.(sess.id); // 游标变更立即落地(断点续传语义)
        }
        return;
      }
      case "sys.frontend_build": {
        // 版本握手(bridge 在 userWs accept 时发,服务端权威=dist/index.html 的 oc-build meta)。
        // 全部防无限刷新守卫(形态/目标一次性/冷却/安全点/storage)在 appUpdate governor
        // 内收口,这里只透传,不允许出现第二套判断。
        appUpdate.onServerBuild((f as { build?: unknown }).build);
        return;
      }
      case "sys.incident": {
        // 仅审批后的 approved_recovery resolved 帧会被 store 接受并弹一次 success toast；
        // 普通/open incident 静默丢弃，socket 层不维护任何运维横幅 UI。
        incidentStore.ingest(f as IncidentWire);
        return;
      }
      case "sys.context_rebuilt": {
        // 引擎无法原生续接、走兜底注入历史(provider 切换 / 非原生 resume)时容器 emit。
        // 插入一条 client-owned 的 system 提示行 + 会话内 transient 软提示(boss 硬指标 3)。
        const frame = f as ContextRebuiltWire;
        const sess = frame.peer?.id ? this.sessions.get(frame.peer.id) : null;
        if (sess) this.applyContextRebuilt(sess, frame);
        return;
      }
      case "sys.relay_ready": {
        // bridge↔容器 relay 真建立的**单一权威信号**(冷暖都发,见 userChatBridge containerWs open)。
        // readiness 权威统一:冷启时 WS 握手(onopen)早于 relay 就绪,期间发的消息经 P7.8 在离线
        // 队列等待;此处一收到就立即排空 → relay 一就绪即投递,不靠 4503 reconnect 反弹的运气/时延。
        this.relayReady = true;
        // relay 建立 = 本连接此前 direct-send 已送达容器("relay 从未建立=必未送达"的反命题)。
        // 清掉冷启窗口的在途记录,防后续 provisioning 关闭把已送达消息误重排(重复发送)。
        this.inFlightSends.clear();
        this.startOfflineDrainNow();
        this.flushAllRepoBinds(); // relay 就绪:补发 PUT 时 WS 未就绪而积压的仓库绑定
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
      case "outbound.control.session_repo_status": {
        const frame = f as RepoStatusWire;
        // 收到任何 status(含 pending)即代表 bind 已被容器接收 → 清待确认队列(version 匹配/更新)。
        this.maybeClearPendingRepoBind(frame.sessionId, frame.selectionVersion);
        this.deps.onRepoStatus?.(frame);
        return;
      }
      case "outbound.control.session_repo_bind_error": {
        const frame = f as RepoBindErrorWire;
        this.maybeClearPendingRepoBind(frame.sessionId, frame.selectionVersion);
        this.deps.onRepoBindError?.(frame);
        return;
      }
      default:
        // pong 已先处理；其余 v5 webchat 不消费。
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
   * (只剩钱包余额刷新)。cost_charged 经 broadcastToUser 按 uid 投递、恰在当前 turn 收尾后到,
   * 故应路由到"正在等响应"的那条会话。
   *
   * **保守归因(Codex 审 HIGH)**:多会话并发(如 A 刚 isFinal、B 仍 streaming)无法仅凭
   * "活跃"区分 cost 属于谁,盲猜会把 A 的 cost 算到 B。故只在**候选唯一**时归因;0 个或 ≥2 个
   * 候选 → 返回 null(applyCostCharged 仅刷余额、不误挂任何消息)。候选 = streaming/sending
   * 或 60s 内刚收尾的会话。单会话(canary/绝大多数实际)恒唯一,正常归因。
   *
   * 本函数只是**回落**路径:委派成本 cost_charged 已带 parentSessionId(父客户端会话),
   * caller 先按它精确路由(见 outbound.cost_charged 分支),命中就不进这里;并发多会话下的
   * 委派归因由此消除脆弱性。普通(非委派)chat 无 parentSessionId,仍走本启发式 —— 那是
   * boss 明确保留的 latent gap(durable 在刷新后兜底,见 §计费)。
   */
  private costTargetSession(): ChatSession | null {
    const now = Date.now();
    let only: ChatSession | null = null;
    let count = 0;
    for (const s of this.sessions.values()) {
      const active =
        !!s._streamingAssistant ||
        s._sendingInFlight ||
        (!!s._lastFinaledAssistantId &&
          !!s._lastFinaledAt &&
          now - s._lastFinaledAt < COST_CHARGED_LAST_FINAL_TTL_MS);
      if (active) {
        count += 1;
        only = s;
        if (count > 1) return null; // 多候选:不猜,避免跨会话误算
      }
    }
    return count === 1 ? only : null;
  }

  /**
   * 构造 hello 帧。includeInFlight：
   *  - true（onopen 默认，reconnect 语义）：带 _sendingInFlight，gateway autoResumeFromHello
   *    据此对断流 in-flight peer 推合成中断 isFinal。
   *  - false（bind 前的注册刷新）：所有 peer 强制 inFlight=false —— 纯 peer 注册副作用，
   *    绝不触发任何 synthetic 中断（对齐 v3 _buildHelloFrame includeInFlight=false）。
   */
  private activeTurnReplayCandidates(sess: ChatSession): string[] {
    const newestFirst: string[] = [];
    let oldestValid: string | undefined;
    let validCount = 0;
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const message = sess.messages[i];
      if (message?._genPlaceholder) continue;
      if (message?.role !== "user") break;
      if (!isClientMessageId(message.id)) continue;
      validCount++;
      oldestValid = message.id;
      // The lock owner is normally the oldest user in a contiguous queued
      // block. Preserve it separately, then spend the remaining bounded hint
      // budget on the newest rows for queue/drain races.
      if (newestFirst.length < 31) newestFirst.push(message.id);
    }
    if (validCount > 31 && oldestValid) return [oldestValid, ...newestFirst.reverse()];
    return newestFirst.reverse();
  }

  private composeHelloFrame(
    includeInFlight = true,
    onlySessionId?: string,
    requireFreshActiveCandidate = false,
  ): { data: string; attemptKeys: string[] } {
    const peers: Array<{
      peerId: string;
      agentId: string;
      inFlight: boolean;
      lastFrameSeq: number;
      resumeActiveTurnCandidateMessageIds?: string[];
    }> = [];
    const attemptKeys: string[] = [];
    for (const [pid, s] of this.sessions) {
      if (onlySessionId && pid !== onlySessionId) continue;
      const safeId = String(pid).replace(/[^a-zA-Z0-9_-]/g, "_");
      const emitted = new Set<string>();
      const pushPeer = (agentId: string, lastFrameSeq: number) => {
        const aid = agentId || s.agentId || this.deps.defaultAgentId || "main";
        if (emitted.has(aid)) return;
        emitted.add(aid);
        const candidates = this.activeTurnReplayCandidates(s);
        const attemptKey = candidates.length > 0 ? `${pid}:${aid}:${candidates.join(",")}` : "";
        const hasFreshCandidates = !!attemptKey && !this.activeReplayAttemptKeys.has(attemptKey);
        if (requireFreshActiveCandidate && !hasFreshCandidates) return;
        if (hasFreshCandidates) attemptKeys.push(attemptKey);
        peers.push({
          peerId: pid,
          agentId: aid,
          inFlight: includeInFlight ? !!s._sendingInFlight : false,
          lastFrameSeq: Number.isFinite(lastFrameSeq) ? lastFrameSeq : 0,
          ...(hasFreshCandidates ? { resumeActiveTurnCandidateMessageIds: candidates } : {}),
        });
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
    return { data: JSON.stringify({ type: "inbound.hello", channel: "webchat", peers }), attemptKeys };
  }

  private buildHelloFrame(includeInFlight = true, onlySessionId?: string): string {
    return this.composeHelloFrame(includeInFlight, onlySessionId).data;
  }

  private sendHelloFrame(
    includeInFlight = true,
    onlySessionId?: string,
    requireFreshActiveCandidate = false,
  ): boolean {
    const hello = this.composeHelloFrame(includeInFlight, onlySessionId, requireFreshActiveCandidate);
    if (requireFreshActiveCandidate && hello.attemptKeys.length === 0) return false;
    const sent = this.safeWsSend(hello.data);
    if (sent) for (const key of hello.attemptKeys) this.activeReplayAttemptKeys.add(key);
    return sent;
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
      // 已断/关闭 → 重连（带 cooldown 去抖）。重连成功后 onopen 会做 S1 对账。
      const now = Date.now();
      if (now - this.lastVisibilityReconnectAt < VISIBILITY_RECONNECT_COOLDOWN_MS) return;
      this.lastVisibilityReconnectAt = now;
      this.clearReconnectTimers();
      this.connect();
      return;
    }
    // 看似 OPEN：1.5s 快探活（真死链更早 close→reconnect，健康则 pong 立即返回无副作用）。
    this.probeWsAlive(this.ws, PROBE_TIMEOUT_VISIBILITY_MS, "visibility");
    // S1：切回前台无条件 REST 对账当前选中 + 近期 in-flight 会话——WS 探活只能发现死连接，
    // 追不回锁屏期间已在服务端生成的内容；对账才能拉回并覆盖本地陈旧态。
    this.reconcileVisibleAndInFlight();
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

  /** 重命名会话(纯元数据):改内存 title + notify → persist sig 变化,IndexedDB 随之落地。
   *  服务端 canonical 由调用方经 PATCH /api/sessions/:id 同步(三持有方一次收口)。*/
  renameSession(sessId: string, title: string): void {
    const s = this.sessions.get(sessId);
    if (!s || s.title === title) return;
    s.title = title;
    this.scheduleNotify();
  }

  removeSession(sessId: string): void {
    this.serverSessionEnsured.delete(sessId);
    this.serverSessionInflight.delete(sessId);
    this.inFlightSends.delete(sessId);
    this.pendingRepoBind.delete(sessId);
    this.transientNotices.delete(sessId);
    this.lastSyncAt.delete(sessId);
    for (const key of this.activeReplayAttemptKeys) {
      if (key.startsWith(`${sessId}:`)) this.activeReplayAttemptKeys.delete(key);
    }
    if (this.sessions.delete(sessId)) this.scheduleNotify();
  }

  /**
   * 清空全部内存会话（登出/换号隐私收尾，类比 P5 媒体缓存按 authKey 失效）。单例
   * service 跨登出存活，若不清，换号后旧会话残留内存。调用前 WS 应已 stop（无活跃 turn）。
   */
  resetSessions(): void {
    // Set/Map 无条件清(即使 sessions 已空也可能有残留 ensured/inflight,Codex 审 LOW)。
    this.serverSessionEnsured.clear();
    this.serverSessionInflight.clear();
    this.inFlightSends.clear();
    this.pendingRepoBind.clear();
    this.transientNotices.clear();
    this.lastSyncAt.clear();
    this.activeReplayAttemptKeys.clear();
    this.activeSessionId = undefined;
    if (this.sessions.size === 0) return;
    this.sessions.clear();
    this.scheduleNotify();
  }

  // ═══════════════ 本地持久 / 历史装载（P6）═══════════════

  /**
   * 序列化为可持久化的 StoredSession：取稳定数据 + 断点续传游标 + 近期 in-flight 标记，
   * 剥离流式指针 / Map 等瞬态（注水时由 rebuildIndexes 重建）。
   */
  toStored(sessId: string): StoredSession | null {
    const s = this.sessions.get(sessId);
    if (!s) return null;
    // 生成占位卡（需求 C）是**本地专属瞬态行**：绝不持久化（重开会话不留孤儿卡，
    // 进行中态靠 resume/回放重建，见规格 §6）。仅当存在占位行时才建新数组，否则保持原引用。
    // 同时剥离 _media 里的 localSrc：那是乐观渲染用的 blob: URL，持久化到 IndexedDB 后
    // reload 即成死链（blob 是页面生命周期内的）。剥离后重开会话的媒体回落 url 走签名管线。
    const needsLocalSrcStrip = s.messages.some((m) => m._media?.some((r) => r.localSrc));
    let messages = s.messages.some((m) => m._genPlaceholder)
      ? s.messages.filter((m) => !m._genPlaceholder)
      : s.messages;
    if (needsLocalSrcStrip) {
      messages = messages.map((m) => {
        if (!m._media?.some((r) => r.localSrc)) return m;
        return {
          ...m,
          _media: m._media.map((r) => {
            if (!r.localSrc) return r;
            const rest = { ...r };
            delete rest.localSrc;
            return rest;
          }),
        };
      });
    }
    return {
      id: s.id,
      agentId: s.agentId,
      title: s.title,
      messages,
      createdAt: s.createdAt,
      lastAt: s.lastAt,
      updatedAt: s.updatedAt,
      _lastFrameSeqByKey: s._lastFrameSeqByKey ? { ...s._lastFrameSeqByKey } : undefined,
      _lastFrameSeq: s._lastFrameSeq,
      ...(s._sendingInFlight ? { _sendingInFlight: true } : {}),
      ...(s._sendingInFlight && isClientMessageId(s._activeClientMessageId)
        ? { _activeClientMessageId: s._activeClientMessageId }
        : {}),
      ...(typeof s._turnStartedAt === "number" ? { _turnStartedAt: s._turnStartedAt } : {}),
      ...(typeof s._lastFrameAt === "number" ? { _lastFrameAt: s._lastFrameAt } : {}),
      _maxSeq: s._maxSeq,
      ...(typeof s._archivedThroughSeq === "number" ? { _archivedThroughSeq: s._archivedThroughSeq } : {}),
      ...(typeof s._archivedCount === "number" ? { _archivedCount: s._archivedCount } : {}),
      _trackerResetAt: typeof s._trackerResetAt === "number" ? s._trackerResetAt : undefined,
      _trackerResetServerTs: typeof s._trackerResetServerTs === "number" ? s._trackerResetServerTs : undefined,
      _localTeardownAt: typeof s._localTeardownAt === "number" ? s._localTeardownAt : undefined,
      _agentSwitchedAt: typeof s._agentSwitchedAt === "number" ? s._agentSwitchedAt : s._agentSwitchedAt ?? undefined,
      ...(s._lastRouting ? { _lastRouting: { ...s._lastRouting } } : {}),
    };
  }

  /**
   * 从 IndexedDB 注水会话（boot/登录读回）。**不发任何帧、不连 WS**——纯本地恢复，
   * 让 reload 不丢会话。已存在（live）则跳过：live 状态永远优先于磁盘快照。
   * 注水后清流式瞬态；仅恢复**近期** in-flight（按 _lastFrameAt 新鲜度判定,refresh 后等待
   * hello/resume 接回仍在响应的 agent），过期快照丢弃防长期卡 loading;cutoff 守卫戳
   * （tracker reset / teardown / agent 切换）一并恢复,再重建 block/agent 索引。
   */
  loadStored(stored: StoredSession): void {
    if (!stored?.id || this.sessions.has(stored.id)) return;
    const s = createSession({
      id: stored.id,
      agentId: stored.agentId || this.deps.defaultAgentId || "main",
      title: stored.title,
      createdAt: stored.createdAt,
    });
    s.messages = Array.isArray(stored.messages)
      ? stored.messages.map((message) => {
          const routing = normalizeRetiredRouting(message._routing);
          return routing !== message._routing ? { ...message, _routing: routing } : message;
        })
      : [];
    s.lastAt = typeof stored.lastAt === "number" ? stored.lastAt : s.lastAt;
    s.updatedAt = stored.updatedAt;
    s._lastFrameSeqByKey = stored._lastFrameSeqByKey ? { ...stored._lastFrameSeqByKey } : {};
    s._lastFrameSeq = stored._lastFrameSeq;
    s._maxSeq = stored._maxSeq;
    if (typeof stored._archivedThroughSeq === "number") s._archivedThroughSeq = stored._archivedThroughSeq;
    if (typeof stored._archivedCount === "number") s._archivedCount = stored._archivedCount;
    s._streamingAssistant = null;
    s._streamingThinking = null;
    const inFlightReference =
      typeof stored._lastFrameAt === "number"
        ? stored._lastFrameAt
        : typeof stored._turnStartedAt === "number"
          ? stored._turnStartedAt
          : 0;
    const inFlightFresh =
      stored._sendingInFlight === true &&
      inFlightReference > 0 &&
      Date.now() - inFlightReference < THINKING_SAFETY_MS;
    s._sendingInFlight = inFlightFresh;
    if (inFlightFresh) {
      s._activeClientMessageId = isClientMessageId(stored._activeClientMessageId)
        ? stored._activeClientMessageId
        : undefined;
      s._turnStartedAt = typeof stored._turnStartedAt === "number" ? stored._turnStartedAt : Date.now();
      s._lastFrameAt = typeof stored._lastFrameAt === "number" ? stored._lastFrameAt : undefined;
    }
    s._trackerResetAt = typeof stored._trackerResetAt === "number" ? stored._trackerResetAt : undefined;
    s._trackerResetServerTs =
      typeof stored._trackerResetServerTs === "number" ? stored._trackerResetServerTs : undefined;
    s._localTeardownAt = typeof stored._localTeardownAt === "number" ? stored._localTeardownAt : undefined;
    s._agentSwitchedAt = typeof stored._agentSwitchedAt === "number" ? stored._agentSwitchedAt : null;
    const restoredRouting = normalizeRetiredRouting(stored._lastRouting);
    s._lastRouting = restoredRouting ? { ...restoredRouting } : undefined;
    rebuildIndexes(s);
    normalizeDelegateCards(s);
    this.sessions.set(stored.id, s);
    if (inFlightFresh) this.resetThinkingSafety(stored.id);
    this.scheduleNotify();
  }

  /**
   * 合并 server canonical 历史（gateway getSession 结果）。server-wins / 按 id 幂等：
   *  - full（!isPartial）：server 整带为权威在前，仅追加本地 server 不认识的乐观尾消息。
   *  - 增量（isPartial）：在本地基础上按 id 覆盖 + 追加新增。
   * maxSeq 单调推进作下次增量游标。会话不存在则按 agentId 惰性建。
   *
   * `archive`(热尾巴):server 现可能只回 `_seq > archivedThroughSeq` 的热尾巴,full 合并须把
   * `archivedThroughSeq` 透传给 mergeFullServerWins —— 本地 `_seq ≤ 水位`的已归档行无条件保留,
   * 绝不被"server 不认识 = 丢弃"误杀(主雷)。同时记录 archivedCount/archivedThroughSeq 到会话态,
   * 供 UI 展示归档计数 + 归档分页游标兜底。
   */
  applyServerMessages(
    sessId: string,
    agentId: string,
    msgs: ChatMessage[],
    full: boolean,
    maxSeq?: number,
    archive?: {
      archivedThroughSeq?: number;
      archivedCount?: number;
      completedClientMessageId?: string;
    },
  ): void {
    const s = this.ensureSession(sessId, agentId || this.deps.defaultAgentId || "main");
    const archivedThroughSeq =
      typeof archive?.archivedThroughSeq === "number" && Number.isFinite(archive.archivedThroughSeq)
        ? archive.archivedThroughSeq
        : 0;
    s.messages = full
      ? mergeFullServerWins(
          msgs,
          s.messages,
          archivedThroughSeq,
          archive?.completedClientMessageId,
        )
      : applyServerIncremental(s.messages, msgs);
    if (archivedThroughSeq > 0) s._archivedThroughSeq = archivedThroughSeq;
    if (typeof archive?.archivedCount === "number" && Number.isFinite(archive.archivedCount)) {
      s._archivedCount = archive.archivedCount;
    }
    if (typeof maxSeq === "number" && (s._maxSeq === undefined || maxSeq > s._maxSeq)) {
      s._maxSeq = maxSeq;
    }
    s._streamingAssistant = null;
    s._streamingThinking = null;
    s._blockIdToMsgId = new Map();
    s._agentGroups = new Map();
    rebuildIndexes(s);
    normalizeDelegateCards(s);
    // 生成占位卡兜底消解:对账带回的 server 行若证明占位所属轮已在服务端收尾(锚点 user
    // 行被 echo + 存在更晚 _seq 的 server-authored assistant 行),清运行中占位——覆盖
    // 「live 终帧丢失、结果靠 REST 对账补上」的帧丢失类故障(2026-07-11 boss 生产事故)。
    expireGenPlaceholdersAgainstServerRows(s);
    this.scheduleNotify();
    // Login/reload can open WS before REST history arrives. If that initial
    // shell hello had no user-row identity it can only produce a generic
    // resume_failed. Once full history exposes trailing persisted user rows,
    // issue one targeted registration hello so the server can verify and
    // replay the exact active turn from its protected boundary.
    if (full && this.ws && this.ws.readyState === 1) {
      this.sendHelloFrame(false, sessId, true);
    }
  }

  /**
   * 归档分页并入(loadOlderHistory 拉回的更早历史)。**只前插 + 按 id 去重,绝不 server-wins 覆盖
   * 本地富卡**(归档行全是 server-authored,srv-* id 与本地 m-* 天然不撞)。无新增(全已在本地)即
   * 无副作用返回。合并后重建 block/agent 索引 + normalizeDelegateCards(与 applyServerMessages 同口径)。
   */
  prependArchivedMessages(sessId: string, msgs: ChatMessage[]): void {
    const s = this.sessions.get(sessId);
    if (!s || !Array.isArray(msgs) || msgs.length === 0) return;
    const next = mergeArchivedHistory(s.messages, msgs);
    if (next === s.messages) return; // 零新增:免无谓重渲
    s.messages = next;
    s._blockIdToMsgId = new Map();
    s._agentGroups = new Map();
    rebuildIndexes(s);
    normalizeDelegateCards(s);
    this.scheduleNotify();
  }

  /**
   * 下一页归档 getSessionArchive 的 before 游标 = 当前已加载的最老 server `_seq`(server 返回
   * `_seq < before` 的一页)。本地还没拉过归档时,最老 server 行即热尾巴首行(`_seq =
   * archivedThroughSeq+1`)→ before 落在 archivedThroughSeq+1,取到最新归档页;每前插一页,最老
   * `_seq` 下降 → 自然上翻。全无 `_seq`(纯乐观/未同步)→ 回退 archivedThroughSeq+1;都缺 → 0
   * (server 按缺省取最新页)。
   */
  archiveBeforeSeq(sessId: string): number {
    const s = this.sessions.get(sessId);
    if (!s) return 0;
    let min: number | null = null;
    for (const m of s.messages) {
      if (typeof m._seq === "number" && Number.isFinite(m._seq) && (min === null || m._seq < min)) min = m._seq;
    }
    if (min !== null) return min;
    return typeof s._archivedThroughSeq === "number" && s._archivedThroughSeq > 0 ? s._archivedThroughSeq + 1 : 0;
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
    sess._localTeardownAt = sess._trackerResetAt;
    this.clearTransientNotice(sess.id); // 切 agent = 换轮，清 transient 软提示
    this.scheduleNotify();
  }

  // ═══════════════ GitHub 仓库绑定控制帧（§repo）═══════════════

  /**
   * 发仓库绑定帧（PUT /github-selection 成功后调）。立即试发一次，并登记待确认队列；
   * 若 WS 未就绪/未投递，onopen(hello 之后) 与 sys.relay_ready 会兜底补发。帧形状严格对齐
   * v3 _buildBindFrame（peer/agentId/channel），bridge 富化 owner/repo/branch/token 后转发容器。
   */
  sendRepoBind(sessId: string, agentId: string, version: number): void {
    if (!sessId) return;
    this.pendingRepoBind.set(sessId, { agentId, version });
    // 新建会话若尚未发过消息，可能还没注册到 bridge（hello 只在 onopen 发）。bind 前先把
    // 会话登记进 this.sessions，再补发一次 registration hello（includeInFlight=false，纯注册、
    // 不触发 auto-resume 合成中断），否则 bridge 5s 后回 SESSION_NOT_REGISTERED（对齐 v3
    // bind 前 refreshWebchatHelloForCurrentSession）。reconnect 兜底仍由 onopen/relay_ready flush 覆盖。
    this.ensureSession(sessId, agentId);
    if (this.ws && this.ws.readyState === 1) this.sendHelloFrame(false);
    this.flushRepoBind(sessId);
  }

  /** 发解绑帧（DELETE /github-selection 成功后调）。先清待确认队列防迟到 status 错配。 */
  sendRepoUnbind(sessId: string, version: number): void {
    if (!sessId) return;
    this.pendingRepoBind.delete(sessId);
    this.safeWsSend(
      JSON.stringify({
        type: "inbound.control.session_repo_unbind",
        sessionId: sessId,
        selectionVersion: version,
      }),
    );
  }

  /** 试发某会话待确认的仓库绑定帧（WS 就绪才发；不就绪静默等 flush 兜底）。 */
  private flushRepoBind(sessId: string): void {
    const entry = this.pendingRepoBind.get(sessId);
    if (!entry) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    this.safeWsSend(
      JSON.stringify({
        type: "inbound.control.session_repo_bind",
        sessionId: sessId,
        selectionVersion: entry.version,
        peer: { id: sessId, kind: "dm" },
        agentId: entry.agentId,
        channel: "webchat",
      }),
    );
  }

  /** 补发所有待确认的仓库绑定（onopen / relay_ready 调）。 */
  private flushAllRepoBinds(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    for (const sessId of this.pendingRepoBind.keys()) this.flushRepoBind(sessId);
  }

  /** 收到匹配/更新版本的 status/bind_error 帧 → bind 已到容器/已被裁决,清待确认。 */
  private maybeClearPendingRepoBind(sessId: string | undefined, version: number | undefined): void {
    if (!sessId) return;
    const entry = this.pendingRepoBind.get(sessId);
    if (entry && typeof version === "number" && version >= entry.version) {
      this.pendingRepoBind.delete(sessId);
    }
  }

  // ═══════════════ 发送（inbound.message 构造 + 离线路由，§7/§10）═══════════════
  sendMessage(p: {
    sessId: string;
    agentId: string;
    text: string;
    displayText?: string;
    media?: InboundMessage["content"]["media"];
    imageEdit?: NonNullable<InboundMessage["content"]>["imageEdit"];
    model?: string;
    effortLevel?: InboundMessage["effortLevel"];
    teamMode?: boolean;
  }): void {
    const sess = this.ensureSession(p.sessId, p.agentId);
    // 主控 session 建行(每会话一次):必须在容器跑完 turn 回传 authored 消息之前落地,
    // 否则 session_not_found 风暴。ensurePromise:用于把"用户消息持久化"排在主控建行之后
    // (行须先存在,否则 append 404)。
    const ensurePromise = this.ensureServerSessionOnce(sess, p.agentId);
    // 路由字段快照:合成续写(服务重启/空轮)复用同一路由,保证桥的 codex 分类
    // (server requestId 注入/preCheck)与被中断 turn 一致。
    const routing = { model: p.model, teamMode: !!p.teamMode, effortLevel: p.effortLevel ?? null };
    sess._lastRouting = routing;
    const media = p.media && p.media.length > 0 ? p.media : undefined;
    // 出站帧 + 跨设备持久化剥离 localSrc:它是本机乐观渲染用的 blob: URL,换设备/刷新即失效,
    // 塞进 server 历史只会污染回显(死链)。乐观气泡(_media)保留 localSrc 供本机即时渲染。
    const outboundMedia = media?.map((m) => {
      if (!m.localSrc) return m;
      const rest = { ...m };
      delete rest.localSrc;
      return rest;
    });
    const payload: InboundMessage = {
      type: "inbound.message",
      idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: p.agentId,
      content: { text: p.text, ...(outboundMedia ? { media: outboundMedia } : {}), ...(p.imageEdit ? { imageEdit: p.imageEdit } : {}) },
      ...(p.effortLevel !== undefined ? { effortLevel: p.effortLevel } : {}),
      ...(p.model ? { model: p.model } : {}),
      // 团队模式(v5 轻量组队):只在开启时带上顶层 teamMode flag;后端仅 main 队长消费。
      ...(p.teamMode ? { teamMode: true } : {}),
      ts: Date.now(),
    };
    const userMsg = addMessage(sess, "user", p.displayText ?? p.text, {
      status: "sending",
      _media: media?.filter((m) => m.hidden !== true),
      // 重发走 dispatchPayload 会重新构帧,用剥离 localSrc 的版本(blob 不重发)。
      _retryMedia: p.imageEdit ? outboundMedia : undefined,
      _imageEdit: p.imageEdit,
      _modelText: p.displayText && p.displayText !== p.text ? p.text : undefined,
      _routing: { ...routing },
    });
    payload.clientMessageId = userMsg.id;
    // 生成占位卡（需求 C）：imageEdit 提交紧随乐观 user 行注入一条**本地专属**占位行
    // （role 'system' 客户端域，空文本），jobId = clientJobId。生成期间 MessageList 拦截
    // 渲染 GeneratingPlaceholderCard；本会话 turn final 由 reducer 按 jobId 消解（结果图作为
    // assistant 消息原位渲染），turn error 转 failed。**不持久化**（toStored 显式剥离）、不进
    // server 历史 → 重开会话不留孤儿卡（reducer 回放路径无此行）。
    this.ensureGenPlaceholder(sess, p.imageEdit, false, userMsg.id);
    // 跨设备持久化用户消息:行确保存在后,带本地 client id POST 给 master(getSession 回带同
    // id → 合并天然去重,不与本地乐观 user 重复)。best-effort:失败不影响发送(本地 + IndexedDB
    // 仍在);容器回传的 server-authored 助手消息走另一条链。
    {
      const sid = sess.id;
      const um = { id: userMsg.id, text: userMsg.text, ts: userMsg.ts, media: outboundMedia?.filter((m) => m.hidden !== true) };
      void ensurePromise
        .then((ok) => {
          if ((ok || this.serverSessionEnsured.has(sid)) && this.sessions.has(sid)) {
            return this.deps.persistUserMessage?.(sid, um);
          }
        })
        .catch(() => {
          /* 持久化失败:best-effort,跨设备该条不显,本地仍在 */
        });
    }
    // 生成中排队(P2 易用性):本会话仍有 in-flight turn 时,后续消息不并轨直发 —— bridge 对
    // mid-turn 并发 inbound 语义未定,且并发会重复计费。改标 queued 入本地队列,本轮 final /
    // stop / 错误清 _sendingInFlight 后由 drain 单条顺序发出(对标 ChatGPT/Claude,见
    // kickQueuedDrainIfIdle)。复用既有 offlineQueue:drainNextOfflineItem 本就"等本会话
    // _sendingInFlight 结束才发",天然具备单飞 + 保序语义,无需并行第二套队列。
    if (sess._sendingInFlight) {
      const enqueued = this.tryEnqueueOffline({ sessId: sess.id, payload, msgId: userMsg.id });
      userMsg.status = enqueued ? "queued" : "error";
      this.scheduleNotify();
      this.deps.persistSession?.(sess.id);
      return;
    }
    this.dispatchPayload(sess, userMsg, payload);
  }

  /**
   * 本会话 turn 结束(final / stop / 错误)后,若在线且尚有排队消息 → 启动一轮 drain 发出。
   * startOfflineDrainNow 自带单飞 + ws 就绪守卫(空队列 / 正在 drain 时 no-op);deferred 一个
   * macrotask,避免在 reducer 处理 final 帧的同步栈里 re-enter 发送。
   */
  private kickQueuedDrainIfIdle(): void {
    if (this.offlineQueue.length === 0) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    setTimeout(() => this.startOfflineDrainNow(), 0);
  }

  /**
   * 主控建行（每会话一次，幂等）。**只在 PUT 确认成功(返回 true)后才标 ensured**;失败则清
   * inflight、下次发送/重试重建(Codex 审 MAJOR:旧实现发送即标 ensured,PUT 失败被吞 → 永不重建)。
   * 已 ensured → resolve(true);inflight 中 → resolve(false)。sendMessage / retryMessage 共用。
   */
  private ensureServerSessionOnce(sess: ChatSession, agentId: string): Promise<boolean> {
    if (this.serverSessionEnsured.has(sess.id)) return Promise.resolve(true);
    if (this.serverSessionInflight.has(sess.id)) return Promise.resolve(false);
    this.serverSessionInflight.add(sess.id);
    const sid = sess.id;
    return Promise.resolve(this.deps.ensureServerSession?.(sid, agentId, sess.title))
      .then((ok) => {
        this.serverSessionInflight.delete(sid);
        // 仅当会话仍在(PUT pending 期间未被 remove/reset)才标 ensured,避免给已删会话留残 marker。
        if (ok && this.sessions.has(sid)) this.serverSessionEnsured.add(sid);
        return !!ok;
      })
      .catch(() => {
        this.serverSessionInflight.delete(sid);
        return false;
      });
  }

  /**
   * 把一条已构造好的 inbound.message payload 投递出去（direct-send 或离线入队）并推进 turn 态。
   * sendMessage / retryMessage 共用的**单一发送收口**：据 ws 就绪与队列情况选路，回填 userMsg
   * 状态（sent/queued/error），成功则起新 turn（计时 + 计费归因复位 + arm thinking-safety）。
   */
  /**
   * 生成占位卡（需求 C）注入/重置。imageEdit 提交/重试按 clientJobId 承载一条**本地专属**
   * 占位行（role 'system'、空文本、toStored 剥离不持久化）。
   *  - `reuse=false`（首发）：恒新注入一条运行中占位（紧随乐观 user 行）。
   *  - `reuse=true`（重试，复用同 clientJobId）：把上次失败的同 job 占位**原地重置**回 running
   *    （无则新注入，如重开后占位已被剥离）——避免重试成功后残留旧失败卡、且重试期正常显示生成中。
   * aspect = targetAspect（outpaint）或源图 width/height 比值（annotated），无则 1:1。
   */
  private ensureGenPlaceholder(
    sess: ChatSession,
    imageEdit: NonNullable<InboundMessage["content"]>["imageEdit"] | undefined,
    reuse: boolean,
    anchorUserMsgId?: string,
  ): void {
    if (!imageEdit) return;
    // aspect 优先 targetAspect（outpaint 五枚举）,否则源图 width/height 比值（annotated）。
    const aspect: number | string =
      imageEdit.targetAspect ??
      (imageEdit.width > 0 && imageEdit.height > 0 ? imageEdit.width / imageEdit.height : 1);
    const gp = {
      jobId: imageEdit.clientJobId,
      aspect,
      status: "running" as const,
      startedAt: Date.now(),
      // 兜底消解锚点(REST 对账按 server _seq 判轮已收尾,见 expireGenPlaceholdersAgainstServerRows)。
      ...(anchorUserMsgId ? { afterUserMsgId: anchorUserMsgId } : {}),
    };
    if (reuse) {
      const existing = sess.messages.find((m) => m._genPlaceholder?.jobId === imageEdit.clientJobId);
      if (existing) {
        existing._genPlaceholder = gp;
        return;
      }
    }
    addMessage(sess, "system", "", { _genPlaceholder: gp });
  }

  private dispatchPayload(sess: ChatSession, userMsg: ChatMessage, payload: InboundMessage): void {
    this.clearTransientNotice(sess.id); // 新一轮发送：清上一轮遗留的 transient 软提示
    sess._streamingAssistant = null;
    sess._streamingThinking = null;
    sess._blockIdToMsgId = new Map();
    sess._agentSwitchedAt = null;
    sess._localTeardownAt = undefined;

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
      // 记录 direct-send 在途消息:若本连接随后 4503/provisioning 关闭(relay 从未建立 = 必未送达),
      // onclose 会把它重排回 offlineQueue 重试,修复冷启首条消息丢失(见 inFlightSends 注释)。
      // **仅在 relay 未就绪的冷启窗口记录**:relay 已建立时 direct-send 即时送达,记录反而是
      // 陈旧条目 —— 此前无条件 set 且 turn 完成不清,同连接后续再遇 provisioning 关闭会把
      // 早已处理完的旧消息重排回 offlineQueue 重复发送。
      if (!this.relayReady) {
        this.inFlightSends.set(sess.id, { sessId: sess.id, payload, msgId: userMsg.id });
      }
      sess._sendingInFlight = true;
      sess._activeClientMessageId = userMsg.id;
      sess._localTeardownAt = undefined;
      sess._turnStartedAt = Date.now();
      // 新 turn 开始：清跨 turn 计费归因状态（与 drain / auto-continue turn-start 一致）。
      sess._pendingCostCredits = "0";
      sess._lastFinaledAssistantId = null;
      sess._lastFinaledAt = 0;
      this.resetThinkingSafety(sess.id);
    } else {
      const enqueued = this.tryEnqueueOffline({ sessId: sess.id, payload, msgId: userMsg.id });
      userMsg.status = enqueued ? "queued" : "error";
    }
    this.scheduleNotify();
    this.deps.persistSession?.(sess.id);
  }

  /**
   * 重试一条发送失败(status==='error')的用户消息（用户报障：发送失败仅红字、无重试）。
   * 复用原消息 payload（含附件引用 _media / 保真文本 _modelText），走既有 dispatchPayload
   * 单一发送收口**原地**重发（不新增气泡）；model/effort/teamMode 必须复用该次首发
   * 的 session routing 快照,不能被用户随后修改的偏好改变。
   */
  retryMessage(p: {
    sessId: string;
    msgId: string;
    agentId: string;
  }): void {
    const sess = this.sessions.get(p.sessId);
    if (!sess) return;
    const userMsg = sess.messages.find((m) => m.id === p.msgId && m.role === "user");
    if (!userMsg || userMsg.status !== "error") return;
    // 主控建行可能在首发失败时未确保 → 幂等补一次(best-effort,不阻塞发送)。
    const agentId = sess.agentId || p.agentId;
    void this.ensureServerSessionOnce(sess, agentId);
    const retryMedia = userMsg._retryMedia ?? userMsg._media;
    const media = retryMedia && retryMedia.length > 0 ? retryMedia : undefined;
    const text = userMsg._modelText ?? userMsg.text ?? "";
    // Historical rows written before message-level snapshots fall back to the session
    // snapshot; all new rows bind retry routing to the original user turn.
    const routing = normalizeRetiredRouting(userMsg._routing ?? sess._lastRouting);
    if (routing) {
      userMsg._routing = { ...routing };
      // Continuations belong to the retried turn, not to a later turn that last
      // overwrote the session snapshot before this retry was dispatched.
      sess._lastRouting = { ...routing };
    }
    const payload: InboundMessage = {
      type: "inbound.message",
      idempotencyKey: `web-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId,
      content: { text, ...(media ? { media } : {}), ...(userMsg._imageEdit ? { imageEdit: userMsg._imageEdit } : {}) },
      ...(routing && Object.prototype.hasOwnProperty.call(routing, "effortLevel")
        ? { effortLevel: routing.effortLevel as InboundMessage["effortLevel"] }
        : {}),
      ...(routing?.model ? { model: routing.model } : {}),
      ...(routing?.teamMode ? { teamMode: true } : {}),
      ts: Date.now(),
    };
    payload.clientMessageId = userMsg.id;
    userMsg.status = "sending"; // 立即回显；dispatchPayload 据结果改 sent/queued/error
    // 生成占位卡（需求 C）：imageEdit 重试复用同 clientJobId → 重置上次失败的占位回 running。
    this.ensureGenPlaceholder(sess, userMsg._imageEdit, true, userMsg.id);
    this.dispatchPayload(sess, userMsg, payload);
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
    this.clearSendingState(sess, { clearThinking: true });
    this.clearTransientNotice(sess.id); // 用户手动停止：清 transient 软提示
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

  // ═══════════════ 服务重启中断 → 自动续写(§7 变体)═══════════════
  //
  // 容器的模型调用经 master 内部代理,master 部署重启会掐断生成中的上游流,容器
  // 合成 meta.interrupted='service_restart' 的 isFinal。此处自动续写被截断的回复:
  //  - 仅当被打断的助手消息**已有内容**(partial 非空)且 10 分钟内 —— 空 turn 走
  //    原「请重新发送」提示,老会话的迟到中断帧不触发;
  //  - 确定性幂等键(autocont-restart-<sess>-<msgId>):双 tab/重放只执行一次,
  //    dedup ack 复用既有清理链路。
  private restartContinued = new Set<string>();
  private autoContinueAfterRestart(sessId: string): void {
    const sess = this.sessions.get(sessId);
    if (!sess || sess._sendingInFlight) return;
    if (!(this.ws && this.ws.readyState === 1)) return;
    const target = [...sess.messages]
      .reverse()
      .find((m) => m && m.role === "assistant" && !m._emptyTurn && (m.text ?? "").trim().length > 0);
    if (!target) return; // 没有被截断的内容 → 保持"请重新发送"提示
    if (typeof target.ts === "number" && Date.now() - target.ts > 10 * 60_000) return;
    const idem = `autocont-restart-${sessId}-${target.id}`;
    if (this.restartContinued.has(idem)) return;
    this.restartContinued.add(idem);
    // 复用被中断 turn 的路由字段(model/teamMode/effort):缺了它桥按默认模型分类,
    // 暖 codex 会话的续写会被 CODEX_BILLING_GUARD fail-closed 拒绝(2026-07-07 事故)。
    const routing = sess._lastRouting;
    const payload: InboundMessage = {
      type: "inbound.message",
      idempotencyKey: idem,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: sess.agentId || this.deps.defaultAgentId || "main",
      content: { text: RESTART_CONTINUE_PROMPT },
      ...(routing && Object.prototype.hasOwnProperty.call(routing, "effortLevel") ? { effortLevel: routing.effortLevel as InboundMessage["effortLevel"] } : {}),
      ...(routing?.model ? { model: routing.model } : {}),
      ...(routing?.teamMode ? { teamMode: true } : {}),
      ts: Date.now(),
    };
    const userMsg = addMessage(sess, "user", RESTART_CONTINUE_DISPLAY, {
      status: "sending",
      _isAutoRetry: true,
      _modelText: RESTART_CONTINUE_PROMPT,
      _idem: idem,
    });
    payload.clientMessageId = userMsg.id;
    const sent = this.safeWsSend(JSON.stringify(payload));
    if (!sent) {
      const ri = sess.messages.indexOf(userMsg);
      if (ri >= 0) sess.messages.splice(ri, 1);
      this.restartContinued.delete(idem);
      return;
    }
    userMsg.status = "sent";
    sess._sendingInFlight = true;
    sess._activeClientMessageId = userMsg.id;
    sess._localTeardownAt = undefined;
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
    // 同服务重启续写:复用被中断 turn 的路由字段,保证桥的 codex 分类一致。
    const routing = sess._lastRouting;
    const payload: InboundMessage = {
      type: "inbound.message",
      idempotencyKey: idem,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: sess.agentId || this.deps.defaultAgentId || "main",
      content: { text: AUTO_CONTINUE_PROMPT },
      ...(routing && Object.prototype.hasOwnProperty.call(routing, "effortLevel") ? { effortLevel: routing.effortLevel as InboundMessage["effortLevel"] } : {}),
      ...(routing?.model ? { model: routing.model } : {}),
      ...(routing?.teamMode ? { teamMode: true } : {}),
      ts: Date.now(),
    };
    const userMsg = addMessage(sess, "user", AUTO_CONTINUE_DISPLAY, {
      status: "sending",
      _isAutoRetry: true,
      _modelText: AUTO_CONTINUE_PROMPT,
      _idem: idem,
    });
    payload.clientMessageId = userMsg.id;
    const sent = this.safeWsSend(JSON.stringify(payload));
    if (!sent) {
      const ri = sess.messages.indexOf(userMsg);
      if (ri >= 0) sess.messages.splice(ri, 1);
      insertNotice();
      return;
    }
    userMsg.status = "sent";
    sess._sendingInFlight = true;
    sess._activeClientMessageId = userMsg.id;
    sess._localTeardownAt = undefined;
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
      this.clearSendingState(sess, { clearTiming: false, resetTracker: false, clearThinking: true });
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

  /**
   * 立即启动一轮离线队列 drain(由 sys.relay_ready 触发:relay 一就绪就发,不等 onopen 延迟
   * 定时器/reconnect)。与 onopen 的延迟 drain 共用单飞守卫(offlineQueueDraining /
   * offlineDrainingCurrent),不会重复 drain;队列空或未连接则 no-op。
   */
  private startOfflineDrainNow(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (this.offlineQueueDraining || this.offlineDrainingCurrent) return;
    if (this.offlineQueue.length === 0) return;
    if (this.offlineDrainTimer) {
      clearTimeout(this.offlineDrainTimer);
      this.offlineDrainTimer = null;
    }
    this.offlineQueuePending = [...this.offlineQueue];
    this.offlineQueue = [];
    this.offlineQueueDraining = true;
    this.drainGeneration++;
    this.drainNextOfflineItem();
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
      sess._activeClientMessageId = item.msgId;
      sess._localTeardownAt = undefined;
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
