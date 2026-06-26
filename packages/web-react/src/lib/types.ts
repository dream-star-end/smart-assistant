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

export type BillingLedgerEntry = {
  id: string;
  type: "seed_grant" | "topup_test" | "charge" | "refund" | "monthly_grant";
  amountCents: number;
  balanceAfterCents: number;
  currency: string;
  description: string;
  createdAt: string;
  traceId?: string;
};

/**
 * 计费摘要（账户面板用）。v5 计费/账单中心在 P3.5 接入（/api/me/usage + 充值），
 * 本期 SettingsCenter / Sidebar 以 `Billing | null` 接收，恒传 null（不显示余额）。
 */
export type Billing = {
  currency: string;
  balanceCents: number;
  ledger: BillingLedgerEntry[];
};

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

/** Agent 订阅/容器状态（GET /api/agent/status）。 */
export type AgentStatus = {
  runtimeReady: boolean;
  subscription: {
    id: string;
    plan: string;
    status: string;
    startAt: string;
    endAt: string;
    autoRenew: boolean;
    lastRenewedAt: string | null;
  } | null;
  container: {
    id: string;
    status: string;
    dockerName: string | null;
    lastError: string | null;
    volumeGcAt: string | null;
  } | null;
};

/** Agent 开通受理（POST /api/agent/open，202 provisioning）。 */
export type AgentOpenResult = {
  subscriptionId: string;
  containerId: string;
  status: string;
  startAt: string;
  endAt: string;
  balanceAfter: string;
  dockerName: string;
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
