/**
 * v5 商业版前端类型。鉴权与账户形态对齐 v5 REST 契约
 * (packages/commercial/src/http/{handlers,agent}.ts)。
 */

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

/**
 * 鉴权会话：access token 的唯一权威源（仅存内存，绝不落地）。
 * - getToken/setToken：api 层在静默刷新成功后回写新 token，App 持有同一引用即可读到最新值。
 * - onExpired：刷新失败（refresh 返回 401）时回调，App 据此清理鉴权状态并回到登录页。
 * api 的鉴权请求统一吃 AuthSession，命中 401 时透明走一次 refresh + 重放。
 */
export type AuthSession = {
  getToken: () => string;
  setToken: (t: string) => void;
  onExpired: () => void;
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
};

/** 静默刷新（POST /api/auth/refresh）。v5 仅回 access token，不回 user。 */
export type RefreshResult = {
  accessToken: string;
  accessExp: number;
  remember: boolean;
};

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
  allowRegistration: boolean;
};

/**
 * 公开模型视图（GET /api/public/models）。v5 经后端 dropGptForV5Channel 过滤掉 gpt-*，
 * 仅 claude / glm-5.2 / deepseek / minimax。字段宽松透传：前端只做展示与选择，权威在后端。
 */
export type PublicModel = {
  id: string;
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
};

/**
 * GET /api/sessions/:id（全量或增量）。
 * - 全量（无 since / since≤0）：isPartial=false，messages 为完整数组。
 * - 增量（?since=<seq>）：messages 仅含 `_seq > since` 的增量；legacy 行降级为
 *   isPartial=false + 全量 messages（后端无副作用回填）。
 * maxSeq 由 messages 实算（非 next_seq-1），客户端据此推进游标。
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
  isPartial: boolean;
  totalMessageCount: number;
  maxSeq: number;
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

export type UsageSessionRow = {
  session_id: string;
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  billed_credits: string;
  last_used_at: string;
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

/** 技能列表项（GET /api/skills 的 skills 项）。 */
export type SkillSummary = {
  name: string;
  description?: string;
  tags?: string[];
  source?: string;
  writable?: boolean;
};

/** 技能详情（GET /api/skills/:name 的 skill）。 */
export type SkillDetail = SkillSummary & {
  body?: string;
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
  name: string;
  description: string;
  tags: string[];
  /** 仅 embedding 检索时带回，用于排序展示，可忽略。 */
  score?: number;
};

/** 市场检索响应。method=all 为空查询返全部目录。 */
export type MarketplaceSearchResult = {
  results: MarketplaceCard[];
  method: "all" | "keyword" | "embed";
};

/** 市场条目详情（GET /api/marketplace/:slug 的 detail，含完整 SKILL.md 供安装确认）。 */
export type MarketplaceDetail = {
  slug: string;
  state: string;
  ownerUserId: string;
  version: string;
  versionId: string;
  name: string;
  description: string;
  tags: string[];
  artifactHash: string;
  rawSkillMd: string;
  riskFlags: MarketplaceRiskFlag[];
  installCount: number;
};

/** 已安装条目（GET /api/marketplace/installed 的 installed 项）。 */
export type MarketplaceInstalled = {
  slug: string;
  version: string;
  versionId: string;
  name: string;
  artifactHash: string;
  installedAt: string;
  listingState: string;
};

/** 待审版本（GET /api/admin/marketplace/pending 的 pending 项，含完整正文供审核）。 */
export type MarketplacePending = {
  versionId: string;
  slug: string;
  version: string;
  name: string;
  description: string;
  tags: string[];
  rawSkillMd: string;
  riskFlags: MarketplaceRiskFlag[];
  submittedBy: string;
  ownerUserId: string;
  createdAt: string;
};

/** 发布入参（POST /api/marketplace/publish）。 */
export type MarketplacePublishInput = {
  slug: string;
  version: string;
  name: string;
  description: string;
  body: string;
  tags: string[];
};

/** 发布响应（200 已提交待审）。 */
export type MarketplacePublishResult = {
  ok: boolean;
  versionId: string;
  status: string;
  riskFlags: MarketplaceRiskFlag[];
  note: string;
};
