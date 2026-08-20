/**
 * v5 WS wire 帧类型 —— 唯一权威是 packages/protocol/src/frames.ts。
 *
 * 这里**不另起一套帧枚举**：出/入站帧的结构定义全部 type-only 复用
 * `@openclaude/protocol/frames`（typebox 在 type-only import 下被构建期擦除，
 * 不进浏览器 bundle）。本文件只做两件 protocol 没覆盖、但运行期真实存在的事：
 *
 *  1. **runtime augmentation**：gateway 在 wire 上额外盖了几个 typebox schema 里
 *     没声明的字段——`frameSeq`（per-session 单调去重序号）、`ts`（server 时间戳，
 *     stale-final 守卫用）、`cronJob`（cron/task 推送标记）、以及 `meta.interrupted`
 *     （service_restart 合成 final 标记）。这些是消费侧不变量的硬依赖（见 §3/§7/§11），
 *     在类型层 augment 出来，避免散落的 `(frame as any)`。
 *  2. **聚合判别联合**：把消费侧 onmessage 分发表（websocket.js:2376-2419）需要识别的
 *     帧聚成一个 `InboundWire` / `OutboundWire` 判别联合，外加 v5 仍可能到达但 protocol
 *     未建模的轻量控制帧（pong / ack / cost_charged / cold_start / repo_status）。
 *
 * codex 帧（outbound.codex_billing / conversationMode:'plan'）v5 P1f 已删、不会到达，
 * 故这里不纳入消费联合；inbound 仍保留 protocol 的 model/effortLevel 顶层字段语义。
 */
import type {
  CallTokenUsageSnapshot,
  InboundControlStop,
  InboundMessage,
  InboundPermissionResponse,
  InboundPromptQueueDelete,
  InboundPromptQueueEdit,
  InboundPromptQueueEnqueue,
  InboundPromptQueueInterject,
  InboundPromptQueueReorder,
  MediaRef,
  OutboundActiveTurnReplayStart,
  OutboundCallUsage,
  OutboundContentBlock,
  OutboundError,
  OutboundMessage,
  OutboundPermissionRequest,
  OutboundPermissionSettled,
  OutboundResumeFailed,
  OutboundTurnStatus,
  OutboundTurnUsage,
  Peer,
  PromptQueueMutationFrame,
  PromptQueueSnapshot,
  TurnTokenUsageSnapshot,
} from "@openclaude/protocol/frames";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";

export type {
  InboundPromptQueueDelete,
  InboundPromptQueueEdit,
  InboundPromptQueueEnqueue,
  InboundPromptQueueInterject,
  InboundPromptQueueReorder,
  MediaRef,
  OutboundContentBlock,
  CallTokenUsageSnapshot,
  Peer,
  PromptQueueSnapshot,
  TurnTokenUsageSnapshot,
};

// ─── runtime-augmented 公共片段 ──────────────────────────────────────
/**
 * gateway 在每个 session-scoped outbound 帧上盖的运行期字段，protocol typebox
 * schema 未声明但 wire 必有/可能有：
 *  - frameSeq：per-sessionKey 单调序号，去重游标用（§3）。可能缺省（legacy/无序帧）。
 *  - ts：server 时间戳（ms），stale-final 跨时钟域守卫用（§11）。
 *  - sessionKey：protocol 多数帧已声明；这里冗余以兼容偶发缺省。
 */
export type WireRuntimeFields = {
  frameSeq?: number;
  ts?: number;
  sessionKey?: string;
};

/** cron/task 后台推送标记（无 peer 或落当前会话时带）。*/
export type CronPushMeta = {
  heartbeat?: boolean;
  label?: string;
};

/** outbound.message.meta + 运行期 interrupted / reconcile 标记（合成 final）。*/
export type OutboundMessageMeta = NonNullable<OutboundMessage["meta"]> & {
  /** 'service_restart' = 重连期 gateway 推的带外清理 final（§11）。*/
  interrupted?: string;
  /**
   * 'turn_completed' = 重连 hello 对账时,server 判定该轮**已在服务端正常收尾**但客户端仍挂
   * 发送态(missed final)而合成的空 blocks final。前端据此清发送态 + 强制 REST 对账拉回丢失内容,
   * 且**不合成空轮气泡**(它不是真正的空轮,内容在服务端已生成)。见 applyOutboundMessage。
   */
  reconcile?: string;
};

// ─── 出站帧（gateway → client，消费侧）───────────────────────────────
export type OutboundMessageWire = Omit<OutboundMessage, "meta"> &
  WireRuntimeFields & {
    meta?: OutboundMessageMeta;
    /** cron/task 推送（个人版语义，v5 商业版基本不触发，保留兜底分支）。*/
    cronJob?: CronPushMeta;
  };

export type OutboundErrorWire = OutboundError & WireRuntimeFields;
export type OutboundPermissionRequestWire = OutboundPermissionRequest & WireRuntimeFields;
export type OutboundPermissionSettledWire = OutboundPermissionSettled & WireRuntimeFields;
export type OutboundResumeFailedWire = OutboundResumeFailed & WireRuntimeFields;
export type OutboundActiveTurnReplayStartWire = OutboundActiveTurnReplayStart;
export type OutboundTurnStatusWire = OutboundTurnStatus & WireRuntimeFields;
export type OutboundTurnUsageWire = OutboundTurnUsage & WireRuntimeFields;
export type OutboundCallUsageWire = OutboundCallUsage & WireRuntimeFields;
export type OutboundModelSwitchPreparedWire = {
  type: "outbound.model_switch.prepared";
  requestId: string;
  sessionKey: string;
  sourceModel: string;
  targetModel: string;
  status: "completed" | "failed";
  errorCode?: string;
  message?: string;
} & WireRuntimeFields;

export type OutboundControlReceiptWire = {
  type: "outbound.control.receipt";
  controlId: string;
  controlKind: "stop" | "permission";
  status: "persisted" | "applied" | "terminal";
  peer?: Peer;
  clientMessageId?: string;
  requestId?: string;
  attempt?: number;
  errorCode?: string;
} & WireRuntimeFields;

/** legacy bridge error 帧（`type:'error'`，protocol 未建模）。*/
export type LegacyBridgeErrorWire = {
  type: "error";
  peer?: Peer;
  clientMessageId?: string;
  code?: string;
  message?: string;
  traceId?: string;
} & WireRuntimeFields;

/** 商业版扣费广播（master→user）。**不进 frameSeq 去重**（§3）。*/
export type CostChargedWire = {
  type: "outbound.cost_charged";
  /** Stable model-request identity. Chat billing paths always provide it;
   * media-only charges omit it and therefore cannot drive a turn reminder. */
  requestId?: string;
  /** agent 内部会话 UUID（引擎会话，非 client peer 键）。历史字段，直接 sessions.get 必失配。*/
  sessionId?: string;
  /** delegate 成本的父**客户端**会话 id（web-*，= sess.id / peerId）。仅委派 cost 非空。
   *  前端据此把 cost_charged **精确路由**到父客户端会话，消 60s TTL 启发式在多会话并发下的
   *  误算/丢弃（Fix B）；普通 chat 恒 undefined → 回落既有启发式。*/
  parentSessionId?: string;
  balanceAfter?: string | null;
  /** Nominal model cost. Kept as the existing response-badge source. */
  costCredits?: string | null;
  /** Actual credits taken from the user's spendable buckets after clamp. */
  debitedCredits?: string | null;
};

/** turn 免单退款广播（master→user）：精确退款与站内信已同事务提交。
 *  **不进 frameSeq 去重**（同 cost_charged，§3）。新 master 的 sessionId 是客户端会话
 *  id；旧兼容端点可缺省。*/
export type CostWaivedWire = {
  type: "outbound.cost_waived";
  sessionId?: string;
  /** Exact root logical turn. Missing/unknown keys never mutate a chat row. */
  turnKey: string;
  balanceAfter?: string | null;
  refundedCredits?: string | null;
  reason?: string;
  inboxMessageId?: string;
};

/** 容器冷启提示（typing-indicator 加 “容器首次加载中” 后缀）。*/
export type ColdStartWire = { type: "sys.cold_start"; peer?: Peer };

/** bridge↔容器 relay 真建立的就绪信号（containerWs open，冷暖都发）。readiness 单一权威：
 *  前端据此立即排空离线队列（冷启时 ws.onopen 早于 relay 就绪，期间消息排队等此信号）。*/
export type RelayReadyWire = {
  type: "sys.relay_ready";
  peer?: Peer;
  automaticRecoveryOwner?: "master-v1";
};

/** 前端版本握手：bridge 在 userWs accept 时下发（服务端权威=dist/index.html 的 oc-build meta）。
 *  build=服务端当前 oc-build id 字符串；appUpdate governor 据此在安全点软刷新长驻旧 bundle。*/
export type FrontendBuildWire = { type: "sys.frontend_build"; build?: string };

/**
 * 上下文重建提示帧（容器 sessionManager 注入历史上下文成功后 emit,provider 切换 / 非原生续接场景）。
 * 前端据此插入一条 client-owned 的 system 提示行(role:'system',文案 pure.contextRebuiltNotice),
 * 告知用户"引擎已走兜底重建上下文,更早细节可能记不全"(boss 硬指标 3)。`messageCount` = 注入条数,
 * `ts`/`frameSeq` 供 per-turn 幂等去重。**依赖 Agent B 在 protocol/frames.ts 补同名帧类型**;protocol
 * 就绪前本地此 wire 定义即消费契约(同 FrontendBuildWire/RelayReadyWire 的本地补声明模式)。
 */
export type ContextRebuiltWire = {
  type: "sys.context_rebuilt";
  peer?: Peer;
  agentId?: string;
  messageCount?: number;
} & WireRuntimeFields;

export type GoalSnapshotWire = {
  type: "sys.goal_snapshot";
  goal: GoalStateSnapshot;
};

/**
 * 审批后的用户恢复通知（master→user）。内部 incident 生命周期不再对用户可见；只有
 * userNoticeApproval 在可信全自动修复、精确影响证据、企微审批和在线收件人门禁全部通过后，
 * 才发送 `status='resolved' + noticeKind='approved_recovery'`。普通/open incident 一律忽略。
 * `rev` 按 incidentId 幂等，防重投或乱序导致重复 toast。
 */
export type IncidentWire = {
  type: "sys.incident";
  incidentId: string;
  rev: number;
  status: "open" | "resolved";
  noticeKind?: "approved_recovery";
  severity: "info" | "warning" | "critical";
  surface: string;
  title: string;
  message: string;
  ts: number;
};

export type MediaJobWire = {
  type: "sys.media_job";
  job: MediaGenerationJob;
  ts: number;
};

/** server durable admission / completed-dedup acknowledgement. */
export type AckWire = {
  type: "outbound.ack";
  admitted?: boolean;
  deduplicated?: boolean;
  /** Master atomically rejected a stale/unsafe recovery child. The browser
   * removes only that deterministic optimistic row and keeps the old tape. */
  recoverySkipped?: boolean;
  recoverySkippedReason?: string;
  sourceClientMessageId?: string;
  idempotencyKey?: string;
  peer?: Peer;
  clientMessageId?: string;
};

/** keepalive pong（按 id 匹配，先于一切 session handler 处理）。*/
export type PongWire = { type: "pong"; id?: number };

/**
 * GitHub 仓库绑定状态推送（容器→bridge→client）。protocol 未建模的轻量控制帧。
 * 容器报告 git clone 进度/结果；bridge 落库更新选择状态。version-gate 用 selectionVersion。
 */
export type RepoStatusWire = {
  type: "outbound.control.session_repo_status";
  sessionId: string;
  selectionVersion?: number;
  status: "pending" | "cloning" | "ready" | "failed";
  owner?: string;
  repo?: string;
  branch?: string;
  headSha?: string;
  errorCode?: string;
  errorMessage?: string;
} & WireRuntimeFields;

/** GitHub 绑定校验失败（bridge→client，stale / link 失效 / 内部错）。*/
export type RepoBindErrorWire = {
  type: "outbound.control.session_repo_bind_error";
  sessionId: string;
  selectionVersion?: number;
  errorCode?: string;
  errorMessage?: string;
} & WireRuntimeFields;

/** 消费侧能识别的全部出站帧判别联合。*/
export type OutboundWire =
  | OutboundMessageWire
  | OutboundErrorWire
  | OutboundPermissionRequestWire
  | OutboundPermissionSettledWire
  | OutboundResumeFailedWire
  | OutboundActiveTurnReplayStartWire
  | OutboundTurnStatusWire
  | OutboundTurnUsageWire
  | OutboundCallUsageWire
  | OutboundControlReceiptWire
  | OutboundModelSwitchPreparedWire
  | PromptQueueSnapshot
  | LegacyBridgeErrorWire
  | CostChargedWire
  | CostWaivedWire
  | ColdStartWire
  | RelayReadyWire
  | FrontendBuildWire
  | ContextRebuiltWire
  | GoalSnapshotWire
  | IncidentWire
  | MediaJobWire
  | AckWire
  | PongWire
  | RepoStatusWire
  | RepoBindErrorWire;

// ─── 入站帧（client → gateway，发送侧）───────────────────────────────
export type { InboundControlStop, InboundMessage, InboundPermissionResponse };

/** client 起手 hello（autoResume：每 peer 带 lastFrameSeq）。protocol 未建模。*/
export type InboundHelloWire = {
  type: "inbound.hello";
  channel: "webchat";
  automaticRecoveryOwner: "master-v1";
  /** Actual DOM oc-build running in this browser tab. */
  clientBuild?: string;
  peers: Array<{
    peerId: string;
    agentId: string;
    inFlight: boolean;
    lastFrameSeq: number;
    resumeActiveTurnCandidateMessageIds?: string[];
    /**
     * durable turn dispatch(RFC §4 身份对称):该 peer 当前在飞 turn 的 clientMessageId
     * (= _activeClientMessageId)。**仅在 inFlight 时携带**;autoResumeFromHello 用它绑定
     * ring/inbox 查询到具体 turn 身份,合成 reconcile 帧据此回带同一 clientMessageId,避免
     * 拿上一轮 outcome 冒充当前在飞 turn(R3 根因)。缺省(legacy)→ 服务端走旧行为。
     */
    inFlightClientMessageId?: string;
  }>;
};

/** keepalive ping。*/
export type InboundPingWire = { type: "ping"; id: number };

/**
 * GitHub 仓库绑定（client→bridge→容器）。前端只发 sessionId + 版本 + peer/agentId/channel；
 * bridge 富化 owner/repo/branch/accessToken/headSha 后转发容器。形状严格对齐 v3
 * websocket.js _buildBindFrame。
 */
export type InboundRepoBindWire = {
  type: "inbound.control.session_repo_bind";
  sessionId: string;
  selectionVersion: number;
  peer: Peer;
  agentId: string;
  channel: "webchat";
};

/** GitHub 解绑（client→bridge→容器）。*/
export type InboundRepoUnbindWire = {
  type: "inbound.control.session_repo_unbind";
  sessionId: string;
  selectionVersion: number;
};

export type InboundWire =
  | InboundMessage
  | InboundControlStop
  | InboundPermissionResponse
  | PromptQueueMutationFrame
  | InboundHelloWire
  | InboundPingWire
  | InboundRepoBindWire
  | InboundRepoUnbindWire;

// ─── narrowing 守卫（onmessage 分发用）────────────────────────────────
export function isOutboundFrame(f: unknown): f is OutboundWire {
  return !!f && typeof (f as { type?: unknown }).type === "string";
}
