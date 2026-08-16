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
import type { MessageReplyQuote } from "@openclaude/protocol";
import {
  applyCostCharged,
  applyCostWaived,
  applyCallUsage,
  applyLegacyBridgeError,
  applyOutboundError,
  applyOutboundMessage,
  applyPermissionRequest,
  applyPermissionSettled,
  applyResumeFailed,
  applyTurnStatus,
  applyTurnUsage,
  AUTO_CONTINUE_PROMPT,
  expireGenPlaceholdersAgainstServerRows,
  normalizeDelegateCards,
  normalizeGoalCards,
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
  isServerAuthoredRow,
  mintMsgId,
  rebuildIndexes,
  resetReplyTracker,
  shouldApplyGoalSnapshot,
} from "./model";
import { repairPostFinalProcessOrder } from "./order";
import {
  isDispatchLostCode,
  isDispatchTerminalRow,
} from "./render";
import {
  applyServerIncremental,
  detectServerTerminalTurns,
  mergeArchivedHistory,
  mergeFullServerWins,
  mergeTimelineHistoryPage,
  reconcileTimelineBashTailAuxiliaries,
  type ServerTurnTerminal,
  type StoredPendingDispatch,
  type StoredPendingControl,
  type StoredSession,
} from "../persist";
import { appUpdate } from "../appUpdate";
import {
  AUTO_CONTINUE_DISPLAY,
  AUTOMATIC_RECOVERY_CHECKPOINT_DISPLAY,
  AUTOMATIC_RECOVERY_REPLAY_DISPLAY,
  contextRebuiltNotice,
  INTERRUPTED_CONTINUE_DISPLAY,
  INTERRUPTED_CONTINUE_PROMPT,
  backoffDelay,
  type ChatStatusClass,
  classifyClose,
  COST_CHARGED_LAST_FINAL_TTL_MS,
  type EmptyTurnDecision,
  emptyTurnNoticeText,
  KEEPALIVE_INTERVAL_MS,
  LIVENESS_CONFIRM_MS,
  OFFLINE_LATCH_GRACE_MS,
  frameSeqKey,
  getFrameSeqCursor,
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
  TURN_STATE_UNKNOWN_SAFETY_MS,
  VISIBILITY_RECONNECT_COOLDOWN_MS,
  WS_CLOSE_CODE_STALLED,
} from "./pure";
import type {
  AckWire,
  ColdStartWire,
  ContextRebuiltWire,
  CostChargedWire,
  CostWaivedWire,
  IncidentWire,
  MediaJobWire,
  InboundMessage,
  LegacyBridgeErrorWire,
  OutboundErrorWire,
  OutboundMessageWire,
  OutboundPermissionRequestWire,
  OutboundPermissionSettledWire,
  OutboundActiveTurnReplayStartWire,
  OutboundResumeFailedWire,
  OutboundTurnStatusWire,
  OutboundTurnUsageWire,
  OutboundCallUsageWire,
  OutboundControlReceiptWire,
  OutboundWire,
  GoalSnapshotWire,
  RepoBindErrorWire,
  RepoStatusWire,
  RelayReadyWire,
} from "./frames";
import { incidentStore } from "../incidentStore";
import {
  AUTOMATIC_TURN_RETRY_MAX,
  assessTurnRecoveryTape,
  DEFAULT_CODEX_ENGINE_MODEL,
  isClientMessageId,
  normalizeTurnErrorCode,
  maxAutomaticTurnRetryAttempt,
  supportsAutomaticTurnRecovery,
  turnRecoveryAttemptIdentity,
  turnRecoveryIdentity,
} from "@openclaude/protocol";
import type { DurableLiveFrame, DurableLiveFramePage, RefreshOutcome } from "../types";

export type { ChatStatusClass };

function messageHasVisibleBody(message: ChatMessage): boolean {
  if (typeof message.text === "string" && message.text.trim().length > 0) return true;
  const blocks = (message as ChatMessage & { blocks?: unknown[] }).blocks;
  return Array.isArray(blocks) && blocks.length > 0;
}

function isLiveJournalAbort(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Successful-but-still-in-flight restore polls. A healthy live turn either
 * gets a WS `onLiveFrame` (exits immediately) or keeps a live owner (we only
 * drop the recovery chrome, not sending). 8 attempts / 45s is enough to
 * distinguish "tape already finished" from "first frames still landing"
 * without leaving the composer on Stop forever. */
export const RESTORE_RECONCILE_MAX_ATTEMPTS = 8;
export const RESTORE_RECONCILE_MAX_MS = 45_000;
/** Empty-journal poll delays: 1s → 2s → 5s → 10s cap. */
export const EMPTY_JOURNAL_POLL_DELAYS_MS = [1000, 2000, 5000, 10_000] as const;
/** Background journal rebuild bounds. 24 pages × 500 frames = 12k frames;
 * 30s wall clock covers a slow first page without silent infinite paging. */
export const LIVE_JOURNAL_MAX_PAGES = 24;
export const LIVE_JOURNAL_MAX_MS = 30_000;

export type LiveJournalObservation = {
  frameCount: number;
  liveClientMessageIds: Set<string>;
  hasTapeProjection: boolean;
  tapeProjectionVersion?: number;
  degraded?: boolean;
};

export type ChatSocketDeps = {
  /** 当前内存态 access JWT（WS 子协议鉴权用）。*/
  getToken: () => string;
  /** AuthSession epoch；与 socket 自身生命周期 epoch 双重隔离。 */
  getAuthEpoch: () => number;
  /** 1008 续期统一走 REST/boot 共用的 epoch-bound coordinator。 */
  silentRefresh: (expectedEpoch: number) => Promise<RefreshOutcome>;
  /** 仅明确 invalid 时按 expectedEpoch 幂等失效。*/
  onAuthExpired: (expectedEpoch: number) => void;
  /** 商业版余额刷新（cost_charged / 4506 / insufficient_credits）。*/
  refreshBalance?: () => void;
  /** 自动免单回执已落站内信后，立即刷新未读角标。 */
  refreshInbox?: () => void;
  /** 真 turn 失败自动上报（跳过预期业务态）。*/
  reportClientError?: (p: { type: string; code: string; traceId?: string; sessionId?: string }) => void;
  /** resume_failed / 重连 reconcile：强制 REST 全量 sync（最终权威源）。*/
  syncSession?: (
    sessId: string,
    context?: { clientMessageId?: string },
  ) => Promise<boolean | void> | boolean | void;
  /** Every successful WS open (initial or reconnect) refreshes the selected
   * and in-flight sessions from the PG GoalState REST authority. Live goal
   * broadcasts are intentionally not trusted to be a replay log. */
  syncGoalState?: (sessId: string) => Promise<void> | void;
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
  ensureServerSession?: (sessId: string, agentId: string, title?: string, modelId?: string) => Promise<boolean> | boolean;
  /** 会话级模型选择持久化到 master(PATCH /api/sessions/:id { modelId })。best-effort:
   *  建行确认后的竞态收敛补写(见 ensureServerSessionOnce)——受理路径会先于 ensure PUT
   *  幂等建行(PR#126),PUT 随体的 modelId 竞态输掉时靠本回调落地。 */
  persistSessionModel?: (sessId: string, modelId: string) => Promise<void> | void;
  /** 立即把某会话快照落 IndexedDB（resume_failed 游标推进 / isFinal turn 收尾时调）。*/
  persistSession?: (sessId: string) => void;
  /** Exact outbound journal. Production waits for one committed row before
   * the first physical WS send and exact-deletes it only after authority ACK. */
  persistPendingDispatch?: (sessId: string, item: StoredPendingDispatch) => Promise<void>;
  deletePendingDispatch?: (sessId: string, msgId: string) => Promise<void>;
  /** Exact Stop/permission control journal. The physical WS send is gated on
   * this commit and the row survives until applied/terminal authority. */
  persistPendingControl?: (item: StoredPendingControl) => Promise<void>;
  deletePendingControl?: (sessId: string, controlId: string) => Promise<void>;
  /** GitHub 仓库绑定状态帧（容器→bridge→client）。由 useRepoBinding 消费（banner/pill）。*/
  onRepoStatus?: (frame: RepoStatusWire) => void;
  /** GitHub 绑定校验失败帧（bridge→client，stale / link 失效 / 内部错）。*/
  onRepoBindError?: (frame: RepoBindErrorWire) => void;
  onMediaJob?: (frame: MediaJobWire) => void;
  defaultAgentId?: string;
};

type OfflineItem = {
  sessId: string;
  payload: InboundMessage;
  msgId: string;
  enqueuedAt: number;
  state: "queued" | "persisting" | "awaiting_admission";
};

type PendingControlItem = Omit<StoredPendingControl, "status"> & {
  status: "persisting" | "waiting_persist" | "queued" | "awaiting_receipt" | "persisted";
};

/** Stable key for one logical browser send attempt.  The normal minted
 * client id keeps the readable form; the deterministic 64-bit fallback only
 * exists for protocol-valid custom ids near the 128-byte wire limit. */
export function messageAttemptIdempotencyKey(clientMessageId: string, attempt: number): string {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  const readable = `web:${clientMessageId}:${safeAttempt}`;
  if (readable.length <= 128) return readable;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < clientMessageId.length; i++) {
    hash ^= BigInt(clientMessageId.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `webh:${hash.toString(36)}:${safeAttempt}`;
}

function stableControlId(kind: "stop" | "permission", identity: string): string {
  const readable = `control:${kind}:${identity}`;
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(readable)) return readable;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < identity.length; i++) {
    hash ^= BigInt(identity.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `control:${kind}:h${hash.toString(36)}`;
}

/** Durable browser identity for exactly one continuation of an interrupted
 * turn. Independent tabs and reloads must mint the same id so the existing
 * durable dispatch inbox, not a short client TTL, owns exactly-once admission. */
export function interruptedContinuationIdentity(
  sessionId: string,
  interruptedClientMessageId: string,
): { clientMessageId: string; idempotencyKey: string } {
  return turnRecoveryIdentity(sessionId, interruptedClientMessageId);
}

export type InterruptedContinuationTarget = {
  user: ChatMessage;
  error: ChatMessage;
  mode: "checkpoint" | "replay";
  clientMessageId: string;
  idempotencyKey: string;
  rootClientMessageId?: string;
  attempt?: number;
  max?: number;
};

function baseTurnRecoveryTarget(
  messages: ChatMessage[],
  error: ChatMessage,
  sessionId: string,
): { user: ChatMessage; error: ChatMessage; rows: ChatMessage[] } | undefined {
  const normalizedCode = normalizeTurnErrorCode(error._errorCode);
  if (!supportsAutomaticTurnRecovery(normalizedCode)) return undefined;
  if (error._source !== "server" && !error._turnTapeId) return undefined;
  const interruptedClientMessageId = error._clientMessageId;
  if (!interruptedClientMessageId) return undefined;
  const userIndex = messages.findIndex(
    (message) => message.role === "user" && message.id === interruptedClientMessageId,
  );
  if (userIndex < 0) return undefined;
  const user = messages[userIndex];
  if (!user._routing) return undefined;
  const errorIndex = messages.indexOf(error);
  if (errorIndex <= userIndex) return undefined;
  if (messages.slice(userIndex + 1).some((message) => message.role === "user")) {
    return undefined;
  }
  return { user, error, rows: messages.slice(userIndex + 1, errorIndex) };
}

function recoveryIdentityAlreadyExists(
  messages: ChatMessage[],
  identity: { clientMessageId: string; idempotencyKey: string },
): boolean {
  return messages.some((message) =>
    message.id === identity.clientMessageId || message._idem === identity.idempotencyKey);
}

/** Manual fallback for a durable interrupted turn. It stays visible when an
 * unresolved external side effect blocks automatic recovery. */
export function interruptedContinuationTarget(
  messages: ChatMessage[],
  error: ChatMessage,
  sessionId: string,
): InterruptedContinuationTarget | undefined {
  const base = baseTurnRecoveryTarget(messages, error, sessionId);
  if (!base) return undefined;
  const durableRows = base.rows.filter(
    (message) => message._source === "server" || !!message._turnTapeId,
  );
  if (assessTurnRecoveryTape(durableRows).mode !== "checkpoint") return undefined;
  const identity = interruptedContinuationIdentity(sessionId, base.user.id);
  if (recoveryIdentityAlreadyExists(messages, identity)) return undefined;
  return {
    user: base.user,
    error: base.error,
    mode: "checkpoint",
    ...identity,
  };
}

/** Automatic recovery is deliberately stricter than the manual CTA: every
 * hop rechecks exact durable rows and advances one shared 1..10 lineage. */
export function automaticTurnRecoveryTarget(
  messages: ChatMessage[],
  error: ChatMessage,
  sessionId: string,
): InterruptedContinuationTarget | undefined {
  const base = baseTurnRecoveryTarget(messages, error, sessionId);
  if (
    !base ||
    base.user._automaticRecoveryAttempted === true ||
    (base.user._source !== "server" && !base.user._turnTapeId)
  ) {
    return undefined;
  }
  const durableRows = base.rows.filter(
    (message) => message._source === "server" || !!message._turnTapeId,
  );
  const assessment = assessTurnRecoveryTape(durableRows);
  const mode = assessment.mode;
  if (!assessment.checkpointSafe) return undefined;
  if (
    mode === "replay" &&
    (base.user._userPayloadDeferred === true || !preciseRetryEligible(base.user))
  ) {
    return undefined;
  }
  const rootClientMessageId = isClientMessageId(base.user._automaticRecoveryRootClientMessageId)
    ? base.user._automaticRecoveryRootClientMessageId
    : base.user._automaticRecovery === true && isClientMessageId(base.user._recoveryOfClientMessageId)
      ? base.user._recoveryOfClientMessageId
      : base.user.id;
  if (!isClientMessageId(rootClientMessageId)) return undefined;
  const sourceAttempt = typeof base.user._automaticRecoveryAttempt === "number" &&
      Number.isSafeInteger(base.user._automaticRecoveryAttempt) &&
      base.user._automaticRecoveryAttempt >= 1
    ? base.user._automaticRecoveryAttempt
    : base.user._automaticRecovery === true
      ? 1
      : 0;
  const terminalAttempt =
    error._automaticRetryRootClientMessageId === rootClientMessageId &&
    error._automaticRetryMax === AUTOMATIC_TURN_RETRY_MAX &&
    Number.isSafeInteger(error._automaticRetryAttempt)
      ? Number(error._automaticRetryAttempt)
      : 0;
  const currentAttempt = Math.max(
    sourceAttempt,
    terminalAttempt,
    maxAutomaticTurnRetryAttempt(durableRows, rootClientMessageId),
  );
  if (currentAttempt >= AUTOMATIC_TURN_RETRY_MAX) return undefined;
  const attempt = currentAttempt + 1;
  const identity = turnRecoveryAttemptIdentity(sessionId, rootClientMessageId, attempt);
  if (recoveryIdentityAlreadyExists(messages, identity)) return undefined;
  return {
    user: base.user,
    error: base.error,
    mode,
    ...identity,
    rootClientMessageId,
    attempt,
    max: AUTOMATIC_TURN_RETRY_MAX,
  };
}

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

/**
 * 精确重试(红卡 CTA)资格判定 —— 与 `retryMessage` 实际读取的字段**严格对齐**(单一权威,
 * Codex 审计 R4)。
 *
 * `retryMessage` 复用被中断轮的 routing 与附件:routing 取 `_routing`(缺省回退
 * `sess._lastRouting`),media 取 `_retryMedia ?? _media`。精确 CTA 是"原样重发这一轮"的承诺,
 * 不允许悄悄借用**另一轮**的 `_lastRouting` 快照(会用错模型/effort 重发),也不允许在附件的
 * 重发证据已丢时静默降级成纯文本重发。故这里加两条完整性硬门:
 *   ① 该 user 行**自带** `_routing` 快照(不依赖 `_lastRouting` 回退);
 *   ② 若原消息带附件,`retryMessage` 实际读取的 media 源(`_retryMedia ?? _media`)必须仍
 *      携带服务端可解析的传输证据(`url`/`base64`)—— `localSrc` 是本机 blob,持久化即被剥离
 *      (见 `toStored`),不可跨发。
 * 任一不满足 → 精确 CTA 不显示(由红卡落回 `onRegenerate` 兜底)。**不改 `retryMessage` 既有
 * 调用方语义**:手动用户气泡「重试」(legacy 行无 `_routing` 时仍回退 `_lastRouting`)不受影响。
 */
export function preciseRetryEligible(
  msg: Pick<
    ChatMessage,
    "_routing" | "_media" | "_retryMedia" | "_userPayloadDeferred" | "_deferredRetryEligible"
  >,
): boolean {
  if (!msg._routing) return false;
  if (msg._userPayloadDeferred === true) return msg._deferredRetryEligible === true;
  const hadAttachments = (msg._media?.length ?? 0) > 0 || (msg._retryMedia?.length ?? 0) > 0;
  if (!hadAttachments) return true;
  const source = msg._retryMedia ?? msg._media;
  if (!source || source.length === 0) return false;
  return source.every(
    (r) =>
      (typeof r.url === "string" && r.url.length > 0) ||
      (typeof r.base64 === "string" && r.base64.length > 0),
  );
}

/** Reconstruct one exact user replay body. Retry and regenerate share this
 * helper so model text, bubble text, attachments and image-edit descriptors
 * cannot silently diverge. The returned data may be large and is never stored
 * back into a deferred session locator. */
export function exactUserReplayPayload(
  msg: Pick<ChatMessage, "text" | "_modelText" | "_media" | "_retryMedia" | "_imageEdit" | "_replyTo">,
): {
  text: string;
  displayText?: string;
  media?: InboundMessage["content"]["media"];
  imageEdit?: NonNullable<InboundMessage["content"]>["imageEdit"];
  replyTo?: MessageReplyQuote;
} {
  const displayText = msg.text ?? "";
  const text = msg._modelText ?? displayText;
  const sourceMedia = msg._retryMedia ?? msg._media;
  const media = sourceMedia && sourceMedia.length > 0 ? sourceMedia : undefined;
  return {
    text,
    ...(displayText !== text ? { displayText } : {}),
    ...(media ? { media } : {}),
    ...(msg._imageEdit ? { imageEdit: msg._imageEdit } : {}),
    ...(msg._replyTo ? { replyTo: msg._replyTo } : {}),
  };
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
  /** 建行 PUT 在途的会话 id→共享 Promise。发送与“先设目标”并发时必须等待同一
   * 结果，不能让后到调用者把“已有请求在途”误判成建行失败。 */
  private serverSessionInflight = new Map<string, Promise<boolean>>();
  /** One browser-side reconciliation worker per failed logical turn. The
   * deterministic recovery id remains the cross-tab/reload dedup authority. */
  private automaticRecoveryPending = new Set<string>();

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
  private wsAuthRetryTimer: ReturnType<typeof setTimeout> | null = null;
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
  private readonly reconcileAttempts = new Map<string, number>();
  private readonly reconcileInFlight = new Set<string>();
  private readonly reconcileRunTokens = new Map<string, symbol>();
  private readonly reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconcileClientMessageIds = new Map<string, string>();
  /** REST live-journal hydration is serialized per session. Stamped WS frames
   * are held until the immutable snapshot has rebuilt the process rows, then
   * released through the same frameSeq reducer so REST/WS overlap is exact. */
  private readonly durableHydrationStates = new Map<string, { buffered: OutboundWire[] }>();
  private readonly durableHydrationTails = new Map<string, Promise<void>>();
  /** Page-lifetime count of server-authoritative cursor resets. The durable
   * checkpoint consumes these epochs at a journal generation boundary so a
   * replacement-container stream already applied live is never replayed. */
  private readonly authoritativeFrameSeqResetEpochBySessionKey = new Map<string, number>();
  /** Page-lifetime journal checkpoint shared by history selection and continuous reconcile.
   * The first exact rebuild starts at zero; later reads append strictly after `cursor` and
   * never destructively reset an already-visible process transcript. */
  private readonly durableLiveJournalCheckpoints = new Map<string, {
    cursor: string;
    /** 本页生命周期内已确认服务端存在 tape 投影并补拉过全量叙事(布尔回退
     * 路径;服务端无版本水位时使用)。 */
    sawTapeProjection?: boolean;
    /** 最近一次观察到的服务端 tape 投影版本水位(tape 投影流计数)。增长 =
     * 有 turn 切到 tape,包括两次水合之间启动、断连期间完成、前后 live owner
     * 集都不含它的场景(codex 审计 blocker:一次性布尔对此是盲的)。 */
    tapeProjectionVersion?: number;
    liveClientMessageIds: Set<string>;
    /** Last journaled frameSeq for each raw wire sessionKey. Unlike the
     * reducer cursor, this follows record_id order across container
     * generations so a sequence restart can be recognized exactly once. */
    lastDurableFrameSeqBySessionKey: Map<string, {
      frameSeq: number;
      consumedAuthoritativeResetEpoch: number;
    }>;
  }>();
  /** Last successful/degraded live-frames page observation, used by the
   * restore state machine to decide exit vs 1s live cadence vs empty backoff. */
  private readonly lastLiveJournalObservation = new Map<string, LiveJournalObservation>();
  private readonly reconcileStartedAt = new Map<string, number>();
  private readonly emptyJournalBackoffIndex = new Map<string, number>();
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

  // ── durable dispatch journal / per-session FIFO ──
  offlineQueue: OfflineItem[] = [];
  /** One slot per peer. It remains occupied after admission until that exact
   * turn reaches final/error/stop, while other peers may dispatch in parallel. */
  private dispatchSlots = new Map<string, string>();
  private dispatchPumpScheduled = false;
  /**
   * 本连接 bridge↔容器 relay 是否已确认建立(收到 sys.relay_ready 即 true)。connect/onclose 复位。
   * readiness 权威统一:冷启时 ws.onopen(握手完成)早于 relay 就绪,relay_ready 才是"可投递"的
   * 单一权威信号。收到即排空离线队列(P7.8 重排进去的冷启首条消息得以立即投递)。
   */
  private relayReady = false;
  /** Per-connection negotiation. Legacy remains the default until relay_ready
   * explicitly advertises Master ownership, preventing mixed-version dual retry. */
  private masterOwnsAutomaticRecovery = false;
  private controlQueue: PendingControlItem[] = [];
  private controlPumpScheduled = false;
  private readonly controlPersistRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    appUpdate.registerBusyProbe(() =>
      this.offlineQueue.length > 0 ||
      [...this.sessions.values()].some((session) => session._sendingInFlight),
    );
  }

  // ═══════════════ 订阅 ═══════════════
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): ChatSnapshot => this.snapshot;

  /** Composer busy/stop affordance includes pre-admission journal work, while
   * TurnActivity still keys only off server-admitted `_sendingInFlight`. */
  isSessionBusy(sessId: string): boolean {
    const sess = this.sessions.get(sessId);
    return !!sess?._sendingInFlight ||
      !!sess?._stopSettlement ||
      this.offlineQueue.some((item) => item.sessId === sessId);
  }

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
    // 不能借用发送队列 —— 队列项会跨连接保留,拿它当 turn 信号会导致排队期间永久降频。
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
    this.authEpoch++;
    this.cancelWsAuthRecovery();
    // Active close bypasses the socket onclose path below (`this.ws` is
    // cleared first). Make every physically-sent but unadmitted turn replayable
    // before detaching the transport; a still-persisting turn keeps its one
    // commit attempt alive.
    this.resetUnadmittedDispatchesForReplay();
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
    // 取消挂起的 rAF 合并渲染(避免 teardown 后再 flush + dangling timer)。
    if (this.notifyRaf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.notifyRaf);
    this.notifyRaf = null;
    if (this.notifyFallbackTimer !== null) clearTimeout(this.notifyFallbackTimer);
    this.notifyFallbackTimer = null;
    this.notifyScheduled = false;
    for (const t of this.thinkingTimers.values()) clearTimeout(t);
    this.thinkingTimers.clear();
    for (const t of this.reconcileTimers.values()) clearTimeout(t);
    this.reconcileTimers.clear();
    this.reconcileInFlight.clear();
    this.reconcileRunTokens.clear();
    this.reconcileAttempts.clear();
    this.reconcileClientMessageIds.clear();
    this.reconcileStartedAt.clear();
    this.emptyJournalBackoffIndex.clear();
    this.lastLiveJournalObservation.clear();
    this.durableLiveJournalCheckpoints.clear();
    for (const t of this.controlPersistRetryTimers.values()) clearTimeout(t);
    this.controlPersistRetryTimers.clear();
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
      this.resetUnadmittedDispatchesForReplay();
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
  private resetThinkingSafety(sessId: string, delayMs: number = THINKING_SAFETY_MS): void {
    const existing = this.thinkingTimers.get(sessId);
    if (existing) clearTimeout(existing);
    const tid = setTimeout(() => {
      this.thinkingTimers.delete(sessId);
      const s = this.sessions.get(sessId);
      if (!s || !s._sendingInFlight) return;
      const sinceLastFrame = Date.now() - (s._lastFrameAt || 0);
      // liveness 复检阈值 = 本次 arm 的窗口(delayMs):默认 10min 时行为不变;turn_state_unknown
      // 缩短到 60s 时,必须用 60s 作阈值,否则「首窗 60s 内有旧帧」永远命中 <10min 而反复 reschedule
      // → 缩短彻底失效(60s 复检拉不回终态)。窗口内有新帧=turn 仍在产出 → 只是慢,reschedule。
      if (s._lastFrameAt && sinceLastFrame < delayMs) {
        this.resetThinkingSafety(sessId); // 复检通过后恢复默认 10min 窗口
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
      this.resetThinkingSafety(sessId); // 复检后恢复默认 10min 窗口(仅首窗被 turn_state_unknown 缩短)
    }, delayMs);
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
    if (
      !s ||
      (!s._sendingInFlight && !this.offlineQueue.some((item) => item.sessId === sessId))
    ) return; // admitted turn 或受理前安全发送阶段
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

  setGoalState(sessId: string, goal: ChatSession["goalState"]): void {
    const sess = this.sessions.get(sessId);
    if (!sess) return;
    if (!shouldApplyGoalSnapshot(sess.goalState, goal ?? null)) return;
    sess.goalState = goal ? structuredClone(goal) : null;
    this.scheduleNotify();
  }

  /** 对单会话触发 syncSession（去抖：同会话 SYNC_DEBOUNCE_MS 内至多一次）。*/
  private reconcileSession(sessId: string): void {
    if (!this.deps.syncSession) return;
    const sess = this.sessions.get(sessId);
    if (sess?._reconciling || sess?._liveStreamBroken) {
      this.startContinuousReconcile(sessId);
      return;
    }
    const now = Date.now();
    const last = this.lastSyncAt.get(sessId) || 0;
    if (now - last < SYNC_DEBOUNCE_MS) return;
    this.lastSyncAt.set(sessId, now);
    if (this.sessions.get(sessId)?._stopSettlement?.phase === "sync") {
      this.syncSessionAndSettleStop(sessId);
      return;
    }
    void this.deps.syncSession(sessId);
  }

  private clearContinuousReconcile(sessId: string, completed = false): void {
    const timer = this.reconcileTimers.get(sessId);
    if (timer) clearTimeout(timer);
    this.reconcileTimers.delete(sessId);
    this.reconcileInFlight.delete(sessId);
    this.reconcileRunTokens.delete(sessId);
    this.reconcileAttempts.delete(sessId);
    this.reconcileClientMessageIds.delete(sessId);
    this.reconcileStartedAt.delete(sessId);
    this.emptyJournalBackoffIndex.delete(sessId);
    const sess = this.sessions.get(sessId);
    if (!sess) return;
    sess._reconciling = false;
    sess._liveStreamBroken = false;
    if (completed && sess._recoveryStatus?.kind !== "stopping") {
      sess._recoveryStatus = { kind: "completed" };
    }
    this.deps.persistSession?.(sessId);
  }

  private scheduleContinuousReconcile(sessId: string, delay: number): void {
    if (this.reconcileTimers.has(sessId) || this.reconcileInFlight.has(sessId)) return;
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(sessId);
      this.runContinuousReconcile(sessId);
    }, delay);
    this.reconcileTimers.set(sessId, timer);
  }

  private startContinuousReconcile(
    sessId: string,
    errorCode?: string,
    context?: { clientMessageId?: string },
  ): void {
    const sess = this.sessions.get(sessId);
    if (!sess || !this.deps.syncSession) return;
    if (isClientMessageId(context?.clientMessageId)) {
      this.reconcileClientMessageIds.set(sessId, context.clientMessageId);
    }
    sess._reconciling = true;
    if (!this.reconcileStartedAt.has(sessId)) {
      this.reconcileStartedAt.set(sessId, Date.now());
    }
    if (sess._recoveryStatus?.kind !== "stopping") {
      const attempt = this.reconcileAttempts.get(sessId) ?? 0;
      sess._recoveryStatus = attempt > 0
        ? { kind: "retrying", attempt, ...(errorCode ? { errorCode } : {}) }
        : { kind: "waiting-service", ...(errorCode ? { errorCode } : {}) };
    }
    this.deps.persistSession?.(sessId);
    this.scheduleNotify();
    // The first authoritative check is immediate; only failures/backoff use a
    // timer. Besides reducing visible recovery latency, this preserves the
    // existing forceSync contract for callers that just received a replay
    // miss or authoritative reconcile marker.
    this.runContinuousReconcile(sessId);
  }

  private runContinuousReconcile(sessId: string): void {
    const sess = this.sessions.get(sessId);
    const syncSession = this.deps.syncSession;
    if (!sess?._reconciling || !syncSession || this.reconcileInFlight.has(sessId)) return;
    this.reconcileInFlight.add(sessId);
    const runToken = Symbol(sessId);
    this.reconcileRunTokens.set(sessId, runToken);
    const attempt = (this.reconcileAttempts.get(sessId) ?? 0) + 1;
    this.reconcileAttempts.set(sessId, attempt);
    if (sess._recoveryStatus?.kind !== "stopping") {
      sess._recoveryStatus = { kind: attempt === 1 ? "waiting-service" : "retrying", attempt };
      this.scheduleNotify();
    }
    const exactClientMessageId = this.reconcileClientMessageIds.get(sessId) ?? sess._activeClientMessageId;
    const context = isClientMessageId(exactClientMessageId)
      ? { clientMessageId: exactClientMessageId }
      : undefined;
    void Promise.resolve(syncSession(sessId, context)).then(
      (synced) => {
        if (this.reconcileRunTokens.get(sessId) !== runToken) return;
        this.reconcileRunTokens.delete(sessId);
        this.reconcileInFlight.delete(sessId);
        const current = this.sessions.get(sessId);
        if (!current?._reconciling) return;
        if (synced === true && this.finishRestoreIfReady(current, attempt)) {
          return;
        }
        if (synced === true && !current._sendingInFlight && !current._stopSettlement) {
          this.clearContinuousReconcile(sessId, true);
          this.scheduleNotify();
          return;
        }
        // Healthy REST: live journal stays on a 1s cadence so a broken WS does
        // not look stale. Empty journal (completed tape / no live owner) uses
        // 1s → 2s → 5s → 10s instead of a 1s death-poll. Failures still back off.
        const delay = synced === true
          ? this.nextSuccessfulReconcileDelayMs(sessId)
          : Math.min(30_000, 1000 * (2 ** Math.min(attempt - 1, 5)));
        if (current._recoveryStatus?.kind !== "stopping") {
          current._recoveryStatus = {
            kind: "retrying",
            attempt,
            ...(synced === true ? {} : { errorCode: "sync_failed" }),
          };
        }
        this.deps.persistSession?.(sessId);
        this.scheduleNotify();
        this.scheduleContinuousReconcile(sessId, delay);
      },
      () => {
        if (this.reconcileRunTokens.get(sessId) !== runToken) return;
        this.reconcileRunTokens.delete(sessId);
        this.reconcileInFlight.delete(sessId);
        const current = this.sessions.get(sessId);
        if (!current?._reconciling) return;
        if (current._recoveryStatus?.kind !== "stopping") {
          current._recoveryStatus = { kind: "retrying", attempt, errorCode: "sync_failed" };
        }
        this.scheduleNotify();
        this.scheduleContinuousReconcile(
          sessId,
          Math.min(30_000, 1000 * (2 ** Math.min(attempt - 1, 5))),
        );
      },
    );
  }

  /**
   * Test/harness hook: record the latest live-frames observation so the
   * restore loop can distinguish an active journal from an empty tape cutover.
   */
  noteLiveJournalObservation(sessId: string, observation: {
    frameCount: number;
    liveClientMessageIds: Iterable<string>;
    hasTapeProjection: boolean;
    tapeProjectionVersion?: number;
    degraded?: boolean;
  }): void {
    this.lastLiveJournalObservation.set(sessId, {
      frameCount: observation.frameCount,
      liveClientMessageIds: new Set(observation.liveClientMessageIds),
      hasTapeProjection: observation.hasTapeProjection,
      ...(observation.tapeProjectionVersion !== undefined
        ? { tapeProjectionVersion: observation.tapeProjectionVersion }
        : {}),
      ...(observation.degraded ? { degraded: true } : {}),
    });
  }

  private sessionHasVisibleTurnBody(sess: ChatSession): boolean {
    const cmid = sess._activeClientMessageId;
    return sess.messages.some((message) => {
      if (message.role !== "assistant" && message.role !== "thinking" && message.role !== "tool") {
        return false;
      }
      if (cmid && message._clientMessageId && message._clientMessageId !== cmid) return false;
      if (!isServerAuthoredRow(message)) return false;
      return messageHasVisibleBody(message);
    });
  }

  private turnAssistantIsEmpty(sess: ChatSession): boolean {
    const cmid = sess._activeClientMessageId;
    const assistants = sess.messages.filter((message) => {
      if (message.role !== "assistant") return false;
      if (cmid && message._clientMessageId && message._clientMessageId !== cmid) return false;
      return true;
    });
    if (assistants.length === 0) return true;
    return assistants.every((message) => !messageHasVisibleBody(message));
  }

  private nextSuccessfulReconcileDelayMs(sessId: string): number {
    const obs = this.lastLiveJournalObservation.get(sessId);
    const sess = this.sessions.get(sessId);
    const cmid = sess?._activeClientMessageId;
    const hasLiveOwner = !!(cmid && obs?.liveClientMessageIds.has(cmid));
    const hasFrames = (obs?.frameCount ?? 0) > 0;
    if (hasLiveOwner || hasFrames) {
      this.emptyJournalBackoffIndex.delete(sessId);
      return 1000;
    }
    const idx = this.emptyJournalBackoffIndex.get(sessId) ?? 0;
    const delay = EMPTY_JOURNAL_POLL_DELAYS_MS[Math.min(idx, EMPTY_JOURNAL_POLL_DELAYS_MS.length - 1)]!;
    this.emptyJournalBackoffIndex.set(sessId, idx + 1);
    return delay;
  }

  /**
   * Restore must have an exit. Returns true when this poll finished the loop.
   * A still-live owner only drops recovery chrome (resumed); a finished tape
   * or visible server body clears sending so the composer is usable again.
   */
  private finishRestoreIfReady(sess: ChatSession, attempt: number): boolean {
    if (sess._stopSettlement) return false;
    const decision = this.restoreExitDecision(sess, attempt);
    if (!decision) return false;
    if (decision.clearSending && sess._sendingInFlight) {
      this.clearSendingState(sess, { clearThinking: true });
    }
    if (decision.kind === "completed") {
      this.clearContinuousReconcile(sess.id, true);
    } else {
      this.clearContinuousReconcile(sess.id, false);
      if (sess._recoveryStatus?.kind !== "stopping") {
        sess._recoveryStatus = { kind: "resumed" };
      }
      this.deps.persistSession?.(sess.id);
    }
    this.scheduleNotify();
    return true;
  }

  private restoreExitDecision(
    sess: ChatSession,
    attempt: number,
  ): { clearSending: boolean; kind: "completed" | "resumed" } | null {
    const obs = this.lastLiveJournalObservation.get(sess.id);
    const cmid = sess._activeClientMessageId;
    const liveOwner = !!(cmid && obs?.liveClientMessageIds.has(cmid));
    const journalEmpty = !obs || obs.frameCount === 0;
    const hasVisible = this.sessionHasVisibleTurnBody(sess);

    // 对账成功且服务端已有可见正文,且当前 turn 已不是 live owner。
    if (hasVisible && !liveOwner) {
      return { clearSending: true, kind: "completed" };
    }
    // journal 为空且没有 live owner:streamClientMessageIds 不含当前消息,且 tape 已投影。
    if (journalEmpty && !liveOwner && obs?.hasTapeProjection === true) {
      return { clearSending: true, kind: "completed" };
    }
    const startedAt = this.reconcileStartedAt.get(sess.id) ?? Date.now();
    if (attempt >= RESTORE_RECONCILE_MAX_ATTEMPTS || Date.now() - startedAt >= RESTORE_RECONCILE_MAX_MS) {
      return { clearSending: !liveOwner, kind: liveOwner ? "resumed" : "completed" };
    }
    return null;
  }

  /**
   * Release an online Stop only after the authoritative session hydration
   * explicitly succeeds. Object identity prevents an older async hydration
   * from clearing a newer Stop on the same session.
   */
  private syncSessionAndSettleStop(
    sessId: string,
    context?: { clientMessageId?: string },
  ): void {
    const settlement = this.sessions.get(sessId)?._stopSettlement;
    if (!settlement || settlement.phase !== "sync") {
      void this.deps.syncSession?.(sessId, context);
      return;
    }
    const syncSession = this.deps.syncSession;
    if (!syncSession) return;
    void Promise.resolve(syncSession(sessId, context)).then(
      (synced) => {
        const sess = this.sessions.get(sessId);
        if (synced !== true || sess?._stopSettlement !== settlement) return;
        sess._stopSettlement = undefined;
        this.deps.persistSession?.(sessId);
        this.scheduleNotify();
      },
      () => {
        // Keep the settlement busy. Foreground/reconnect reconciliation retries.
      },
    );
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

  /** A closed transport cannot deliver the admission ACK. Requeue only turns
   * that were physically sent; a `persisting` turn retains its single commit
   * attempt and will decide against whichever connection is current when it
   * settles. */
  private resetUnadmittedDispatchesForReplay(): void {
    const touched = new Set<string>();
    for (const item of this.offlineQueue) {
      if (item.state !== "awaiting_admission") continue;
      item.state = "queued";
      touched.add(item.sessId);
      const sess = this.sessions.get(item.sessId);
      const message = sess?.messages.find(
        (candidate) => candidate.role === "user" && candidate.id === item.msgId,
      );
      if (message) message.status = "queued";
      if (sess?._activeClientMessageId === item.msgId) {
        sess._sendingInFlight = false;
        sess._activeClientMessageId = undefined;
        clearTurnTiming(sess);
        this.clearThinkingSafety(sess.id);
      }
    }
    if (touched.size === 0) return;
    for (const sessId of touched) this.deps.persistSession?.(sessId);
    this.scheduleNotify();
  }

  private maybePromoteToConnected(): void {
    if (!this.ws || this.ws.readyState !== 1 || !this.relayReady) return;
    if (this.offlineQueue.length > 0) return;
    this.setStatus("已连接", "connected");
  }

  /** Remove one exact unacknowledged journal entry. The server's admission
   * ACK or any exact authoritative outbound frame is the only normal path
   * that may clear it before turn terminal. */
  private clearPendingDispatch(sessId: string, clientMessageId: string): boolean {
    const index = this.offlineQueue.findIndex(
      (item) => item.sessId === sessId && item.msgId === clientMessageId,
    );
    if (index < 0) return false;
    this.offlineQueue.splice(index, 1);
    this.maybePromoteToConnected();
    const durableClear = this.deps.deletePendingDispatch?.(sessId, clientMessageId);
    if (durableClear) void durableClear.catch(() => {});
    this.deps.persistSession?.(sessId);
    return true;
  }

  /** Durable admission confirms delivery but does not finish the turn. Keep
   * the peer slot occupied until final/error/stop so later prompts remain FIFO. */
  private confirmDispatchAdmission(sessId: string, clientMessageId: string): boolean {
    const sess = this.sessions.get(sessId);
    if (!sess) return false;
    const pending = this.offlineQueue.find(
      (item) => item.sessId === sessId && item.msgId === clientMessageId,
    );
    const ownsTurn = sess._activeClientMessageId === clientMessageId || pending !== undefined;
    if (!ownsTurn) return false;
    // Stop keeps the exact correlation id in memory while waiting for terminal
    // authority. A late admission ACK must not revive sending or remove the
    // local teardown fence during that settlement window.
    if (sess._stopSettlement?.clientMessageId === clientMessageId) return true;
    this.clearPendingDispatch(sessId, clientMessageId);
    this.dispatchSlots.set(sessId, clientMessageId);
    const user = sess.messages.find((message) => message.role === "user" && message.id === clientMessageId);
    if (user) user.status = "sent";
    if (!sess._sendingInFlight) {
      this.clearTransientNotice(sess.id);
      sess._streamingAssistant = null;
      sess._streamingThinking = null;
      sess._blockIdToMsgId = new Map();
      sess._agentSwitchedAt = null;
      sess._localTeardownAt = undefined;
      sess._sendingInFlight = true;
      sess._activeClientMessageId = clientMessageId;
      // New authoritative root-turn boundary. cost_charged itself has no
      // frameSeq, so reminder accounting uses its stable requestId set.
      sess._turnCostCredits = "0";
      sess._turnCostSeenRequestIds = new Set();
      sess._turnCostReminderCredits = undefined;
      sess._activeAgentId =
        typeof pending?.payload.agentId === "string" && pending.payload.agentId
          ? pending.payload.agentId
          : sess.agentId;
      sess._turnStartedAt = Date.now();
      sess._pendingCostCredits = "0";
      sess._lastFinaledAssistantId = null;
      sess._lastFinaledAt = 0;
      this.resetThinkingSafety(sessId);
    }
    this.scheduleNotify();
    return true;
  }

  /** Exact turn terminal: discard any stale unacknowledged replay, release the
   * peer slot, and immediately make the next same-session FIFO item eligible. */
  private finishDispatch(sessId: string, clientMessageId: string | undefined): void {
    if (!clientMessageId) return;
    this.clearPendingDispatch(sessId, clientMessageId);
    if (this.dispatchSlots.get(sessId) === clientMessageId) this.dispatchSlots.delete(sessId);
    this.kickDispatchPump();
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
    sess._activeAgentId = undefined;
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
        const settlement = sess._stopSettlement;
        if (
          !isCronOrHeartbeat &&
          settlement &&
          (
            !settlement.clientMessageId ||
            (frame.clientMessageId ?? clientMessageId) === settlement.clientMessageId
          )
        ) {
          if (settlement.controlId) {
            this.settleControl(settlement.controlId, "terminal");
          } else {
            sess._stopSettlement = {
              ...(settlement.clientMessageId
                ? { clientMessageId: settlement.clientMessageId }
                : {}),
              phase: "sync",
            };
          }
        }
        if (this.reconnectInFlightSet) {
          this.reconnectInFlightSet.delete(sess.id);
          if (this.reconnectInFlightSet.size === 0 && this.reconnectInFlightTimer) {
            clearTimeout(this.reconnectInFlightTimer);
            this.reconnectInFlightTimer = null;
            this.reconnectInFlightSet = null;
          }
        }
        if (!isCronOrHeartbeat) this.finishDispatch(sess.id, clientMessageId);
        // 生成中排队的后续消息:本轮 final 已清 _sendingInFlight → 顺序发出下一条。
        if (!isCronOrHeartbeat) this.kickQueuedDrainIfIdle();
        // turn 收尾：落地完成轮（reload 不丢；游标 + 完整 tape durable）。
        this.deps.persistSession?.(sess.id);
        // 真终态到达时 lossless tape 已完成，立即做一次精确 REST 对账，让
        // server-authored srv-* 行替换这一轮的 m-* fallback。reconcile 已在
        // forceSync 分支恰好拉一次；interrupted/cron 没有新权威 tape，均不拉。
        if (
          // REST journal replay is already inside the authoritative sync.
          // Re-entering it from its persisted final creates a self-sustaining hydration loop.
          !this.durableHydrationStates.has(sess.id) &&
          !isCronOrHeartbeat &&
          frame.meta?.reconcile !== "turn_completed" &&
          frame.meta?.reconcile !== "interrupted" &&
          (sess._stopSettlement?.phase === "sync" || !frame.meta?.interrupted)
        ) {
          const context = clientMessageId ? { clientMessageId } : undefined;
          if (sess._stopSettlement?.phase === "sync") {
            this.syncSessionAndSettleStop(sess.id, context);
          } else {
            void this.deps.syncSession?.(sess.id, context);
          }
        }
      },
      onLiveFrame: (sess) => {
        if (sess._reconciling) {
          this.clearContinuousReconcile(sess.id);
          if (sess._recoveryStatus?.kind !== "stopping") {
            sess._recoveryStatus = { kind: "resumed" };
          }
        }
        if (sess._sendingInFlight) {
          this.resetThinkingSafety(sess.id);
          this.clearTransientNotice(sess.id); // 有新 live 帧 = 内容仍在流，清软提示
        }
      },
      scheduleAutoContinue: (sessId, targetMsgId, cls) => {
        setTimeout(() => this.autoContinueEmptyTurn(sessId, targetMsgId, cls), 0);
      },
      scheduleAutomaticRecovery: (sessId, clientMessageId) => {
        if (!this.masterOwnsAutomaticRecovery) {
          setTimeout(() => void this.autoRecoverTerminalTurn(sessId, clientMessageId), 0);
        }
      },
      refreshBalance: () => this.deps.refreshBalance?.(),
      reportTurnError: (p) =>
        this.deps.reportClientError?.({ type: "turn_error", code: p.code, traceId: p.traceId, sessionId: p.sessionId }),
      forceSync: (sessId, context) => {
        if (this.sessions.get(sessId)?._stopSettlement?.phase === "sync") {
          this.syncSessionAndSettleStop(sessId, context);
        } else {
          this.startContinuousReconcile(sessId, undefined, context);
        }
      },
      onTurnStateUnknown: (sessId) => {
        // 在飞 turn 终态未知:把 thinking-safety 首窗降至 60s(仍不清发送态),尽快 REST 复检。
        const s = this.sessions.get(sessId);
        if (s?._sendingInFlight) this.resetThinkingSafety(sessId, TURN_STATE_UNKNOWN_SAFETY_MS);
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
    this.masterOwnsAutomaticRecovery = false;
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

      // sys.goal_snapshot is a low-latency live path, not a durable replay
      // ring. Close the disconnect window on every successful socket open by
      // re-reading PG for the selected and any in-flight sessions. The hook's
      // monotonic merge rejects a slower REST response if a newer WS snapshot
      // wins the race.
      const goalRefreshSessions = new Set<string>();
      if (this.activeSessionId) goalRefreshSessions.add(this.activeSessionId);
      for (const sessId of this.reconnectInFlightSet ?? []) goalRefreshSessions.add(sessId);
      for (const sessId of goalRefreshSessions) {
        try {
          void Promise.resolve(this.deps.syncGoalState?.(sessId)).catch(() => {
            /* retain the last monotonic snapshot; next open/selection retries */
          });
        } catch {
          /* synchronous test/adapter failure follows the same retry policy */
        }
      }

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
      if (this.bufferStampedFrameDuringDurableHydration(f)) return;
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
      this.masterOwnsAutomaticRecovery = false;
      this.resetControlsForReplay();
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
      this.resetUnadmittedDispatchesForReplay();

      const decision = classifyClose(e.code, e.reason);
      for (const sessId of new Set(this.offlineQueue.map((item) => item.sessId))) {
        this.deps.persistSession?.(sessId);
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
        if (this.deps.getToken()) this.startWsAuthRecovery();
        else this.tearDownAuth(this.deps.getAuthEpoch());
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
        if (frame.clientMessageId) this.confirmDispatchAdmission(sess.id, frame.clientMessageId);
        applyOutboundMessage(sess, frame, this.effects());
        return;
      }
      case "outbound.turn_status": {
        const frame = f as OutboundTurnStatusWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) {
          const clientMessageId = (frame as OutboundTurnStatusWire & { clientMessageId?: string }).clientMessageId;
          if (clientMessageId) this.confirmDispatchAdmission(sess.id, clientMessageId);
          applyTurnStatus(sess, frame);
        }
        return;
      }
      case "outbound.turn_usage": {
        const frame = f as OutboundTurnUsageWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) {
          this.confirmDispatchAdmission(sess.id, frame.clientMessageId);
          applyTurnUsage(sess, frame);
        }
        return;
      }
      case "outbound.call_usage": {
        const frame = f as OutboundCallUsageWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) {
          this.confirmDispatchAdmission(sess.id, frame.clientMessageId);
          applyCallUsage(sess, frame);
        }
        return;
      }
      case "outbound.error": {
        const frame = f as OutboundErrorWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) {
          const activeClientMessageId = sess._activeClientMessageId;
          const ownsActiveTurn = !frame.clientMessageId ||
            activeClientMessageId === frame.clientMessageId;
          applyOutboundError(sess, frame, this.effects());
          this.finishDispatch(sess.id, frame.clientMessageId ?? (ownsActiveTurn ? activeClientMessageId : undefined));
          if (ownsActiveTurn) this.clearThinkingSafety(sess.id);
        }
        return;
      }
      case "error": {
        const frame = f as LegacyBridgeErrorWire;
        const sess = frame.peer?.id ? this.sessions.get(frame.peer.id) : this.firstSession();
        if (sess) {
          const activeClientMessageId = sess._activeClientMessageId;
          const ownsActiveTurn = !frame.clientMessageId ||
            activeClientMessageId === frame.clientMessageId;
          applyLegacyBridgeError(sess, frame, this.effects());
          this.finishDispatch(sess.id, frame.clientMessageId ?? (ownsActiveTurn ? activeClientMessageId : undefined));
          if (ownsActiveTurn) this.clearThinkingSafety(sess.id);
          this.deps.persistSession?.(sess.id);
        }
        return;
      }
      case "outbound.permission_request": {
        const frame = f as OutboundPermissionRequestWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) {
          applyPermissionRequest(sess, frame);
          sess._recoveryStatus = { kind: "needs-confirmation" };
          this.deps.persistSession?.(sess.id);
        }
        return;
      }
      case "outbound.permission_settled": {
        const frame = f as OutboundPermissionSettledWire;
        const sess = this.sessions.get(frame.peer?.id);
        if (sess) {
          applyPermissionSettled(sess, frame);
          const pending = this.controlQueue.find(
            (item) => item.controlKind === "permission" && item.requestId === frame.requestId,
          );
          if (pending) this.settleControl(pending.controlId, "terminal");
          else sess._recoveryStatus = { kind: "resumed" };
          this.deps.persistSession?.(sess.id);
        }
        return;
      }
      case "outbound.active_turn_replay_start": {
        const frame = f as OutboundActiveTurnReplayStartWire;
        const sess = frame.peer?.id ? this.sessions.get(frame.peer.id) : null;
        if (!sess || !isClientMessageId(frame.clientMessageId)) return;
        // A reconnect hello can race an exact user Stop while the gateway is
        // still settling that turn. Never let its already-in-flight replay
        // acknowledgement revoke the browser-owned cancellation fence.
        if (sess._cancelledAutomaticRecoveryIds?.[frame.clientMessageId] === true) return;
        // Only this direct, server-verified boundary may move an agent-scoped
        // cursor backwards. The following replay contains exclusively frames
        // after that exact turn's server-owned baseSeq.
        this.noteAuthoritativeFrameSeqReset(sess, frame);
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
        if (sess) {
          if (frame.to === 0 && frame.reason === "no_buffer") {
            this.noteAuthoritativeFrameSeqReset(sess, frame);
          }
          applyResumeFailed(sess, frame, this.effects());
        }
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
        this.deps.refreshInbox?.();
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
          this.noteAuthoritativeAgentFrameSeqResets(sess);
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
      case "sys.media_job": {
        this.deps.onMediaJob?.(f as MediaJobWire);
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
      case "sys.goal_snapshot": {
        const frame = f as GoalSnapshotWire;
        this.setGoalState(frame.goal.sessionId, frame.goal);
        return;
      }
      case "sys.relay_ready": {
        // bridge↔容器 relay 真建立的**单一权威信号**(冷暖都发,见 userChatBridge containerWs open)。
        // readiness 权威统一:冷启时 WS 握手(onopen)早于 relay 就绪,期间发的消息经 P7.8 在离线
        // 队列等待;此处一收到就立即排空 → relay 一就绪即投递,不靠 4503 reconnect 反弹的运气/时延。
        const relay = f as RelayReadyWire;
        this.masterOwnsAutomaticRecovery = relay.automaticRecoveryOwner === "master-v1";
        this.relayReady = true;
        this.kickDispatchPump();
        this.kickControlPump();
        this.maybePromoteToConnected();
        this.flushAllRepoBinds(); // relay 就绪:补发 PUT 时 WS 未就绪而积压的仓库绑定
        return;
      }
      case "outbound.ack": {
        const frame = f as AckWire;
        if (frame.recoverySkipped) {
          this.reconcileSkippedRecovery(frame);
          return;
        }
        if (frame.admitted && frame.peer?.id && frame.clientMessageId) {
          this.confirmDispatchAdmission(frame.peer.id, frame.clientMessageId);
        }
        if (frame.deduplicated) {
          const reconciled = this.reconcileDeduplicatedTurn(frame);
          if (!reconciled && typeof frame.idempotencyKey === "string" && frame.idempotencyKey.startsWith("autocont-")) {
            // Rolling compatibility with an old gateway ACK that did not yet
            // carry peer/clientMessageId.
            this.clearAutoContinueInFlight(frame.idempotencyKey);
          }
        }
        return;
      }
      case "outbound.control.receipt": {
        this.applyControlReceipt(f as OutboundControlReceiptWire);
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

  private bufferStampedFrameDuringDurableHydration(f: OutboundWire): boolean {
    const frame = f as OutboundWire & {
      peer?: { id?: unknown };
      sessionKey?: unknown;
      frameSeq?: unknown;
    };
    const sessId = frame.peer && typeof frame.peer === "object" &&
      typeof frame.peer.id === "string"
      ? frame.peer.id
      : null;
    if (
      sessId === null ||
      typeof frame.sessionKey !== "string" ||
      typeof frame.frameSeq !== "number" ||
      !Number.isSafeInteger(frame.frameSeq) ||
      frame.frameSeq <= 0
    ) return false;
    const state = this.durableHydrationStates.get(sessId);
    if (!state) return false;
    state.buffered.push(f);
    return true;
  }

  private noteAuthoritativeFrameSeqReset(
    sess: ChatSession,
    frame: { sessionKey?: string },
  ): void {
    const key = frameSeqKey(frame, sess.id);
    this.authoritativeFrameSeqResetEpochBySessionKey.set(
      key,
      (this.authoritativeFrameSeqResetEpochBySessionKey.get(key) ?? 0) + 1,
    );
  }

  private noteAuthoritativeAgentFrameSeqResets(sess: ChatSession): void {
    const byKey = sess._lastFrameSeqByKey;
    if (!byKey || typeof byKey !== "object") return;
    const safeId = String(sess.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const suffix = `:webchat:dm:${safeId}`;
    for (const key of Object.keys(byKey)) {
      if (key.startsWith("agent:") && key.endsWith(suffix)) {
        this.noteAuthoritativeFrameSeqReset(sess, { sessionKey: key });
      }
    }
  }

  /** Reconcile a server-confirmed duplicate without touching another queued
   * or newer turn on the same peer. Returns false for legacy/unscoped ACKs. */
  private reconcileDeduplicatedTurn(frame: AckWire): boolean {
    const sessId = frame.peer?.id;
    const clientMessageId = frame.clientMessageId;
    if (!sessId || !clientMessageId) return false;
    const sess = this.sessions.get(sessId);
    if (!sess) return false;
    const owns = sess._activeClientMessageId === clientMessageId || this.offlineQueue.some(
      (item) => item.sessId === sessId && item.msgId === clientMessageId,
    );
    if (!owns) return false;

    this.finishDispatch(sessId, clientMessageId);
    this.clearSendingState(sess, { clearThinking: true });
    const user = sess.messages.find((m) => m.role === "user" && m.id === clientMessageId);
    if (user) user.status = "sent";
    void this.deps.syncSession?.(sessId, { clientMessageId });
    this.scheduleNotify();
    return true;
  }

  /** Atomic master lineage rejection: remove only the deterministic recovery
   * child. The original user/process/error tape remains untouched and visible. */
  private reconcileSkippedRecovery(frame: AckWire): boolean {
    const sessId = frame.peer?.id;
    const clientMessageId = frame.clientMessageId;
    if (!sessId || !clientMessageId) return false;
    const sess = this.sessions.get(sessId);
    if (!sess) return false;
    const sourceClientMessageId = isClientMessageId(frame.sourceClientMessageId)
      ? frame.sourceClientMessageId
      : undefined;
    if (sourceClientMessageId) {
      sess._automaticRecoveryDecisions = {
        ...(sess._automaticRecoveryDecisions ?? {}),
        [sourceClientMessageId]: true,
      };
    }
    const userIndex = sess.messages.findIndex((message) =>
      message.role === "user" &&
      message.id === clientMessageId &&
      message._isAutoRetry === true &&
      !!message._recoveryOfClientMessageId);
    if (userIndex < 0) {
      this.deps.persistSession?.(sessId);
      return sourceClientMessageId !== undefined;
    }
    this.finishDispatch(sessId, clientMessageId);
    if (sess._activeClientMessageId === clientMessageId) {
      this.clearSendingState(sess, { clearThinking: true, persist: false });
    }
    sess.messages = sess.messages.filter((message, index) =>
      index !== userIndex &&
      message._genPlaceholder?.afterUserMsgId !== clientMessageId);
    this.deps.persistSession?.(sessId);
    this.scheduleNotify();
    return true;
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
      if (sess._cancelledAutomaticRecoveryIds?.[message.id] === true) continue;
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
      inFlightClientMessageId?: string;
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
        const emitInFlight = includeInFlight && !!s._sendingInFlight;
        peers.push({
          peerId: pid,
          agentId: aid,
          inFlight: emitInFlight,
          lastFrameSeq: Number.isFinite(lastFrameSeq) ? lastFrameSeq : 0,
          ...(hasFreshCandidates ? { resumeActiveTurnCandidateMessageIds: candidates } : {}),
          // RFC §4:在飞 turn 身份随 hello 上报,服务端据此绑定 reconcile 到具体 clientMessageId。
          ...(emitInFlight && isClientMessageId(s._activeClientMessageId)
            ? { inFlightClientMessageId: s._activeClientMessageId }
            : {}),
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
    return {
      data: JSON.stringify({
        type: "inbound.hello",
        channel: "webchat",
        automaticRecoveryOwner: "master-v1",
        peers,
      }),
      attemptKeys,
    };
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

  private startWsAuthRecovery(): void {
    if (this.wsAuthRefreshInFlight) return;
    this.wsAuthRefreshInFlight = true;
    const socketEpoch = this.authEpoch;
    const sessionEpoch = this.deps.getAuthEpoch();
    this.setStatus("会话续期中…", "connecting");

    const attempt = async (): Promise<void> => {
      let outcome: RefreshOutcome;
      try {
        outcome = await this.deps.silentRefresh(sessionEpoch);
      } catch {
        outcome = { kind: "transient", epoch: sessionEpoch, retryAfterMs: 1_000 };
      }
      if (this.authEpoch !== socketEpoch || this.deps.getAuthEpoch() !== sessionEpoch) return;

      if (outcome.kind === "success") {
        this.wsAuthRefreshInFlight = false;
        if (this.deps.getToken()) this.connect();
        return;
      }
      if (outcome.kind === "invalid") {
        this.wsAuthRefreshInFlight = false;
        this.tearDownAuth(outcome.epoch);
        return;
      }
      if (outcome.kind === "stale") {
        this.wsAuthRefreshInFlight = false;
        return;
      }

      this.setStatus("会话续期中…", "connecting");
      this.wsAuthRetryTimer = setTimeout(() => {
        this.wsAuthRetryTimer = null;
        void attempt();
      }, Math.max(250, outcome.retryAfterMs));
    };
    void attempt();
  }

  private cancelWsAuthRecovery(): void {
    if (this.wsAuthRetryTimer) clearTimeout(this.wsAuthRetryTimer);
    this.wsAuthRetryTimer = null;
    this.wsAuthRefreshInFlight = false;
  }

  private tearDownAuth(expectedEpoch: number): void {
    this.authEpoch++;
    this.cancelWsAuthRecovery();
    this.setProvisioningBanner(false);
    this.deps.onAuthExpired(expectedEpoch);
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
    this.cancelWsAuthRecovery();
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

  /** Ensure the platform-owned client_sessions row exists before operations
   * such as GoalState set that require ownership but may precede the first
   * chat turn. Shares the same idempotent PUT flight as sendMessage. */
  ensureServerSession(sessId: string, agentId: string, title?: string): Promise<boolean> {
    const sess = this.ensureSession(sessId, agentId, title);
    return this.ensureServerSessionOnce(sess, agentId);
  }

  /** 重命名会话(纯元数据):改内存 title + notify → persist sig 变化,IndexedDB 随之落地。
   *  服务端 canonical 由调用方经 PATCH /api/sessions/:id 同步(三持有方一次收口)。*/
  renameSession(sessId: string, title: string): void {
    const s = this.sessions.get(sessId);
    if (!s || s.title === title) return;
    s.title = title;
    this.scheduleNotify();
  }

  /** 会话级模型选择(纯元数据,与 renameSession 同构):改内存 _selectedModelId + notify →
   *  persist sig 变化,IndexedDB 随之落地。服务端 canonical 由调用方经 PATCH 同步。
   *  会话尚不存在(新会话未发首条消息)→ no-op:首发时 sendMessage 会定格 + 建行 PUT 携带。*/
  setSessionModel(sessId: string, modelId: string): void {
    const s = this.sessions.get(sessId);
    if (!s || s._selectedModelId === modelId) return;
    s._selectedModelId = modelId;
    this.scheduleNotify();
  }

  removeSession(sessId: string): void {
    this.serverSessionEnsured.delete(sessId);
    this.serverSessionInflight.delete(sessId);
    this.dispatchSlots.delete(sessId);
    const removed = this.offlineQueue.filter((item) => item.sessId === sessId);
    this.offlineQueue = this.offlineQueue.filter((item) => item.sessId !== sessId);
    for (const item of removed) {
      void this.deps.deletePendingDispatch?.(sessId, item.msgId).catch(() => {});
    }
    const removedControls = this.controlQueue.filter((item) => item.sessId === sessId);
    this.controlQueue = this.controlQueue.filter((item) => item.sessId !== sessId);
    for (const item of removedControls) {
      const retryTimer = this.controlPersistRetryTimers.get(item.controlId);
      if (retryTimer) clearTimeout(retryTimer);
      this.controlPersistRetryTimers.delete(item.controlId);
      void this.deps.deletePendingControl?.(sessId, item.controlId).catch(() => {});
    }
    this.clearContinuousReconcile(sessId);
    this.durableLiveJournalCheckpoints.delete(sessId);
    const safeId = String(sessId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const suffix = `:webchat:dm:${safeId}`;
    for (const key of this.authoritativeFrameSeqResetEpochBySessionKey.keys()) {
      if (key === `peer:${sessId}` || key.endsWith(suffix)) {
        this.authoritativeFrameSeqResetEpochBySessionKey.delete(key);
      }
    }
    this.maybePromoteToConnected();
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
    this.dispatchSlots.clear();
    this.offlineQueue = [];
    this.controlQueue = [];
    this.pendingRepoBind.clear();
    this.transientNotices.clear();
    this.lastSyncAt.clear();
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer);
    this.reconcileTimers.clear();
    this.reconcileAttempts.clear();
    this.reconcileInFlight.clear();
    this.reconcileRunTokens.clear();
    this.reconcileClientMessageIds.clear();
    this.durableLiveJournalCheckpoints.clear();
    this.authoritativeFrameSeqResetEpochBySessionKey.clear();
    for (const timer of this.controlPersistRetryTimers.values()) clearTimeout(timer);
    this.controlPersistRetryTimers.clear();
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
    const shouldStrip = (message: ChatMessage) =>
      !!message._genPlaceholder ||
      message._timelineRecord === true ||
      message._turnTapeProcess === true ||
      typeof message._turnTapeProcessLoadedFrom === "string" ||
      typeof message._historyPageLoadedFrom === "string" ||
      message.id.startsWith("projection-") ||
      message.id.startsWith("oc-dispatch-err:") ||
      !!(message as ChatMessage & { _historyProjection?: unknown })._historyProjection;
    let messages = s.messages.some(shouldStrip)
      ? s.messages.filter((message) => !shouldStrip(message))
      : s.messages;
    // Loaded tape pages are a refetchable viewport cache. Persist only the tiny
    // invisible cursor control so IndexedDB never grows with a 50 MB tool record.
    if (messages.some((message) => message._turnTapeProcessExpanded)) {
      messages = messages.map((message) => {
        if (!message._turnTapeProcessExpanded) return message;
        const clean = { ...message };
        delete clean._turnTapeProcessExpanded;
        delete clean._turnTapeProcessCursor;
        return clean;
      });
    }
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
      ...(s._sendingInFlight && s._activeAgentId
        ? { _activeAgentId: s._activeAgentId }
        : {}),
      ...(s._dispatchPaused ? { _dispatchPaused: true } : {}),
      ...(s._cancelledAutomaticRecoveryIds
        ? { _cancelledAutomaticRecoveryIds: { ...s._cancelledAutomaticRecoveryIds } }
        : {}),
      ...(s._automaticRecoveryDecisions
        ? { _automaticRecoveryDecisions: { ...s._automaticRecoveryDecisions } }
        : {}),
      ...(typeof s._turnStartedAt === "number" ? { _turnStartedAt: s._turnStartedAt } : {}),
      ...(typeof s._lastFrameAt === "number" ? { _lastFrameAt: s._lastFrameAt } : {}),
      _maxSeq: s._maxSeq,
      ...(typeof s._historyRevision === "number" ? { _historyRevision: s._historyRevision } : {}),
      ...(typeof s._archivedThroughSeq === "number" ? { _archivedThroughSeq: s._archivedThroughSeq } : {}),
      ...(typeof s._archivedCount === "number" ? { _archivedCount: s._archivedCount } : {}),
      _trackerResetAt: typeof s._trackerResetAt === "number" ? s._trackerResetAt : undefined,
      _trackerResetServerTs: typeof s._trackerResetServerTs === "number" ? s._trackerResetServerTs : undefined,
      _localTeardownAt: typeof s._localTeardownAt === "number" ? s._localTeardownAt : undefined,
      _agentSwitchedAt: typeof s._agentSwitchedAt === "number" ? s._agentSwitchedAt : s._agentSwitchedAt ?? undefined,
      ...(s._lastRouting ? { _lastRouting: { ...s._lastRouting } } : {}),
      ...(s._selectedModelId ? { _selectedModelId: s._selectedModelId } : {}),
    };
  }

  /**
   * 从 IndexedDB 注水会话（boot/登录读回）。**不发任何帧、不连 WS**——纯本地恢复，
   * 让 reload 不丢会话。已存在（live）则跳过：live 状态永远优先于磁盘快照。
   * 注水后清流式瞬态；任何年龄但带 exact clientMessageId 的 in-flight 都进入 reconciling，
   * 由 hello/resume + 持续 REST 权威对账决定终态，不用客户端时间阈值猜测；cutoff 守卫戳
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
      ? stored.messages
        .filter((message) =>
          !message.id.startsWith("projection-") &&
          !message.id.startsWith("oc-dispatch-err:") &&
          message._timelineRecord !== true &&
          message._turnTapeProcess !== true &&
          typeof message._historyPageLoadedFrom !== "string" &&
          !(message as ChatMessage & { _historyProjection?: unknown })._historyProjection,
        )
        .map((message) => {
          const routing = normalizeRetiredRouting(message._routing);
          return routing !== message._routing ? { ...message, _routing: routing } : message;
        })
      : [];
    s.lastAt = typeof stored.lastAt === "number" ? stored.lastAt : s.lastAt;
    s.updatedAt = stored.updatedAt;
    s._lastFrameSeqByKey = stored._lastFrameSeqByKey ? { ...stored._lastFrameSeqByKey } : {};
    s._lastFrameSeq = stored._lastFrameSeq;
    s._maxSeq = stored._maxSeq;
    s._historyRevision = stored._historyRevision;
    if (typeof stored._archivedThroughSeq === "number") s._archivedThroughSeq = stored._archivedThroughSeq;
    if (typeof stored._archivedCount === "number") s._archivedCount = stored._archivedCount;
    s._streamingAssistant = null;
    s._streamingThinking = null;
    const storedPending = Array.isArray(stored._pendingDispatches)
      ? stored._pendingDispatches.filter((item) =>
          item && isClientMessageId(item.msgId) &&
          item.payload?.type === "inbound.message" &&
          item.payload.clientMessageId === item.msgId &&
          item.payload.peer?.id === stored.id,
        )
      : [];
    const restoredExactInFlight = storedPending.length === 0 &&
      stored._sendingInFlight === true &&
      isClientMessageId(stored._activeClientMessageId);
    s._sendingInFlight = restoredExactInFlight;
    if (restoredExactInFlight) {
      s._activeClientMessageId = stored._activeClientMessageId;
      s._activeAgentId =
        typeof stored._activeAgentId === "string" && stored._activeAgentId
          ? stored._activeAgentId
          : undefined;
      s._turnStartedAt = typeof stored._turnStartedAt === "number" ? stored._turnStartedAt : Date.now();
      s._lastFrameAt = typeof stored._lastFrameAt === "number" ? stored._lastFrameAt : undefined;
      s._reconciling = true;
      s._recoveryStatus = { kind: "waiting-service" };
    }
    s._dispatchPaused = stored._dispatchPaused === true;
    s._cancelledAutomaticRecoveryIds =
      stored._cancelledAutomaticRecoveryIds &&
      typeof stored._cancelledAutomaticRecoveryIds === "object"
        ? { ...stored._cancelledAutomaticRecoveryIds }
        : undefined;
    s._automaticRecoveryDecisions =
      stored._automaticRecoveryDecisions &&
      typeof stored._automaticRecoveryDecisions === "object"
        ? { ...stored._automaticRecoveryDecisions }
        : undefined;
    s._trackerResetAt = typeof stored._trackerResetAt === "number" ? stored._trackerResetAt : undefined;
    s._trackerResetServerTs =
      typeof stored._trackerResetServerTs === "number" ? stored._trackerResetServerTs : undefined;
    s._localTeardownAt = typeof stored._localTeardownAt === "number" ? stored._localTeardownAt : undefined;
    s._agentSwitchedAt = typeof stored._agentSwitchedAt === "number" ? stored._agentSwitchedAt : null;
    const restoredRouting = normalizeRetiredRouting(stored._lastRouting);
    s._lastRouting = restoredRouting ? { ...restoredRouting } : undefined;
    if (typeof stored._selectedModelId === "string" && stored._selectedModelId) {
      s._selectedModelId = stored._selectedModelId;
    }
    for (const pending of storedPending) {
      this.offlineQueue.push({
        sessId: stored.id,
        payload: pending.payload,
        msgId: pending.msgId,
        enqueuedAt: Number.isFinite(pending.enqueuedAt) ? pending.enqueuedAt : pending.payload.ts,
        state: "queued",
      });
      const user = s.messages.find((message) => message.role === "user" && message.id === pending.msgId);
      if (user) user.status = "queued";
    }
    this.offlineQueue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    rebuildIndexes(s);
    normalizeDelegateCards(s);
    normalizeGoalCards(s);
    const repairedStoredMessages = repairPostFinalProcessOrder(s.messages);
    const repairedStoredOrder = repairedStoredMessages !== s.messages;
    if (repairedStoredOrder) s.messages = repairedStoredMessages;
    this.sessions.set(stored.id, s);
    const storedControls = Array.isArray(stored._pendingControls)
      ? stored._pendingControls.filter((item) =>
          item?.kind === "control" &&
          item.sessId === stored.id &&
          typeof item.controlId === "string" &&
          item.payload?.controlId === item.controlId)
      : [];
    for (const control of storedControls) {
      const item: PendingControlItem = { ...control, status: "queued" };
      if (control.controlKind === "stop") {
        s._sendingInFlight = true;
        s._activeClientMessageId = control.clientMessageId;
        s._stopSettlement = {
          ...(control.clientMessageId ? { clientMessageId: control.clientMessageId } : {}),
          controlId: control.controlId,
          phase: "awaiting_receipt",
        };
        s._recoveryStatus = { kind: "stopping" };
      } else if (control.controlKind === "permission" && control.requestId) {
        const permission = s.messages.find((message) => message.requestId === control.requestId);
        if (permission) permission._controlPending = true;
        s._recoveryStatus = { kind: "needs-confirmation" };
      }
      this.enqueueControl(item, true);
    }
    // The persistence callback resolves the snapshot through this.sessions,
    // so register the repaired session first.  A clean second load remains a
    // zero-write fast path because the repair is idempotent.
    if (repairedStoredOrder) this.deps.persistSession?.(stored.id);
    if (restoredExactInFlight && storedControls.every((item) => item.controlKind !== "stop")) {
      this.startContinuousReconcile(stored.id);
    }
    if (storedPending.length > 0 && !s._dispatchPaused) this.kickDispatchPump();
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
      /** 载荷的 SessionDetail.updatedAt:P1 缺席删除的版本护栏证据(见下)。 */
      serverUpdatedAt?: number;
      /** 载荷的 SessionDetail.modelId(会话级模型选择,server canonical):携带时 server-wins
       *  镜像进会话态(缺省=服务端无值,保留本地,与侧栏 listSessions 合并同语义)。 */
      modelId?: string;
      /** History revision paired with maxSeq; set only after payload acceptance. */
      historyRevision?: number;
      /** Stable cursor epoch for the unified real timeline. */
      timelineGeneration?: number;
      timelineCursor?: string | null;
      timelineHasMore?: boolean;
      timelineSnapshotMaxSeq?: number;
      /** Legacy backend fallback: invalidate hydrated history on every full read. */
      invalidateHistoryCache?: boolean;
    },
  ): void {
    const s = this.ensureSession(sessId, agentId || this.deps.defaultAgentId || "main");
    const incomingTimelineGeneration = archive?.timelineGeneration;
    const hasTimelineGeneration =
      typeof incomingTimelineGeneration === "number" &&
      Number.isSafeInteger(incomingTimelineGeneration) &&
      incomingTimelineGeneration >= 1;
    if (!hasTimelineGeneration && msgs.some((message) => message?._turnTapeProcess === true)) {
      // Rolling predecessor payloads need their old process-card renderer.
      // This bundle intentionally removed that substitute, so preserve the
      // current transcript and let the build handshake safely reload rather
      // than accepting a payload whose Agent process would become invisible.
      return;
    }
    // Controls/projection remnants from rolling predecessor caches are never
    // part of the real transcript and must not survive a unified read.
    msgs = msgs.filter((message) =>
      message?._turnTapeProcess !== true &&
      !message?.id?.startsWith("projection-") &&
      !message?.id?.startsWith("oc-dispatch-err:"));
    const archivedThroughSeq =
      typeof archive?.archivedThroughSeq === "number" && Number.isFinite(archive.archivedThroughSeq)
        ? archive.archivedThroughSeq
        : 0;
    // 同步权威传播的版本护栏:loadHistory 与 syncSession 是两条独立 REST,旧载荷可能晚于更新的
    // 合并抵达。被证明过期的载荷(updatedAt < 已应用水位)**整体丢弃**——不只是撤销 P1 授权:
    // 旧 full 的同 id server-wins 会把新行覆盖回旧版、preservedMid 规则会丢中段新 server 行、
    // 归档计数/水位会回退、流式索引会被重建,全都是破坏面(Codex R2 BLOCKER)。水位随任何
    // 成功应用的带版本载荷推进(full+增量),只在本进程内存(会话重开从 0 起,首个载荷天然可用)。
    const serverUpdatedAt = archive?.serverUpdatedAt;
    const hasVersion = typeof serverUpdatedAt === "number" && Number.isFinite(serverUpdatedAt);
    const watermark = s._lastServerSyncUpdatedAt ?? 0;
    if (hasVersion && serverUpdatedAt < watermark) return;
    // 会话级模型选择镜像:载荷已过版本护栏(未被证明过期)才应用,server-wins;
    // 缺省 = 服务端无值,保留本地(与侧栏 listSessions 合并同语义)。
    if (typeof archive?.modelId === "string" && archive.modelId) s._selectedModelId = archive.modelId;
    // 终态收敛:先从载荷推导「已收尾 turn → 终态类别」。verified failure status、
    // 持久化 error 卡、真 tape 生成行都在此被识别,合并后 convergeTerminalTurns 显式清发送态 +
    // 落 user 行终态,不再依赖「completion-evidence 恰好命中」的巧合路径。
    const terminalTurns = detectServerTerminalTurns(msgs);
    const incomingHistoryRevision = archive?.historyRevision;
    const hasHistoryRevision =
      typeof incomingHistoryRevision === "number" &&
      Number.isSafeInteger(incomingHistoryRevision) &&
      incomingHistoryRevision >= 0;
    const timelineGenerationChanged = hasTimelineGeneration &&
      s._timelineGeneration !== undefined &&
      incomingTimelineGeneration !== s._timelineGeneration;
    const adoptingUnifiedTimeline = hasTimelineGeneration && s._timelineGeneration === undefined;
    const invalidateHistoryCache = adoptingUnifiedTimeline || timelineGenerationChanged ||
      (full && archive?.invalidateHistoryCache === true);
    let authoritativeMessages = msgs;
    if (hasTimelineGeneration && !timelineGenerationChanged) {
      // Ordinary append/latest-page refresh must never evict records already
      // loaded during this page lifetime. Merge by the server's logical unit
      // identity, with the fresh snapshot updating mutable billing/status
      // overlays in place.
      const byUnit = new Map<string, ChatMessage>();
      for (const message of s.messages) {
        if (message._timelineRecord !== true) continue;
        const key = message._timelineUnitKey ?? `id:${message.id}`;
        byUnit.set(key, message);
      }
      for (const message of msgs) {
        const key = message._timelineUnitKey ?? `id:${message.id}`;
        const previous = byUnit.get(key);
        byUnit.set(key, previous?._historyPageLoadedFrom && !message._historyPageLoadedFrom
          ? {
              ...message,
              _historyPageLoadedFrom: previous._historyPageLoadedFrom,
              _historyPageKey: previous._historyPageKey,
            }
          : message);
      }
      authoritativeMessages = [...byUnit.values()];
    }
    // P1 缺席删除只在「载荷携带版本且 ≥ 水位」的 full 上授权;无版本信息的载荷照常合并但不授权
    // (缺席不可证)。活跃轮守卫:发送中的轮绝不被载荷自证清除 —— **但载荷携带该活跃轮的精确终态
    // 证据时给守卫开口**(server 权威胜),让合并按证据收敛本地乐观行,而非把已终态轮永久保护住。
    const sendingCmid = s._sendingInFlight ? s._activeClientMessageId : undefined;
    const activeClientMessageId =
      sendingCmid && terminalTurns.has(sendingCmid) ? undefined : sendingCmid;
    s.messages = full
      ? mergeFullServerWins(
          authoritativeMessages,
          s.messages,
          archivedThroughSeq,
          archive?.completedClientMessageId,
          {
            deletionAuthority: hasVersion,
            activeClientMessageId,
            invalidateHistoryCache,
            adoptUnifiedTimeline: adoptingUnifiedTimeline,
          },
        )
      : applyServerIncremental(s.messages, authoritativeMessages, archive?.completedClientMessageId, {
          activeClientMessageId,
        });
    s.messages = reconcileTimelineBashTailAuxiliaries(s.messages);
    if (hasVersion) s._lastServerSyncUpdatedAt = serverUpdatedAt;
    if (hasHistoryRevision) {
      s._historyRevision = incomingHistoryRevision;
    }
    if (hasTimelineGeneration) {
      const hadOlderPages = (s._historyPageSerial ?? 0) > 0 && !timelineGenerationChanged;
      s._timelineGeneration = incomingTimelineGeneration;
      if (!hadOlderPages) {
        s._timelineCursor = typeof archive?.timelineCursor === "string"
          ? archive.timelineCursor
          : null;
        s._timelineHasMore = archive?.timelineHasMore === true;
      }
      if (timelineGenerationChanged) s._historyPageSerial = 0;
      if (
        typeof archive?.timelineSnapshotMaxSeq === "number" &&
        Number.isSafeInteger(archive.timelineSnapshotMaxSeq)
      ) s._timelineSnapshotMaxSeq = archive.timelineSnapshotMaxSeq;
    }
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
    normalizeGoalCards(s);
    s.messages = repairPostFinalProcessOrder(s.messages);
    // 生成占位卡兜底消解:对账带回的 server 行若证明占位所属轮已在服务端收尾(锚点 user
    // 行被 echo + 存在更晚 _seq 的 server-authored assistant 行),清运行中占位——覆盖
    // 「live 终帧丢失、结果靠 REST 对账补上」的帧丢失类故障(2026-07-11 boss 生产事故)。
    expireGenPlaceholdersAgainstServerRows(s);
    // 终态收敛(RFC §5 M5):载荷自证已收尾的 turn → 清发送态 + 落 user 行终态(显式,不巧合)。
    this.convergeTerminalTurns(s, terminalTurns);
    this.scheduleNotify();
    const tailRecoverableError = [...s.messages].reverse().find((message) =>
      message.role === "assistant" &&
      !!message._errorCode &&
      (message._source === "server" || !!message._turnTapeId) &&
      supportsAutomaticTurnRecovery(message._errorCode));
    const recoveryDecisionKey = tailRecoverableError?._clientMessageId ?? "tail";
    if (
      !this.masterOwnsAutomaticRecovery &&
      tailRecoverableError &&
      s._automaticRecoveryDecisions?.[recoveryDecisionKey] !== true
    ) {
      setTimeout(
        () => void this.autoRecoverTerminalTurn(
          s.id,
          tailRecoverableError._clientMessageId,
        ),
        0,
      );
    }
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
   * Hydrate the exact live journal without repeatedly replaying its entire history.
   *
   * One cold/page-lifetime read stages the unbounded snapshot from zero and resets
   * the affected client-owned rows exactly once. Every later caller (session history
   * selection or continuous reconcile) resumes from the same committed record cursor,
   * so a long active turn only applies newly persisted frames. A failed page never
   * advances past unapplied data; replaying an already-applied page remains safe via
   * the ordinary sessionKey+frameSeq dedupe.
   */
  hydrateDurableLiveFrameJournal(
    sessId: string,
    fetchPage: (after: string) => Promise<DurableLiveFramePage>,
    applyTapeProjection: () => Promise<void>,
  ): Promise<void> {
    return this.runDurableLiveFrameHydration(sessId, async () => {
      const checkpoint = this.durableLiveJournalCheckpoints.get(sessId);
      const initial = checkpoint === undefined;
      let cursor = checkpoint?.cursor ?? "0";
      const previousLiveOwners = checkpoint?.liveClientMessageIds ?? new Set<string>();
      let currentLiveOwners = new Set(previousLiveOwners);
      const observedLiveOwners = new Set(previousLiveOwners);
      // Work on a copy and commit it with the record cursor only after every
      // page succeeds. A failed later page must leave both checkpoints at the
      // same retry boundary.
      const lastDurableFrameSeqBySessionKey = new Map(
        checkpoint?.lastDurableFrameSeqBySessionKey ?? [],
      );
      let sawTapeProjection = false;
      let maxTapeProjectionVersion: number | undefined;
      let frameCount = 0;
      let degraded = false;
      const startedAt = Date.now();
      let pagesRead = 0;

      const readPages = async (stage: DurableLiveFrame[] | null): Promise<void> => {
        for (;;) {
          if (pagesRead >= LIVE_JOURNAL_MAX_PAGES || Date.now() - startedAt >= LIVE_JOURNAL_MAX_MS) {
            degraded = true;
            break;
          }
          let page: DurableLiveFramePage;
          try {
            page = await fetchPage(cursor);
          } catch (error) {
            // Hung/aborted live-frames must not pin restore. Other page errors
            // still reject so the checkpoint stays on the last committed cursor.
            if (isLiveJournalAbort(error)) {
              degraded = true;
              return;
            }
            throw error;
          }
          pagesRead += 1;
          sawTapeProjection ||= page.hasTapeProjection === true;
          if (typeof page.tapeProjectionVersion === "number") {
            maxTapeProjectionVersion = Math.max(
              maxTapeProjectionVersion ?? 0,
              page.tapeProjectionVersion,
            );
          }
          currentLiveOwners = new Set(page.streamClientMessageIds);
          for (const clientMessageId of currentLiveOwners) observedLiveOwners.add(clientMessageId);
          frameCount += page.frames.length;
          if (stage) {
            stage.push(...page.frames);
          } else if (page.frames.length > 0) {
            this.applyDurableLiveFrames(
              sessId,
              page.frames,
              [],
              lastDurableFrameSeqBySessionKey,
            );
          }
          if (page.hasMore && !page.nextCursor) {
            throw new Error("live frame page missing cursor");
          }
          if (page.nextCursor) cursor = page.nextCursor;
          if (!page.hasMore) break;
        }
      };

      if (initial) {
        const stagedFrames: DurableLiveFrame[] = [];
        await readPages(stagedFrames);
        this.applyDurableLiveFrames(
          sessId,
          stagedFrames,
          [...observedLiveOwners],
          lastDurableFrameSeqBySessionKey,
        );
        if (!degraded) {
          // Close snapshot→reset races while stamped WS frames remain buffered.
          await readPages(null);
        }
      } else {
        await readPages(null);
      }

      const liveOwnerProjectedToTape = [...previousLiveOwners].some(
        (clientMessageId) => !currentLiveOwners.has(clientMessageId),
      );
      // 自愈触发(三路,均幂等到 checkpoint):
      // 1) 版本水位增长(权威):两次水合之间发生的 live→tape 切换,含断连期间
      //    完成、前后 owner 集都不含它的 turn —— liveOwnerProjectedToTape 对此
      //    是盲的(codex 审计 blocker);
      // 2) 布尔回退:旧后端无水位字段,本页首次观察到 tape 投影(含 initial 与
      //    网关重启后带旧 checkpoint 重连)补拉一次;
      // 3) 亲眼看 live owner 切 tape 的既有触发。
      // 4) 降级或「在飞 + journal 空 + 最后一条 assistant 空白」:刷新后 cursor
      //    回 0、turn 已切 tape 时 live-frames 不再给正文,必须补拉 tape。
      const versionAdvanced =
        typeof maxTapeProjectionVersion === "number" &&
        (checkpoint?.tapeProjectionVersion === undefined
          ? maxTapeProjectionVersion > 0
          : maxTapeProjectionVersion > checkpoint.tapeProjectionVersion);
      const tapeProjectionAppeared =
        typeof maxTapeProjectionVersion !== "number" &&
        sawTapeProjection && checkpoint?.sawTapeProjection !== true;
      const sess = this.sessions.get(sessId);
      const activeCmid = sess?._activeClientMessageId;
      const noLiveOwner = !activeCmid || !currentLiveOwners.has(activeCmid);
      const emptyInFlightBubble = !!sess?._sendingInFlight && noLiveOwner &&
        (sess ? this.turnAssistantIsEmpty(sess) : true);
      if (
        versionAdvanced ||
        tapeProjectionAppeared ||
        liveOwnerProjectedToTape ||
        degraded ||
        (sawTapeProjection && emptyInFlightBubble)
      ) {
        try {
          await applyTapeProjection();
        } catch {
          degraded = true;
        }
      }

      this.noteLiveJournalObservation(sessId, {
        frameCount,
        liveClientMessageIds: currentLiveOwners,
        hasTapeProjection: sawTapeProjection || checkpoint?.sawTapeProjection === true,
        ...(typeof maxTapeProjectionVersion === "number"
          ? { tapeProjectionVersion: maxTapeProjectionVersion }
          : {}),
        degraded,
      });
      if (sess) {
        sess._liveJournalDegraded = degraded;
        this.scheduleNotify();
      }

      this.durableLiveJournalCheckpoints.set(sessId, {
        cursor,
        ...(sawTapeProjection || checkpoint?.sawTapeProjection ? { sawTapeProjection: true } : {}),
        ...(typeof maxTapeProjectionVersion === "number"
          ? { tapeProjectionVersion: maxTapeProjectionVersion }
          : checkpoint?.tapeProjectionVersion !== undefined
            ? { tapeProjectionVersion: checkpoint.tapeProjectionVersion }
            : {}),
        liveClientMessageIds: currentLiveOwners,
        lastDurableFrameSeqBySessionKey,
      });
    });
  }

  /** Serialize one session's REST journal rebuild and hold overlapping stamped
   * WS frames. The caller may page/fetch freely inside `hydrate`; the finally
   * path always releases live frames through the ordinary frameSeq reducer. */
  runDurableLiveFrameHydration(sessId: string, hydrate: () => Promise<void>): Promise<void> {
    const previous = this.durableHydrationTails.get(sessId) ?? Promise.resolve();
    const run = previous.catch(() => { /* a failed older read must not wedge later sync */ }).then(async () => {
      const state = { buffered: [] as OutboundWire[] };
      this.durableHydrationStates.set(sessId, state);
      try {
        await hydrate();
      } finally {
        if (this.durableHydrationStates.get(sessId) === state) {
          this.durableHydrationStates.delete(sessId);
        }
        // Synchronous drain: browser WS callbacks cannot interleave between
        // deleting the hold and replaying this already ordered buffer.
        for (const frame of state.buffered) {
          try { this.dispatch(frame); } catch { /* match live dispatch isolation */ }
        }
        if (state.buffered.length > 0) this.scheduleNotify();
      }
    });
    let tracked!: Promise<void>;
    tracked = run.finally(() => {
      if (this.durableHydrationTails.get(sessId) === tracked) {
        this.durableHydrationTails.delete(sessId);
      }
    });
    this.durableHydrationTails.set(sessId, tracked);
    return tracked;
  }

  /**
   * Rebuild one abnormal/open turn from the exact master-side frame journal.
   * The first call clears only client-owned rows for the listed turn owners,
   * resets the affected stream cursors, then replays immutable frames through
   * the same frameSeq reducer used by WS. Later pages/confirmations therefore
   * deduplicate exactly against any buffered live delivery.
   */
  applyDurableLiveFrames(
    sessId: string,
    frames: DurableLiveFrame[],
    resetClientMessageIds: string[] = [],
    lastDurableFrameSeqBySessionKey?: Map<string, {
      frameSeq: number;
      consumedAuthoritativeResetEpoch: number;
    }>,
  ): void {
    const sess = this.sessions.get(sessId);
    if (!sess) return;
    if (resetClientMessageIds.length > 0) {
      const resetSessionKeys = new Set<string>();
      for (const record of frames) {
        const payload = record.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        const sessionKey = (payload as { sessionKey?: unknown }).sessionKey;
        if (typeof sessionKey === "string") resetSessionKeys.add(sessionKey);
      }
      for (const sessionKey of resetSessionKeys) {
        resetFrameSeqCursor(sess, { sessionKey });
      }
      const owners = new Set(resetClientMessageIds);
      sess.messages = sess.messages.filter((message) => {
        if (message.role === "user") return true;
        if (message._source === "server" || !!message._turnTapeId) return true;
        return !(
          (typeof message._turnOwnerId === "string" && owners.has(message._turnOwnerId)) ||
          (typeof message._clientMessageId === "string" && owners.has(message._clientMessageId))
        );
      });
      sess._streamingAssistant = null;
      sess._streamingThinking = null;
      sess._blockIdToMsgId = new Map();
      sess._agentGroups = new Map();
      rebuildIndexes(sess);
    }
    for (const record of frames) {
      if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) continue;
      const raw = record.payload as Record<string, unknown>;
      const peer = raw.peer;
      if (
        !peer || typeof peer !== "object" || Array.isArray(peer) ||
        (peer as { id?: unknown }).id !== sessId
      ) continue;
      const rawSessionKey = raw.sessionKey;
      const frameSeq = raw.frameSeq;
      if (
        lastDurableFrameSeqBySessionKey &&
        typeof rawSessionKey === "string" && rawSessionKey &&
        typeof frameSeq === "number" && Number.isSafeInteger(frameSeq) && frameSeq > 0
      ) {
        const previousDurable = lastDurableFrameSeqBySessionKey.get(rawSessionKey);
        const authoritativeResetEpoch =
          this.authoritativeFrameSeqResetEpochBySessionKey.get(rawSessionKey) ?? 0;
        if (previousDurable !== undefined && frameSeq <= previousDurable.frameSeq) {
          // A replacement container starts its outbound ring at one while the
          // wire sessionKey stays stable. If refresh restored the previous
          // generation's high reducer cursor, reset it before replaying this
          // generation. A server-authoritative cold-start/resume reset may
          // already have admitted this generation live, even beyond the old
          // high-water mark; its unconsumed epoch keeps that live cursor so
          // journal/WS overlap stays deduplicated.
          const currentReducerSeq = getFrameSeqCursor(
            sess._lastFrameSeqByKey,
            sess._lastFrameSeq,
            rawSessionKey,
          );
          const resetAlreadyApplied = authoritativeResetEpoch >
            previousDurable.consumedAuthoritativeResetEpoch;
          if (!resetAlreadyApplied && currentReducerSeq >= previousDurable.frameSeq) {
            resetFrameSeqCursor(sess, { sessionKey: rawSessionKey });
          }
          lastDurableFrameSeqBySessionKey.set(rawSessionKey, {
            frameSeq,
            consumedAuthoritativeResetEpoch: authoritativeResetEpoch,
          });
        } else if (previousDurable) {
          // An authoritative reset can race ahead of still-arriving records
          // from the old journal generation. Consume its epoch only when the
          // sequence actually crosses the generation boundary.
          lastDurableFrameSeqBySessionKey.set(rawSessionKey, {
            ...previousDurable,
            frameSeq,
          });
        } else {
          lastDurableFrameSeqBySessionKey.set(rawSessionKey, {
            frameSeq,
            consumedAuthoritativeResetEpoch: authoritativeResetEpoch,
          });
        }
      }
      this.dispatch(raw as unknown as OutboundWire);
    }
    rebuildIndexes(sess);
    normalizeDelegateCards(sess);
    normalizeGoalCards(sess);
    sess.messages = repairPostFinalProcessOrder(sess.messages);
    this.deps.persistSession?.(sessId);
    this.scheduleNotify();
  }

  /**
   * 终态收敛(RFC §5 M5):REST 对账载荷自证「已收尾 turn」时,显式落 user 行终态并清发送态。
   * 覆盖 durable dispatch 下真 final 帧永不到达的丢 turn场景(verified status / 静默收尾),
   * 不依赖既有 completion-evidence 的巧合命中。
   *  - completed:user 行 → replied;可重试 error → error;运行中断 → sent(不覆盖已 replied)。
   *  - 该 turn 恰为当前活跃在飞轮 → clearSendingState 收口("回复中"停转、drain 推进)。
   */
  private convergeTerminalTurns(s: ChatSession, terminalTurns: Map<string, ServerTurnTerminal>): void {
    if (terminalTurns.size === 0) return;
    for (const [cmid, kind] of terminalTurns) {
      const userRow = s.messages.find((m) => m.role === "user" && m.id === cmid);
      if (userRow) {
        if (kind === "completed") {
          userRow.status = "replied";
        } else if (kind === "error" && userRow.status !== "replied") {
          userRow.status = "error";
        } else if (userRow.status !== "replied") {
          // A service restart happened after durable admission. It belongs on
          // the turn status card, never on the user's transport state.
          userRow.status = "sent";
        }
      }
      if (s._sendingInFlight && s._activeClientMessageId === cmid) {
        // 显式收口活跃轮:与 isFinal / error 收尾同一 clearSendingState 路径(清计时/tracker/
        // thinking-safety + persist + kick drain),避免发送态永挂。
        this.clearSendingState(s, { clearThinking: true });
      }
      const stopSettlement = s._stopSettlement;
      if (stopSettlement?.clientMessageId === cmid && stopSettlement.controlId) {
        // REST reconciliation is terminal authority too. A Stop receipt/final
        // frame may be lost after Master applied it, so settle the durable
        // browser control journal from the exact terminal turn identity.
        this.settleControl(stopSettlement.controlId, "terminal");
      }
      this.finishDispatch(s.id, cmid);
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
    normalizeGoalCards(s);
    s.messages = repairPostFinalProcessOrder(s.messages);
    this.scheduleNotify();
  }

  /** Merge exactly one user-requested older page. No persistence, eviction,
   * scroll observer or live normalizer participates; refresh is the cache
   * boundary and a true timeline-generation change replaces the stream. */
  prependTimelinePage(
    sessId: string,
    msgs: ChatMessage[],
    loadedFrom: string,
    nextCursor: string | null,
    hasMore: boolean,
    timelineGeneration: number,
  ): void {
    const s = this.sessions.get(sessId);
    if (
      !s || s._timelineGeneration !== timelineGeneration ||
      s._timelineCursor !== loadedFrom
    ) return;
    const serial = (s._historyPageSerial ?? 0) + 1;
    const pageKey = `history-page:${timelineGeneration}:${serial}`;
    const page = msgs.map((message) => ({
      ...message,
      _source: "server" as const,
      _timelineRecord: true,
      _historyPageLoadedFrom: loadedFrom,
      _historyPageKey: pageKey,
    }));
    s.messages = mergeTimelineHistoryPage(s.messages, page);
    s.messages = reconcileTimelineBashTailAuxiliaries(s.messages);
    s._historyPageSerial = serial;
    s._timelineCursor = nextCursor;
    s._timelineHasMore = hasMore && typeof nextCursor === "string" && nextCursor.length > 0;
    s._blockIdToMsgId = new Map();
    s._agentGroups = new Map();
    rebuildIndexes(s);
    // Historical rows are already the exact Agent records. Do not run
    // delegate/goal/card normalizers that can group or rewrite them.
    this.scheduleNotify();
  }

  /** Replace one hidden deferred Bash-tail locator with its Range+SHA verified
   * exact runtime record, then reconcile the owning real ToolCard. */
  resolveTimelineAuxiliary(
    sessId: string,
    unitKey: string,
    records: ChatMessage[],
  ): void {
    const s = this.sessions.get(sessId);
    if (!s) return;
    const index = s.messages.findIndex((message) =>
      message._timelineUnitKey === unitKey &&
      message._timelineAuxiliary === "bash-tail" &&
      message._payloadDeferred === true);
    if (index < 0) return;
    const locator = s.messages[index]!;
    const exact = records.find((message) => {
      if (message.role !== "runtime-event") return false;
      const event = message._runtimeEvent;
      if (!event || typeof event !== "object" || Array.isArray(event)) return false;
      const raw = event as Record<string, unknown>;
      return raw.type === "system" && raw.subtype === "bash_output_tail" &&
        typeof raw.tool_use_id === "string" && raw.tool_use_id.length > 0;
    });
    const next = [...s.messages];
    if (!exact) {
      next.splice(index, 1);
    } else {
      next[index] = {
        ...exact,
        _source: "server",
        _orderSeq: locator._orderSeq,
        _seq: locator._seq,
        _turnTapeId: locator._turnTapeId,
        _turnTapeOrdinal: locator._turnTapeOrdinal,
        _recordOrdinal: locator._recordOrdinal,
        _turnTapeSha256: locator._turnTapeSha256,
        _turnTapeComplete: true,
        _turnKey: locator._turnKey,
        _dispatchOutcome: locator._dispatchOutcome,
        _clientMessageId: exact._clientMessageId ?? locator._clientMessageId,
        _timelineRecord: true,
        _timelineAuxiliary: "bash-tail",
        _timelineUnitKey: unitKey,
        _historyPageLoadedFrom: locator._historyPageLoadedFrom,
        _historyPageKey: locator._historyPageKey,
        _payloadDeferred: undefined,
        _payloadBytes: undefined,
        _payloadSha256: undefined,
      };
    }
    s.messages = reconcileTimelineBashTailAuxiliaries(next);
    s._blockIdToMsgId = new Map();
    s._agentGroups = new Map();
    rebuildIndexes(s);
    this.scheduleNotify();
  }

  /** Archive-page revision mismatch recovery. Bypass the ordinary debounce:
   * the page was captured from a different history generation, so a full
   * history reconciliation is required before retrying pagination. */
  syncHistoryNow(sessId: string): void {
    void this.deps.syncSession?.(sessId);
  }

  /**
   * 下一页归档 getSessionArchive 的 before 游标 = 当前已加载的最老 server `_orderSeq`。
   * 本地还没拉过归档时,最老 server 行即热尾巴首行(`_orderSeq =
   * archivedThroughSeq+1`)→ before 落在 archivedThroughSeq+1,取到最新归档页;每前插一页,最老
   * `_orderSeq` 下降 → 自然上翻。全无顺序轴(纯乐观/未同步)→ 回退水位+1;都缺 → 0
   * (server 按缺省取最新页)。
   */
  archiveBeforeSeq(sessId: string): number {
    const s = this.sessions.get(sessId);
    if (!s) return 0;
    let min: number | null = null;
    for (const m of s.messages) {
      const orderSeq = typeof m._orderSeq === "number" ? m._orderSeq : m._seq;
      if (typeof orderSeq === "number" && Number.isFinite(orderSeq) && (min === null || orderSeq < min)) min = orderSeq;
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
    if (
      sess._sendingInFlight ||
      this.offlineQueue.some((item) => item.sessId === sessId)
    ) {
      // Stop is bound to the old turn before the selector is overwritten.
      // This also cascades through the old captain's team delegation tree.
      this.stopTurn(sessId);
    }
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
    replyTo?: MessageReplyQuote;
    model?: string;
    effortLevel?: InboundMessage["effortLevel"];
    teamMode?: boolean;
  }): void {
    const sess = this.ensureSession(p.sessId, p.agentId);
    if (sess._recoveryStatus?.kind === "completed" || sess._recoveryStatus?.kind === "resumed") {
      sess._recoveryStatus = undefined;
    }
    // An explicit user send is the resume gesture for ordinary prompts that a
    // previous Stop intentionally left queued.
    sess._dispatchPaused = false;
    // 会话级模型选择定格:首发/换模发送都把当前有效模型落为会话选择(建行 PUT 在下面
    // 读它随体携带,故必须先于 ensureServerSessionOnce 写入)。p.model 缺省(模型列表
    // 未加载等)不清空既有选择。
    if (p.model) sess._selectedModelId = p.model;
    // 主控 session 建行(每会话一次):必须在容器跑完 turn 回传 authored 消息之前落地,
    // 否则 session_not_found 风暴。用户行不再走独立 HTTP append：WS
    // admitUserTurn 在同一事务里落 user row + turn_dispatches，避免出现有消息无 dispatch。
    void this.ensureServerSessionOnce(sess, p.agentId);
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
      // Filled from the minted client message id below.  A fixed placeholder
      // keeps construction type-safe; it is never dispatched as-is.
      idempotencyKey: "web:pending:0",
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: p.agentId,
      content: {
        text: p.text,
        ...(p.displayText !== undefined && p.displayText !== p.text
          ? { displayText: p.displayText }
          : {}),
        ...(outboundMedia ? { media: outboundMedia } : {}),
        ...(p.imageEdit ? { imageEdit: p.imageEdit } : {}),
        ...(p.replyTo ? { replyTo: p.replyTo } : {}),
      },
      ...(p.replyTo ? { replyToId: p.replyTo.messageId } : {}),
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
      _modelText: p.displayText !== undefined && p.displayText !== p.text ? p.text : undefined,
      _replyTo: p.replyTo,
      _routing: { ...routing },
      _sendAttempt: 0,
    });
    payload.clientMessageId = userMsg.id;
    payload.idempotencyKey = messageAttemptIdempotencyKey(userMsg.id, 0);
    // 生成占位卡（需求 C）：imageEdit 提交紧随乐观 user 行注入一条**本地专属**占位行
    // （role 'system' 客户端域，空文本），jobId = clientJobId。生成期间 MessageList 拦截
    // 渲染 GeneratingPlaceholderCard；本会话 turn final 由 reducer 按 jobId 消解（结果图作为
    // assistant 消息原位渲染），turn error 转 failed。**不持久化**（toStored 显式剥离）、不进
    // server 历史 → 重开会话不留孤儿卡（reducer 回放路径无此行）。
    this.ensureGenPlaceholder(sess, p.imageEdit, false, userMsg.id);
    this.dispatchPayload(sess, userMsg, payload);
  }

  /** 本会话 turn 结束后继续派发其下一条已持久化消息。 */
  private kickQueuedDrainIfIdle(): void {
    if (this.offlineQueue.length === 0) return;
    this.kickDispatchPump();
  }

  /**
   * 主控建行（每会话一次，幂等）。**只在 PUT 确认成功(返回 true)后才标 ensured**;失败则清
   * inflight、下次发送/重试重建(Codex 审 MAJOR:旧实现发送即标 ensured,PUT 失败被吞 → 永不重建)。
   * 已 ensured → resolve(true);inflight 中 → 共享同一 Promise。发送/目标设置共用。
   */
  private ensureServerSessionOnce(sess: ChatSession, agentId: string): Promise<boolean> {
    if (this.serverSessionEnsured.has(sess.id)) return Promise.resolve(true);
    const existing = this.serverSessionInflight.get(sess.id);
    if (existing) return existing;
    const sid = sess.id;
    const pending = Promise.resolve()
      // modelId 随建行 PUT 携带(读调用时刻的会话选择;服务端 COALESCE,未携带不清空)。
      .then(() => this.deps.ensureServerSession?.(sid, agentId, sess.title, sess._selectedModelId))
      .then((ok) => {
        this.serverSessionInflight.delete(sid);
        // 仅当会话仍在(PUT pending 期间未被 remove/reset)才标 ensured,避免给已删会话留残 marker。
        if (ok && this.sessions.has(sid)) {
          this.serverSessionEnsured.add(sid);
          // 会话级模型选择收敛:受理路径会先于本 PUT 幂等建行(PR#126,后到 PUT 409),
          // PUT 随体的 modelId 竞态输掉时不落地。行确认存在后补一发元数据 PATCH,
          // 与"选择时 PATCH"同一写通道/同一 best-effort 契约(幂等,多写同值无害)。
          const chosen = this.sessions.get(sid)?._selectedModelId;
          if (chosen) void this.deps.persistSessionModel?.(sid, chosen);
        }
        return !!ok;
      })
      .catch(() => {
        this.serverSessionInflight.delete(sid);
        return false;
      });
    this.serverSessionInflight.set(sid, pending);
    return pending;
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
    this.tryEnqueueOffline({
      sessId: sess.id,
      payload,
      msgId: userMsg.id,
      enqueuedAt: payload.ts,
      state: "queued",
    });
    userMsg.status = "queued";
    this.scheduleNotify();
    this.kickDispatchPump();
  }

  private dispatchTurnRecovery(
    sess: ChatSession,
    target: InterruptedContinuationTarget,
    agentId: string,
    automatic: boolean,
  ): void {
    if (sess._sendingInFlight) return;
    if (
      automatic &&
      sess._cancelledAutomaticRecoveryIds?.[target.user.id] === true
    ) {
      return;
    }
    const routing = normalizeRetiredRouting(target.user._routing);
    if (!routing) return;
    const resolvedAgentId = sess.agentId || agentId;
    void this.ensureServerSessionOnce(sess, resolvedAgentId);
    const replay = target.mode === "replay"
      ? exactUserReplayPayload(target.user)
      : null;
    const modelText = replay?.text ?? INTERRUPTED_CONTINUE_PROMPT;
    const displayText = automatic
      ? target.mode === "checkpoint"
        ? AUTOMATIC_RECOVERY_CHECKPOINT_DISPLAY
        : AUTOMATIC_RECOVERY_REPLAY_DISPLAY
      : INTERRUPTED_CONTINUE_DISPLAY;
    const content: InboundMessage["content"] = {
      text: modelText,
      displayText,
      ...(replay?.media ? { media: replay.media } : {}),
      ...(replay?.imageEdit ? { imageEdit: replay.imageEdit } : {}),
      ...(replay?.replyTo ? { replyTo: replay.replyTo } : {}),
      recovery: automatic
        ? {
            sourceClientMessageId: target.user.id,
            mode: target.mode,
            automatic: true,
            rootClientMessageId: target.rootClientMessageId!,
            attempt: target.attempt!,
            max: AUTOMATIC_TURN_RETRY_MAX,
          }
        : {
            sourceClientMessageId: target.user.id,
            mode: target.mode,
            automatic: false,
          },
    };
    const payload: InboundMessage = {
      type: "inbound.message",
      idempotencyKey: target.idempotencyKey,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: resolvedAgentId,
      content,
      ...(replay?.replyTo ? { replyToId: replay.replyTo.messageId } : {}),
      ...(Object.prototype.hasOwnProperty.call(routing, "effortLevel")
        ? { effortLevel: routing.effortLevel as InboundMessage["effortLevel"] }
        : {}),
      ...(routing.model ? { model: routing.model } : {}),
      ...(routing.teamMode ? { teamMode: true } : {}),
      ts: Date.now(),
      clientMessageId: target.clientMessageId,
    };
    if (automatic) {
      target.user._automaticRecoveryAttempted = true;
    }
    const userMsg = addMessage(sess, "user", displayText, {
      id: target.clientMessageId,
      status: "sending",
      _isAutoRetry: true,
      _modelText: modelText,
      ...(replay?.media ? { _media: replay.media } : {}),
      ...(replay?.imageEdit ? { _imageEdit: replay.imageEdit } : {}),
      ...(replay?.replyTo ? { _replyTo: replay.replyTo } : {}),
      _idem: target.idempotencyKey,
      _routing: { ...routing },
      _continuationOfClientMessageId: target.user.id,
      _recoveryOfClientMessageId: target.user.id,
      _recoveryMode: target.mode,
      _automaticRecovery: automatic,
      ...(automatic
        ? {
            _automaticRecoveryRootClientMessageId: target.rootClientMessageId,
            _automaticRecoveryAttempt: target.attempt,
            _automaticRecoveryMax: AUTOMATIC_TURN_RETRY_MAX,
          }
        : {}),
    });
    if (automatic && target.attempt) {
      sess._turnStatus = {
        kind: "retrying",
        attempt: target.attempt,
        max: AUTOMATIC_TURN_RETRY_MAX,
        retryAt: Date.now(),
      };
    }
    sess._lastRouting = { ...routing };
    if (replay?.imageEdit) {
      this.ensureGenPlaceholder(sess, replay.imageEdit, true, userMsg.id);
    }
    this.dispatchPayload(sess, userMsg, payload);
  }

  private async autoRecoverTerminalTurn(
    sessId: string,
    clientMessageId?: string,
  ): Promise<void> {
    if (this.masterOwnsAutomaticRecovery) return;
    const pendingKey = `${sessId}\0${clientMessageId ?? "tail"}`;
    const beforeSync = this.sessions.get(sessId);
    if (beforeSync?._automaticRecoveryDecisions?.[clientMessageId ?? "tail"] === true) return;
    if (beforeSync && clientMessageId) {
      const sourceUserIndex = beforeSync.messages.findIndex((message) =>
        message.role === "user" && message.id === clientMessageId);
      if (
        sourceUserIndex >= 0 &&
        beforeSync.messages.slice(sourceUserIndex + 1).some((message) => message.role === "user")
      ) {
        beforeSync._automaticRecoveryDecisions = {
          ...(beforeSync._automaticRecoveryDecisions ?? {}),
          [clientMessageId]: true,
        };
        this.deps.persistSession?.(sessId);
        return;
      }
    }
    if (this.automaticRecoveryPending.has(pendingKey)) return;
    this.automaticRecoveryPending.add(pendingKey);
    try {
      await this.deps.syncSession?.(
        sessId,
        clientMessageId ? { clientMessageId } : undefined,
      );
      const sess = this.sessions.get(sessId);
      if (!sess || sess._sendingInFlight || sess._dispatchPaused) return;
      const error = [...sess.messages].reverse().find((message) =>
        message.role === "assistant" &&
        !!message._errorCode &&
        (clientMessageId === undefined || message._clientMessageId === clientMessageId));
      if (!error) return;
      const target = automaticTurnRecoveryTarget(sess.messages, error, sess.id);
      if (!target) return;
      if (sess._cancelledAutomaticRecoveryIds?.[target.user.id] === true) return;
      if (sess._automaticRecoveryDecisions?.[target.user.id] === true) return;
      sess._automaticRecoveryDecisions = {
        ...(sess._automaticRecoveryDecisions ?? {}),
        [target.user.id]: true,
      };
      this.deps.persistSession?.(sess.id);
      this.dispatchTurnRecovery(
        sess,
        target,
        sess.agentId || this.deps.defaultAgentId || "main",
        true,
      );
    } finally {
      this.automaticRecoveryPending.delete(pendingKey);
    }
  }

  /** Continue one interrupted, already-executed turn without replaying its
   * original prompt or attachments. The old tape remains immutable; this
   * appends a separately admitted user turn in the same native session. */
  continueInterruptedTurn(p: {
    sessId: string;
    errorMessageId: string;
    agentId: string;
  }): void {
    const sess = this.sessions.get(p.sessId);
    if (!sess || sess._sendingInFlight) return;
    sess._dispatchPaused = false;
    const error = sess.messages.find(
      (message) => message.id === p.errorMessageId && message.role === "assistant",
    );
    if (!error) return;
    const target = interruptedContinuationTarget(sess.messages, error, sess.id);
    if (!target) return;
    this.dispatchTurnRecovery(sess, target, p.agentId, false);
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
    /** Exact lazy-hydrated source for this dispatch only. It is deliberately
     * not assigned into the hot session or IndexedDB locator. */
    sourceOverride?: ChatMessage;
  }): void {
    const sess = this.sessions.get(p.sessId);
    if (!sess) return;
    sess._dispatchPaused = false;
    const userMsg = sess.messages.find((m) => m.id === p.msgId && m.role === "user");
    if (!userMsg || userMsg.status !== "error") return;
    const source = p.sourceOverride?.id === userMsg.id && p.sourceOverride.role === "user"
      ? p.sourceOverride
      : userMsg;
    // 主控建行可能在首发失败时未确保 → 幂等补一次(best-effort,不阻塞发送)。
    const agentId = sess.agentId || p.agentId;
    void this.ensureServerSessionOnce(sess, agentId);
    const replay = exactUserReplayPayload(source);
    // Historical rows written before message-level snapshots fall back to the session
    // snapshot; all new rows bind retry routing to the original user turn.
    // NB: the red-card precise CTA never reaches this fallback — resolveRetryTarget gates it
    // behind preciseRetryEligible (own _routing required). Only the manual user-bubble retry
    // (legacy send-failure rows) may still fall back to _lastRouting, and that path is preserved.
    const routing = normalizeRetiredRouting(source._routing ?? userMsg._routing ?? sess._lastRouting);
    if (routing) {
      userMsg._routing = { ...routing };
      // Continuations belong to the retried turn, not to a later turn that last
      // overwrote the session snapshot before this retry was dispatched.
      sess._lastRouting = { ...routing };
    }
    const payload: InboundMessage = {
      type: "inbound.message",
      idempotencyKey: "web:pending:retry",
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId,
      content: {
        text: replay.text,
        ...(replay.displayText !== undefined ? { displayText: replay.displayText } : {}),
        ...(replay.media ? { media: replay.media } : {}),
        ...(replay.imageEdit ? { imageEdit: replay.imageEdit } : {}),
        ...(replay.replyTo ? { replyTo: replay.replyTo } : {}),
      },
      ...(replay.replyTo ? { replyToId: replay.replyTo.messageId } : {}),
      ...(routing && Object.prototype.hasOwnProperty.call(routing, "effortLevel")
        ? { effortLevel: routing.effortLevel as InboundMessage["effortLevel"] }
        : {}),
      ...(routing?.model ? { model: routing.model } : {}),
      ...(routing?.teamMode ? { teamMode: true } : {}),
      ts: Date.now(),
    };
    // 重试语义分流(RFC §5):
    //  - **dispatch 终态**(_dispatchTerminal / 稳定错误码指向同轮):
    //    server 已**证明该 clientMessageId 未被接受或已终态**,复用旧 id 只会撞 admitUserTurn 的
    //    previously_failed 幂等错误帧、永远起不了新 turn。故铸**新 clientMessageId = 新逻辑 turn**,
    //    并清掉旧轮残留的 durable dispatch status。
    //  - 其余 **resend-uncertain**(网络失败等,不确定是否已达 server):**复用旧 id + attempt 递增**,
    //    靠 gateway inbound 幂等去重防重复计费(dedup 保护),绝不铸新 id。
    if (this.isDispatchTerminalFailure(sess, userMsg)) {
      const staleCmid = userMsg.id;
      const freshId = mintMsgId();
      sess.messages = sess.messages.filter(
        (m) => !(m && m._clientMessageId === staleCmid && isDispatchTerminalRow(m)),
      );
      // The new id is dispatch identity, not storage identity. A deferred
      // payload may still exist only under the previous immutable sidecar key
      // while this retry is offline/in flight, so retain that key in the tiny
      // locator persisted to IndexedDB. A later server echo for `freshId`
      // replaces it with the newly durable sidecar locator.
      if (userMsg._userPayloadDeferred === true && !userMsg._userPayloadId) {
        userMsg._userPayloadId = staleCmid;
      }
      userMsg.id = freshId;
      userMsg._errorCode = undefined;
      userMsg._errorDetail = undefined;
      userMsg._sendAttempt = 0;
      payload.clientMessageId = freshId;
      payload.idempotencyKey = messageAttemptIdempotencyKey(freshId, 0);
    } else {
      payload.clientMessageId = userMsg.id;
      const previousAttempt = Number.isSafeInteger(userMsg._sendAttempt) && (userMsg._sendAttempt ?? 0) >= 0
        ? userMsg._sendAttempt!
        : 0;
      const nextAttempt = previousAttempt + 1;
      userMsg._sendAttempt = nextAttempt;
      payload.idempotencyKey = messageAttemptIdempotencyKey(userMsg.id, nextAttempt);
    }
    userMsg.status = "sending"; // 立即回显；dispatchPayload 据结果改 sent/queued/error
    // 生成占位卡（需求 C）：imageEdit 重试复用同 clientJobId → 重置上次失败的占位回 running。
    this.ensureGenPlaceholder(sess, replay.imageEdit, true, userMsg.id);
    this.dispatchPayload(sess, userMsg, payload);
  }

  /**
   * 该 user 行的发送失败是否源于 durable dispatch 终态(RFC §5 重试分流判据)。**去枚举化**:
   * 判据走 server 持久标记 `_dispatchTerminal` + 不可变 tape 稳定协议码,
   * 而非前端枚举内部 failureCode —— 单一权威 isDispatchTerminalRow。命中任一:
   *  - user 行自身被标记 dispatch 终态(或带稳定协议码);
   *  - 同 _clientMessageId(= user 行 id)存在 dispatch 终态行(_dispatchTerminal / 稳定码)。
   * 命中 → 重试铸新 clientMessageId;否则复用旧 id(dedup 保护)。
   */
  private isDispatchTerminalFailure(sess: ChatSession, userMsg: ChatMessage): boolean {
    if (userMsg._dispatchTerminal === true || isDispatchLostCode(userMsg._errorCode)) return true;
    const cmid = userMsg.id;
    return sess.messages.some(
      (m) => m != null && m._clientMessageId === cmid && isDispatchTerminalRow(m),
    );
  }

  private enqueueControl(item: PendingControlItem, alreadyPersisted = false): void {
    if (this.controlQueue.some((candidate) => candidate.controlId === item.controlId)) return;
    this.controlQueue.push(item);
    this.controlQueue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    if (alreadyPersisted) {
      item.status = "queued";
      this.kickControlPump();
      return;
    }
    this.persistControl(item);
  }

  private persistControl(item: PendingControlItem): void {
    if (!this.controlQueue.includes(item) || item.status === "persisting") return;
    item.status = "persisting";
    const persist = this.deps.persistPendingControl;
    if (!persist) {
      // Test/SSR adapters without storage still use the rolling-compatible
      // in-memory path. Production always wires SessionStore.
      item.status = "queued";
      this.kickControlPump();
      return;
    }
    const durable: StoredPendingControl = { ...item, status: "queued" };
    void Promise.resolve(persist(durable)).then(
      () => {
        if (!this.controlQueue.includes(item)) return;
        item.status = "queued";
        this.kickControlPump();
      },
      () => {
        if (!this.controlQueue.includes(item)) return;
        item.status = "waiting_persist";
        item.attempt += 1;
        const sess = this.sessions.get(item.sessId);
        if (sess) {
          sess._recoveryStatus = {
            kind: "waiting-service",
            attempt: item.attempt,
            errorCode: "control_journal_unavailable",
          };
          this.scheduleNotify();
        }
        const delay = Math.min(30_000, 1000 * (2 ** Math.min(item.attempt - 1, 5)));
        const timer = setTimeout(() => {
          this.controlPersistRetryTimers.delete(item.controlId);
          this.persistControl(item);
        }, delay);
        this.controlPersistRetryTimers.set(item.controlId, timer);
      },
    );
  }

  private resetControlsForReplay(): void {
    for (const item of this.controlQueue) {
      if (item.status === "awaiting_receipt" || item.status === "persisted") {
        item.status = "queued";
      }
    }
  }

  private kickControlPump(): void {
    if (this.controlPumpScheduled) return;
    this.controlPumpScheduled = true;
    try {
      if (!this.ws || this.ws.readyState !== 1 || !this.relayReady) return;
      for (let index = 0; index < this.controlQueue.length; index += 1) {
        const item = this.controlQueue[index]!;
        if (item.status !== "queued") continue;
        // Persistence transactions may settle out of order. Preserve each
        // session's user intent order without letting an unrelated session's
        // slow IndexedDB transaction block its controls.
        if (this.controlQueue.slice(0, index).some((earlier) =>
          earlier.sessId === item.sessId &&
          (earlier.status === "persisting" || earlier.status === "waiting_persist"))) {
          continue;
        }
        item.attempt += 1;
        if (!this.safeWsSend(JSON.stringify(item.payload))) {
          item.attempt -= 1;
          break;
        }
        item.status = "awaiting_receipt";
        const sess = this.sessions.get(item.sessId);
        if (sess?._stopSettlement?.controlId === item.controlId) {
          sess._stopSettlement.phase = "awaiting_receipt";
          sess._recoveryStatus = { kind: "stopping", attempt: item.attempt };
        }
      }
      this.scheduleNotify();
    } finally {
      this.controlPumpScheduled = false;
    }
  }

  private settleControl(controlId: string, status: "applied" | "terminal"): void {
    const index = this.controlQueue.findIndex((item) => item.controlId === controlId);
    if (index < 0) return;
    const [item] = this.controlQueue.splice(index, 1);
    const retryTimer = this.controlPersistRetryTimers.get(controlId);
    if (retryTimer) clearTimeout(retryTimer);
    this.controlPersistRetryTimers.delete(controlId);
    const durableClear = this.deps.deletePendingControl?.(item.sessId, controlId);
    if (durableClear) void durableClear.catch(() => {});
    const sess = this.sessions.get(item.sessId);
    if (!sess) return;
    if (item.controlKind === "stop") {
      this.clearContinuousReconcile(sess.id);
      this.finishDispatch(sess.id, item.clientMessageId);
      sess._stopSettlement = undefined;
      this.clearSendingState(sess, { clearThinking: true });
    } else if (item.requestId) {
      const permission = sess.messages.find((message) => message.requestId === item.requestId);
      if (permission) {
        permission._resolved = true;
        permission._behavior = item.behavior;
        permission._controlPending = false;
      }
    }
    sess._recoveryStatus = {
      kind: item.controlKind === "permission" ? "resumed" : "completed",
    };
    this.deps.persistSession?.(sess.id);
    this.scheduleNotify();
    if (status === "applied") this.reconcileSession(sess.id);
  }

  private applyControlReceipt(frame: OutboundControlReceiptWire): void {
    const item = this.controlQueue.find((candidate) => candidate.controlId === frame.controlId);
    if (!item || item.controlKind !== frame.controlKind) return;
    if (frame.peer?.id && frame.peer.id !== item.sessId) return;
    if (item.clientMessageId && frame.clientMessageId && frame.clientMessageId !== item.clientMessageId) return;
    if (item.requestId && frame.requestId && frame.requestId !== item.requestId) return;
    const sess = this.sessions.get(item.sessId);
    if (frame.status === "persisted" || (frame.status === "applied" && item.controlKind === "stop")) {
      item.status = "persisted";
      const stopSettlement = sess?._stopSettlement;
      if (sess && stopSettlement?.controlId === frame.controlId) {
        stopSettlement.phase = "persisted";
        sess._recoveryStatus = {
          kind: "stopping",
          masterPersisted: true,
          attempt: frame.attempt ?? item.attempt,
          ...(frame.errorCode ? { errorCode: frame.errorCode } : {}),
        };
      } else if (sess) {
        sess._recoveryStatus = {
          kind: "needs-confirmation",
          attempt: frame.attempt ?? item.attempt,
          ...(frame.errorCode ? { errorCode: frame.errorCode } : {}),
        };
      }
      this.deps.persistSession?.(item.sessId);
      this.scheduleNotify();
      return;
    }
    this.settleControl(frame.controlId, frame.status);
  }

  /** Register the exact logical turn synchronously. There is intentionally no
   * arbitrary item/byte cap: IndexedDB + per-session FIFO provide backpressure
   * without silently rejecting user work. */
  private tryEnqueueOffline(item: OfflineItem): boolean {
    if (this.offlineQueue.some((candidate) =>
      candidate.sessId === item.sessId && candidate.msgId === item.msgId)) return true;
    this.offlineQueue.push(item);
    this.offlineQueue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    return true;
  }

  private kickDispatchPump(): void {
    if (this.dispatchPumpScheduled) return;
    this.dispatchPumpScheduled = true;
    try {
      this.pumpPendingDispatches();
    } finally {
      this.dispatchPumpScheduled = false;
    }
  }

  private pumpPendingDispatches(): void {
    if (!this.ws || this.ws.readyState !== 1 || !this.relayReady) return;
    for (const item of this.offlineQueue) {
      if (item.state !== "queued") continue;
      const sess = this.sessions.get(item.sessId);
      if (!sess) continue;
      if (sess._dispatchPaused) continue;
      const slot = this.dispatchSlots.get(item.sessId);
      if (slot !== undefined && slot !== item.msgId) continue;
      if (sess._sendingInFlight && sess._activeClientMessageId !== item.msgId) continue;
      this.dispatchSlots.set(item.sessId, item.msgId);
      item.state = "persisting";
      this.setTransientNotice(sess.id, "正在发送…");
      const committed = this.deps.persistPendingDispatch?.(item.sessId, {
        msgId: item.msgId,
        payload: item.payload,
        enqueuedAt: item.enqueuedAt,
      });
      if (committed) {
        void committed.then(
          () => this.sendPersistedDispatch(item),
          () => this.handleDispatchJournalFailure(item),
        );
      } else {
        // Unit/SSR adapters without persistence keep their existing in-memory
        // behavior. Production always supplies persistPendingDispatch.
        this.sendPersistedDispatch(item);
      }
    }
  }

  private handleDispatchJournalFailure(item: OfflineItem): void {
    if (!this.offlineQueue.includes(item) || item.state !== "persisting") return;
    // Local recovery storage is an enhancement, not a delivery gate. Keep the
    // exact in-memory identity until the server ACK and send immediately.
    this.sendPersistedDispatch(item, false);
  }

  private sendPersistedDispatch(item: OfflineItem, journalCommitted = true): void {
    if (!this.offlineQueue.includes(item) || item.state !== "persisting") return;
    if (
      !this.ws || this.ws.readyState !== 1 || !this.relayReady ||
      this.dispatchSlots.get(item.sessId) !== item.msgId
    ) {
      item.state = "queued";
      return;
    }
    if (!this.safeWsSend(JSON.stringify(item.payload))) {
      item.state = "queued";
      return;
    }
    item.state = "awaiting_admission";
    const sess = this.sessions.get(item.sessId);
    if (!sess) return;
    const user = sess.messages.find((message) => message.role === "user" && message.id === item.msgId);
    if (user) user.status = "sending";
    // Correlation identity is safe before admission and lets a terminal frame
    // that omits its optional clientMessageId still bind to this exact turn.
    // The user-visible thinking clock remains off until authority confirms.
    sess._activeClientMessageId = item.msgId;
    sess._activeAgentId =
      typeof item.payload.agentId === "string" && item.payload.agentId
        ? item.payload.agentId
        : sess.agentId;
    if (journalCommitted) this.clearTransientNotice(sess.id);
    else this.setTransientNotice(sess.id, "正在确认发送…");
    this.scheduleNotify();
    this.deps.persistSession?.(sess.id);
  }

  stopTurn(sessId: string): void {
    const sess = this.sessions.get(sessId);
    if (!sess) return;
    const pending = this.offlineQueue.filter((item) => item.sessId === sessId);
    if (!sess._sendingInFlight && pending.length === 0) return;
    const slottedClientMessageId = this.dispatchSlots.get(sessId);
    const activeClientMessageId =
      sess._activeClientMessageId ??
      slottedClientMessageId ??
      pending[0]?.msgId;
    const activeItem = activeClientMessageId
      ? pending.find((item) => item.msgId === activeClientMessageId)
      : undefined;
    const activeUser = activeClientMessageId
      ? sess.messages.find(
          (message) =>
            message.role === "user" && message.id === activeClientMessageId,
        )
      : undefined;
    const cancelIds = new Set<string>();
    if (activeItem) cancelIds.add(activeItem.msgId);
    for (const item of pending) {
      const user = sess.messages.find(
        (message) => message.role === "user" && message.id === item.msgId,
      );
      if (user?._isAutoRetry === true || user?._automaticRecovery === true) {
        cancelIds.add(item.msgId);
      }
    }

    const cancelledLineageIds = new Set<string>();
    const addCancelledLineage = (user: ChatMessage | undefined) => {
      if (!user) return;
      cancelledLineageIds.add(user.id);
      if (user._recoveryOfClientMessageId) {
        cancelledLineageIds.add(user._recoveryOfClientMessageId);
      }
      if (user._continuationOfClientMessageId) {
        cancelledLineageIds.add(user._continuationOfClientMessageId);
      }
    };
    addCancelledLineage(activeUser);
    for (const item of pending) {
      if (!cancelIds.has(item.msgId)) continue;
      addCancelledLineage(
        sess.messages.find(
          (message) => message.role === "user" && message.id === item.msgId,
        ),
      );
    }
    if (cancelledLineageIds.size > 0) {
      sess._cancelledAutomaticRecoveryIds = {
        ...(sess._cancelledAutomaticRecoveryIds ?? {}),
      };
      for (const id of cancelledLineageIds) {
        sess._cancelledAutomaticRecoveryIds[id] = true;
      }
    }

    const mayHaveReachedServer =
      sess._sendingInFlight ||
      activeItem?.state === "awaiting_admission";
    const cancelPending = pending.filter((item) =>
      cancelIds.has(item.msgId) &&
      !(mayHaveReachedServer && item.msgId === activeClientMessageId));
    const preservedManual = pending.filter((item) =>
      !cancelIds.has(item.msgId) && item.msgId !== activeClientMessageId);
    // Stop never implicitly submits work queued behind the stopped turn.
    // It remains visible and durable until the user's next explicit send/retry.
    sess._dispatchPaused = preservedManual.length > 0;
    for (const item of cancelPending) {
      this.clearPendingDispatch(sess.id, item.msgId);
      const user = sess.messages.find(
        (message) => message.role === "user" && message.id === item.msgId,
      );
      if (user && user.status !== "sent") {
        user.status = "error";
        user._errorDetail =
          user._isAutoRetry === true || user._automaticRecovery === true
            ? "自动重试已停止"
            : "发送已取消";
      }
    }
    if (mayHaveReachedServer) {
      const existing = this.controlQueue.find((item) =>
        item.controlKind === "stop" &&
        item.sessId === sess.id &&
        item.clientMessageId === activeClientMessageId);
      if (existing) return;
      const sendAttempt =
        Number.isSafeInteger(activeUser?._sendAttempt) && (activeUser?._sendAttempt ?? 0) > 0
          ? activeUser!._sendAttempt!
          : 0;
      const stopIdentity = activeClientMessageId
        ? sendAttempt > 0
          ? `${activeClientMessageId}:attempt:${sendAttempt}`
          : activeClientMessageId
        : `peer:${sess.id}:${mintMsgId()}`;
      const controlId = stableControlId("stop", stopIdentity);
      const agentId =
        sess._activeAgentId ||
        activeItem?.payload.agentId ||
        sess.agentId ||
        this.deps.defaultAgentId ||
        "main";
      // Freeze the visible stream at the user's cancellation boundary without
      // pretending the remote turn is already terminal. The exact identity
      // remains active/busy until Master supplies terminal authority.
      resetReplyTracker(sess);
      sess._localTeardownAt = sess._trackerResetAt;
      sess._sendingInFlight = true;
      sess._activeClientMessageId = activeClientMessageId;
      sess._activeAgentId = agentId;
      sess._stopSettlement = {
        ...(activeClientMessageId ? { clientMessageId: activeClientMessageId } : {}),
        controlId,
        phase: "persisting",
      };
      sess._recoveryStatus = { kind: "stopping" };
      this.enqueueControl({
        kind: "control",
        sessId: sess.id,
        controlId,
        controlKind: "stop",
        ...(activeClientMessageId ? { clientMessageId: activeClientMessageId } : {}),
        agentId,
        payload: {
          type: "inbound.control.stop",
          controlId,
          channel: "webchat",
          peer: { id: sess.id, kind: "dm" },
          agentId,
          ...(activeClientMessageId ? { clientMessageId: activeClientMessageId } : {}),
        },
        enqueuedAt: Date.now(),
        attempt: 0,
        status: "queued",
      });
      this.deps.persistSession?.(sess.id);
    } else {
      if (activeClientMessageId) this.finishDispatch(sess.id, activeClientMessageId);
      this.dispatchSlots.delete(sess.id);
      this.clearSendingState(sess, { clearThinking: true });
      sess._recoveryStatus = { kind: "completed" };
    }
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
    const controlId = stableControlId("permission", `${p.requestId}:${p.behavior}`);
    if (this.controlQueue.some((item) => item.controlId === controlId)) return;
    const payload: StoredPendingControl["payload"] = {
      type: "inbound.permission_response",
      controlId,
      channel: "webchat",
      peer: { id: sess.id, kind: "dm" },
      agentId: sess.agentId || this.deps.defaultAgentId || "main",
      requestId: p.requestId,
      behavior: p.behavior,
      message: p.message || undefined,
      ...(p.updatedInput && p.behavior === "allow" ? { updatedInput: p.updatedInput } : {}),
    };
    const msg = sess.messages.find((m) => m.requestId === p.requestId);
    if (msg) {
      msg._controlPending = true;
    }
    sess._recoveryStatus = { kind: "needs-confirmation" };
    this.enqueueControl({
      kind: "control",
      sessId: sess.id,
      controlId,
      controlKind: "permission",
      requestId: p.requestId,
      behavior: p.behavior,
      agentId: sess.agentId || this.deps.defaultAgentId || "main",
      payload,
      enqueuedAt: Date.now(),
      attempt: 0,
      status: "queued",
    });
    this.deps.persistSession?.(sess.id);
    this.scheduleNotify();
  }

  // ═══════════════ 单次 auto-continue（确定性 idempotencyKey，§7）═══════════════
  private autoContinueEmptyTurn(sessId: string, targetMsgId: string, cls: EmptyTurnDecision): void {
    const sess = this.sessions.get(sessId);
    if (!sess) return;
    if (sess._sendingInFlight || sess._dispatchPaused) return; // 旧 final teardown 后已有新 turn → 放弃
    const idx = sess.messages.findIndex((m) => m && m.id === targetMsgId);
    if (idx < 0) return;
    const target = sess.messages[idx];
    if (
      target._clientMessageId &&
      sess._cancelledAutomaticRecoveryIds?.[target._clientMessageId] === true
    ) {
      return;
    }
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

    const hasQueued = this.offlineQueue.some((item) => item.sessId === sess.id);
    if (!(this.ws && this.ws.readyState === 1 && this.relayReady) || hasQueued) {
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
      _automaticRecovery: true,
      ...(target._clientMessageId
        ? {
            _recoveryOfClientMessageId: target._clientMessageId,
            _continuationOfClientMessageId: target._clientMessageId,
          }
        : {}),
      _modelText: AUTO_CONTINUE_PROMPT,
      _idem: idem,
    });
    payload.clientMessageId = userMsg.id;
    this.dispatchPayload(sess, userMsg, payload);
  }

  /** dedup ack 对账：另一 tab/replay 已跑过同一 auto-continue，清乐观 in-flight。*/
  private clearAutoContinueInFlight(idem: string): void {
    for (const sess of this.sessions.values()) {
      if (!sess.messages.some((m) => m && m._isAutoRetry && m._idem === idem)) continue;
      if (!sess._sendingInFlight) return;
      this.finishDispatch(sess.id, sess._activeClientMessageId);
      this.clearSendingState(sess, { clearTiming: false, resetTracker: false, clearThinking: true });
      this.scheduleNotify();
      return;
    }
  }

}
