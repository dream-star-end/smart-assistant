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
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";

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
    /**
     * 2026-04-23:邮箱验证从 link 改 6 位数字 code 后新增。
     * code 空间 10^6,必须限制尝试频率防暴破;30 min TTL + 10/min/IP 足够挡住
     * 自动化枚举,又不影响用户手动输错重试。
     */
    verifyEmail: RateLimitConfig;
    hupiCreate: RateLimitConfig;
    // 2026-04-21 安全审计 HIGH (refresh/logout 限流)补齐的条目
    refresh: RateLimitConfig;
    logout: RateLimitConfig;
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
  /**
   * 2026-04-21 安全审计 HIGH#6 — v3 supervisor 依赖(docker + pool + image)。
   * 注入后 admin 对 v3 行(docker_name=NULL)的 restart/stop/remove 走 v3 路径
   * (`stopAndRemoveV3Container`,行标 vanished)。未注入时对 v3 行返 503。
   * 与 `agentRuntime` 是平行的两条路线,两边各管各的镜像 / docker socket。
   */
  v3Supervisor?: V3SupervisorDeps;
  /**
   * v3 file proxy —— HOST 侧签 per-container nonce 的 rootSecret(32 byte hex)。
   * 由 `bridgeSecret.loadOrCreateBridgeSecret` 从 `/var/lib/openclaude/.v3-bridge-secret`
   * 加载。supervisor 在启动容器时用它算 HMAC(rootSecret, containerId) 作为
   * `OC_BRIDGE_NONCE` env 注入;containerFileProxy 在转发时用同一方式再算一遍写进
   * 请求头。未注入 → file proxy 整体降级(router 按 BLOCKED 处理)。
   */
  bridgeSecret?: string;
  /**
   * v3 file proxy feature flag —— OFF = router 走 BLOCKED 403(与上线前一致);
   * ON = PROXY 路径命中 /api/file GET + /api/media/* GET 时走 containerFileProxy。
   * 任何一阶段发现问题立即 OFF 回退,见 v3-file-return-spec-mvp.md §5。
   */
  fileProxyEnabled?: boolean;
}

export interface RequestContext {
  requestId: string;
  /**
   * "真实客户端 IP",给 rate-limit key / access log / metrics 用。
   * Caddy 反代时 = XFF 首段(CF edge IP 或 CF-Connecting-IP,取决于 clientIpOf 判断)。
   * 会随 CF 边缘节点漂移,**不适合**作为 auth bound_ip 的 fingerprint 基线。
   */
  clientIp: string;
  /**
   * 2026-04-22 HIGH#4 回归修:auth 专用的"稳定出口 IP"。
   *
   * 用途(R5 audit 后精确范围):
   *   - `handleLogin` → `LoginDeps.bindIp`,作为 `refresh_tokens.ip` 写入
   *   - `handleRefresh` → `RefreshExtraDeps.remoteIp`,用于 race grace sameIp
   *     比对 + 新 row 的 `refresh_tokens.ip`
   *   - 所有写 / 比对 `refresh_tokens.ip`(bound_ip fingerprint)的场景
   *
   * **不用于** Turnstile remoteip(register/login/requestPasswordReset 里
   * 的 `remoteIp` 参数只给 Turnstile,继续使用 `ctx.clientIp`,CF bot 评分需要
   * 真实访客 IP)。详见 `LoginDeps.remoteIp` / `bindIp` 的 JSDoc。
   *
   * 语义:**不经任何反代 header 解析**,直接 socket.remoteAddress:
   *   - Caddy 反代时永远 = 127.0.0.1(loopback)→ race grace sameIp 恒真,合法多 tab
   *     race 正常放行
   *   - 攻击者绕过 Caddy 直连 gateway → 另一个非 loopback IP → 与旧 row bound_ip=127
   *     必然 mismatch → 走 theft 路径 mass-revoke family
   *
   * 根本起因:R1 I3 把 `clientIp` 改成 CF edge IP(每次不同)后,HIGH#4 "Caddy 背后 IP
   * 恒定" 的假设失效,grace race 里的 sameIp 比对持续 false → 合法用户被误判 theft →
   * 整族 revoke → 下次 refresh cookie 已清 → 400 "refresh_token is required" → 登录页。
   */
  authBoundIp: string;
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
  // 2026-04-23:邮箱验证码提交限流,防 10^6 key space 暴破。
  // 10/min/IP 对正常用户宽松(手动输错重试 3-5 次),对自动化脚本
  // 30min TTL 内最多 300 次尝试,相对 10^6 空间可忽略。
  verifyEmail: { scope: "verify_email", windowSeconds: 60, max: 10 } satisfies RateLimitConfig,
  // 04-API §8:同用户 10 次 / 1h
  hupiCreate: { scope: "hupi_create", windowSeconds: 3600, max: 10 } satisfies RateLimitConfig,
  // 2026-04-21 安全审计 HIGH#1:refresh/logout 从不限流,攻击者拿到泄漏的
  // refresh token 可无限撞 grace window 试图刷出新 access。按 IP 每分钟 30
  // 次足够覆盖正常多 tab race(典型 <10),又能堵枚举。
  refresh: { scope: "refresh", windowSeconds: 60, max: 30 } satisfies RateLimitConfig,
  logout: { scope: "logout", windowSeconds: 60, max: 30 } satisfies RateLimitConfig,
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
    // register 里 remoteIp 只给 Turnstile(CF bot scoring 需要真实访客 IP),不写
    // refresh_tokens。用 ctx.clientIp(CF-Connecting-IP)。
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
    // login 里 remoteIp 被两处用到:
    //   1. Turnstile verify — 需要真实访客 IP(CF bot scoring)
    //   2. 写进 refresh_tokens.ip(bound_ip)— 需要稳定出口(Caddy loopback)
    // 两个语义拆开:remoteIp 走 clientIp 保持 Turnstile 语义,bindIp 走 authBoundIp
    // 让 refresh_tokens.ip 恒为 loopback,下一次 refresh sameIp 恒真。
    const result = await login(body, {
      jwtSecret: deps.jwtSecret,
      turnstileSecret: deps.turnstileSecret,
      turnstileBypass: deps.turnstileBypass,
      fetchImpl: deps.fetchImpl,
      remoteIp: ctx.clientIp,
      bindIp: ctx.authBoundIp,
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
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 2026-04-21 安全审计 HIGH#1:refresh 端点此前无限流,攻击者可暴力撞 grace
  // window 刷出新 access token。按 IP 每分钟 30 次兜底,多 tab 正常 race 够用。
  const cfg = deps.rateLimits?.refresh ?? DEFAULT_RATE_LIMITS.refresh;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

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
    // LOW(2026-04-21):refresh 现在每次轮换,返回新 raw token + exp。
    // 不论来源是 cookie 还是 body,都把新 raw 写回 HttpOnly cookie 并丢弃
    // 客户端送来的旧 token(已被 refresh() 内部 revoked)。
    //
    // 2026-04-22 HIGH#4 回归修:改用 ctx.authBoundIp(= socket.remoteAddress,
    // 不经反代 header 解析)。
    //
    // 原注释(保留备忘)设想 `ctx.clientIp` 就是 socket.remoteAddress,但 R1 I3
    // 修了 rate-limit 全站共享桶问题后,`ctx.clientIp` 改走 CF-Connecting-IP /
    // XFF peer,每次 CF 边缘节点漂移都会让 bound_ip 值漂移 → grace race 里的
    // sameIp 比对持续 false → 合法多 tab 用户被误判 theft → 整族 revoke → 下次
    // refresh 400 "refresh_token is required" → 登录页。
    //
    // 分离之后:
    //   - ctx.clientIp(CF edge / CF-Connecting-IP)继续给 rate-limit key / log 用
    //   - ctx.authBoundIp(稳定 loopback)专供 auth bound_ip,维持 HIGH#4 原意
    // 攻击者绕过 Caddy 直连 gateway 会有独立 socket.remoteAddress(非 loopback),
    // 依旧 mismatch → theft 路径仍然能识别盗用。
    const r = await refresh(rawRefresh, {
      jwtSecret: deps.jwtSecret,
      remoteIp: ctx.authBoundIp,
      userAgent: ctx.userAgent ?? undefined,
    });
    // cookie Max-Age = 新 token 真实剩余 TTL;到期时间由 server 主导
    const cookieTtl = Math.max(1, r.refresh_exp - Math.floor(Date.now() / 1000));
    setRefreshCookie(res, r.refresh_token, cookieTtl, { secure: deps.refreshCookieSecure });
    sendJson(res, 200, { access_token: r.access_token, access_exp: r.access_exp });
  } catch (err) {
    if (err instanceof RefreshError) {
      const status = err.code === "VALIDATION" ? 400 : 401;
      // LOW(2026-04-21):盗用与 普通过期/不存在 共享 INVALID_REFRESH 错误码,
      // 不给攻击者枚举区别。同时清浏览器 cookie,避免下一次还带着失效 token。
      // 但 REFRESH_RACE(grace 内多 tab race)**不**清 cookie:此时浏览器
      // cookie 实际已被 sibling tab 的响应种成新值,清掉反而会把合法用户
      // 踢登录。前端只需 retry 一次即可继续。
      if (err.code === "INVALID_REFRESH") {
        clearRefreshCookie(res, { secure: deps.refreshCookieSecure });
      }
      throw new HttpError(status, err.code, err.message);
    }
    throw err;
  }
}

// ─── POST /api/auth/logout ──────────────────────────────────────────

export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 2026-04-21 安全审计 HIGH#1:logout 端点此前无限流,虽然本身破坏性有限
  // (幂等 revoke),但同 IP 每分钟 30 次兜底防撞库枚举 / DoS 打 DB。
  const cfg = deps.rateLimits?.logout ?? DEFAULT_RATE_LIMITS.logout;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

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
//
// 2026-04-23:从 {token} 改为 {email, code}。
//   - body 校验在这里做最小 shape 校验;email 格式/code 6 位数字的精确
//     校验延迟到 verifyEmail() 用 zod schema 做,错误码统一 VALIDATION
//   - 加 IP 速率限制(10/min):code 空间 10^6,必须限制尝试频率

export async function handleVerifyEmail(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.verifyEmail ?? DEFAULT_RATE_LIMITS.verifyEmail;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  const body = (await readJsonBody(req)) as { email?: unknown; code?: unknown } | undefined;
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).email !== "string" ||
    typeof (body as Record<string, unknown>).code !== "string"
  ) {
    throw new HttpError(400, "VALIDATION", "email and code are required");
  }
  const { email, code } = body as { email: string; code: string };
  try {
    const r = await verifyEmail(email, code);
    sendJson(res, 200, { user_id: r.user_id, newly_verified: r.newly_verified });
  } catch (err) {
    if (err instanceof VerifyError) {
      // INVALID_TOKEN 也是 400(用户改不了的格式错,需前端重新输)
      throw new HttpError(400, err.code, err.message);
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
        // requestPasswordReset 里 remoteIp 只给 Turnstile。用 ctx.clientIp。
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

// ─── GET /api/me/usage (「使用消耗统计」前端弹窗) ──────────────────────
//
// 鉴权:Bearer access JWT(同 /api/me)。返回当前用户在 usage_records / credit_ledger
// 上的聚合视图,首版字段见 response shape 注释。
//
// 设计约束(Codex R1→R3 review 落地):
//   - billed(名义账单)vs debited(实际扣款)分离:clamp/billing_failed 场景两者会不等
//   - 精确 savings 用 price_snapshot + calculator 同口径 BigInt 重算,行数 >10000 时
//     标记 `savings_unavailable=true`,不返回粗估假值
//   - sessions 用 offset 分页 + LIMIT+1 探测 has_more;稳定排序 ORDER BY MAX(ts), session_id
//   - ledger 复用 admin/ledger.ts 的 id 游标 keyset(`before`),不按时间
//   - legacy_unattributed = session_id IS NULL 的聚合,让用户知道"为什么 summary > sessions 总和"
//   - 所有大数字段以字符串返回(user balance / tokens / cost 都有越过 2^53 的风险)

const USAGE_ID_RE = /^[1-9][0-9]{0,19}$/;
const SAVINGS_ROW_CAP = 10_000;

function parseUsageLimit(raw: string | null, def: number, max: number): number {
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new HttpError(400, "INVALID_USAGE_QUERY", `limit must be integer in [1,${max}]`);
  }
  return n;
}

function parseUsageOffset(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    throw new HttpError(400, "INVALID_USAGE_QUERY", "offset must be non-negative integer");
  }
  return n;
}

export async function handleGetMyUsage(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sessionsLimit = parseUsageLimit(url.searchParams.get("sessions_limit"), 20, 100);
  const sessionsOffset = parseUsageOffset(url.searchParams.get("sessions_offset"));
  const ledgerLimit = parseUsageLimit(url.searchParams.get("ledger_limit"), 20, 100);
  const ledgerBeforeRaw = url.searchParams.get("ledger_before");
  if (ledgerBeforeRaw !== null && ledgerBeforeRaw !== "" && !USAGE_ID_RE.test(ledgerBeforeRaw)) {
    throw new HttpError(400, "INVALID_USAGE_QUERY", "ledger_before must be a bigint id");
  }

  const uid = user.id; // bigint-safe string from auth

  // 并发 6 条只读查询。所有语义均 WHERE user_id=$1,无 IDOR。
  const [
    summaryRow,
    legacyRow,
    debitedRow,
    sessionsRows,
    cutoffRow,
    savingsRows,
  ] = await Promise.all([
    // 1) summary:全量 success(含 session_id NULL)
    query<{
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      billed_credits: string;
      requests_total: string;
    }>(
      `SELECT COALESCE(SUM(input_tokens),0)::text        AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text       AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text   AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0)::text  AS cache_write_tokens,
              COALESCE(SUM(cost_credits),0)::text        AS billed_credits,
              COUNT(*)::bigint::text                     AS requests_total
         FROM usage_records
        WHERE user_id = $1 AND status = 'success'`,
      [uid],
    ),
    // 2) legacy:session_id IS NULL 的 success 行
    query<{
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      billed_credits: string;
    }>(
      `SELECT COUNT(*)::bigint::text                      AS requests,
              COALESCE(SUM(input_tokens),0)::text         AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text        AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text    AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0)::text   AS cache_write_tokens,
              COALESCE(SUM(cost_credits),0)::text         AS billed_credits
         FROM usage_records
        WHERE user_id = $1 AND status = 'success' AND session_id IS NULL`,
      [uid],
    ),
    // 3) debited:JOIN usage_records.ledger_id → credit_ledger,只统计真实 debit(delta<0)
    //    (Codex 建议:比按 reason 白名单更精确,避免未来其他 reason 混入)
    query<{ debited_credits: string }>(
      `SELECT COALESCE(SUM(-cl.delta), 0)::text AS debited_credits
         FROM usage_records ur
         JOIN credit_ledger cl ON cl.id = ur.ledger_id
        WHERE ur.user_id = $1 AND ur.status = 'success' AND cl.delta < 0`,
      [uid],
    ),
    // 4) sessions 分页:GROUP BY session_id,非 NULL,稳定排序,LIMIT+1 探 has_more
    query<{
      session_id: string;
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      billed_credits: string;
      last_used_at: Date;
    }>(
      `SELECT session_id,
              COUNT(*)::bigint::text                     AS requests,
              COALESCE(SUM(input_tokens),0)::text        AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text       AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text   AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0)::text  AS cache_write_tokens,
              COALESCE(SUM(cost_credits),0)::text        AS billed_credits,
              MAX(created_at)                            AS last_used_at
         FROM usage_records
        WHERE user_id = $1 AND status = 'success' AND session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY MAX(created_at) DESC, session_id DESC
        LIMIT $2 OFFSET $3`,
      [uid, sessionsLimit + 1, sessionsOffset],
    ),
    // 5) cutoff:最早一次带 session_id 的时间戳。UI 里提示"从何时开始支持会话维度"
    query<{ cutoff_started_at: Date | null }>(
      `SELECT MIN(created_at) AS cutoff_started_at
         FROM usage_records
        WHERE user_id = $1 AND session_id IS NOT NULL`,
      [uid],
    ),
    // 6) savings 精算所需原始行。LIMIT SAVINGS_ROW_CAP+1 真正截断,不做 COUNT(*) 扫全表
    query<{ cache_read_tokens: string; price_snapshot: unknown }>(
      `SELECT cache_read_tokens::text AS cache_read_tokens,
              price_snapshot
         FROM usage_records
        WHERE user_id = $1 AND status = 'success' AND cache_read_tokens > 0
        LIMIT ${SAVINGS_ROW_CAP + 1}`,
      [uid],
    ),
  ]);

  // ── savings 精算(BigInt,per-row 防御) ──────────────────────────────
  // 公式:节省 = Σ ceil( cache_read_tokens × (input_per_mtok - cache_read_per_mtok) × mul_scaled / 1e9 )
  //   单位:分。clamp ≥ 0。公式与 calculator.ts 同口径但更窄(仅 cache_read 维度)。
  //
  // 行数 > SAVINGS_ROW_CAP → savings_unavailable=true(Codex R3:不返回 ¥0 粗估,
  // 也不冒充当前 pricing 作为历史值)。
  const { multiplierToScaled, COST_SCALE } = await import("../billing/calculator.js");
  let savingsTotal = 0n;
  let savingsRowsSkipped = 0;
  let savingsUnavailable = false;
  if (savingsRows.rows.length > SAVINGS_ROW_CAP) {
    savingsUnavailable = true;
  } else {
    for (const r of savingsRows.rows) {
      try {
        const snap = r.price_snapshot as {
          input_per_mtok?: unknown;
          cache_read_per_mtok?: unknown;
          multiplier?: unknown;
        } | null;
        if (!snap || typeof snap !== "object") { savingsRowsSkipped++; continue; }
        if (typeof snap.input_per_mtok !== "string" ||
            typeof snap.cache_read_per_mtok !== "string" ||
            typeof snap.multiplier !== "string") {
          savingsRowsSkipped++;
          continue;
        }
        const inputPer = BigInt(snap.input_per_mtok);
        const cachePer = BigInt(snap.cache_read_per_mtok);
        if (inputPer <= cachePer) continue;
        const mul = multiplierToScaled(snap.multiplier);
        const tokens = BigInt(r.cache_read_tokens);
        if (tokens <= 0n) continue;
        const scaled = tokens * (inputPer - cachePer) * mul;
        if (scaled <= 0n) continue;
        const cents = (scaled + COST_SCALE - 1n) / COST_SCALE;
        savingsTotal += cents;
      } catch {
        savingsRowsSkipped++;
      }
    }
  }

  // ── cache hit rate:cache_read / (input + cache_read) ──────────────────
  //   cache_write 是"写入成本"不计入命中率分母(Codex R2 建议)
  const inTokStr = summaryRow.rows[0]?.input_tokens ?? "0";
  const crTokStr = summaryRow.rows[0]?.cache_read_tokens ?? "0";
  const inTok = BigInt(inTokStr);
  const crTok = BigInt(crTokStr);
  let hitRate: number | null = null;
  const denom = inTok + crTok;
  if (denom > 0n) {
    // 比例转 Number 是安全的(值在 [0,1])
    hitRate = Number((crTok * 10_000n) / denom) / 10_000;
  }

  // ── sessions 分页:splice 第 N+1 行 ───────────────────────────────────
  const fetched = sessionsRows.rows;
  const hasMore = fetched.length > sessionsLimit;
  const rowsPage = hasMore ? fetched.slice(0, sessionsLimit) : fetched;
  const sessions = rowsPage.map((r) => ({
    session_id: r.session_id,
    requests: r.requests,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
    billed_credits: r.billed_credits,
    last_used_at: r.last_used_at.toISOString(),
  }));

  // ── ledger 分页:复用 admin/ledger 的 id 游标 keyset ───────────────────
  //   用户自查不限 reason,也不允许按 reason 过滤(UI 首版不做 filter)
  const { listLedger } = await import("../admin/ledger.js");
  const ledgerResult = await listLedger({
    userId: uid,
    limit: ledgerLimit,
    before: ledgerBeforeRaw && ledgerBeforeRaw !== "" ? ledgerBeforeRaw : undefined,
  });
  const ledger = {
    rows: ledgerResult.rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      balance_after: r.balance_after,
      reason: r.reason,
      ref_type: r.ref_type,
      ref_id: r.ref_id,
      memo: r.memo,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
    next_before: ledgerResult.next_before,
  };

  const sum = summaryRow.rows[0] ?? {
    input_tokens: "0", output_tokens: "0",
    cache_read_tokens: "0", cache_write_tokens: "0",
    billed_credits: "0", requests_total: "0",
  };
  const leg = legacyRow.rows[0] ?? {
    requests: "0", input_tokens: "0", output_tokens: "0",
    cache_read_tokens: "0", cache_write_tokens: "0", billed_credits: "0",
  };
  const deb = debitedRow.rows[0]?.debited_credits ?? "0";
  const cutoff = cutoffRow.rows[0]?.cutoff_started_at ?? null;

  sendJson(res, 200, {
    summary: {
      input_tokens: sum.input_tokens,
      output_tokens: sum.output_tokens,
      cache_read_tokens: sum.cache_read_tokens,
      cache_write_tokens: sum.cache_write_tokens,
      requests_total: sum.requests_total,
      billed_credits: sum.billed_credits,
      debited_credits: deb,
    },
    legacy_unattributed: {
      requests: leg.requests,
      input_tokens: leg.input_tokens,
      output_tokens: leg.output_tokens,
      cache_read_tokens: leg.cache_read_tokens,
      cache_write_tokens: leg.cache_write_tokens,
      billed_credits: leg.billed_credits,
    },
    savings: {
      savings_credits: savingsUnavailable ? null : savingsTotal.toString(),
      savings_is_estimate: !savingsUnavailable && savingsRowsSkipped > 0,
      savings_unavailable: savingsUnavailable,
      savings_rows_skipped: savingsRowsSkipped,
    },
    cache: { hit_rate: hitRate },
    sessions: {
      rows: sessions,
      limit: sessionsLimit,
      offset: sessionsOffset,
      has_more: hasMore,
    },
    ledger,
    cutoff_started_at: cutoff ? cutoff.toISOString() : null,
  });
}

// ─── v3 file proxy: session cookie endpoints ────────────────────────

/**
 * POST /api/auth/session —— 用 Bearer access token 换一个 HttpOnly `oc_session` cookie。
 *
 * **为什么要**:浏览器原生 `<a href="/api/file?path=...">` / `window.open()` / `<img>`
 * 无法携带 `Authorization: Bearer`。commercial user 的 access token 存在 localStorage
 * 里,下载链接 fallback 只能靠 cookie。为了不让长期存活的 token 落进 cookie
 * XSS-readable 空间,我们:
 *   - HttpOnly + SameSite=Strict + Secure + Path=/api/(仅 api 路径带,不污染静态资源)
 *   - Max-Age = min(exp - now, 30d) —— 不比 JWT 本身活得更久
 *   - 前端主动 mint(登录 / refresh 成功 / app 启动 `_ensureSessionCookie`)
 *   - 只对有 Authorization 头的请求 mint —— 不自我续期、不从 cookie 刷 cookie
 *
 * 返回 `{ ok: true, maxAge }` 让前端知道 TTL(debug 用,不做决策)。
 */
export async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/);
  if (!m) {
    throw new HttpError(401, "UNAUTHORIZED", "bearer token required");
  }
  const token = m[1]!.trim();
  if (!token) {
    throw new HttpError(401, "UNAUTHORIZED", "bearer token required");
  }
  // 复用同步 JWT 校验(router BLOCKED 路径也用的是它)
  const { verifyCommercialJwtSync } = await import("../auth/jwtSync.js");
  const claims = verifyCommercialJwtSync(token, deps.jwtSecret);
  if (!claims) {
    throw new HttpError(401, "UNAUTHORIZED", "invalid or expired token");
  }

  // Secure 标志判定:socket.encrypted(直连 HTTPS)或 Caddy 反代 + X-Forwarded-Proto=https。
  // 本地 dev(http://localhost + COMMERCIAL_INSECURE_COOKIE=1)拿不到 Secure → 不设。
  const socket = req.socket as { encrypted?: boolean };
  const xfp = req.headers["x-forwarded-proto"];
  const isLoopback =
    /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress ?? "");
  const secure = socket.encrypted || (isLoopback && xfp === "https") ? "; Secure" : "";

  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(1, claims.exp - now), 30 * 86400);

  // 直接拼 Set-Cookie —— 与 cookies.ts 的 refresh cookie 并存(Path/Name 不同)
  const existing = res.getHeader("Set-Cookie");
  const line = `oc_session=${token}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${ttl}`;
  if (existing == null) {
    res.setHeader("Set-Cookie", line);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, line]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), line]);
  }
  sendJson(res, 200, { ok: true, maxAge: ttl });
}

/**
 * POST /api/auth/session/logout —— 清 `oc_session` cookie。
 * 必须和 `handleCreateSession` 的 attributes 完全一致(name/Path/HttpOnly/SameSite/Secure),
 * 否则浏览器会视作"另一个 cookie"忽略。
 *
 * 幂等:不检查 body、不查 DB —— 清本地 cookie 足矣。真正的 token 失效由 JWT exp 负责。
 */
export async function handleClearSession(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const socket = req.socket as { encrypted?: boolean };
  const xfp = req.headers["x-forwarded-proto"];
  const isLoopback =
    /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress ?? "");
  const secure = socket.encrypted || (isLoopback && xfp === "https") ? "; Secure" : "";

  const existing = res.getHeader("Set-Cookie");
  const line = `oc_session=; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=0`;
  if (existing == null) {
    res.setHeader("Set-Cookie", line);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, line]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), line]);
  }
  sendJson(res, 200, { ok: true });
}

// helper for tests / 其他 module
export { clientIpOf, userAgentOf };
