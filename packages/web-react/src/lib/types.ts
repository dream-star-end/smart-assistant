/**
 * v5 商业版前端类型。鉴权与账户形态对齐 v5 REST 契约
 * (packages/commercial/src/http/{handlers,agent}.ts)。
 */
import type {
  MarketplaceArtifactKind,
  MarketplaceCapabilityInstallOutcome,
  MarketplaceCapabilityReadiness,
  MarketplaceCapabilityRef,
  MarketplacePluginType,
  MarketplaceReviewSource,
} from "@openclaude/protocol";

export type {
  MarketplaceCapabilityReadiness,
  MarketplaceCapabilityRef,
} from "@openclaude/protocol";

/**
 * 当前用户。`displayName` / `roles` 是 UI 既有展示字段（Sidebar / SettingsCenter 等读它），
 * 由 api 层从 v5 后端的 `display_name` / `role` 适配而来，保证组件层零改动。
 * 其余字段是 v5 `/api/me` 的原生字段（按需消费；做成可选以免 demo fixture 冗余）。
 * 重要：`credits` 是字符串大数（可能越过 2^53），**绝不数值化**。
 */
export type User = {
  id: string;
  displayName: string;
  roles: string[];
  email?: string;
  role?: "user" | "admin";
  emailVerified?: boolean;
  avatarUrl?: string | null;
  /** 余额（积分），字符串大数，勿 Number() 化。 */
  credits?: string;
  createdAt?: string;
  /** 企业版(P3.1):caller 的 active org 归属。无归属 → null / 缺省。 */
  org?: OrgMembershipBrief | null;
  /**
   * cohort 分批切流 lane（P3 RFC D1）：`g<generation>.<slot>`（如 g42.B）或 null。
   * 由服务端 evaluateLane 在 /api/me 等响应体下发（同时 Set-Cookie oc_v5lane）；前端仅作
   * 状态/观测持有——**字段缺失=后端未部署 lane=向后兼容视为已就绪**（laneReady 不依赖本值）。
   */
  lane?: string | null;
};

/** /api/me 注入的 org 归属摘要(handleMe LEFT JOIN)。org suspended 仍返回(带 status)。 */
export type OrgRole = "owner" | "admin" | "member";
export type OrgStatus = "active" | "suspended" | "deleting" | "deleted";
export type OrgMembershipBrief = {
  id: string;
  name: string;
  role: OrgRole;
  status: OrgStatus;
  billing_enabled: boolean;
  /** 财务委派(三期 P3.1):owner 授予后可执行组织计费写操作(充值/订阅/加席/发票)。缺省 false。 */
  billing_delegate?: boolean;
};

/**
 * 会话。v5 的会话历史权威源是 WS user-chat-bridge（hello/peer + master 侧持久化），
 * REST 不再提供 chat session CRUD。本期（P2）会话仅为本地脚手架占位，
 * 真实 WS 会话装载在 P4 接入。
 */
export type Session = {
  id: string;
  title: string;
  ownerUserId: string;
  updatedAt: string;
  messageCount: number;
  /** 会话级模型选择(per-session 持久化;缺省 = 未显式选择 → 选择器回落 default_model)。
   *  来源:本地选择写通 / IndexedDB 注水 / listSessions server-wins;App 切会话据此恢复选择器。 */
  modelId?: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  traceId?: string;
};

export type ToolCard = {
  id: string;
  title: string;
  status: string;
  evidence?: string[];
};

// P3.5 计费/账单中心已接入真实 v5 契约：余额走 /api/me 的 credits（字符串大数），
// 账单流水走 /api/me/usage 的 credit_ledger（keyset 分页），充值走 /api/payment/*。
// 旧的本地 Billing/BillingLedgerEntry（分为单位、number）已废弃删除——计费 surface
// 全程消费下方 v5 wire 类型，绝不再数值化大数。

/** access token 与身份代次的原子快照。epoch 每次登录尝试/登出/失效都递增。 */
export type AuthSnapshot = { token: string; epoch: number };

/**
 * 鉴权会话：access token + 身份 epoch 的唯一权威源（仅存内存，绝不落地）。
 *
 * 所有异步 refresh / REST replay / WS 恢复都必须拿起始 epoch 做 commit/expire；这样旧账号的
 * 晚到响应只能变成 stale no-op，绝不能覆盖新登录，也不能把新登录误判过期。
 */
export type AuthSession = {
  snapshot: () => AuthSnapshot;
  /** 开始新身份边界（登录尝试/主动清理）：递增 epoch 并清 token，返回新 epoch。 */
  beginIdentity: () => number;
  /** 仅 expectedEpoch 仍为当前身份时写 token。 */
  commitToken: (expectedEpoch: number, token: string) => boolean;
  /** 仅 expectedEpoch 仍为当前身份时失效一次并通知 UI；重复/晚到调用返回 false。 */
  expire: (expectedEpoch: number) => boolean;
};

/** @deprecated 历史命名，等同 AuthSession；保留以减小调用点改动面。 */
export type Auth = AuthSession;

// ─── v5 REST 契约形态 ────────────────────────────────────────────────

/** 登录成功（POST /api/auth/login）。access token 仅存内存，refresh 走 HttpOnly cookie。 */
export type LoginResult = {
  accessToken: string;
  accessExp: number;
  refreshExp: number;
  remember: boolean;
  user: User;
  /**
   * cohort 分批切流 lane（P3 RFC D1，`g<generation>.<slot>` 或 null）。服务端下发/清除
   * cookie 后在响应体附带；缺失=后端未部署 lane=向后兼容（laneReady 视为已就绪，见 useLaneGate）。
   */
  lane?: string | null;
};

/** 静默刷新（POST /api/auth/refresh）。v5 仅回 access token，不回 user。 */
export type RefreshResult = {
  accessToken: string;
  accessExp: number;
  remember: boolean;
};

/** 静默续期的可判别结果；只有 invalid 才允许把用户带回登录页。 */
export type RefreshOutcome =
  | { kind: "success"; epoch: number; result: RefreshResult }
  | { kind: "invalid"; epoch: number }
  // throttled=true 表示限频早返(nextAllowedAt 未到,本次没发真实网络请求):不是新的失败
  // 证据,消费方不得计入重试次数,只补睡 retryAfterMs(两层时钟亚毫秒错位的收口语义)。
  | { kind: "transient"; epoch: number; retryAfterMs: number; throttled?: boolean }
  | { kind: "stale"; epoch: number };

/** 注册（POST /api/auth/register，201）。 */
export type RegisterResult = { userId: string; verifyEmailSent: boolean };

/** 邮箱验证（POST /api/auth/verify-email）。 */
export type VerifyEmailResult = { userId: string; newlyVerified: boolean };

/** 公开配置（GET /api/public/config）。匿名可读，驱动 Turnstile / 注册开关。 */
export type PublicConfig = {
  turnstileSiteKey: string;
  turnstileBypass: boolean;
  requireEmailVerified: boolean;
  featureRemoteSsh: boolean;
  featureImage2: boolean;
  allowRegistration: boolean;
};

/**
 * 公开模型视图（GET /api/public/models）。字段宽松透传：前端只做展示与选择，
 * 模型准入、计费与思考能力权威均在后端/protocol。
 */
export type PublicModel = {
  id: string;
  /** protocol modelReasoningPolicy 的 API 投影；空数组 = 不支持思考深度。 */
  supported_efforts?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  /** Blended cost vs DeepSeek V4 Pro (one decimal), from GET /api/public/models. */
  cost_x?: number;
  /**
   * 0108 provider 健康度:后端 /api/models 对归属 provider 生效降级的模型注解 true
   * (只注解不过滤)。ModelSelector 据此标「暂不可用」徽记 + 禁选。
   */
  degraded?: boolean;
  [k: string]: unknown;
};

/** 用户偏好快照（GET/PATCH /api/me/preferences）。strict allowlist 在后端，前端宽松透传。 */
export type Preferences = Record<string, unknown>;

/** agent_subscriptions.status（后端权威：commercial/src/agent/subscriptions.ts）。 */
export type AgentSubscriptionStatus = "active" | "expired" | "canceled" | "suspended";

/** agent_containers.status（后端权威：commercial/src/agent/subscriptions.ts）。 */
export type AgentContainerStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "removed"
  | "error";

/** Agent 订阅/容器状态（GET /api/agent/status）。 */
export type AgentStatus = {
  /** false = 系统未开 agent 运行时；true + subscription=null = 用户未订阅。 */
  runtimeReady: boolean;
  /**
   * true = 按需容器模型(v5 ccb 单底座):无 legacy 订阅,容器随 user-chat-bridge WS 连接
   * ensureRunning 起、按 turn 计费。前端跳过订阅 gate 直连 WS,冷启由 useChatSocket 4503 重试处理。
   */
  ondemand: boolean;
  subscription: {
    id: string;
    plan: string;
    status: AgentSubscriptionStatus | string;
    startAt: string;
    endAt: string;
    autoRenew: boolean;
    lastRenewedAt: string | null;
  } | null;
  container: {
    id: string;
    subscriptionId: string | null;
    dockerId: string | null;
    dockerName: string | null;
    image: string | null;
    status: AgentContainerStatus | string;
    lastStartedAt: string | null;
    lastStoppedAt: string | null;
    volumeGcAt: string | null;
    lastError: string | null;
  } | null;
};

/**
 * Agent 开通受理（POST /api/agent/open，202 provisioning）。
 * 402（余额不足，issues 带 shortfall）/ 409（已订阅，issues 带 subscription_id+end_at）
 * 经 ApiError 抛出，调用方按 status 分支。balanceAfter 为字符串大数，勿数值化。
 */
export type AgentOpenResult = {
  subscriptionId: string;
  containerId: string;
  status: string;
  startAt: string;
  endAt: string;
  balanceAfter: string;
  ledgerId: string;
  dockerName: string;
  workspaceVolume: string;
  homeVolume: string;
};

/** Agent 退订（POST /api/agent/cancel）。404 = 未订阅（经 ApiError 抛出）。 */
export type AgentCancelResult = {
  subscriptionId: string;
  endAt: string;
  autoRenew: false;
  wasAutoRenew: boolean;
};

/**
 * 流式对话处理回调（P4 真实 WS 接入时消费）。本期对话传输未实现，保留类型供 P4/P5。
 */
export type StreamError = { code: string; message: string; requestId?: string };
export type StreamHandlers = {
  onDelta: (text: string) => void;
  onToolCard?: (card: ToolCard) => void;
  onError?: (err: StreamError) => void;
  onDone: (payload: { session: Session; messages: Message[] }) => void;
};

// ─── 会话历史（权威源 = gateway/src/server.ts，非 commercial router） ────────
//
// 注意：这一组端点的 wire 形态是 **camelCase**（gateway 直接序列化 storage 层的
// TS 对象 ClientSessionMeta / ClientSession），与 commercial REST 的 snake_case
// 截然不同 —— 故此处类型不做适配，按 wire 原样透传，供 P4/P5 装载真实会话。
// 鉴权：gateway checkHttpAuth 接受 commercial access JWT（按 `c:<sub>` 分区），
// 因此仍走 Bearer + callWithRefresh。messages 内层结构是 P4/P5 的渲染契约，这里宽松 unknown[]。

/** GET /api/sessions/list → { sessions: SessionMeta[] }。列表项，无 messages。 */
export type SessionMeta = {
  id: string;
  agentId: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  lastAt: number;
  messageCount: number;
  updatedAt: number;
  /** 会话级模型选择(服务端 client_sessions.model_id;缺省 = 该会话从未显式选过)。 */
  modelId?: string;
};

/**
 * GET /api/sessions/:id（全量或增量）。
 * - 全量（无 since / since≤0）：isPartial=false，messages 为完整数组。
 * - 增量（?since=<seq>&since_history_revision=<rev>）：revision 匹配时 messages
 *   仅含 `_seq > since` 的增量；legacy 行或 revision 缺失/不匹配降级为
 *   isPartial=false + 全量 messages（后端无副作用回填）。
 * maxSeq 由 messages 实算（非 next_seq-1），客户端据此推进游标。
 *
 * 归档(热尾巴)扩展：行体积到顶前 server 会把最老的一截消息搬进归档 chunk，full/增量
 * 两分支的 `messages` 都可能**只含热尾巴**（`_orderSeq > archivedThroughSeq` 的那截）。
 * `archivedThroughSeq` = 已归档的最大 `_orderSeq`（字段名为滚动兼容保留，
 * 见 persist.mergeFullServerWins）；`archivedCount` = 已归档条数（会话总数 = tail + 归档）。
 * 两者可缺省（老后端/未归档会话）→ 按 0 处理。
 */
export type SessionDetail = {
  id: string;
  userId: string;
  agentId: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  lastAt: number;
  messages: unknown[];
  updatedAt: number;
  /** History revision paired with `maxSeq`; absent only on rolling old backends. */
  historyRevision?: number;
  /** Cursor epoch for the one real browser timeline. */
  timelineGeneration?: number;
  /** Opaque exclusive cursor for the next older unified page. */
  timelineCursor?: string | null;
  timelineHasMore?: boolean;
  /** Highest actual durable `_seq` in the page read snapshot. */
  timelineSnapshotMaxSeq?: number;
  /** Client-local marker: incremental request hit a legacy backend and was retried full. */
  _historyRevisionUnsupported?: true;
  isPartial: boolean;
  totalMessageCount: number;
  maxSeq: number;
  /** 会话级模型选择(见 SessionMeta.modelId;detail 回带供 socket 会话镜像 → IndexedDB)。 */
  modelId?: string;
  /** 已归档条数（会话总数 = 返回的 tail 数 + 此值）。缺省=0（未归档/老后端）。*/
  archivedCount?: number;
  /** 已归档的最大 `_orderSeq` 水位；字段名为滚动兼容保留。缺省=0。*/
  archivedThroughSeq?: number;
};

export type DurableLiveFrame = {
  recordId: string;
  streamKey: string;
  source: "gateway" | "rollout_import";
  clientMessageId: string | null;
  payload: unknown;
};

export type DurableLiveFramePage = {
  frames: DurableLiveFrame[];
  nextCursor: string | null;
  hasMore: boolean;
  streamClientMessageIds: string[];
  hasTapeProjection: boolean;
  /** 服务端 tape 投影版本水位(tape 投影流计数,单调递增)。旧后端不带该字段
   * (undefined)时,客户端回退到 hasTapeProjection 一次性布尔自愈。 */
  tapeProjectionVersion?: number;
};

/** GET /api/sessions/:id/timeline — one exact chronological page containing
 * user, thinking, tool, agent-group and assistant records at equal rank. */
export type SessionTimelinePage = {
  messages: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
  timelineGeneration: number;
  historyRevision: number;
  snapshotMaxSeq: number;
};

/**
 * GET /api/sessions/:id/archive?before=<seq>&limit=<n> → 归档分页（显式点击加载更早历史）。
 * `messages` = `_orderSeq < before` 的最近 `limit` 条归档消息（升序返回）；
 * `oldestSeq` = 本页最老 `_orderSeq`（字段名保留兼容）。
 */
export type SessionArchivePage = {
  messages: unknown[];
  hasMore: boolean;
  oldestSeq: number | null;
  /** History revision captured with this page (rolling old backend may omit). */
  historyRevision?: number;
};

/** 单条记录的真实、脱敏后不可变 JSON payload。 */
export type TapeRecordPayload = {
  bytes: ArrayBuffer;
  contentSha256: string;
  recordId: string;
  role: string;
};

/**
 * PUT /api/sessions/:id 请求体。`_baseSyncedAt` 是乐观并发基线（上次同步到的
 * updatedAt）：服务端若发现 existing.updated_at > _baseSyncedAt → 409 conflict。
 * wire body 上限 2MB（超出 413）；存储层 blob 上限 4MB（post-merge 超出也 413 oversized）。
 */
export type PutSessionInput = {
  agentId?: string;
  title?: string;
  pinned?: boolean;
  createdAt?: number;
  lastAt?: number;
  messages?: unknown[];
  /** 会话级模型选择:仅建行场景携带(服务端 COALESCE,未携带绝不清空既有值)。 */
  modelId?: string;
  _baseSyncedAt?: number;
};

/** PUT /api/sessions/:id 成功响应。 */
export type PutSessionResult = { ok: true; applied: boolean; updatedAt: number };

// ─── 用量统计（GET /api/me/usage，commercial REST，snake_case 透传） ─────────
//
// 设计取舍：这是一个 ~25 字段的只读聚合 read-model，后端 wire 形态即唯一权威。
// 若强行 snake→camel 适配会引入第二套必须与后端同步演进的并行 schema（drift 风险），
// 故此处刻意保留 snake_case 类型镜像 wire，不做适配。**所有大数（token / credit /
// cost）后端均以字符串返回，本类型一律 string，严禁 Number() 化。**

export type UsageSummary = {
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  requests_total: string;
  /** 名义账单（按 pricing 计），可能 != 实扣（clamp / billing_failed）。 */
  billed_credits: string;
  /** 实际扣款（credit_ledger delta<0 聚合）。 */
  debited_credits: string;
};

export type UsageLegacyUnattributed = {
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  billed_credits: string;
};

export type UsageSavings = {
  /** 节省积分（字符串大数）；savings_unavailable=true 时为 null。 */
  savings_credits: string | null;
  savings_is_estimate: boolean;
  savings_unavailable: boolean;
  savings_rows_skipped: number;
};

/** 会话行内的组队(delegate)per-agent×model 明细(积分降序)。 */
export type UsageDelegateDetail = {
  /** 委派目标 agent id(如 coder / hidden-reviewer);展示经 agentDisplayName 解析。 */
  delegate_agent_id: string | null;
  model: string;
  requests: string;
  billed_credits: string;
};

export type UsageSessionRow = {
  session_id: string;
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  billed_credits: string;
  last_used_at: string;
  /** 组队(delegate)并入部分的积分小计(字符串大数;无组队时 "0")。
   *  可选:兼容尚未升级的后端。 */
  delegate_credits?: string;
  /** 组队并入的请求次数(字符串大数;无组队时 "0")。 */
  delegate_requests?: string;
  /** 该行完全由 delegate 行构成(孤儿 delegate 独立行 / 纯组队归组行)。 */
  delegate_only?: boolean;
  /** per-agent×model 组队明细;仅含 delegate 行时下发。 */
  delegates?: UsageDelegateDetail[];
};

export type UsageSessionsPage = {
  rows: UsageSessionRow[];
  limit: number;
  offset: number;
  has_more: boolean;
};

export type UsageLedgerRow = {
  id: string;
  delta: string;
  balance_after: string;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  memo: string | null;
  created_at: string;
};

export type UsageLedger = {
  rows: UsageLedgerRow[];
  /** keyset 游标：下一页传 ledger_before=next_before；null = 到底。 */
  next_before: string | null;
};

export type UsageResponse = {
  summary: UsageSummary;
  legacy_unattributed: UsageLegacyUnattributed;
  savings: UsageSavings;
  cache: { hit_rate: number | null };
  sessions: UsageSessionsPage;
  ledger: UsageLedger;
  cutoff_started_at: string | null;
};

/** getUsage 查询参数（分页 / keyset 游标）。 */
export type UsageQuery = {
  sessionsLimit?: number;
  sessionsOffset?: number;
  ledgerLimit?: number;
  /** credit_ledger id keyset 游标（取上一页 ledger.next_before）。 */
  ledgerBefore?: string;
};

// ─── 用量报表（GET /api/me/usage/report，图表化窗口口径） ────────────────────
// 与 /api/me/usage 同信封风格；**所有数字字段全程字符串大数，绝不数值化当权威**。
// trend 已由后端补零升序（24h=24 个 hour 桶，7d/30d=day 桶）。

export type UsageReportWindow = "24h" | "7d" | "30d";

/** 窗口口径 summary（对应 4 张 Stat 卡 + Token 构成环图）。 */
export type UsageReportSummary = {
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  credits: string;
};

/** 用量趋势单桶。bucket 形如「YYYY-MM-DD」或「MM-DD HH:00」。 */
export type UsageReportTrendPoint = {
  bucket: string;
  requests: string;
  credits: string;
};

/** 按模型积分构成单项。 */
export type UsageReportModel = {
  model: string;
  requests: string;
  credits: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
};

/** 账本收支趋势单桶（credited=入账 / debited=支出，字符串大数）。 */
export type UsageReportLedgerTrendPoint = {
  bucket: string;
  credited: string;
  debited: string;
};

/** 支出构成单项（按 credit_ledger.reason 归组）。 */
export type UsageReportLedgerReason = {
  reason: string;
  debited: string;
};

export type UsageReportLedger = {
  trend: UsageReportLedgerTrendPoint[];
  by_reason: UsageReportLedgerReason[];
};

export type UsageReport = {
  window: UsageReportWindow;
  summary: UsageReportSummary;
  trend: UsageReportTrendPoint[];
  models: UsageReportModel[];
  ledger: UsageReportLedger;
};

// ─── API Keys（GET/POST/DELETE /api/me/api-keys，commercial REST） ───────────
// 注意：当前后端 admin-only rollout —— 普通用户调用返 403（requireAdmin）。

/** API key 摘要（列表项），不含明文与 hash。 */
export type ApiKeySummary = {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/** 新建 API key（201）。`plaintext` 完整明文仅此一次返回，之后无法再取。 */
export type CreatedApiKey = {
  id: string;
  label: string;
  keyPrefix: string;
  /** `oc-cc.<prefix>.<secret>` —— 仅创建时返回一次，必须立即引导用户保存。 */
  plaintext: string;
  createdAt: string;
};

// ─── 充值 / 计费（GET /api/payment/*，commercial REST，虎皮椒扫码） ──────────
// 金额一律「分」字符串大数，credits 字符串大数，全程勿数值化。

/** 充值套餐（GET /api/payment/plans，公开端点；带 token 则按用户过滤首充档）。 */
export type PaymentPlan = {
  code: string;
  label: string;
  /** 金额（分），字符串。 */
  amountCents: string;
  /** 到账积分，字符串。 */
  credits: string;
};

/** 创建虎皮椒订单（POST /api/payment/hupi/create）。409 = 首充已用过（FIRST_TOPUP_USED）。 */
export type HupiCreateResult = {
  orderNo: string;
  /** 扫码 URL（PC 端展二维码）。 */
  qrcodeUrl: string;
  /** 移动端跳转 URL（可能 null）。 */
  mobileUrl: string | null;
  amountCents: string;
  credits: string;
  expiresAt: string;
};

// ─── 月度订阅（0096） ────────────────────────────────────────────────────

/** 套餐档（GET /api/subscription/plans）。金额/积分字符串大数。 */
export type SubscriptionPlanWire = {
  code: string;
  name: string;
  priceCents: string;
  monthlyCredits: string;
  periodDays: number;
  /** 档位高低（升档判定）。 */
  tier: number;
};

/** 当前订阅 + 双钱包余额（GET /api/subscription/me）。 */
export type MySubscription = {
  planCode: string;
  planName: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  /** 当期套餐期内桶余额。 */
  periodCredits: string;
  monthlyCredits: string;
  priceCents: string;
  tier: number;
  paid: boolean;
  /** 双钱包明细：wallet 持久钱包 + period 期内桶 = total 总可用。 */
  balance: { wallet: string; period: string; total: string };
};

/** 订单视图（GET /api/payment/orders/:orderNo，轮询）。status: pending|paid|expired|... */
export type PaymentOrder = {
  orderNo: string;
  status: string;
  amountCents: string;
  credits: string;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
  provider: string;
};

// ─── 媒体签名（commercial REST） ─────────────────────────────────────────────

/**
 * POST /api/media-sign → 容器内路径 → opaque 签名 URL 映射。
 * `urls` 仅含通过 ACL（isContainerPathAllowed）的路径，被拒路径会被 **静默跳过**
 * （key 缺失即未签发，调用方需自行判断缺漏）。expMs = 绝对过期时间戳（ms）。
 */
export type MediaSignResult = {
  urls: Record<string, string>;
  expMs: number;
};

// ─── 用户文献库(research_documents,master 直存;ManageCenter「文献库」tab) ──

/** 文献库单篇(GET /api/me/research/library 的 documents 项)。 */
export type ResearchLibraryDoc = {
  docId: string;
  title: string | null;
  lang: string;
  spanCount: number;
  createdAt: string;
};

/** 上传入库结果(POST /api/me/research/library):成功回 outline,扫描件回 needsOcr。 */
export type ResearchLibraryUploadResult = {
  docId?: string;
  title?: string | null;
  lang?: string;
  spanCount?: number;
  needsOcr?: boolean;
  reason?: string;
};

// ─── 容器内管理（记忆 / 定时任务 / 技能；经 commercial router 代理进用户容器） ──

/** 定时任务（GET /api/cron 的 jobs 项；字段宽松，按容器 gateway 实际返回。 */
export type CronJob = {
  id: string;
  schedule?: string;
  agent?: string;
  prompt?: string;
  deliver?: string;
  enabled?: boolean;
  oneshot?: boolean;
  label?: string;
  nextRunAt?: string | number | null;
  lastRunAt?: string | number | null;
  heartbeat?: boolean;
};

/** 新建定时任务入参（POST /api/cron）。 */
export type CronCreateInput = {
  schedule: string;
  prompt: string;
  deliver?: string;
  oneshot?: boolean;
  label?: string;
  agent?: string;
};

// ── 用户画像文档（GET/PUT /api/agents/:id/memory/user） ─────────────────────
//
// 用户画像 = 共享的 `~/.openclaude/user.md`(所有智能体通用),去 § 化后是单文档纯
// markdown,单文本编辑 + 乐观锁 409。核心记忆已改为 memdir 文件列表(见下方 Memory* 类型)。

/** 用户画像读取响应（version 为乐观锁令牌，PUT 回传以检测并发写）。 */
export type MemoryDocResponse = {
  target: string;
  text: string;
  /** 乐观锁版本；后端权威。缺省（旧后端）时前端按空串处理，不参与冲突检测。 */
  version?: string;
  charCount?: number;
  limit?: number;
};

/** 用户画像写入冲突（后端 409：智能体在用户编辑期间改动了画像）。 */
export type MemoryConflict = { text: string; version: string; charCount: number; limit: number };

/**
 * PUT 用户画像结果：成功带新 version（更新基线），或 409 冲突数据（刷新基线后以用户版本为准）。
 * 用判别式 `ok` 分流，让上层无需 catch 也能区分「写成功」与「版本冲突」。
 */
export type PutMemoryResult =
  | { ok: true; version: string; charCount?: number; limit?: number }
  | { ok: false; conflict: MemoryConflict };

// ── 核心记忆 memdir（GET/PUT/DELETE /api/agents/:id/memory/{memory,files/:file}） ──
//
// 核心记忆改为「每条一个 frontmatter 文件 + MEMORY.md 纯索引」(memdir 范式)。
//  - GET .../memory/memory → 索引文本 + 文件元数据列表(kind='index')；
//  - GET/PUT/DELETE .../memory/files/:file → 逐文件正文读写删,PUT 带乐观锁 version。

/** memdir 单个记忆文件的元数据（来自后端逐文件解析 frontmatter；version 由 GET file 单取）。 */
export type MemoryFileMeta = {
  /** 磁盘文件名（如 `user-preferences.md`），路由 :file 段。 */
  file: string;
  /** frontmatter `name`（缺省回落文件名）。 */
  name: string;
  /** frontmatter `description`（一句话摘要，决定未来会话是否召回）。 */
  description: string;
  /** frontmatter `type`：user | feedback | project | reference。 */
  type: string;
  /** 最近修改时间（epoch ms），前端做相对时间展示。 */
  mtimeMs: number;
  /** 文件字节大小。 */
  size: number;
};

/** GET .../memory/memory 响应：只读索引文本 + 文件列表（core 记忆改列表后不再是可编辑 blob）。 */
export type MemoryIndexResponse = {
  kind: "index";
  /** MEMORY.md 索引正文（首行 marker + 每条一行钩子），只读折叠预览。 */
  text: string;
  files: MemoryFileMeta[];
  /** 索引乐观锁版本（当前 UI 不写索引，保留兼容）。 */
  version?: string;
};

/** GET .../memory/files/:file 响应：正文 + 乐观锁 version（sha256 前 16 位）。 */
export type MemoryFileContent = { content: string; version: string };

/** PUT 记忆文件 409 冲突：文件已被别处修改，携最新正文与 version 供刷新基线。 */
export type MemoryFileConflict = { content: string; version: string };

/** PUT 记忆文件结果：成功带新 version，或 409 冲突（刷新基线后重存）。 */
export type PutMemoryFileResult =
  | { ok: true; version: string }
  | { ok: false; conflict: MemoryFileConflict };

/** GET .../auto-dream-report：不含整理模型、prompt、原始会话/记忆正文或内部错误。 */
export type AutoDreamMemoryChange = {
  file: string;
  action: "created" | "updated" | "deleted";
  type?: "user" | "feedback" | "project" | "reference";
};

export type AutoDreamLastReport = {
  status: "success" | "failed";
  finishedAt: string;
  sessionsReviewed: number;
  summary: string;
  created: AutoDreamMemoryChange[];
  updated: AutoDreamMemoryChange[];
  deleted: AutoDreamMemoryChange[];
};

export type AutoDreamReportResponse = {
  status: "idle" | "running" | "success" | "failed";
  mode?: "legacy_memory_v1" | "optimizer_v2";
  startedAt?: string;
  pendingSessions: number;
  lastReport?: AutoDreamLastReport;
};

export type AutoDreamOptimizerProposal = {
  id: string;
  fingerprint: string;
  category: string;
  action: string;
  title: string;
  reason: string;
  targetId: string;
  before: string;
  after: string;
  beforeFingerprint: string;
  state: "pending" | "applied" | "dismissed" | "conflict";
  createdAt: string;
  appliedAt?: string;
  error?: string;
};

export type AutoDreamOptimizerState = {
  schemaVersion: 2;
  status: "idle" | "running" | "success" | "failed" | "cancelled";
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  lastSuccessAt?: string;
  sessionsProcessedThroughSeq?: number;
  sessionsReviewed: number;
  pagesReviewed: number;
  summary?: string;
  error?: string;
  cancelRequestedAt?: string;
  proposals: AutoDreamOptimizerProposal[];
};

/** 技能列表项（GET /api/skills 的 skills 项）。 */
export type SkillSummary = {
  name: string;
  description?: string;
  version?: string;
  tags?: string[];
  source?: string;
  /** 精确来源层（shared/legacy/hub…）；用于区分自建与市场安装。平台层后端已剔除。 */
  layer?: string;
  writable?: boolean;
  agentIds?: string[];
};

/** 评测用例(skill 目录 evals/evals.json)。 */
export type SkillEvalCase = {
  id: string;
  prompt: string;
  assertions: string[];
  expectedOutput?: string;
};

export type SkillEvalsFile = {
  version: 1;
  cases: SkillEvalCase[];
  /** P3 每日自动回归 opt-in(消耗积分,默认关;UI 开启时须确认成本)。 */
  autoRegression?: boolean;
};

export type SkillRunUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
};

/** 评测 run(GET /api/skill-eval/:runId 的 run)。 */
export type SkillEvalRun = {
  runId: string;
  skillName: string;
  mode: "baseline" | "draft";
  trainRunId?: string | null;
  model: string;
  status: "queued" | "running" | "grading" | "done" | "failed";
  progress: { done: number; total: number };
  cases: SkillEvalCase[];
  results: Array<{
    caseId: string;
    arm: "with" | "without" | "draft";
    output: string;
    usage: SkillRunUsage;
    assertions: Array<{ text: string; passed: boolean; evidence: string }>;
    error?: string;
  }>;
  benchmark: {
    passRate: Partial<Record<"with" | "without" | "draft", number>>;
    counts: Partial<Record<"with" | "without" | "draft", { passed: number; total: number }>>;
    avgOutputTokens: Partial<Record<"with" | "without" | "draft", number>>;
    preference?: { draft: number; current: number; tie: number };
    verdict: string;
  } | null;
  usage: SkillRunUsage;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

/**
 * AI 生成评测用例 job(GET /api/skill-eval-gen/:runId)。
 * 生成绝不落库 —— done 时只回草稿 cases,前端灌进编辑器变 dirty 态,保存仍走
 * PUT /api/skills/:name/evals(唯一写路径)。异步轻量 job,同技能不并发。
 */
export type SkillEvalGenJob = {
  status: "running" | "done" | "failed";
  /** 仅 done:草稿用例(id 已由服务端归一化为 gen-1..n,避免与现有用例冲突)。 */
  cases?: SkillEvalCase[];
  /** 失败原因,或"无真实使用记录,按声明场景推导"之类提示。 */
  note?: string;
  usage?: SkillRunUsage;
};

/** 训练 run(GET /api/skill-training/:runId 的 run)。 */
export type SkillTrainRun = {
  runId: string;
  skillName: string | null;
  status: "queued" | "running" | "diff_ready" | "merged" | "discarded" | "failed";
  phase: string;
  proposalCount: number;
  toolCalls: number;
  usage?: SkillRunUsage;
  autoEval?: boolean;
  evalRunId?: string | null;
  error: string | null;
  summary: string | null;
  startedAt: number;
  finishedAt: number | null;
};

/**
 * 启动训练 run 响应(POST /api/skills/:name/train)。
 * P3:`feedbackRefs` = 本次训练命中的「用户差评过的真实使用记录」引用条数,前端据此
 * 提示「优先分析这些失败案例」。**旧后端不返回该字段 → undefined,前端不渲染提示**(容错)。
 */
export type SkillTrainStartResult = {
  ok: boolean;
  runId: string;
  /** 命中的差评真实使用记录条数(>0 时前端提示;缺省=旧后端,不提示)。 */
  feedbackRefs?: number;
};

/** 训练草稿摘要/详情。 */
export type SkillDraftSummary = {
  name: string;
  op: "create" | "update" | "delete";
  baseVersion: string | null;
  rationale: string;
  authoredBy: "ai" | "user";
  updatedAt: string;
};

export type SkillDraftDetail = {
  draft: {
    meta: { name: string; description: string; tags?: string[] };
    body: string;
    rawContent: string;
    evalsJson?: string;
    record: SkillDraftSummary & { runId: string; createdAt: string };
  };
  current: { body: string; description: string; version?: string } | null;
};

/** 技能详情（GET /api/skills/:name 的 skill）。 */
export type SkillDetail = SkillSummary & {
  body?: string;
  /** skill 目录下的文件相对路径（一套技能是一个目录，含 SKILL.md + 可能的附属文件）。 */
  files?: string[];
};

// ── 社区共建教程 ─────────────────────────────────────────────────────────

export type CommunityTutorialCategory = "research" | "coding" | "general";
export type CommunityTutorialStatus = "pending" | "approved" | "rejected" | "withdrawn";

export type CommunityTutorialSummary = {
  id: string;
  title: string;
  summary: string;
  category: CommunityTutorialCategory;
  authorName: string;
  publishedAt: string;
};

export type CommunityTutorialDetail = CommunityTutorialSummary & {
  bodyMarkdown: string;
};

export type CommunityTutorialMine = {
  id: string;
  title: string;
  summary: string;
  category: CommunityTutorialCategory;
  bodyMarkdown: string;
  status: CommunityTutorialStatus;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  publishedAt: string | null;
};

export type CommunityTutorialPending = CommunityTutorialMine & {
  authorName: string;
};

export type CommunityTutorialDraft = {
  title: string;
  summary: string;
  category: CommunityTutorialCategory;
  bodyMarkdown: string;
};

export type CommunityTutorialPage<T> = {
  tutorials: T[];
  nextCursor: string | null;
};

// ── AI 市场（marketplace，见 packages/commercial/src/marketplace） ──────────

/** 静态安全扫描命中项（发布被拦截时返回，前端做友好提示）。 */
export type MarketplaceRiskFlag = {
  category: string;
  severity: string;
  code: string;
  message: string;
  sample?: string;
  block: boolean;
};

/** 市场目录卡片（GET /api/marketplace/search 的 results 项）。 */
export type MarketplaceCard = {
  slug: string;
  /** 加法兼容投影；存量 `kind=connector` 在产品层展示为 plugin。 */
  artifactKind?: MarketplaceArtifactKind;
  pluginType?: MarketplacePluginType | null;
  kind: MarketplaceKind;
  name: string;
  description: string;
  tags: string[];
  /** 仅 embedding 检索时带回，用于排序展示，可忽略。 */
  score?: number;
  /** 当前活跃安装数（≈使用人数；旧后端可能不带）。 */
  installCount?: number;
  /** 平台预设 agent(开箱即用,无需安装)。 */
  preset?: boolean;
  /** 平台验证的官方身份；不等于预装，官方 Plugin 仍可能需要用户安装。 */
  official?: boolean;
  /** 官方默认连接器：平台预装，无 install/uninstall。 */
  preinstalled?: boolean;
  /** 发布者自报评测摘要(仅有数据时渲染徽记;展示须标注"发布者提供·未经平台验证")。 */
  benchmark?: { withPassRate: number; withoutPassRate: number; cases: number } | null;
  // ── 人向商品层（storefront 元数据；权威枚举见 @openclaude/protocol taxonomy） ──
  // 全部可选:旧后端/存量 NULL 数据缺字段时 UI 优雅降级(显示未分类/不渲染该区块)。
  /** 分类 id(∈ MARKETPLACE_CATEGORIES;缺/未知 → 未分类)。 */
  category?: string | null;
  /** 适用场景(1-4 条),卡片透出用于分类导航与「为什么适配你」的解释。 */
  useCases?: string[];
  /** 平台精选权重(越小越靠前;null/缺省=非精选)。只由平台运维脚本写入。 */
  featuredRank?: number | null;
  // ── 真实使用信号（批2;全部可选,旧后端缺字段 → UI 优雅降级不渲染） ──
  /** 近 30 天技能使用事件数（skill_view 计次;缺/0 时卡片沿用安装数徽章）。 */
  usage30d?: number;
  /** 近 30 天去重使用人数(>0 → 卡片以「30天 N 人在用」替代安装数徽章位)。 */
  users30d?: number;
  /** 使用后评分聚合;样本(up+down)<5 时**服务端直接返回 null**(前端零阈值判断,权威在服务端)。 */
  rating?: { up: number; down: number } | null;
};

/** 市场检索响应。method=all 为空查询返全部目录。 */
export type MarketplaceSearchResult = {
  results: MarketplaceCard[];
  method: "all" | "keyword" | "embed";
};

/** 市场条目类型（技能 / 智能体）。 */
export type MarketplaceKind = "skill" | "agent" | "connector";

export type MarketplaceInstallResult = MarketplaceCapabilityInstallOutcome & {
  ok: boolean;
  slug: string;
  kind: MarketplaceKind;
  artifactKind?: MarketplaceArtifactKind;
  pluginType?: MarketplacePluginType | null;
  version: string;
  note: string;
  installedDeps: number;
};

/** 市场条目详情（GET /api/marketplace/:slug 的 detail，含完整工件供安装确认）。 */
export type MarketplaceDetail = {
  slug: string;
  artifactKind?: MarketplaceArtifactKind;
  pluginType?: MarketplacePluginType | null;
  kind: MarketplaceKind;
  state: string;
  ownerUserId: string;
  version: string;
  versionId: string;
  name: string;
  description: string;
  tags: string[];
  artifactHash: string;
  /** 通用原始工件（技能=SKILL.md；智能体=manifest）。 */
  rawArtifact: string;
  /** 技能专有：SKILL.md（智能体为 null）。 */
  rawSkillMd?: string | null;
  /** 结构化元数据（智能体：model/toolsets/skillDeps；技能为 null）。 */
  manifest?: unknown;
  capabilityReadiness?: MarketplaceCapabilityReadiness;
  /** @deprecated Legacy servers may include scanner diagnostics; storefronts must not render them. */
  riskFlags?: MarketplaceRiskFlag[];
  /** 审核来源；旧后端缺字段时 UI 使用不夸大的通用文案。 */
  reviewSource?: MarketplaceReviewSource | null;
  installCount: number;
  /** 平台预设 agent(开箱即用,无需安装)。 */
  preset?: boolean;
  /** 平台验证的官方身份；不等于预装。 */
  official?: boolean;
  /** 精确平台默认 Plugin：开箱即用，无 install/uninstall。 */
  preinstalled?: boolean;
  connectorContract?: {
    authMode: string;
    approvedOrigins: string[];
    actions: Array<{ id: string; effect: string }>;
  } | null;
  /** 附属文件(references/assets/evals;path → content)。 */
  rawBundle?: Record<string, string> | null;
  /** 发布者自报评测摘要(展示须标注"发布者提供")。 */
  benchmark?: { withPassRate: number; withoutPassRate: number; cases: number } | null;
  // ── 人向商品层（detail 透出全部 storefront 字段；全部可选,缺则优雅降级） ──
  /** 分类 id(∈ MARKETPLACE_CATEGORIES;缺/未知 → 未分类)。 */
  category?: string | null;
  /** 适用场景(1-4 条)。 */
  useCases?: string[];
  /** 效果示例(0-4 条):「给它什么→得到什么」的具体产出示例。 */
  outcomeExamples?: string[];
  /** 人向富介绍(Markdown 渲染;≤16384 字)。 */
  humanMd?: string | null;
  /** 平台精选权重(越小越靠前;null=非精选)。 */
  featuredRank?: number | null;
  // ── 真实使用信号（批2;全部可选,旧后端缺字段 → UI 优雅降级不渲染） ──
  /** 近 30 天技能使用事件数（skill_view 计次）。 */
  usage30d?: number;
  /** 近 30 天去重使用人数。 */
  users30d?: number;
  /** 使用后评分聚合;样本(up+down)<5 时**服务端直接返回 null**(前端零阈值判断,权威在服务端)。 */
  rating?: { up: number; down: number } | null;
};

/** 已安装条目（GET /api/marketplace/installed 的 installed 项）。 */
export type MarketplaceInstalled = {
  slug: string;
  artifactKind?: MarketplaceArtifactKind;
  pluginType?: MarketplacePluginType | null;
  kind: MarketplaceKind;
  version: string;
  versionId: string;
  name: string;
  artifactHash: string;
  /** 用户显式分配的归属；不含 Agent 依赖自动带来的绑定。 */
  manualAgentIds?: string[];
  /** 兼容展示投影：手动归属 + Agent 依赖归属。 */
  agentIds?: string[];
  installedAt: string;
  listingState: string;
  /** listing 当前上架版本（升级可见性；旧后端/无上架版本时缺省）。 */
  latestVersion?: string | null;
  latestVersionId?: string | null;
  capabilityReadiness?: MarketplaceCapabilityReadiness;
};

/** 我的发布记录（GET /api/marketplace/my-publishes 的 publishes 项）。 */
export type MarketplaceMyPublish = {
  versionId: string;
  slug: string;
  artifactKind?: MarketplaceArtifactKind;
  pluginType?: MarketplacePluginType | null;
  kind: MarketplaceKind;
  version: string;
  name: string;
  /** pending | approved | rejected */
  status: string;
  /** 审核备注（拒绝理由等）。 */
  reviewNote?: string | null;
  reviewSource?: MarketplaceReviewSource | null;
  createdAt: string;
  reviewedAt?: string | null;
  /** 该版本是否 listing 当前上架版本。 */
  isCurrent: boolean;
  /** listing 状态（active/unlisted/revoked）。 */
  listingState: string;
};

/** 批量审核结果（POST /api/admin/marketplace/review-batch）。 */
export type MarketplaceReviewBatchResult = {
  ok: boolean;
  reviewed: number;
  failed: number;
  results: Array<{ versionId: string; ok: boolean; code?: string; message?: string }>;
};

/** 待审版本（GET /api/admin/marketplace/pending 的 pending 项，含完整工件供审核）。 */
export type MarketplacePending = {
  versionId: string;
  slug: string;
  kind: MarketplaceKind;
  version: string;
  name: string;
  description: string;
  tags: string[];
  /** 通用原始工件（技能=SKILL.md；智能体=manifest）。 */
  rawArtifact: string;
  artifactHash: string;
  rawSkillMd?: string | null;
  manifest?: unknown;
  riskFlags: MarketplaceRiskFlag[];
  submittedBy: string;
  ownerUserId: string;
  createdAt: string;
  rawBundle?: Record<string, string> | null;
  benchmark?: { withPassRate: number; withoutPassRate: number; cases: number } | null;
  /** AI 审核意见（escalate/warn 降级/解析失败时的原因）；人审展开区「供参考」展示。 */
  aiNote?: string | null;
  // ── 人向商品层（审核队列透出全部 storefront 字段;缺 category/useCases 打「缺失」徽章） ──
  /** 分类 id(∈ MARKETPLACE_CATEGORIES;缺/未知 → 未分类)。 */
  category?: string | null;
  useCases?: string[];
  outcomeExamples?: string[];
  humanMd?: string | null;
};

/** AI 自动审批记录项（GET /api/admin/marketplace/ai-reviews；review_source='ai'）。 */
export type MarketplaceAiReview = {
  versionId: string;
  slug: string;
  kind: MarketplaceKind;
  version: string;
  name: string;
  /** AI 最终裁决落到 status。 */
  status: "approved" | "rejected" | string;
  aiNote?: string | null;
  reviewedAt?: string | null;
};

/** 我的智能体项（GET /api/marketplace/my-agents：默认全能助手 + 已安装）。 */
export type MarketplaceMyAgent = {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarEmoji?: string | null;
  model?: string | null;
  version?: string | null;
  installed: boolean;
  isDefault?: boolean;
  /** 平台预设(编程/办公/科研):开箱即用、不可卸载、恒为最新上架版本。 */
  preset?: boolean;
  capabilityReadiness?: MarketplaceCapabilityReadiness;
};

/**
 * 人向商品层发布字段（两条发布路径对称）。这些是发布级 storefront 元数据,
 * **不进 SKILL.md 工件 / agent manifest** —— 后端在 validateAgentManifest 前从
 * manifestInput 剔除,前端只负责按契约传上去。
 */
export type MarketplaceHumanMetaInput = {
  /** 分类 id(必填,须 ∈ MARKETPLACE_CATEGORIES)。 */
  category?: string;
  /** 适用场景(必填 1-4 条,每条 trim 后 4-120 字)。 */
  useCases?: string[];
  /** 效果示例(选填 0-4 条,每条 trim 后 ≤200 字)。 */
  outcomeExamples?: string[];
  /** 人向富介绍(选填,≤16384 字,Markdown)。 */
  humanMd?: string;
};

/** 智能体发布入参（POST /api/marketplace/agent/publish；manifest 白名单字段 + storefront 元数据）。 */
export type MarketplaceAgentPublishInput = MarketplaceHumanMetaInput & {
  slug: string;
  version: string;
  name: string;
  description: string;
  tags: string[];
  model: string;
  toolsets: string[];
  capabilities: MarketplaceCapabilityRef[];
  skillDeps: string[];
  persona: string;
  displayName?: string;
  avatarEmoji?: string;
  greeting?: string;
};

/** 连接器技术发布入参；securityDecision 是发布者建议，最终以平台审核签名决定为准。 */
export type MarketplaceConnectorPublishInput = MarketplaceHumanMetaInput & {
  version: string;
  spec: Record<string, unknown>;
  securityDecision: Record<string, unknown>;
  tags: string[];
};

/** 发布入参（POST /api/marketplace/publish；含 storefront 元数据）。 */
export type MarketplacePublishInput = MarketplaceHumanMetaInput & {
  slug: string;
  version: string;
  name: string;
  description: string;
  body: string;
  tags: string[];
  /** 附属文本文件(references/ assets/ evals/;scripts 暂不支持)。 */
  files?: Array<{ path: string; content: string }>;
  /** 发布者自报评测摘要(来自本地评测 last-run,可选)。 */
  benchmark?: { withPassRate: number; withoutPassRate: number; cases: number };
};

/** 发布响应（200 已提交待审）。 */
export type MarketplacePublishResult = {
  ok: boolean;
  versionId: string;
  status: string;
  riskFlags: MarketplaceRiskFlag[];
  note: string;
};

// ── 站内信（inbox） ──────────────────────────────────────────────────
export type InboxLevel = "info" | "notice" | "promo" | "warning";

/** 站内信一条消息（GET /api/me/messages，后端 InboxMessageView 原样 wire）。 */
export type InboxMessage = {
  id: string;
  audience: "all" | "user";
  user_id: string | null;
  title: string;
  /** markdown 正文（前端经 <Markdown> 渲染）。 */
  body_md: string;
  level: InboxLevel;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  read: boolean;
};

// ── GitHub 仓库绑定 ──────────────────────────────────────────────────
/** GitHub 账号关联状态（GET /api/me/github）。 */
export type GithubLink =
  | { linked: false }
  | { linked: true; login: string; avatar_url?: string; scopes: string };

/** 用户 GitHub 仓库（GET /api/me/github/repos）。 */
export type GithubRepo = {
  owner: { login: string };
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  pushed_at?: string;
};

/** 仓库分支（GET /api/me/github/repos/:owner/:repo/branches）。 */
export type GithubBranch = { name: string; commit: { sha: string } };

/** 容器克隆/绑定状态机。 */
export type RepoStatus = "pending" | "cloning" | "ready" | "failed";

/** 某会话的仓库选择（GET/PUT /api/me/sessions/:sid/github-selection）。 */
export type RepoSelection =
  | { selected: false }
  | {
      selected: true;
      owner: string;
      repo: string;
      branch: string;
      default_branch?: string;
      status: RepoStatus;
      head_sha?: string;
      error_code?: string;
      error_message?: string;
      selection_version: number;
    };

// ─── 企业版(P3.1)org 自助后台 ─────────────────────────────────────────────
// 全部大数(credits / tokens / amount_cents)一律字符串,组件层禁止 Number() 化。
// org 由服务端从 caller membership 推导,前端任何请求**不带** org_id。

/** GET /api/org 概要(队长/管理员 + 成员均可读)。 */
export type OrgSummary = {
  id: string;
  name: string;
  status: OrgStatus;
  role: OrgRole;
  billing_enabled: boolean;
  member_count: number;
  max_members: number;
  /** 组织钱包余额(积分,字符串大数)。 */
  credits: string;
};

/** 成员(GET /api/org/members)。 */
export type OrgMember = {
  user_id: string;
  email: string;
  display_name: string | null;
  org_role: OrgRole;
  status: "active" | "suspended";
  billing_enabled: boolean;
  /** 财务委派标志(三期):仅 owner 可授予/回收。 */
  billing_delegate: boolean;
  /** 月度组织用量限额(积分,字符串大数;null=不限)。admin 可改。 */
  monthly_org_budget: string | null;
  /** 本月(Asia/Shanghai 自然月)该成员消耗的组织资金(积分,字符串大数)。 */
  month_org_spent: string;
  user_status: string;
  invited_by: string | null;
  joined_at: string;
};

/** 邀请(GET /api/org/invitations)。 */
export type OrgInvitation = {
  id: string;
  email: string;
  org_role: OrgRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

// ─── 报表(GET /api/org/usage?window=24h|7d|30d) ────────────────────────────
export type OrgUsageWindow = "24h" | "7d" | "30d";

/** 四项 token + 请求数 + 扣费(全部字符串大数)。 */
export type OrgUsageTotals = {
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  credits: string;
};

export type OrgMemberUsage = OrgUsageTotals & {
  user_id: string;
  email: string;
  display_name: string | null;
};

export type OrgModelUsage = OrgUsageTotals & { model: string };

export type OrgUsageTrendPoint = { bucket: string; requests: string; credits: string };

export type OrgUsageReport = {
  window: OrgUsageWindow;
  summary: OrgUsageTotals;
  members: OrgMemberUsage[];
  models: OrgModelUsage[];
  trend: OrgUsageTrendPoint[];
};

// ─── 发票(GET/PUT /api/org/invoice-profile · GET/POST /api/org/invoices) ────
export type OrgInvoiceProfile = {
  org_id: string;
  title: string;
  tax_id: string | null;
  address: string | null;
  email: string | null;
  updated_by: string | null;
  updated_at: string;
};

export type OrgInvoiceProfileInput = {
  title: string;
  tax_id?: string | null;
  address?: string | null;
  email?: string | null;
};

export type OrgInvoiceRequest = {
  id: string;
  org_id: string;
  order_ids: string[];
  amount_cents: string;
  profile_snapshot: { title?: string; tax_id?: string | null; address?: string | null; email?: string | null };
  status: "pending" | "issued" | "rejected";
  requested_by: string | null;
  admin_note: string | null;
  processed_by: string | null;
  processed_at: string | null;
  created_at: string;
};

// ─── 计费(批次 B 契约,前端只调用)────────────────────────────────────────
// POST /api/org/topup {amount_cents} → {ok,data:{order_no,qrcode_url,mobile_url}};
// GET /api/org/balance → {credits};
// GET /api/org/orders(keyset)。前端按此契约调用,字段名以方案 §3 为准。
export type OrgTopupResult = {
  orderNo: string;
  qr: string;
  mobileUrl: string | null;
  amountCents?: string;
};
export type OrgOrder = {
  order_no: string;
  status: string;
  amount_cents: string;
  credits: string;
  created_at: string;
  paid_at: string | null;
};
export type OrgLedgerRow = {
  id: string;
  delta: string;
  balance_after: string;
  reason: string;
  memo: string | null;
  created_at: string;
};

// ─── 技能(批次 C 契约,前端只调用)────────────────────────────────────────
// GET /api/org/skills → {installed[], available[]};POST /api/org/skills/install {slug};
// DELETE /api/org/skills/:slug。
export type OrgSkill = {
  slug: string;
  name: string;
  summary?: string | null;
  version?: string | null;
  installed_by?: string | null;
  installed_at?: string | null;
};
export type OrgSkillsResponse = { installed: OrgSkill[]; available: OrgSkill[] };

// ─── 席位订阅(二期 P3.1;批次 F 契约,前端 api.ts 做适配层)─────────────────────
// 单一 plans 权威(subscription_plans scope='org')。字段名以 F 实际为准 —— api.ts
// 的 normalizeOrgPlan / normalizeOrgSubscription 做容错适配,UI 只吃这里的归一化类型。
// 大数(每席价分 / 每席积分 / 期内池)一律字符串,组件层禁止 Number() 化。

/** 企业套餐档(GET /api/org/plans · GET /api/org/subscription.plans;无 org 也可读)。 */
export type OrgPlan = {
  code: string;
  name: string;
  /** 每席/月价格(分,字符串大数)。 */
  seatPriceCents: string;
  /** 每席入池积分(字符串大数)。 */
  perSeatCredits: string;
  /** 档位最低席位数。 */
  minSeats: number;
  /** 计费周期天数。 */
  periodDays: number;
};

/** 当前 org 订阅(GET /api/org/subscription.subscription;无订阅 → null)。 */
export type OrgSubscriptionView = {
  planCode: string;
  /** 展示名:后端 subscription 不含 plan_name 时回落 code,UI 优先用 plans 列表里的名。 */
  planName: string;
  /** 订阅状态(active / expired;到期 sweeper 置 expired 并清空期内池)。 */
  status: string;
  seats: number;
  periodStart: string;
  periodEnd: string;
  /** 期内池当前余额(字符串大数)。 */
  periodCredits: string;
} | null;

/** GET /api/org/subscription 响应:当前订阅 + 可选档列表。 */
export type OrgSubscriptionInfo = {
  subscription: OrgSubscriptionView;
  plans: OrgPlan[];
};

/** 席位订单下单结果(provision/subscribe/seats 统一形):{order_no, qrcode_url, mobile_url}。
 *  到账判定复用 GET /api/payment/orders/:order_no(api.getOrder,status→'paid')。 */
export type OrgPayResult = {
  orderNo: string;
  qr: string;
  mobileUrl: string | null;
  amountCents?: string;
};
