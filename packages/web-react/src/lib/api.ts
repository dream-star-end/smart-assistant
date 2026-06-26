import type {
  AgentOpenResult,
  AgentStatus,
  AuthSession,
  LoginResult,
  Preferences,
  PublicConfig,
  PublicModel,
  RefreshResult,
  RegisterResult,
  StreamHandlers,
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

async function jsonOrThrow<T>(p: Promise<Response> | Response): Promise<T> {
  const res = await p;
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const b = await res.json();
      msg = (b?.error?.message as string) || (b?.message as string) || msg;
    } catch {
      /* ignore */
    }
    throw new Error(withReqId(msg, res));
  }
  return (await res.json()) as T;
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
    if (!res.ok) {
      let msg = "登录失败";
      try {
        const b = await res.json();
        msg = (b?.error?.message as string) || msg;
      } catch {
        /* ignore */
      }
      throw new Error(withReqId(msg, res));
    }
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

  // ── 账户 ───────────────────────────────────────────────────────────

  /** 当前用户（GET /api/me，Bearer）。credits 为字符串大数，adaptUser 原样保留。 */
  me: (a: AuthSession) =>
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

  /** 用量统计（GET /api/me/usage，Bearer）。形态宽松透传（P3.5 细化）；失败返回 null。 */
  getUsage: (a: AuthSession): Promise<Record<string, unknown> | null> =>
    jsonOrThrow<Record<string, unknown>>(
      callWithRefresh(a, (t) =>
        fetch("/api/me/usage", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).catch(() => null),

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
  agentStatus: (a: AuthSession): Promise<AgentStatus> =>
    jsonOrThrow<{
      runtime_ready: boolean;
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
        status: string;
        docker_name: string | null;
        last_error: string | null;
        volume_gc_at: string | null;
      } | null;
    }>(
      callWithRefresh(a, (t) =>
        fetch("/api/agent/status", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({
      runtimeReady: b.runtime_ready,
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
            status: b.container.status,
            dockerName: b.container.docker_name,
            lastError: b.container.last_error,
            volumeGcAt: b.container.volume_gc_at,
          }
        : null,
    })),

  /** 开通 Agent 订阅（POST /api/agent/open，202 provisioning，Bearer）。 */
  agentOpen: (a: AuthSession): Promise<AgentOpenResult> =>
    jsonOrThrow<{
      subscription_id: string;
      container_id: string;
      status: string;
      start_at: string;
      end_at: string;
      balance_after: string;
      docker_name: string;
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
      dockerName: b.docker_name,
    })),

  // ── 对话传输（P4 占位：WS user-chat-bridge 尚未接入） ──────────────────

  /**
   * 对话发送 / 流式解析。
   *
   * v5 对话传输走 WebSocket（/ws/user-chat-bridge，bearer 子协议：
   * `new WebSocket(url, ['bearer', accessJWT])`，inbound.message 帧），不再是 v4-trial 的
   * SSE。该 hook 在 **P4** 接入；本期刻意 **不实现**，调用即抛错，绝不假装能用。
   */
  chat: {
    /** @throws 永远抛 —— P4 未接入 WS 对话传输前不可调用。 */
    send(
      _a: AuthSession,
      _sessionId: string,
      _content: string,
      _h: StreamHandlers,
      _signal?: AbortSignal,
      _agentId?: string,
    ): Promise<never> {
      // TODO(P4): 实现 useChatSocket —— bearer 子协议鉴权 + safeWsSend 背压 +
      // per-sessionKey 连接复用，消费 inbound.message / outbound 帧。
      return Promise.reject(
        new Error("对话传输尚未接入（P4：WebSocket user-chat-bridge）。当前为 v5 前端骨架。"),
      );
    },
  },
};
