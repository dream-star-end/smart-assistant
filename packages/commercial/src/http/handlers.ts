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
import { register, RegisterError } from "../auth/register.js";
import { verifyEmail, requestPasswordReset, confirmPasswordReset, VerifyError } from "../auth/verify.js";
import { login, refresh, logout, LoginError, RefreshError } from "../auth/login.js";
import { requireAuth } from "./auth.js";
import { query } from "../db/queries.js";
import { checkRateLimit, recordRateLimitEvent, type RateLimitConfig, type RateLimitRedis } from "../middleware/rateLimit.js";
import type { Mailer } from "../auth/mail.js";
import type { PricingCache } from "../billing/pricing.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { ChatLLM } from "./chat.js";
import type { HupijiaoClient, HupijiaoConfig } from "../payment/hupijiao/client.js";

export interface CommercialHttpDeps {
  jwtSecret: string | Uint8Array;
  mailer: Mailer;
  redis: RateLimitRedis;
  turnstileSecret?: string;
  turnstileBypass?: boolean;
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
  /** T-23: LLM 执行器,默认 stub(固定 1000 in / 500 out);T-40 接真 Claude 时替换 */
  chatLLM?: ChatLLM;
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
    hupiCreate: RateLimitConfig;
  }>;
}

export interface RequestContext {
  requestId: string;
  clientIp: string;
  userAgent: string | null;
}

export const DEFAULT_RATE_LIMITS = {
  register: { scope: "register", windowSeconds: 60, max: 5 } satisfies RateLimitConfig,
  login: { scope: "login", windowSeconds: 60, max: 5 } satisfies RateLimitConfig,
  requestReset: { scope: "request_reset", windowSeconds: 60, max: 3 } satisfies RateLimitConfig,
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
    });
    sendJson(res, 200, {
      user: result.user,
      access_token: result.access_token,
      access_exp: result.access_exp,
      refresh_token: result.refresh_token,
      refresh_exp: result.refresh_exp,
    });
  } catch (err) {
    if (err instanceof LoginError) {
      const map: Record<string, { status: number }> = {
        VALIDATION: { status: 400 },
        TURNSTILE_FAILED: { status: 400 },
        INVALID_CREDENTIALS: { status: 401 },
      };
      const m = map[err.code];
      throw new HttpError(m.status, err.code, err.message, { issues: err.issues });
    }
    throw err;
  }
}

// ─── POST /api/auth/refresh ─────────────────────────────────────────

export async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const body = (await readJsonBody(req)) as { refresh_token?: unknown } | undefined;
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).refresh_token !== "string") {
    throw new HttpError(400, "VALIDATION", "refresh_token is required");
  }
  const rawRefresh = (body as { refresh_token: string }).refresh_token;
  try {
    const r = await refresh(rawRefresh, { jwtSecret: deps.jwtSecret });
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
): Promise<void> {
  const body = (await readJsonBody(req)) as { refresh_token?: unknown } | undefined;
  const rawRefresh = body && typeof (body as Record<string, unknown>).refresh_token === "string"
    ? (body as { refresh_token: string }).refresh_token
    : "";
  const r = await logout(rawRefresh);
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

  const body = (await readJsonBody(req)) as { email?: unknown } | undefined;
  const email = body && typeof (body as Record<string, unknown>).email === "string"
    ? (body as { email: string }).email
    : "";
  // 防枚举:即使 email 缺失也走 requestPasswordReset(它会 accept=true)
  const r = await requestPasswordReset(email, {
    mailer: deps.mailer,
    resetUrlBase: deps.resetPasswordUrlBase,
  });
  sendJson(res, 200, { accepted: r.accepted });
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

// helper for tests / 其他 module
export { clientIpOf, userAgentOf };
