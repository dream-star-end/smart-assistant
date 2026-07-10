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
  /** 企业版(P3.1):caller 的 active org 归属。无归属 → null / 缺省。 */
  org?: OrgMembershipBrief | null;
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
 * 公开模型视图（GET /api/public/models）。字段宽松透传：前端只做展示与选择，
 * 模型准入、计费与思考能力权威均在后端/protocol。
 */
export type PublicModel = {
  id: string;
  /** protocol modelReasoningPolicy 的 API 投影；空数组 = 不支持思考深度。 */
  supported_efforts?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
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

// ── 记忆文档（GET/PUT /api/agents/:id/memory/:target） ──────────────────────

/** 记忆文档读取响应（version 为乐观锁令牌，PUT 回传以检测并发写）。 */
export type MemoryDocResponse = {
  target: string;
  text: string;
  /** 乐观锁版本；后端权威。缺省（旧后端）时前端按空串处理，不参与冲突检测。 */
  version?: string;
  charCount?: number;
  limit?: number;
};

/** 记忆写入冲突（后端 409：智能体在用户编辑期间改动了记忆）。 */
export type MemoryConflict = { text: string; version: string; charCount: number; limit: number };

/**
 * PUT 记忆结果：成功带新 version（更新基线），或 409 冲突数据（触发条目级并入）。
 * 用判别式 `ok` 分流，让上层无需 catch 也能区分「写成功」与「版本冲突」。
 */
export type PutMemoryResult =
  | { ok: true; version: string; charCount?: number; limit?: number }
  | { ok: false; conflict: MemoryConflict };

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
  /** 发布者自报评测摘要(仅有数据时渲染徽记;展示须标注"发布者提供·未经平台验证")。 */
  benchmark?: { withPassRate: number; withoutPassRate: number; cases: number } | null;
};

/** 市场检索响应。method=all 为空查询返全部目录。 */
export type MarketplaceSearchResult = {
  results: MarketplaceCard[];
  method: "all" | "keyword" | "embed";
};

/** 市场条目类型（技能 / 智能体）。 */
export type MarketplaceKind = "skill" | "agent";

/** 市场条目详情（GET /api/marketplace/:slug 的 detail，含完整工件供安装确认）。 */
export type MarketplaceDetail = {
  slug: string;
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
  riskFlags: MarketplaceRiskFlag[];
  installCount: number;
  /** 平台预设 agent(开箱即用,无需安装)。 */
  preset?: boolean;
  /** 附属文件(references/assets/evals;path → content)。 */
  rawBundle?: Record<string, string> | null;
  /** 发布者自报评测摘要(展示须标注"发布者提供")。 */
  benchmark?: { withPassRate: number; withoutPassRate: number; cases: number } | null;
};

/** 已安装条目（GET /api/marketplace/installed 的 installed 项）。 */
export type MarketplaceInstalled = {
  slug: string;
  kind: MarketplaceKind;
  version: string;
  versionId: string;
  name: string;
  artifactHash: string;
  agentIds?: string[];
  installedAt: string;
  listingState: string;
  /** listing 当前上架版本（升级可见性；旧后端/无上架版本时缺省）。 */
  latestVersion?: string | null;
  latestVersionId?: string | null;
};

/** 我的发布记录（GET /api/marketplace/my-publishes 的 publishes 项）。 */
export type MarketplaceMyPublish = {
  versionId: string;
  slug: string;
  kind: MarketplaceKind;
  version: string;
  name: string;
  /** pending | approved | rejected */
  status: string;
  /** 审核备注（拒绝理由等）。 */
  reviewNote?: string | null;
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
};

/** 智能体发布入参（POST /api/marketplace/agent/publish；manifest 白名单字段）。 */
export type MarketplaceAgentPublishInput = {
  slug: string;
  version: string;
  name: string;
  description: string;
  tags: string[];
  model: string;
  toolsets: string[];
  skillDeps: string[];
  persona: string;
  displayName?: string;
  avatarEmoji?: string;
  greeting?: string;
};

/** 发布入参（POST /api/marketplace/publish）。 */
export type MarketplacePublishInput = {
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
// POST /api/org/topup {amount_cents} → {order_no, qr};GET /api/org/balance → {credits};
// GET /api/org/orders(keyset)。前端按此契约调用,字段名以方案 §3 为准。
export type OrgTopupResult = { orderNo: string; qr: string; amountCents?: string };
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

/** 席位订单下单结果(provision/subscribe/seats 统一形):{order_no, qr}。
 *  到账判定复用 GET /api/payment/orders/:order_no(api.getOrder,status→'paid')。 */
export type OrgPayResult = { orderNo: string; qr: string };
