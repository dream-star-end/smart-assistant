import { HardDrive, Mail, MessagesSquare, NotebookText, Plug } from "lucide-react";
import { type ComponentType, type ReactElement, createElement } from "react";

/**
 * 应用连接器（App Connectors）的**纯逻辑 + 展示元数据层**（框架无关、可单测）。
 * 与 lib/github.ts 同定位：错误码→中文文案、provider 图标/读写能力标注、确认动作/状态文案，
 * 全部收敛于此单一权威，杜绝 ConnectorsTab / 确认卡各自硬编码散落。
 *
 * 后端契约字段（provider.label/description/authKind/formFields、connection.status/lastErrorCode…）
 * 见下方类型；本模块只补充「后端不下发但前端需要」的展示项（图标、读写能力、文案映射）。
 */

// ── 与后端钉死的 HTTP 契约类型（不得擅改） ──────────────────────────────────

/** 绑定方式：token/basic 表单 · BYOA oauth2（用户自带 client 凭据） */
export type ConnectorAuthKind = "oauth2_byoa" | "token" | "basic_form";
/** 表单字段类型（password 走密码框；url 走 url 输入） */
export type ConnectorFieldType = "text" | "password" | "url";

/** provider 声明的单个表单字段（formFields 驱动绑定弹层）。 */
export type ConnectorFormField = {
  key: string;
  label: string;
  type: ConnectorFieldType;
  placeholder?: string;
  required: boolean;
  /** 字段引导说明（如「QQ 邮箱需使用授权码而非登录密码」）。 */
  helpText?: string;
  /** 引导链接（如「如何获取 QQ 邮箱授权码」）。 */
  helpUrl?: string;
};

/** 目录里的一个可绑定 provider（静态声明，label/description 由后端下发）。 */
export type ConnectorProvider = {
  id: string;
  label: string;
  description: string;
  authKind: ConnectorAuthKind;
  formFields: ConnectorFormField[];
};

/** 一条已绑连接（多账号：同 provider 可多行）。 */
export type ConnectorConnection = {
  id: string;
  provider: string;
  displayName: string;
  /** 账号提示（脱敏，如邮箱/工作区名/服务器 host），供多账号区分。 */
  accountHint: string;
  status: "active" | "error";
  lastErrorCode: string | null;
  createdAt: string;
};

/** GET /api/connectors 目录 + 已绑合并视图。 */
export type ConnectorsResponse = {
  providers: ConnectorProvider[];
  connections: ConnectorConnection[];
};

/** POST /api/connectors/:provider 绑定成功回包。 */
export type ConnectorBindResult = { connection: ConnectorConnection };

/** POST /api/connectors/:provider/oauth/start 回包（整页跳转授权页）。 */
export type ConnectorOAuthStartResult = { authorizeUrl: string };

/** 确认账本状态机（对齐后端 connector_write_ledger.status）。 */
export type ConnectorConfirmStatus =
  | "pending"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "expired"
  | "denied";

/** GET /api/connectors/confirmations/:id 完整确认详情（服务端解密渲染）。 */
export type ConnectorConfirmationDetail = {
  id: string;
  provider: string;
  action: string;
  summary: string;
  /** 结构化完整内容（邮件=收件人/主题/正文；文件=路径/大小/哈希；日历/消息同理）。 */
  detail: unknown;
  status: ConnectorConfirmStatus;
  expiresAt: string;
};

/** POST approve|deny 回包。 */
export type ConnectorDecisionResult = { ok: boolean; status: ConnectorConfirmStatus };

/**
 * CLI 在需要确认时 stdout 输出的触发对象（包裹在 {"oc_connect": …} 内）。
 *
 * 安全关键（P0#1）：**只含不透明 id**。CLI 的 stdout 经模型可读，任何 provider/action/summary
 * 等内容字段都可被模型伪造（同 id 换无害摘要诱导批准），故一律不进本类型、不用于展示。
 * 确认卡凭此 id 向服务端 `GET /api/connectors/confirmations/:id` 拉取解密后的真实参数，
 * provider/action/summary/detail/status/expiresAt **全部以服务端响应（ConnectorConfirmationDetail）
 * 为准**。id 是展示与执行的唯一锚点：同一 id 决定「展示什么」与「批准后执行什么」，二者不可分叉。
 */
export type ConnectorConfirmTrigger = {
  type: "confirmation_required";
  id: string;
};

// ── 声明式引擎（未来单一权威）契约类型 + bind 表单元数据 ─────────────────────
// 声明式连接器走 REST 前缀 /api/connectors/declarative/*，与 v1 手写 provider 并存
// （过渡期）。字段与后端钉死（不得擅改）；本模块补充「后端不下发但前端 bind 弹层需要」
// 的展示项（source → 表单字段元数据、actions → 读写能力）。

/** 声明式目录里的一个连接器（catalog 条目，label/description 由后端下发）。 */
export type DeclarativeCatalogEntry = {
  versionId: number;
  slug: string;
  label: string;
  description: string;
  authMode: string;
  /** bind 时用户要填的凭据字段名（source 名，如 access_token / client_id）。 */
  requiredBindSources: string[];
  /**
   * 仅 authMode='oauth2-auth-code' 时下发：client 供给模式。
   *   'platform' → **一键授权**（平台已注册 OAuth App，用户零填写；能出现在目录里就意味着已 provision）；
   *   'byoa'     → 用户自带 App（需填 client_id/client_secret，即 requiredBindSources）。
   * **读后端显式字段**，不从 `requiredBindSources.length === 0` 反推——那是隐式契约。
   */
  clientProvisioning?: "byoa" | "platform";
  /** 该连接器声明的动作（effect 推导读写能力）。 */
  actions: { id: string; effect: string }[];
};

/** GET /api/connectors/declarative/catalog 回包。 */
export type DeclarativeCatalogResponse = { connectors: DeclarativeCatalogEntry[] };

/** 一条已绑声明式连接（无 status，视为 active）。 */
export type DeclarativeConnection = {
  id: string;
  slug: string;
  displayName: string;
  accountHint?: string;
  connectorVersionId?: string | null;
  createdAt: string;
};

/** GET /api/connectors/declarative/connections 回包。 */
export type DeclarativeConnectionsResponse = { connections: DeclarativeConnection[] };

/** 管理中心连接器聚合项（default ∪ marketplace install ∪ orphan binding）。 */
export type DeclarativeManagementConnector = {
  slug: string;
  label: string;
  description: string;
  installation: "default" | "marketplace" | "orphan";
  official: boolean;
  available: boolean;
  canBind: boolean;
  listingState: string;
  installedVersion: string | null;
  installedVersionId: string | null;
  latestVersion: string | null;
  latestVersionId: string | null;
  updateAvailable: boolean;
  connectionCount: number;
  contract: DeclarativeCatalogEntry | null;
};

export type DeclarativeManagementResponse = {
  connectors: DeclarativeManagementConnector[];
  connections: DeclarativeConnection[];
};

/** POST /api/connectors/declarative/bind 回包。 */
export type DeclarativeBindResult = {
  connection: { id: string; rebound: boolean; accountHint?: string };
};

/** POST /api/connectors/declarative/oauth/start 回包（整页跳转授权页）。 */
export type DeclarativeOauthStartResult = { authorizeUrl: string };

// ── 通用 Plugin 运行时（sandboxed-local / managed-browser）────────────────

export type RuntimePluginCatalogEntry = {
  versionId: string
  slug: string
  pluginType: 'sandboxed-local' | 'managed-browser'
  label: string
  description: string
  accountMode: 'none' | 'required'
  actions: Array<{ id: string; description: string; readOnly: boolean }>
  installed: boolean
  installedVersion: string
  latestVersionId: string | null
  latestVersion: string | null
  installedCurrent: boolean
  updateAvailable: boolean
  available: boolean
}

export type RuntimePluginAccount = {
  id: string
  provider: string
  pluginType: 'sandboxed-local' | 'managed-browser'
  displayName: string
  accountHint: string
  status: 'active' | 'error'
  actions: Array<{ id: string; description: string; readOnly: boolean }>
  versionId: string
  executable: boolean
  writeControl: {
    available: boolean
    enabled: boolean
    disclaimerVersion: number
    acceptedVersion: number | null
    acceptedAt: string | null
    disclaimerText: string
  } | null
}

export type PluginManagementResponse = {
  catalog: RuntimePluginCatalogEntry[]
  accounts: RuntimePluginAccount[]
}

export type KnowledgePlanetAutomationControl = {
  available: boolean
  enabled: boolean
  disclaimerVersion: number
  acceptedVersion: number | null
  acceptedAt: string | null
  disclaimerText: string
  accountDailyLimit: number
  pausedReason: string | null
}

export type KnowledgePlanetAutomationRule = {
  id: string
  groupId: string
  name: string
  instructions: string
  triggerKind: 'new_topic' | 'new_question'
  enabled: boolean
  dailyLimit: number
  cooldownMinutes: number
  maxReplyChars: number
  consecutiveFailures: number
  pausedReason: string | null
  lastCursorAt: string | null
  nextRunAt: string
  createdAt: string
  updatedAt: string
}

export type KnowledgePlanetAutomationRun = {
  id: string
  ruleId: string
  sourceTopicId: string
  status:
    | 'reserved'
    | 'generating'
    | 'ready'
    | 'dispatching'
    | 'succeeded'
    | 'skipped'
    | 'failed'
    | 'unknown'
  reasonCode: string | null
  upstreamCommentId: string | null
  createdAt: string
  finishedAt: string | null
}

export type KnowledgePlanetAutomationView = {
  control: KnowledgePlanetAutomationControl
  rules: KnowledgePlanetAutomationRule[]
  recentRuns: KnowledgePlanetAutomationRun[]
}

export type KnowledgePlanetSetupView = {
  sessionId: string
  status: 'waiting_for_scan' | 'finalizing' | 'active' | 'cancelled' | 'expired' | 'failed'
  phase?:
    | 'generating_qr'
    | 'waiting_for_scan'
    | 'scan_confirmed'
    | 'saving'
    | 'active'
    | 'cancelled'
    | 'expired'
    | 'failed'
  qrReady: boolean
  agentReady?: boolean
  createdAt: string
  expiresAt: string
  accountId?: string
  errorCode?: string
}

/**
 * 该 authMode 是否走 OAuth 授权码重定向流（用户 BYOA 自建应用：填 client 凭据 → 跳授权页）。
 * 单一权威：UI 一律用本函数判断，禁止各组件散写 authMode 字符串比较。
 * oauth2-auth-code 连接器**不能**走直填 bind（后端硬拒），必须走 oauth/start。
 */
export function isOauthAuthMode(authMode: string): boolean {
  return authMode === "oauth2-auth-code";
}

/** bind 表单单个字段的展示元数据（source → label/输入类型/占位符）。 */
export type BindFieldMeta = { label: string; type: "text" | "password"; placeholder?: string };

/**
 * source（后端 requiredBindSources 下发的凭据字段名）→ 表单字段展示元数据（单一权威）。
 * 未知 source 回退 password 类型（安全默认：宁可当密码遮挡也不明文回显未知凭据）。
 */
const BIND_SOURCE_FIELD: Record<string, BindFieldMeta> = {
  access_token: { label: "访问令牌 / API Token", type: "password" },
  client_id: { label: "应用 ID (Client ID)", type: "text" },
  client_secret: { label: "应用密钥 (Client Secret)", type: "password" },
  refresh_token: { label: "刷新令牌 (Refresh Token)", type: "password" },
};

/** source → 表单字段元数据（未知 source 回退 password + 原 source 名作 label）。 */
export function bindFieldMeta(source: string): BindFieldMeta {
  return BIND_SOURCE_FIELD[source] ?? { label: source, type: "password" };
}

/**
 * 声明式连接器读写能力标注（由 actions 的 effect 推导）：
 * 存在 write/send 类动作 → 可读写；否则只读。v1 卡片仍用 connectorCapabilityLabel。
 */
export function declarativeCapabilityLabel(actions: { effect: string }[]): string {
  const canWrite = actions.some((a) => a.effect === "write" || a.effect === "send");
  return canWrite ? "可读写" : "只读";
}

// ── provider 展示元数据（图标 + 读写能力标注） ──────────────────────────────

/** 连接器图标组件的最小 props 面（LucideIcon 与内联品牌标志都满足）。 */
export type ConnectorIcon = ComponentType<{ size?: number | string; className?: string }>;

/** 官方 GitHub 标志（lucide 无品牌图标 → 内联 path，对齐 github/RepoPill 的 GithubMark）。
 *  本文件是 .ts（无 JSX），用 createElement 构造。 */
function GithubMark({
  size = 16,
  className,
}: { size?: number | string; className?: string }): ReactElement {
  return createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "currentColor",
      "aria-hidden": true,
      className,
    },
    createElement("path", {
      d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    }),
  );
}

/** provider id → 图标（后端不下发图标，前端补充；未知 provider 回退通用插头）。 */
const CONNECTOR_ICON: Record<string, ConnectorIcon> = {
  webdav: HardDrive,
  imap: Mail,
  notion: NotebookText,
  github: GithubMark,
  feishu: MessagesSquare,
};

/** provider 图标（含未知回退，保证目录/确认卡永不缺图）。 */
export function connectorIcon(provider: string): ConnectorIcon {
  return CONNECTOR_ICON[provider] ?? Plug;
}

/** provider 读写能力：write=false → 目录标「只读」（v1 github 只读）。未登记 provider 回退可读写。 */
const CONNECTOR_CAPABILITY: Record<string, { read: boolean; write: boolean }> = {
  webdav: { read: true, write: true },
  imap: { read: true, write: true },
  notion: { read: true, write: true },
  github: { read: true, write: false },
  feishu: { read: true, write: true },
};

/** provider 读写能力标注文案（目录卡 pill）。 */
export function connectorCapabilityLabel(provider: string): string {
  const cap = CONNECTOR_CAPABILITY[provider] ?? { read: true, write: true };
  if (cap.read && cap.write) return "可读写";
  if (cap.read) return "只读";
  return "只写";
}

// ── 错误码 → 中文文案（照 lib/github.ts 模式：map + 未知回退，绝不暴露裸码） ──

const CONNECTOR_ERROR_TEXT: Record<string, string> = {
  // 凭据校验 / 绑定
  INVALID_CREDENTIALS: "凭据校验失败，请检查账号或授权码后重试",
  VERIFY_FAILED: "连接校验失败，请检查填写信息后重试",
  RELINK_REQUIRED: "授权已失效，请重新绑定",
  ACCOUNT_ALREADY_LINKED: "该账号已绑定，请勿重复绑定",
  CONNECTOR_NOT_INSTALLED: "请先从 AI 市场安装或更新该连接器",
  DUPLICATE_CONNECTION: "该账号已绑定，请勿重复绑定",
  TOO_MANY_CONNECTIONS: "绑定数量已达上限，请先解绑部分账号",
  QUOTA_EXCEEDED: "绑定数量已达上限，请先解绑部分账号",
  // 出站策略 / URL 形状（自由域 provider）
  SSRF_BLOCKED: "该服务器地址不被允许（仅支持公网 https 地址）",
  INVALID_HOST: "该服务器地址不被允许（仅支持公网 https 地址）",
  INVALID_URL: "地址格式不正确，请检查后重试",
  UNSUPPORTED_SCHEME: "仅支持 https 安全连接",
  // OAuth（BYOA）
  CONNECTOR_UNAVAILABLE: "该连接器暂不可用，请稍后重试或联系管理员",
  OAUTH_START_FAILED: "发起授权失败，请稍后重试",
  TOKEN_EXCHANGE_FAILED: "授权失败，请重新发起授权",
  INVALID_CLIENT: "应用凭据无效，请检查 Client ID / Secret",
  STATE_MISMATCH: "授权状态校验失败，请重新发起授权",
  // 授权页勾选的权限不足(后端 fail-closed 拒绝绑定,不落半残连接)。
  SCOPE_INSUFFICIENT: "授权的权限不足，请在授权页勾选全部所需权限后重试",
  // 通用
  RATE_LIMITED: "操作过于频繁，请稍后再试",
  UNSUPPORTED_PROVIDER: "暂不支持该应用",
  NOT_FOUND: "连接不存在或已解绑",
  // 声明式引擎（/api/connectors/declarative/* 经 HttpError 抛的 code）
  UPSTREAM_AUTH_FAILED: '应用凭据校验失败，请检查后重试',
  IDENTITY_INVALID: '账号身份校验失败，请稍后重试',
  BAD_REQUEST: '请求参数有误，请检查后重试',
  CONNECTION_NOT_FOUND: '连接不存在或已解绑',
  NOT_INSTALLED: '请先从 AI 市场安装该 Plugin',
  SETUP_ACTIVE: '已有一个扫码授权正在进行，请先完成或取消',
  SETUP_NOT_FOUND: '扫码会话已失效，请重新生成二维码',
  ACCOUNT_ALREADY_EXISTS: '该 Plugin 已授权账号，无需重复绑定',
  QR_NOT_READY: '二维码尚未就绪，请稍后重试',
  PLUGIN_RUNTIME_UNAVAILABLE: 'Plugin 授权服务暂不可用，请稍后重试',
  PLUGIN_SETUP_FAILED: 'Plugin 授权未完成，请重新扫码',
  LEASE_BUSY: '账号正在执行任务，请稍后再解绑',
  LEASE_UNAVAILABLE: '账号安全锁暂不可用，请稍后重试',
  WRITE_DISABLED: '写入能力尚未开启，请先在 Plugin 账号中阅读免责声明并开启',
  CONSENT_REQUIRED: '请先阅读并接受无人值守自动回复免责声明',
  MEDIA_INVALID: '图片或附件无效、已变化或超过大小限制，请重新选择',
  PRECONDITION_CHANGED: '目标内容在确认后已变化，本次操作未发送，请重新检查',
  TARGET_NOT_FOUND: 'Plugin 账号不存在或已解绑',
  TARGET_STALE: 'Plugin 账号状态已变化，请刷新后重试',
  INTERNAL: '服务暂时不可用，请稍后重试',
  UPSTREAM_ERROR: '应用服务暂时不可用，请稍后重试',
}

/** 错误码 → 友好中文（未知码回退通用文案，绝不暴露裸码/上游细节）。 */
export function connectorErrorText(code: string | null | undefined): string {
  if (!code) return "操作失败，请重试";
  return CONNECTOR_ERROR_TEXT[code] ?? "操作失败，请重试";
}

/** status='error' 且需重绑（lastErrorCode='RELINK_REQUIRED'）。 */
export function connectorNeedsRelink(
  conn: Pick<ConnectorConnection, "status" | "lastErrorCode">,
): boolean {
  return conn.status === "error" && conn.lastErrorCode === "RELINK_REQUIRED";
}

// ── 确认卡：写动作 + 账本状态 → 中文文案 ────────────────────────────────────

const CONFIRM_ACTION_LABEL: Record<string, string> = {
  put_file: "上传文件",
  send_email: "发送邮件",
  create_page: "创建页面",
  create_calendar_event: "创建日历事件",
  send_message: "发送消息",
};

/** 写动作 → 中文名（未知动作回退原文，不吞未知类型）。 */
export function confirmActionLabel(action: string): string {
  return CONFIRM_ACTION_LABEL[action] || action;
}

const CONFIRM_STATUS_LABEL: Record<ConnectorConfirmStatus, string> = {
  pending: "待确认",
  approved: "已确认",
  executing: "执行中",
  succeeded: "已完成",
  failed: "执行失败",
  unknown: "结果未知",
  expired: "已过期",
  denied: "已拒绝",
};

/** 账本状态 → 中文标签（未知状态回退原文）。 */
export function confirmStatusLabel(status: string): string {
  return CONFIRM_STATUS_LABEL[status as ConnectorConfirmStatus] || status;
}

/** 状态语义色调（卡片状态行/徽标用）。 */
export function confirmStatusTone(status: string): "pending" | "ok" | "danger" | "muted" {
  switch (status) {
    case "pending":
      return "pending";
    case "approved":
    case "succeeded":
      return "ok";
    case "failed":
    case "denied":
      return "danger";
    default:
      return "muted";
  }
}

/** 是否终态（不可再操作）。 */
export function isConfirmTerminal(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "unknown" ||
    status === "expired" ||
    status === "denied"
  );
}

/** 过期判定：expiresAt 已过（非法时间视为未过期，交由后端权威裁决）。 */
export function isConfirmExpired(expiresAt: string, nowMs: number = Date.now()): boolean {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= nowMs;
}
