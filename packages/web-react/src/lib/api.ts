import type {
  AgentCancelResult,
  AgentOpenResult,
  AgentStatus,
  ApiKeySummary,
  AuthSession,
  CreatedApiKey,
  CronCreateInput,
  CronJob,
  AgentTeam,
  AgentTeamInput,
  TeamRun,
  TeamDelegation,
  GithubBranch,
  GithubLink,
  GithubRepo,
  InboxMessage,
  RepoSelection,
  SkillDetail,
  SkillSummary,
  MarketplaceDetail,
  MarketplaceInstalled,
  MarketplaceMyAgent,
  MarketplacePending,
  MarketplacePublishInput,
  MarketplacePublishResult,
  MarketplaceSearchResult,
  HupiCreateResult,
  LoginResult,
  MediaSignResult,
  PaymentOrder,
  PaymentPlan,
  Preferences,
  PublicConfig,
  PublicModel,
  PutSessionInput,
  PutSessionResult,
  RefreshResult,
  RegisterResult,
  SessionDetail,
  SessionMeta,
  SubscriptionPlanWire,
  MySubscription,
  UsageQuery,
  UsageResponse,
  User,
  VerifyEmailResult,
} from "./types";

/**
 * v5 商业版前端网络层。
 *
 * 鉴权模型（与后端 packages/commercial/src/http/{handlers,cookies}.ts 对齐）：
 * - 内存态 access JWT 是唯一在用凭据，绝不落地（XSS 拿不到）。
 * - refresh token 走 HttpOnly cookie（__Host-* / 同源），登录/刷新/登出全部
 *   `credentials:'include'`，由浏览器自动携带 + 后端轮换，前端永不接触其明文。
 * - 命中 401 时透明刷新一次并重放（singleflight 防刷新风暴）。
 *
 * v4-trial 时代的 SSE `/api/v4/chat/*` 对话传输已移除：v5 对话走 WS
 * user-chat-bridge（bearer 子协议），在 P4 接入；本文件保留清晰的 chat stub。
 */

// ─── 静默刷新 + singleflight ─────────────────────────────────────────
// 每个 AuthSession 的共享刷新锁：并发 401 只发一次 /api/auth/refresh。
// 否则多个请求会用同一个 refresh cookie 并发刷新，第二个携带已轮换的旧 cookie
// 到后端会被判 reuse → 撤销整个 token family → 正常用户被踢下线。
const refreshInFlight = new WeakMap<AuthSession, Promise<string | null>>();

function refreshOnce(a: AuthSession): Promise<string | null> {
  let pending = refreshInFlight.get(a);
  if (!pending) {
    pending = (async () => {
      const refreshed = await api.refresh();
      if (refreshed) {
        a.setToken(refreshed.accessToken);
        return refreshed.accessToken;
      }
      a.onExpired();
      return null;
    })().finally(() => refreshInFlight.delete(a));
    refreshInFlight.set(a, pending);
  }
  return pending;
}

async function callWithRefresh(
  a: AuthSession,
  make: (token: string) => Promise<Response>,
): Promise<Response> {
  const usedToken = a.getToken();
  const res = await make(usedToken);
  if (res.status !== 401) return res;
  // 若期间别的并发请求已刷新出新 token，直接用新 token 重放，不再触发 refresh。
  const current = a.getToken();
  const newToken = current && current !== usedToken ? current : await refreshOnce(a);
  if (!newToken) {
    // 刷新失败 → 会话过期（onExpired 已在 refreshOnce 内触发一次），把原始 401 交回上层。
    return res;
  }
  // 用新 token 重放一次（最多一次，重放仍失败不再刷新）。
  return make(newToken);
}

/** 可中断 sleep（用于冷启轮询退避）。abort 时 reject AbortError 并清理定时器。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 拼鉴权头：身份完全由 access JWT(sub) 决定，只带 Bearer。 */
function bearerHeaders(token: string, json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (json) h["content-type"] = "application/json";
  return h;
}

/** 把 x-request-id 拼到错误信息末尾，方便用户反馈、运维追溯。 */
function withReqId(msg: string, res: Response): string {
  const id = res.headers.get("x-request-id");
  return id ? `${msg}（追踪号 ${id}）` : msg;
}

/** 后端错误 issue（commercial HttpError.issues：path+message 键值对）。 */
export type ApiIssue = { path: string; message: string };

/**
 * 统一的网络错误类型 —— 唯一权威，承载 status / code / issues / requestId，
 * 让上层按 **状态码 + 机器码** 分支（402 余额不足 / 409 已订阅 / 409 conflict /
 * 413 too large / 404 not found …），而不是去 parse 中文 message 字符串。
 *
 * 兼容两套后端错误信封：
 *   - commercial REST：`{ error: { code, message, issues? } }`
 *   - gateway（会话历史等）：`{ error: "<string>" }`
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly issues?: ApiIssue[];
  /** 503 / 4503 冷启场景的建议重试秒数（Retry-After 头或 body）。 */
  readonly retryAfterSec?: number;
  /** 原始解析后的 body（调试 / 提取 commercial issues 的额外字段）。 */
  readonly body?: unknown;
  constructor(init: {
    status: number;
    message: string;
    code?: string;
    requestId?: string;
    issues?: ApiIssue[];
    retryAfterSec?: number;
    body?: unknown;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.issues = init.issues;
    this.retryAfterSec = init.retryAfterSec;
    this.body = init.body;
  }
  /** 从 issues 里取某个字段值（如 402 的 shortfall、409 的 subscription_id）。 */
  issue(path: string): string | undefined {
    return this.issues?.find((i) => i.path === path)?.message;
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** 读 !res.ok 的响应体，组装并抛出 ApiError（绝不返回）。 */
async function throwApi(res: Response): Promise<never> {
  let message = `请求失败 (${res.status})`;
  let code: string | undefined;
  let issues: ApiIssue[] | undefined;
  let body: unknown;
  try {
    body = await res.json();
    const b = body as Record<string, unknown> | null;
    const err = b?.error;
    if (err && typeof err === "object") {
      // commercial：{ error: { code, message, issues } }
      const e = err as Record<string, unknown>;
      if (typeof e.message === "string") message = e.message;
      if (typeof e.code === "string") code = e.code;
      if (Array.isArray(e.issues)) issues = e.issues as ApiIssue[];
    } else if (typeof err === "string") {
      // gateway：{ error: "<string>" }
      message = err;
    } else if (typeof b?.message === "string") {
      message = b.message as string;
    }
  } catch {
    /* 非 JSON 响应：保留默认 message */
  }
  throw new ApiError({
    status: res.status,
    message: withReqId(message, res),
    code,
    issues,
    requestId: res.headers.get("x-request-id") ?? undefined,
    retryAfterSec: parseRetryAfter(res),
    body,
  });
}

async function jsonOrThrow<T>(p: Promise<Response> | Response): Promise<T> {
  const res = await p;
  if (!res.ok) await throwApi(res);
  return (await res.json()) as T;
}

/** 订阅/升档下单响应 → HupiCreateResult（与 hupi/create 同形，复用 QR + 订单轮询）。 */
function parseSubscriptionOrder(p: Promise<Response>): Promise<HupiCreateResult> {
  return jsonOrThrow<{
    ok: boolean;
    data: {
      order_no: string; qrcode_url: string; mobile_url: string | null;
      amount_cents: string; credits: string; expires_at: string;
    };
  }>(p).then((b) => ({
    orderNo: b.data.order_no,
    qrcodeUrl: b.data.qrcode_url,
    mobileUrl: b.data.mobile_url,
    amountCents: b.data.amount_cents,
    credits: b.data.credits,
    expiresAt: b.data.expires_at,
  }));
}

// ─── v5 后端 wire 形态 → 前端类型适配 ────────────────────────────────
type WireUser = {
  id: string;
  email?: string;
  email_verified?: boolean;
  role?: "user" | "admin";
  display_name?: string | null;
  avatar_url?: string | null;
  credits?: string;
  created_at?: string;
};

/** v5 `/api/me` / login user → 前端 User。displayName/roles 由后端字段适配，组件层零改动。 */
function adaptUser(u: WireUser): User {
  return {
    id: u.id,
    displayName: u.display_name || u.email || "用户",
    roles: u.role ? [u.role] : ["user"],
    email: u.email,
    role: u.role,
    emailVerified: u.email_verified,
    avatarUrl: u.avatar_url ?? null,
    credits: u.credits, // 字符串大数，原样保留，绝不数值化
    createdAt: u.created_at,
  };
}

export const api = {
  // ── 鉴权 ───────────────────────────────────────────────────────────

  /**
   * 邮箱+密码登录（POST /api/auth/login）。成功返回内存态 accessToken + 用户信息。
   * credentials:'include' 让浏览器接收并存下 HttpOnly refresh cookie（同源），后续 refresh 才能用。
   * turnstileToken 可选：开启 Turnstile 时由调用方传入（生产必填）。
   */
  async login(email: string, password: string, turnstileToken?: string): Promise<LoginResult> {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
      }),
    });
    if (!res.ok) await throwApi(res);
    const b = (await res.json()) as {
      user: WireUser;
      access_token: string;
      access_exp: number;
      refresh_exp: number;
      remember: boolean;
    };
    return {
      accessToken: b.access_token,
      accessExp: b.access_exp,
      refreshExp: b.refresh_exp,
      remember: b.remember,
      user: adaptUser(b.user),
    };
  },

  /**
   * 静默刷新（POST /api/auth/refresh）：无 body、无 Authorization，仅凭同源 HttpOnly refresh
   * cookie 换新 access token。浏览器在同源 fetch 上自动带 Origin（满足后端 CSRF 校验）。
   * v5 仅回 access token（不回 user）。200 返回解析体，否则 null。
   * 该调用绝不经 callWithRefresh 包装，避免 401 时自我递归。
   */
  async refresh(): Promise<RefreshResult | null> {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const b = (await res.json()) as { access_token: string; access_exp: number; remember: boolean };
      return { accessToken: b.access_token, accessExp: b.access_exp, remember: b.remember };
    } catch {
      return null;
    }
  },

  /** 主动登出（POST /api/auth/logout）：吊销 refresh cookie。错误一律吞掉（前端清状态即视为已登出）。 */
  async logout(): Promise<void> {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
    } catch {
      /* ignore */
    }
  },

  /** 注册（POST /api/auth/register，201）。turnstileToken 开启 Turnstile 时必填。 */
  register(input: {
    email: string;
    password: string;
    turnstileToken?: string;
    displayName?: string;
  }): Promise<RegisterResult> {
    return jsonOrThrow<{ user_id: string; verify_email_sent: boolean }>(
      fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          ...(input.turnstileToken ? { turnstile_token: input.turnstileToken } : {}),
          ...(input.displayName ? { display_name: input.displayName } : {}),
        }),
      }),
    ).then((b) => ({ userId: b.user_id, verifyEmailSent: b.verify_email_sent }));
  },

  /** 邮箱验证（POST /api/auth/verify-email）：{email, code} → 验证结果。 */
  verifyEmail(email: string, code: string): Promise<VerifyEmailResult> {
    return jsonOrThrow<{ user_id: string; newly_verified: boolean }>(
      fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      }),
    ).then((b) => ({ userId: b.user_id, newlyVerified: b.newly_verified }));
  },

  /** 重发验证邮件（POST /api/auth/resend-verification）。后端防枚举，恒 200 + accepted。 */
  resendVerification(email: string): Promise<{ accepted: boolean }> {
    return jsonOrThrow<{ accepted: boolean }>(
      fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
  },

  /** 跨设备查邮箱验证态（GET /api/auth/check-verification?email=）。后端防枚举，恒 200。 */
  checkVerification(email: string): Promise<{ verified: boolean }> {
    return jsonOrThrow<{ verified: boolean }>(
      fetch(`/api/auth/check-verification?email=${encodeURIComponent(email)}`, {
        headers: { Accept: "application/json" },
      }),
    );
  },

  /**
   * 发起密码重置（POST /api/auth/request-password-reset）。后端防枚举：无论邮箱是否存在
   * 恒返 200 + accepted（仅 turnstile 校验失败会 400 TURNSTILE_FAILED）。校验通过后后端给
   * 该邮箱发一封含 `/reset-password?token=…` 链接的邮件，用户点链接回站内走 confirmPasswordReset。
   * turnstileToken：开启 Turnstile 时必填（生产）；canary bypass 发占位串即可。
   */
  requestPasswordReset(email: string, turnstileToken?: string): Promise<{ accepted: boolean }> {
    return jsonOrThrow<{ accepted: boolean }>(
      fetch("/api/auth/request-password-reset", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          email,
          ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
        }),
      }),
    );
  },

  /**
   * 完成密码重置（POST /api/auth/confirm-password-reset）。token 来自重置邮件链接的
   * `?token=` 参数；成功后该用户**所有未吊销的 refresh token 全部被撤销**（强制各端重登）。
   * token 失效 / 过期 / 已用 / 新密码不合规 → 400（经 ApiError 抛，调用方据 message 提示）。
   */
  confirmPasswordReset(
    token: string,
    newPassword: string,
  ): Promise<{ userId: string; revokedRefreshTokens: number }> {
    return jsonOrThrow<{ user_id: string; revoked_refresh_tokens: number }>(
      fetch("/api/auth/confirm-password-reset", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ token, new_password: newPassword }),
      }),
    ).then((b) => ({ userId: b.user_id, revokedRefreshTokens: b.revoked_refresh_tokens }));
  },

  // ── 账户 ───────────────────────────────────────────────────────────

  /** 当前用户（GET /api/me，Bearer）。credits 为字符串大数，adaptUser 原样保留。 */
  getMe: (a: AuthSession) =>
    jsonOrThrow<{ user: WireUser }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((r) => adaptUser(r.user)),

  /** 偏好快照（GET /api/me/preferences，Bearer）。 */
  getPreferences: (a: AuthSession) =>
    jsonOrThrow<Preferences>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/preferences", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ),

  /** 改偏好（PATCH /api/me/preferences，Bearer）→ 新快照。 */
  patchPreferences: (a: AuthSession, patch: Preferences) =>
    jsonOrThrow<Preferences>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/preferences", {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ),

  /**
   * 用量统计（GET /api/me/usage，Bearer）。summary + 分页 sessions（offset）+
   * keyset ledger（before）+ savings。**所有大数字段为字符串，勿数值化。**
   * 抛 ApiError（含 400 INVALID_USAGE_QUERY）—— 调用方自行兜底，不再吞成 null。
   */
  getUsage: (a: AuthSession, q?: UsageQuery): Promise<UsageResponse> => {
    const qs = new URLSearchParams();
    if (q?.sessionsLimit != null) qs.set("sessions_limit", String(q.sessionsLimit));
    if (q?.sessionsOffset != null) qs.set("sessions_offset", String(q.sessionsOffset));
    if (q?.ledgerLimit != null) qs.set("ledger_limit", String(q.ledgerLimit));
    if (q?.ledgerBefore) qs.set("ledger_before", q.ledgerBefore);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return jsonOrThrow<UsageResponse>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/usage${suffix}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    );
  },

  // ── API Keys（注意：当前后端 admin-only rollout，普通用户调用返 403） ─────────

  /** 列出我的 API key（GET /api/me/api-keys，Bearer）。不含明文。 */
  listApiKeys: (a: AuthSession): Promise<ApiKeySummary[]> =>
    jsonOrThrow<{
      keys: Array<{
        id: string;
        label: string;
        key_prefix: string;
        created_at: string;
        last_used_at: string | null;
      }>;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/api-keys", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) =>
      b.keys.map((k) => ({
        id: k.id,
        label: k.label,
        keyPrefix: k.key_prefix,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at,
      })),
    ),

  /**
   * 新建 API key（POST /api/me/api-keys，201，Bearer）。返完整明文 plaintext **仅一次**，
   * 必须立即引导用户复制保存；后端永远无法重新生成。400 INVALID_LABEL 经 ApiError 抛。
   */
  createApiKey: (a: AuthSession, label: string): Promise<CreatedApiKey> =>
    jsonOrThrow<{
      id: string;
      label: string;
      key_prefix: string;
      plaintext: string;
      created_at: string;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/api-keys", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ label }),
        }),
      ),
    ).then((b) => ({
      id: b.id,
      label: b.label,
      keyPrefix: b.key_prefix,
      plaintext: b.plaintext,
      createdAt: b.created_at,
    })),

  /**
   * 撤销 API key（DELETE /api/me/api-keys/:id，Bearer）。软撤销，幂等。
   * 不存在 / 已撤销 / 非本人一律 404（不暴露存在性），经 ApiError 抛。
   */
  deleteApiKey: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/api-keys/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 公开（匿名可读） ────────────────────────────────────────────────

  /** 公开配置（GET /api/public/config）：Turnstile site key / 注册开关等。 */
  getPublicConfig: (): Promise<PublicConfig> =>
    jsonOrThrow<{
      turnstile_site_key: string;
      turnstile_bypass: boolean;
      require_email_verified: boolean;
      feature_remote_ssh: boolean;
      allow_registration: boolean;
    }>(fetch("/api/public/config", { headers: { Accept: "application/json" } })).then((b) => ({
      turnstileSiteKey: b.turnstile_site_key,
      turnstileBypass: b.turnstile_bypass,
      requireEmailVerified: b.require_email_verified,
      featureRemoteSsh: b.feature_remote_ssh,
      allowRegistration: b.allow_registration,
    })),

  /**
   * 公开模型列表（GET /api/public/models）。v5 经后端 dropGptForV5Channel 仅
   * claude/glm-5.2/deepseek/minimax。可选带 Bearer（登录用户走 grants 视图）。
   */
  async getPublicModels(a?: AuthSession): Promise<PublicModel[]> {
    const run = (t?: string) =>
      fetch("/api/public/models", {
        headers: t ? bearerHeaders(t) : { Accept: "application/json" },
      });
    const res = a ? await callWithRefresh(a, (t) => run(t)) : await run();
    const b = await jsonOrThrow<{ models: PublicModel[] }>(res);
    return b.models || [];
  },

  // ── 对话前置（Agent 订阅 / 容器） ────────────────────────────────────

  /** Agent 订阅/容器状态（GET /api/agent/status，Bearer）。 */
  getAgentStatus: (a: AuthSession): Promise<AgentStatus> =>
    jsonOrThrow<{
      runtime_ready: boolean;
      ondemand?: boolean;
      subscription: {
        id: string;
        plan: string;
        status: string;
        start_at: string;
        end_at: string;
        auto_renew: boolean;
        last_renewed_at: string | null;
      } | null;
      container: {
        id: string;
        subscription_id: string | null;
        docker_id: string | null;
        docker_name: string | null;
        image: string | null;
        status: string;
        last_started_at: string | null;
        last_stopped_at: string | null;
        volume_gc_at: string | null;
        last_error: string | null;
      } | null;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent/status", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({
      runtimeReady: b.runtime_ready,
      ondemand: Boolean(b.ondemand),
      subscription: b.subscription
        ? {
            id: b.subscription.id,
            plan: b.subscription.plan,
            status: b.subscription.status,
            startAt: b.subscription.start_at,
            endAt: b.subscription.end_at,
            autoRenew: b.subscription.auto_renew,
            lastRenewedAt: b.subscription.last_renewed_at,
          }
        : null,
      container: b.container
        ? {
            id: b.container.id,
            subscriptionId: b.container.subscription_id,
            dockerId: b.container.docker_id,
            dockerName: b.container.docker_name,
            image: b.container.image,
            status: b.container.status,
            lastStartedAt: b.container.last_started_at,
            lastStoppedAt: b.container.last_stopped_at,
            volumeGcAt: b.container.volume_gc_at,
            lastError: b.container.last_error,
          }
        : null,
    })),

  /**
   * 开通 Agent 订阅（POST /api/agent/open，Bearer）。成功 202（status='provisioning'，
   * 容器异步开机，需随后 pollAgentReady）。失败经 ApiError 抛：
   *   - 402（issues.shortfall = 缺口积分字符串）→ 余额不足
   *   - 409（issues.subscription_id / issues.end_at）→ 已有有效订阅
   * balanceAfter 为字符串大数，勿数值化。
   */
  openAgent: (a: AuthSession): Promise<AgentOpenResult> =>
    jsonOrThrow<{
      subscription_id: string;
      container_id: string;
      status: string;
      start_at: string;
      end_at: string;
      balance_after: string;
      ledger_id: string;
      docker_name: string;
      workspace_volume: string;
      home_volume: string;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent/open", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({
      subscriptionId: b.subscription_id,
      containerId: b.container_id,
      status: b.status,
      startAt: b.start_at,
      endAt: b.end_at,
      balanceAfter: b.balance_after,
      ledgerId: b.ledger_id,
      dockerName: b.docker_name,
      workspaceVolume: b.workspace_volume,
      homeVolume: b.home_volume,
    })),

  /** 退订 Agent（POST /api/agent/cancel，Bearer）。404 = 未订阅（经 ApiError 抛）。 */
  agentCancel: (a: AuthSession): Promise<AgentCancelResult> =>
    jsonOrThrow<{
      subscription_id: string;
      end_at: string;
      auto_renew: false;
      was_auto_renew: boolean;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent/cancel", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({
      subscriptionId: b.subscription_id,
      endAt: b.end_at,
      autoRenew: false as const,
      wasAutoRenew: b.was_auto_renew,
    })),

  /**
   * 容器冷启轮询封装（对话前置）。openAgent 返 202 provisioning 后，容器在后台异步开机，
   * 此 helper 轮询 getAgentStatus 直到容器 'running'。
   *
   * 终态语义：
   *   - container.status==='running'         → resolve(status)
   *   - container.status==='error'           → reject(ApiError 503 CONTAINER_ERROR, 带 lastError)
   *   - 超时（timeoutMs）                     → reject(ApiError 504 PROVISION_TIMEOUT)
   *   - signal abort                          → reject(AbortError)
   * 其余态（provisioning/stopped/无容器）继续按 intervalMs 轮询。
   *
   * 说明：WS user-chat-bridge 的容器未就绪用 **WS close code 4503 + retryAfterSec**
   * 表达（非 HTTP 状态），其重连节流由 P4 useChatSocket 负责；此处只覆盖 REST 侧的
   * open→running 过渡，供对话前置 UI 展示「正在开机」。
   */
  async pollAgentReady(
    a: AuthSession,
    opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AgentStatus> {
    const intervalMs = opts?.intervalMs ?? 2000;
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (opts?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const status = await api.getAgentStatus(a);
      const cs = status.container?.status;
      if (cs === "running") return status;
      if (cs === "error") {
        throw new ApiError({
          status: 503,
          code: "CONTAINER_ERROR",
          message: status.container?.lastError || "容器开机失败，请稍后重试或联系支持。",
        });
      }
      if (Date.now() + intervalMs >= deadline) {
        throw new ApiError({
          status: 504,
          code: "PROVISION_TIMEOUT",
          message: "容器开机超时，请稍后重试。",
        });
      }
      await sleep(intervalMs, opts?.signal);
    }
  },

  // ── 会话历史（权威源 = gateway，camelCase wire；走 Bearer + callWithRefresh） ──

  /** 列出我的会话（GET /api/sessions/list，Bearer）。无 messages 的元数据列表。 */
  listSessions: (a: AuthSession): Promise<SessionMeta[]> =>
    jsonOrThrow<{ sessions: SessionMeta[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/sessions/list", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.sessions || []),

  /**
   * 取单个会话（GET /api/sessions/:id，Bearer）。
   * sinceSeq>0 → 增量同步（仅返 `_seq > sinceSeq` 的 messages；legacy 行降级全量）。
   * 不存在 → 404（经 ApiError 抛）。id 形态须匹配后端 `[A-Za-z0-9_-]{8,50}`。
   */
  getSession: (a: AuthSession, id: string, sinceSeq = 0): Promise<SessionDetail> => {
    const suffix = sinceSeq > 0 ? `?since=${encodeURIComponent(String(sinceSeq))}` : "";
    return jsonOrThrow<SessionDetail>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}${suffix}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    );
  },

  /**
   * 写入会话（PUT /api/sessions/:id，Bearer）。乐观并发：传 `_baseSyncedAt`（上次同步
   * 到的 updatedAt），服务端发现被他人抢先 → 409 conflict（经 ApiError 抛，调用方需
   * 重新拉取合并后重试）。wire body 上限 2MB / 存储 blob 上限 4MB，超出 413。
   */
  putSession: (a: AuthSession, id: string, input: PutSessionInput): Promise<PutSessionResult> =>
    jsonOrThrow<PutSessionResult>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /**
   * 跨设备持久化「用户发送的消息」（POST /api/sessions/:id/user-message，Bearer）。
   * 带前端 client 消息 id；服务端直写(role:'user',绕乐观并发,scoped by userId),
   * getSession 回带同 id → 前端合并去重。best-effort，调用方吞错不阻断发送。
   */
  appendUserMessage: (
    a: AuthSession,
    id: string,
    msg: { id: string; text: string; ts: number; media?: unknown },
  ): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}/user-message`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(msg),
        }),
      ),
    ).then(() => undefined),

  /** 删除会话（DELETE /api/sessions/:id，Bearer）。幂等，恒 200。 */
  deleteSession: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<{ ok: true }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 文件上传（gateway /api/uploads，Bearer；写入用户容器工作区，返回内容寻址 URL） ──

  /**
   * 上传单个文件（POST /api/uploads，Bearer）。原始二进制 body + x-filename 头。
   * 返回 `{ url, digest, size, mimeType }`——url 形如 `/api/media/<digest>.<ext>`，
   * 可直接作为 MediaRef.url 放进对话 inbound.message.content.media。
   * File/Blob body 可重发，故 401 透明刷新重放安全。
   */
  uploadFile: (
    a: AuthSession,
    file: File,
  ): Promise<{ url: string; digest?: string; size?: number; mimeType?: string }> =>
    jsonOrThrow(
      callWithRefresh(a, (t) =>
        fetch("/api/uploads", {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${t}`,
            "content-type": file.type || "application/octet-stream",
            "x-filename": encodeURIComponent(file.name || "file"),
          },
          body: file,
        }),
      ),
    ),

  // ── 媒体签名（commercial REST） ──────────────────────────────────────────

  /**
   * 批量签名容器内媒体路径（POST /api/media-sign，Bearer + cookie dual-verify）。
   * 返回 path→opaque签名URL 映射（被 ACL 拒的路径静默缺失，需自行判断）。
   * 签出的 URL 可直接用于 `<img src>` / `<a href>`（无需鉴权头，opaque token 自证）。
   */
  mediaSign: (a: AuthSession, paths: string[]): Promise<MediaSignResult> =>
    jsonOrThrow<MediaSignResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/media-sign", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ paths }),
        }),
      ),
    ),

  /**
   * 按签名 URL 取媒体二进制（GET /api/media-signed，公开端点，无需鉴权头）。
   * 多数场景下 mediaSign 返回的 URL 直接挂到元素 src 即可；此 helper 仅用于需要
   * 程序化拿到 Blob 的场景（如下载 / 转存）。
   * 冷启容器未就绪 → 503 + Retry-After：自动按 Retry-After 退避重试（上限 maxRetries）。
   */
  async fetchSignedMedia(
    signedUrl: string,
    opts?: { maxRetries?: number; signal?: AbortSignal },
  ): Promise<Blob> {
    const maxRetries = opts?.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const res = await fetch(signedUrl, { headers: { Accept: "*/*" }, signal: opts?.signal });
      if (res.ok) return res.blob();
      // 容器冷启：503 + Retry-After（见 commercial handleMediaSigned ensureContainerReady）。
      if (res.status === 503 && attempt < maxRetries) {
        const retryAfterSec = parseRetryAfter(res) ?? 2;
        await sleep(retryAfterSec * 1000, opts?.signal);
        continue;
      }
      await throwApi(res);
    }
  },

  // ── 充值 / 计费（虎皮椒扫码，commercial REST） ────────────────────────────

  /**
   * 充值套餐列表（GET /api/payment/plans）。公开端点，可选带 Bearer（登录用户首充档
   * 按是否用过过滤）。金额/积分均字符串大数。
   */
  async listPlans(a?: AuthSession): Promise<PaymentPlan[]> {
    const run = (t?: string) =>
      fetch("/api/payment/plans", {
        credentials: "include",
        headers: t ? bearerHeaders(t) : { Accept: "application/json" },
      });
    const res = a ? await callWithRefresh(a, (t) => run(t)) : await run();
    const b = await jsonOrThrow<{
      ok: boolean;
      data: {
        plans: Array<{ code: string; label: string; amount_cents: string; credits: string }>;
      };
    }>(res);
    return (b.data?.plans || []).map((p) => ({
      code: p.code,
      label: p.label,
      amountCents: p.amount_cents,
      credits: p.credits,
    }));
  },

  /**
   * 创建虎皮椒充值订单（POST /api/payment/hupi/create，Bearer）。
   * 返回扫码 URL + 订单号（随后用 getOrder 轮询到账）。
   * 409 FIRST_TOPUP_USED = 老用户企图复用首充档（经 ApiError 抛）。
   */
  createHupiOrder: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        order_no: string;
        qrcode_url: string;
        mobile_url: string | null;
        amount_cents: string;
        credits: string;
        expires_at: string;
      };
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/payment/hupi/create", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ).then((b) => ({
      orderNo: b.data.order_no,
      qrcodeUrl: b.data.qrcode_url,
      mobileUrl: b.data.mobile_url,
      amountCents: b.data.amount_cents,
      credits: b.data.credits,
      expiresAt: b.data.expires_at,
    })),

  /**
   * 查询订单（GET /api/payment/orders/:orderNo，Bearer）。轮询用：status 转 'paid'
   * 即到账。404 ORDER_NOT_FOUND（非本人 / 不存在）经 ApiError 抛。
   */
  getOrder: (a: AuthSession, orderNo: string): Promise<PaymentOrder> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        order_no: string;
        status: string;
        amount_cents: string;
        credits: string;
        expires_at: string;
        paid_at: string | null;
        created_at: string;
        provider: string;
      };
    }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/payment/orders/${encodeURIComponent(orderNo)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({
      orderNo: b.data.order_no,
      status: b.data.status,
      amountCents: b.data.amount_cents,
      credits: b.data.credits,
      expiresAt: b.data.expires_at,
      paidAt: b.data.paid_at,
      createdAt: b.data.created_at,
      provider: b.data.provider,
    })),

  // ── 月度订阅（0096，commercial REST） ──────────────────────────────────────

  /** 套餐档列表（GET /api/subscription/plans，公开）。金额/积分字符串大数。 */
  async listSubscriptionPlans(): Promise<SubscriptionPlanWire[]> {
    const b = await jsonOrThrow<{
      ok: boolean;
      data: {
        plans: Array<{
          code: string; name: string; price_cents: string;
          monthly_credits: string; period_days: number; tier: number;
        }>;
      };
    }>(fetch("/api/subscription/plans", { headers: { Accept: "application/json" } }));
    return (b.data?.plans || []).map((p) => ({
      code: p.code,
      name: p.name,
      priceCents: p.price_cents,
      monthlyCredits: p.monthly_credits,
      periodDays: p.period_days,
      tier: p.tier,
    }));
  },

  /** 当前订阅 + 双钱包余额明细（GET /api/subscription/me，Bearer）。 */
  getMySubscription: (a: AuthSession): Promise<MySubscription> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        subscription: {
          plan_code: string; plan_name: string; status: string;
          period_start: string; period_end: string; period_credits: string;
          monthly_credits: string; price_cents: string; tier: number; paid: boolean;
        };
        balance: { wallet: string; period: string; total: string };
      };
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/me", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({
      planCode: b.data.subscription.plan_code,
      planName: b.data.subscription.plan_name,
      status: b.data.subscription.status,
      periodStart: b.data.subscription.period_start,
      periodEnd: b.data.subscription.period_end,
      periodCredits: b.data.subscription.period_credits,
      monthlyCredits: b.data.subscription.monthly_credits,
      priceCents: b.data.subscription.price_cents,
      tier: b.data.subscription.tier,
      paid: b.data.subscription.paid,
      balance: {
        wallet: b.data.balance.wallet,
        period: b.data.balance.period,
        total: b.data.balance.total,
      },
    })),

  /** 购买/续费某档（POST /api/subscription/subscribe，Bearer）→ 虎皮椒扫码（同 hupi/create 形）。 */
  subscribe: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/subscribe", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ),

  /** 升档（补差价，POST /api/subscription/upgrade，Bearer）→ 扫码。 */
  upgradeSubscription: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/upgrade", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ),

  /** 购买积分加量包（进期内桶，POST /api/subscription/pack，Bearer）→ 扫码。v5 专属，与 v3 隔离。 */
  buyPack: (a: AuthSession): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetch("/api/subscription/pack", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  // ── 容器内管理（记忆 / 定时任务 / 技能；经 commercial router 自动代理进用户容器） ──
  //
  // 这些 host 级路径对商业用户本会 403 BLOCKED，但命中 bridgeApiAllowlist 的
  // proxyFromCommercial 条目后由 router 注入 bridge nonce 转发到用户容器内 gateway
  // (127.0.0.1:18789，按 userId 隔离)。前端只需普通 Bearer fetch，无需特殊 header。
  // 容器未就绪时 router 会先 ensureContainerReady（可能冷启 ~40s），失败返 503/4503。

  /** 取某 agent 的记忆文档（GET /api/agents/:id/memory/:target，target=memory|user）。 */
  getMemory: (a: AuthSession, agentId: string, target: "memory" | "user") =>
    jsonOrThrow<{ text: string; charCount?: number; target: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/${target}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 写某 agent 的记忆文档（PUT /api/agents/:id/memory/:target）。 */
  putMemory: (a: AuthSession, agentId: string, target: "memory" | "user", text: string) =>
    jsonOrThrow<{ ok: boolean; charCount?: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agents/${encodeURIComponent(agentId)}/memory/${target}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ text }),
        }),
      ),
    ),

  /** 定时任务列表（GET /api/cron）。 */
  listCron: (a: AuthSession) =>
    jsonOrThrow<{ jobs: CronJob[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/cron", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.jobs || []),

  /** 新建定时任务（POST /api/cron）。 */
  createCron: (a: AuthSession, body: CronCreateInput) =>
    jsonOrThrow<{ ok: boolean; job?: CronJob }>(
      callWithRefresh(a, (t) =>
        fetch("/api/cron", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 改定时任务（PUT /api/cron/:id，如 {enabled}）。 */
  updateCron: (a: AuthSession, id: string, patch: Record<string, unknown>) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/cron/${encodeURIComponent(id)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ),

  /** 删除定时任务（DELETE /api/cron/:id）。 */
  deleteCron: (a: AuthSession, id: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/cron/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── Agent Teams（团队模式）─────────────────────────────
  /** 团队列表（GET /api/agent-teams）。 */
  listTeams: (a: AuthSession) =>
    jsonOrThrow<{ teams: AgentTeam[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent-teams", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.teams || []),

  /** 新建团队（POST /api/agent-teams）。 */
  createTeam: (a: AuthSession, body: AgentTeamInput) =>
    jsonOrThrow<{ team: AgentTeam }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent-teams", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ).then((b) => b.team),

  /** 改团队（PUT /api/agent-teams/:id）。 */
  updateTeam: (a: AuthSession, id: string, body: AgentTeamInput) =>
    jsonOrThrow<{ team: AgentTeam }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agent-teams/${encodeURIComponent(id)}`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ).then((b) => b.team),

  /** 删除团队（DELETE /api/agent-teams/:id）。 */
  deleteTeam: (a: AuthSession, id: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agent-teams/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 发起一次团队运行（POST /api/agent-teams/:id/runs）→ { teamRunId }。 */
  createTeamRun: (
    a: AuthSession,
    id: string,
    body: {
      goal: string;
      sessionKey?: string;
      origin?: { channel?: string; peerId?: string; peerKind?: string; userId?: string };
    },
  ) =>
    jsonOrThrow<{ teamRunId: string }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/agent-teams/${encodeURIComponent(id)}/runs`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 团队运行账本（GET /api/team-runs/:id）→ { run, delegations }。 */
  getTeamRun: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ run: TeamRun; delegations: TeamDelegation[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/team-runs/${encodeURIComponent(runId)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 停止一次团队运行（POST /api/team-runs/:id/stop）→ 中断队长+全部委派。 */
  stopTeamRun: (a: AuthSession, runId: string) =>
    jsonOrThrow<{ ok: boolean; wasActive: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/team-runs/${encodeURIComponent(runId)}/stop`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 技能列表（GET /api/skills）。 */
  listSkills: (a: AuthSession) =>
    jsonOrThrow<{ skills: SkillSummary[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/skills", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.skills || []),

  /** 技能详情（GET /api/skills/:name）。 */
  getSkill: (a: AuthSession, name: string) =>
    jsonOrThrow<{ skill: SkillDetail }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.skill),

  /** 删除技能（DELETE /api/skills/:name）。 */
  deleteSkill: (a: AuthSession, name: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── AI 市场（marketplace，见 packages/commercial/src/marketplace） ─────────

  /** 市场检索/浏览（GET /api/marketplace/search?q=&limit=&kind=，空 q 返该 kind 全部目录）。 */
  searchMarketplace: (a: AuthSession, q = "", kind?: "skill" | "agent", limit = 50) =>
    jsonOrThrow<MarketplaceSearchResult>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/marketplace/search?q=${encodeURIComponent(q)}&limit=${limit}${kind ? `&kind=${kind}` : ""}`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ),

  /** 市场条目详情（GET /api/marketplace/:slug，含完整 SKILL.md 供安装确认）。 */
  getMarketplaceDetail: (a: AuthSession, slug: string) =>
    jsonOrThrow<{ detail: MarketplaceDetail }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/${encodeURIComponent(slug)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.detail),

  /** 安装一个已批准版本（POST /api/marketplace/install）。 */
  installMarketplace: (a: AuthSession, versionId: string) =>
    jsonOrThrow<{ ok: boolean; slug: string; version: string; note: string }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/install", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ versionId }),
        }),
      ),
    ),

  /** 我的已安装（GET /api/marketplace/installed）。 */
  listMarketplaceInstalled: (a: AuthSession) =>
    jsonOrThrow<{ installed: MarketplaceInstalled[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/installed", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.installed || []),

  /** 卸载（DELETE /api/marketplace/installed/:slug）。 */
  uninstallMarketplace: (a: AuthSession, slug: string) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/marketplace/installed/${encodeURIComponent(slug)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 发布（POST /api/marketplace/publish）。被静态扫描拦截时抛 ApiError
   * (status 422, code SCAN_BLOCKED, body 含 riskFlags)，上层据此做友好提示。
   */
  publishMarketplace: (a: AuthSession, input: MarketplacePublishInput) =>
    jsonOrThrow<MarketplacePublishResult>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/publish", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ),

  /** 我的智能体（GET /api/marketplace/my-agents：默认全能助手 + 已安装市场智能体）。 */
  listMyAgents: (a: AuthSession) =>
    jsonOrThrow<{ agents: MarketplaceMyAgent[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/marketplace/my-agents", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.agents || []),

  // ── 管理员审核（admin；后端 requireAdminVerifyDb 二次把关） ────────────────

  /** 待审版本列表（GET /api/admin/marketplace/pending）。 */
  adminMarketplacePending: (a: AuthSession) =>
    jsonOrThrow<{ pending: MarketplacePending[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/admin/marketplace/pending", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.pending || []),

  /** 审核(批准/拒绝)一个版本（POST /api/admin/marketplace/:id/review）。 */
  adminMarketplaceReview: (
    a: AuthSession,
    versionId: string,
    decision: "approve" | "reject",
    note?: string,
  ) =>
    jsonOrThrow<{ ok: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/admin/marketplace/${encodeURIComponent(versionId)}/review`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ decision, note }),
        }),
      ),
    ),

  /** 下架(kill-switch)一个条目（POST /api/admin/marketplace/:slug/revoke）。 */
  adminMarketplaceRevoke: (a: AuthSession, slug: string, reason?: string) =>
    jsonOrThrow<{ ok: boolean; affectedInstalls: number; affectedUserIds: number[] }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/admin/marketplace/${encodeURIComponent(slug)}/revoke`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ reason }),
        }),
      ),
    ),

  // ── 站内信（inbox，用户侧） ───────────────────────────────────────────

  /** 拉站内信列表 + 未读数（GET /api/me/messages，Bearer）。unreadOnly 仅返未读。 */
  listInboxMessages: (
    a: AuthSession,
    opts?: { unreadOnly?: boolean; limit?: number; offset?: number },
  ): Promise<{ messages: InboxMessage[]; unread_count: number }> => {
    const qs = new URLSearchParams();
    if (opts?.unreadOnly) qs.set("unread_only", "1");
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return jsonOrThrow<{ messages: InboxMessage[]; unread_count: number }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/messages${suffix}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    );
  },

  /** 仅未读数（GET /api/me/messages/unread_count，Bearer）。铃铛红点轮询用，轻量。 */
  getInboxUnreadCount: (a: AuthSession): Promise<number> =>
    jsonOrThrow<{ unread_count: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/messages/unread_count", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.unread_count),

  /** 标记单条已读（POST /api/me/messages/:id/read，Bearer，幂等）。 */
  markInboxRead: (a: AuthSession, id: string): Promise<{ ok: boolean; already: boolean }> =>
    jsonOrThrow<{ ok: boolean; already: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/messages/${encodeURIComponent(id)}/read`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 全部标记已读（POST /api/me/messages/read_all，Bearer）。返插入行数。 */
  markAllInboxRead: (a: AuthSession): Promise<{ ok: boolean; inserted: number }> =>
    jsonOrThrow<{ ok: boolean; inserted: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/messages/read_all", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── GitHub 仓库绑定 ──────────────────────────────────────────────────

  /**
   * 启动 GitHub 账号关联 OAuth（POST /api/auth/github/start，Bearer）。
   * 返回 authorizeUrl + state（同时 Set-Cookie state 做双因素校验），调用方
   * `location.href = authorizeUrl` 跳转 GitHub 授权页；授权后后端 302 回
   * `/?github_linked=1` 或 `/?github_error=<code>`。未配 OAuth 时后端 503。
   */
  startGithubOAuth: (a: AuthSession): Promise<{ authorizeUrl: string; state: string }> =>
    jsonOrThrow<{ authorizeUrl: string; state: string }>(
      callWithRefresh(a, (t) =>
        fetch("/api/auth/github/start", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),

  /** 读 GitHub 账号关联状态（GET /api/me/github，Bearer）。 */
  getGithubLink: (a: AuthSession): Promise<GithubLink> =>
    jsonOrThrow<GithubLink>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ),

  /** 解绑 GitHub 账号（DELETE /api/me/github，Bearer）。级联清所有会话选择。 */
  unlinkGithub: (a: AuthSession): Promise<{ revoked: boolean; sessionsCleared: number }> =>
    jsonOrThrow<{ revoked: boolean; sessionsCleared: number }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github", {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** 列我的 GitHub 仓库（GET /api/me/github/repos，Bearer）。默认按 pushed 倒序、owner 类型。 */
  listGithubRepos: (a: AuthSession): Promise<GithubRepo[]> =>
    jsonOrThrow<{ items: GithubRepo[] }>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/github/repos?per_page=100&sort=pushed&type=owner", {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.items ?? []),

  /** 列某仓库分支（GET /api/me/github/repos/:owner/:repo/branches，Bearer）。 */
  listGithubBranches: (a: AuthSession, owner: string, repo: string): Promise<GithubBranch[]> =>
    jsonOrThrow<{ items: GithubBranch[] }>(
      callWithRefresh(a, (t) =>
        fetch(
          `/api/me/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
          { credentials: "include", headers: bearerHeaders(t) },
        ),
      ),
    ).then((b) => b.items ?? []),

  /** 读某会话的仓库选择（GET /api/me/sessions/:sid/github-selection，Bearer）。 */
  getRepoSelection: (a: AuthSession, sid: string): Promise<RepoSelection> =>
    jsonOrThrow<RepoSelection>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /**
   * 设置某会话的仓库选择（PUT /api/me/sessions/:sid/github-selection，Bearer）。
   * 后端校验写权限/分支存在，返回权威 selection_version + status:'pending'。
   * 调用方拿到版本后经 WS 发 inbound.control.session_repo_bind 触发容器克隆。
   */
  putRepoSelection: (
    a: AuthSession,
    sid: string,
    body: { owner: string; repo: string; branch: string },
  ): Promise<RepoSelection> =>
    jsonOrThrow<RepoSelection>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(body),
        }),
      ),
    ),

  /** 清某会话的仓库选择（DELETE /api/me/sessions/:sid/github-selection，Bearer）。不返新版本号。 */
  deleteRepoSelection: (a: AuthSession, sid: string): Promise<{ cleared: boolean }> =>
    jsonOrThrow<{ cleared: boolean }>(
      callWithRefresh(a, (t) =>
        fetch(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── 对话传输（P4 已接入：WS user-chat-bridge） ────────────────────────
  //
  // v5 对话传输走 WebSocket（/ws/user-chat-bridge，bearer 子协议
  // `new WebSocket(url, ['bearer', accessJWT])`，inbound.message 帧），不再是
  // v4-trial 的 SSE。实现不在 api.ts（REST 专属），而在渲染树之外的单例 service
  // `lib/chat/socket.ts`（ChatSocket：safeWsSend 2MB 背压 + per-sessionKey frameSeq
  // 去重 + 三层断点续传 + 离线队列三段式 drain），由 React 绑定 `hooks/useChatSocket.ts`
  // 消费。会话历史的 REST 全量 sync（断点续传最终权威源）走上面的 getSession。
};
