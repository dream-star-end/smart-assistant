/**
 * T-16 — /api/auth/* + /api/me 业务 handler 函数。
 *
 * 每个 handler 都是 async (req, res, ctx) → void,
 * ctx 由 router 在派发前装配(包含 requestId / clientIp / userAgent / config)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HttpError,
  readJsonBody,
  sendJson,
  clientIpOf,
  userAgentOf,
} from "./util.js";
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
} from "./cookies.js";
import { register, RegisterError } from "../auth/register.js";
import { verifyEmail, requestPasswordReset, confirmPasswordReset, resendVerification, VerifyError } from "../auth/verify.js";
import { login, refresh, logout, LoginError, RefreshError } from "../auth/login.js";
import { requireAuth } from "./auth.js";
import { query } from "../db/queries.js";
import { checkRateLimit, recordRateLimitEvent, type RateLimitConfig, type RateLimitRedis } from "../middleware/rateLimit.js";
import type { Mailer } from "../auth/mail.js";
import type { PricingCache } from "../billing/pricing.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { Logger } from "../logging/logger.js";
import type { HupijiaoClient, HupijiaoConfig } from "../payment/hupijiao/client.js";
import type { AgentHttpDeps } from "./agent.js";

export interface CommercialHttpDeps {
  jwtSecret: string | Uint8Array;
  mailer: Mailer;
  redis: RateLimitRedis;
  turnstileSecret?: string;
  turnstileBypass?: boolean;
  /**
   * Turnstile 公钥(client-side site key)。
   * 经 `GET /api/public/config` 暴露给前端 auth 模态加载 widget 用。
   * 未配 → 前端 widget 占位为空字符串,需配合 `turnstileBypass=true` 才能完成注册/登录。
   */
  turnstileSiteKey?: string;
  /** Turnstile fetchImpl 注入(用于测试) */
  fetchImpl?: typeof fetch;
  verifyEmailUrlBase?: string;
  resetPasswordUrlBase?: string;
  /**
   * T-20: 定价缓存。未注入时 `/api/public/models` 返回 503
   * (表示模块尚未加载完毕),便于 gateway 在 start 阶段早期也能挂上路由。
   */
  pricing?: PricingCache;
  /**
   * T-23: chat 预检用 Redis。未注入时 /api/chat 返 503。
   * 测试可注入 `InMemoryPreCheckRedis` 跳过真 Redis。
   */
  preCheckRedis?: PreCheckRedis;
  /**
   * T-24: 虎皮椒 HTTP 客户端。未注入时 POST /api/payment/hupi/create 返 503。
   * 测试时注入返回固定 qrcode 的 mock,避免打外网。
   */
  hupijiao?: HupijiaoClient;
  /**
   * T-24: 虎皮椒回调校签所需配置(至少 appSecret)。
   * 分开 deps.hupijiao 是为了允许 "callback 能 verify,但 create 暂未开"。
   */
  hupijiaoConfig?: Pick<HupijiaoConfig, "appSecret" | "appId">;
  /** 限流配置覆盖(测试用) */
  rateLimits?: Partial<{
    register: RateLimitConfig;
    login: RateLimitConfig;
    requestReset: RateLimitConfig;
    resendVerify: RateLimitConfig;
    hupiCreate: RateLimitConfig;
  }>;
  /** T-12.1:开启后,login 强制要求 email_verified=true */
  requireEmailVerified?: boolean;
  /**
   * 2026-04-21 安全审计 HIGH#4 — refresh token Set-Cookie 是否带 `Secure` 标志。
   * 默认 true(生产 claudeai.chat 全 HTTPS)。本地 dev / 单测走 http://
   * 必须显式传 false,否则浏览器/fetch undici 不会回带 cookie 给 HTTP 端点。
   */
  refreshCookieSecure?: boolean;
  /**
   * T-53: Agent 运行时(docker + image + network + seccomp + proxy + rpc dir)。
   * 未注入时 `/api/agent/open` 返 503(仍允许 /status 查看过去订阅)。
   */
  agentRuntime?: AgentHttpDeps;
}

export interface RequestContext {
  requestId: string;
  clientIp: string;
  userAgent: string | null;
  /**
   * V3 Phase 2 Task 2I-1:per-request 结构化 logger。
   * 由 router 在分发前 child({ requestId, route, method }) 派生,
   * handler 内部派生更多 binding(uid / containerId / phase 等)。
   *
   * 任何 chat 路径(2D anthropicProxy / 2E userChatBridge / 2C
   * containerIdentity / preCheck / finalize)的 log 都必须经过 ctx.log
   * 而不是 console.*,以确保 requestId 贯穿。
   */
  log: Logger;
}

export const DEFAULT_RATE_LIMITS = {
  register: { scope: "register", windowSeconds: 60, max: 5 } satisfies RateLimitConfig,
  login: { scope: "login", windowSeconds: 60, max: 5 } satisfies RateLimitConfig,
  requestReset: { scope: "request_reset", windowSeconds: 60, max: 3 } satisfies RateLimitConfig,
  resendVerify: { scope: "resend_verify", windowSeconds: 60, max: 3 } satisfies RateLimitConfig,
  // 04-API §8:同用户 10 次 / 1h
  hupiCreate: { scope: "hupi_create", windowSeconds: 3600, max: 10 } satisfies RateLimitConfig,
};

/**
 * 限流帮助:超限抛 HttpError(429),并写一行 rate_limit_events。
 * 导出给 payment / chat 等路由复用。
 */
export async function enforceRateLimit(
  deps: CommercialHttpDeps,
  cfg: RateLimitConfig,
  identifier: string,
): Promise<void> {
  const decision = await checkRateLimit(deps.redis, cfg, identifier);
  if (!decision.allowed) {
    // 不 await — 记录失败不应阻塞响应
    void recordRateLimitEvent(cfg.scope, identifier, true);
    throw new HttpError(429, "RATE_LIMITED", "too many requests, slow down", {
      extraHeaders: { "Retry-After": decision.retryAfterSeconds },
    });
  }
}

// ─── POST /api/auth/register ─────────────────────────────────────────

export async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.register ?? DEFAULT_RATE_LIMITS.register;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = await readJsonBody(req);
  try {
    const result = await register(body, {
      mailer: deps.mailer,
      turnstileSecret: deps.turnstileSecret,
      turnstileBypass: deps.turnstileBypass,
      fetchImpl: deps.fetchImpl,
      remoteIp: ctx.clientIp,
      verifyEmailUrlBase: deps.verifyEmailUrlBase,
    });
    sendJson(res, 201, {
      user_id: result.user_id,
      verify_email_sent: result.verify_email_sent,
    });
  } catch (err) {
    if (err instanceof RegisterError) {
      const map: Record<string, { status: number }> = {
        VALIDATION: { status: 400 },
        TURNSTILE_FAILED: { status: 400 },
        CONFLICT: { status: 409 },
      };
      const m = map[err.code];
      throw new HttpError(m.status, err.code, err.message, { issues: err.issues });
    }
    throw err;
  }
}

// ─── POST /api/auth/login ───────────────────────────────────────────

export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.login ?? DEFAULT_RATE_LIMITS.login;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = await readJsonBody(req);
  try {
    const result = await login(body, {
      jwtSecret: deps.jwtSecret,
      turnstileSecret: deps.turnstileSecret,
      turnstileBypass: deps.turnstileBypass,
      fetchImpl: deps.fetchImpl,
      remoteIp: ctx.clientIp,
      userAgent: ctx.userAgent ?? undefined,
      requireEmailVerified: deps.requireEmailVerified,
    });
    // HIGH#4:refresh token 走 HttpOnly cookie 下发,不再放 body。
    // Max-Age 用 (refresh_exp - now) 而不是固定 30d,确保前端能精确算到截止时间;
    // 即使 result.refresh_exp 计算有偏差,Math.max(0,…) 兜底防负数 cookie。
    const ttl = Math.max(0, result.refresh_exp - Math.floor(Date.now() / 1000));
    setRefreshCookie(res, result.refresh_token, ttl, { secure: deps.refreshCookieSecure });
    sendJson(res, 200, {
      user: result.user,
      access_token: result.access_token,
      access_exp: result.access_exp,
      // refresh_exp 仍然回传,前端可凭它显示"会话剩余时间";
      // refresh_token 本身不出现在 body —— XSS 拿不到。
      refresh_exp: result.refresh_exp,
    });
  } catch (err) {
    if (err instanceof LoginError) {
      const map: Record<string, { status: number }> = {
        VALIDATION: { status: 400 },
        TURNSTILE_FAILED: { status: 400 },
        INVALID_CREDENTIALS: { status: 401 },
        EMAIL_NOT_VERIFIED: { status: 403 },
      };
      const m = map[err.code];
      throw new HttpError(m.status, err.code, err.message, { issues: err.issues });
    }
    throw err;
  }
}

// ─── POST /api/auth/resend-verification ─────────────────────────────

export async function handleResendVerification(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.resendVerify ?? DEFAULT_RATE_LIMITS.resendVerify;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = (await readJsonBody(req)) as { email?: unknown } | undefined;
  const email = body && typeof (body as Record<string, unknown>).email === "string"
    ? (body as { email: string }).email
    : "";
  // 防枚举:即使 email 缺失也走 resendVerification(它会 accept=true)
  const r = await resendVerification(email, {
    mailer: deps.mailer,
    verifyEmailUrlBase: deps.verifyEmailUrlBase,
  });
  sendJson(res, 200, { accepted: r.accepted });
}

// ─── GET /api/auth/check-verification?email=xxx ─────────────────────
// 跨设备邮箱验证状态查询。前端注册成功后轮询此端点 —— 当用户在另一台
// 设备(如手机)点开验证邮件后,原桌面端注册页能自动检测并跳转到登录。
//
// 反枚举:无论 email 是否存在、是否拼写有效,一律 200 + verified=false。
// 真正命中且已验证才返 verified=true。
//
// 调用频率:前端 4s 一次 / 最多 10 分钟,所以默认限流给到 30/分钟,
// 既能支撑单用户正常轮询,又能挡住按 email 撞库枚举的滥用。

export async function handleCheckVerification(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg: RateLimitConfig = { scope: "check_verification", windowSeconds: 60, max: 30 };
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const emailRaw = url.searchParams.get("email") ?? "";
  const email = emailRaw.trim().toLowerCase();

  // 反枚举:无效格式直接返 false,而不是 400
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    sendJson(res, 200, { verified: false });
    return;
  }

  const result = await query<{ email_verified: boolean }>(
    `SELECT email_verified FROM users WHERE email = $1`,
    [email],
  );
  const verified = result.rows.length > 0 && result.rows[0].email_verified === true;
  sendJson(res, 200, { verified });
}

// ─── POST /api/auth/refresh ─────────────────────────────────────────

export async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // HIGH#4:优先读 HttpOnly cookie;迁移期(2 周内)兼容 body.refresh_token,
  // 旧前端 localStorage 里存的 token 还能用一次,然后浏览器在下次 login 后
  // 把 cookie 接管为唯一凭据。
  const fromCookie = readRefreshCookie(req);
  let rawRefresh: string | null = fromCookie;
  if (!rawRefresh) {
    const body = (await readJsonBody(req)) as { refresh_token?: unknown } | undefined;
    if (body && typeof body === "object" && typeof (body as Record<string, unknown>).refresh_token === "string") {
      rawRefresh = (body as { refresh_token: string }).refresh_token;
    }
  }
  if (!rawRefresh) {
    throw new HttpError(400, "VALIDATION", "refresh_token is required");
  }
  try {
    const r = await refresh(rawRefresh, { jwtSecret: deps.jwtSecret });
    // 迁移期把通过 body 提交的 refresh 自动"升级"到 cookie:旧前端发完
    // 这一次 body 后,后续 cookie 就由浏览器自动带,逐步把 localStorage
    // 里的 token 淘汰。已在 cookie 里的不重写(Max-Age 仍按原 cookie 走)。
    if (!fromCookie) {
      // refresh 不轮换 token(MVP),所以这里 cookie 里写的就是同一个 raw。
      // TTL 按 REFRESH_TOKEN_TTL_SECONDS 给 30 天上限,真正过期由服务器
      // refresh_tokens.expires_at 控制 — cookie TTL 长一点也无害。
      setRefreshCookie(res, rawRefresh, 30 * 24 * 60 * 60, { secure: deps.refreshCookieSecure });
    }
    sendJson(res, 200, { access_token: r.access_token, access_exp: r.access_exp });
  } catch (err) {
    if (err instanceof RefreshError) {
      const status = err.code === "VALIDATION" ? 400 : 401;
      throw new HttpError(status, err.code, err.message);
    }
    throw err;
  }
}

// ─── POST /api/auth/logout ──────────────────────────────────────────

export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // HIGH#4:cookie 优先;无论成败都清 cookie(本地清理永不依赖 server 状态)。
  // 兼容 body.refresh_token 让旧前端能完成最后一次 logout。
  const fromCookie = readRefreshCookie(req);
  let rawRefresh = fromCookie ?? "";
  if (!rawRefresh) {
    const body = (await readJsonBody(req)) as { refresh_token?: unknown } | undefined;
    if (body && typeof (body as Record<string, unknown>).refresh_token === "string") {
      rawRefresh = (body as { refresh_token: string }).refresh_token;
    }
  }
  const r = await logout(rawRefresh);
  // 即使 server 没找到匹配的 row,也清浏览器 cookie:不能让"server 觉得 token
  // 已 revoked,但 cookie 还在浏览器"这种状态延续到下一次 refresh 又被认证。
  clearRefreshCookie(res, { secure: deps.refreshCookieSecure });
  // logout 一律 200,即使 token 不存在(幂等)
  sendJson(res, 200, { revoked: r.revoked });
}

// ─── POST /api/auth/verify-email ────────────────────────────────────

export async function handleVerifyEmail(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as { token?: unknown } | undefined;
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).token !== "string") {
    throw new HttpError(400, "VALIDATION", "token is required");
  }
  const token = (body as { token: string }).token;
  try {
    const r = await verifyEmail(token);
    sendJson(res, 200, { user_id: r.user_id, newly_verified: r.newly_verified });
  } catch (err) {
    if (err instanceof VerifyError) {
      const status = err.code === "VALIDATION" ? 400 : 400; // INVALID_TOKEN 也算 400(用户改不了的事)
      throw new HttpError(status, err.code, err.message);
    }
    throw err;
  }
}

// ─── POST /api/auth/request-password-reset ───────────────────────────

export async function handleRequestPasswordReset(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.requestReset ?? DEFAULT_RATE_LIMITS.requestReset;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = (await readJsonBody(req)) as
    | { email?: unknown; turnstile_token?: unknown }
    | undefined;
  const email = body && typeof (body as Record<string, unknown>).email === "string"
    ? (body as { email: string }).email
    : "";
  const turnstileToken = body && typeof (body as Record<string, unknown>).turnstile_token === "string"
    ? (body as { turnstile_token: string }).turnstile_token
    : "";
  // 防枚举:即使 email 缺失也走 requestPasswordReset(它会 accept=true)。
  // 但 turnstile 是攻击者可控参数,缺/错都直接抛 TURNSTILE_FAILED —— 校验
  // 发生在 email 查库之前,不会泄露邮箱存在性。
  try {
    const r = await requestPasswordReset(
      { email, turnstile_token: turnstileToken },
      {
        mailer: deps.mailer,
        resetUrlBase: deps.resetPasswordUrlBase,
        turnstileSecret: deps.turnstileSecret,
        turnstileBypass: deps.turnstileBypass,
        remoteIp: ctx.clientIp,
        fetchImpl: deps.fetchImpl,
      },
    );
    sendJson(res, 200, { accepted: r.accepted });
  } catch (err) {
    if (err instanceof VerifyError) {
      throw new HttpError(400, err.code, err.message);
    }
    throw err;
  }
}

// ─── POST /api/auth/confirm-password-reset ──────────────────────────

export async function handleConfirmPasswordReset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as
    | { token?: unknown; new_password?: unknown }
    | undefined;
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).token !== "string" ||
    typeof (body as Record<string, unknown>).new_password !== "string"
  ) {
    throw new HttpError(400, "VALIDATION", "token and new_password are required");
  }
  const { token, new_password } = body as { token: string; new_password: string };
  try {
    const r = await confirmPasswordReset(token, new_password);
    sendJson(res, 200, {
      user_id: r.user_id,
      revoked_refresh_tokens: r.revoked_refresh_tokens,
    });
  } catch (err) {
    if (err instanceof VerifyError) {
      throw new HttpError(400, err.code, err.message);
    }
    throw err;
  }
}

// ─── GET /api/me ────────────────────────────────────────────────────

export async function handleMe(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const r = await query<{
    id: string;
    email: string;
    email_verified: boolean;
    role: "user" | "admin";
    display_name: string | null;
    avatar_url: string | null;
    credits: string;
    status: string;
  }>(
    `SELECT id::text AS id, email, email_verified, role, display_name, avatar_url,
            credits::text AS credits, status
       FROM users WHERE id = $1`,
    [user.id],
  );
  if (r.rows.length === 0 || r.rows[0].status !== "active") {
    // 用户 token 还有效但账号被删/封 → 401
    throw new HttpError(401, "UNAUTHORIZED", "user is not active");
  }
  const u = r.rows[0];
  sendJson(res, 200, {
    user: {
      id: u.id,
      email: u.email,
      email_verified: u.email_verified,
      role: u.role,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      credits: u.credits,
    },
  });
}

// ─── GET /api/public/config ─────────────────────────────────────────
// 公开路径(Phase 4A:前端 auth 模态启动时拉取)。仅暴露公开值:
//   - turnstile_site_key:Cloudflare 站点公钥,前端 widget 注册时必需
//   - require_email_verified:布尔,影响登录前是否拦截 + 注册成功后是否提示去查邮箱
// 未来扩展(brand_name / contact / commercial_enabled tier 等)在此追加,但绝不放
// secrets/server-side flags(避免给攻击者侦察 surface)。
// 不限流、不验证、不读 DB,纯静态(进程启动后由 deps 决定)→ 极快,可被前端缓存。

export async function handleGetPublicConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  sendJson(res, 200, {
    turnstile_site_key: deps.turnstileSiteKey ?? "",
    // turnstile_bypass=true → 前端可直接发"占位 token",dev/CI 用;生产必须 false
    turnstile_bypass: deps.turnstileBypass === true,
    require_email_verified: deps.requireEmailVerified === true,
  });
}

// ─── GET /api/public/models ─────────────────────────────────────────
// 公开路径,不限流、不需要登录;返回启用模型的公开视图(含 per-ktok 积分估价)。

export async function handleListPublicModels(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.pricing) {
    throw new HttpError(503, "PRICING_NOT_READY", "pricing cache not initialized");
  }
  sendJson(res, 200, { models: deps.pricing.listPublic() });
}

// ─── GET / PATCH /api/me/preferences (V3 Phase 2 Task 2G) ──────────────
//
// 鉴权:Bearer access JWT(同 /api/me)。
// GET:不存在记录 → 默认空对象 + 当前时间戳;不写 DB(避免 read-write 副作用)。
// PATCH:body 必须是 object(strict allowlist 字段);返回新快照。

export async function handleGetMyPreferences(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const { getPreferences } = await import("../user/preferences.js");
  const snap = await getPreferences(user.id);
  sendJson(res, 200, snap);
}

export async function handlePatchMyPreferences(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_BODY", "body must be a JSON object");
  }
  const { patchPreferences, PreferencesError } = await import("../user/preferences.js");
  try {
    const snap = await patchPreferences(user.id, body);
    sendJson(res, 200, snap);
  } catch (err) {
    if (err instanceof PreferencesError) {
      if (err.code === "VALIDATION") {
        throw new HttpError(400, "INVALID_PREFERENCES", err.message);
      }
      throw new HttpError(500, "PREFERENCES_INTERNAL", "preferences update failed");
    }
    throw err;
  }
}

// helper for tests / 其他 module
export { clientIpOf, userAgentOf };
