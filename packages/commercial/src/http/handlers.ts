/**
 * T-16 — /api/auth/* + /api/me 业务 handler 函数。
 *
 * 每个 handler 都是 async (req, res, ctx) → void,
 * ctx 由 router 在派发前装配(包含 requestId / clientIp / userAgent / config)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  HttpError,
  readJsonBody,
  sendJson,
  clientIpOf,
  userAgentOf,
  ensureRequestId,
  setSecurityHeaders,
  REQUEST_ID_HEADER,
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
import { insertFeedback } from "../admin/feedback.js";
import {
  verifyCommercialJwtSync,
  verifyCommercialJwtSyncDetailed,
  type CommercialJwtClaims,
} from "../auth/jwtSync.js";
import { requireActiveAccountVerifyDb } from "./requireUser.js";
import {
  buildSignedUrl,
  verifySignedUrl,
  normalizeSignBatchInput,
  isContainerPathAllowed,
  DEFAULT_SIGN_TTL_MS,
} from "./mediaSign.js";
import { containerFileProxy } from "./containerFileProxy.js";
import { getBearerToken, getSessionCookieToken } from "./authHelpers.js";
import { defaultTunnelFetchHealthz } from "./tunnelHealthzProbe.js";
import { getHostById as computePoolGetHostById } from "../compute-pool/queries.js";
import { dialTunnelSocket as defaultTunnelDial } from "../compute-pool/nodeAgentClient.js";
import { checkRateLimit, recordRateLimitEvent, type RateLimitConfig, type RateLimitRedis } from "../middleware/rateLimit.js";
import { getSystemSetting } from "../admin/systemSettings.js";
import type { Mailer } from "../auth/mail.js";
import type { PricingCache } from "../billing/pricing.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { Logger } from "../logging/logger.js";
import type { HupijiaoClient, HupijiaoConfig } from "../payment/hupijiao/client.js";
import type { AgentHttpDeps } from "./agent.js";
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";
import type { RemoteHostTester } from "../remoteHosts/service.js";
import type { AccountHealthTracker } from "../account-pool/health.js";
import type { AnthropicProxyHandler } from "./proxy/shared.js";

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
    /**
     * 2026-04-28 (A6):per-email 限流,补 verifyEmail 仅按 IP 的盲点。
     * 攻击者切 IP 池绕过 verifyEmail(IP 维度),但目标邮箱固定,加这条
     * 后单一目标邮箱 30min 最多 10 次尝试,10^6 空间下成功概率 0.001%/30min。
     * key 用 sha256(email.trim().toLowerCase()).slice(0,16),避免 PII 落
     * rate_limit_events 表(明文邮箱不能进可被取证读出的限流日志)。
     */
    verifyEmailEmail: RateLimitConfig;
    hupiCreate: RateLimitConfig;
    // 2026-04-21 安全审计 HIGH (refresh/logout 限流)补齐的条目
    refresh: RateLimitConfig;
    logout: RateLimitConfig;
    // P1-2 (2026-04-25):用户反馈匿名可提交,必须按 IP 限流防 spam
    feedback: RateLimitConfig;
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
  /**
   * FEATURE_REMOTE_SSH 灰度 flag。OFF 时 `/api/remote-hosts/*` 全部返 503
   * FEATURE_DISABLED。前端也会根据 `/api/public/config.feature_remote_ssh` 决定
   * 是否渲染执行环境切换器。
   */
  remoteSshEnabled?: boolean;
  /**
   * SSH 探测回调。由 gateway 装配时提供(ControlMaster 模块)。未注入 →
   * `POST /api/remote-hosts/:id/test` 返 503 TESTER_NOT_CONFIGURED。
   */
  remoteHostTester?: RemoteHostTester;
  /**
   * Claude 账号池 health tracker。`/api/admin/accounts/:id/reset-cooldown`
   * 需要它来把 status='cooldown' 的账号一并恢复到 active(避免历史
   * `cooldown_until=NULL ∧ status='cooldown'` 永久卡死状态)。未注入 →
   * 该路由返 503 ACCOUNT_HEALTH_NOT_CONFIGURED;其他路由不受影响。
   */
  accountHealth?: AccountHealthTracker;
  /**
   * 2026-05-12:邮箱验证成功 → fire-and-forget 触发 v3 容器 pre-warm。
   * 用"验证 → 首消息"的 p50=215s 间隔覆盖 docker run 冷启(5-8s),
   * 让用户首条消息直接命中 running 容器,无等待。
   *
   * 装配:v3Deps 配齐时由 `makePrewarmContainer` 包装 `makeV3EnsureRunning(v3Deps)`
   * 注入(见 commercial/src/index.ts)。v3Deps 未配 → undefined,
   * handler 端 `deps.prewarmContainer?.()` 变 no-op。
   *
   * 约定:此函数同步 return void,**绝不抛**(任何错误内部 swallow + log)。
   * handler 调用方不需要 try/catch。详见 agent-sandbox/v3prewarm.ts JSDoc。
   */
  prewarmContainer?: (uid: bigint) => void;
  /**
   * v1.0.120 feat/codex-disable-rebind:admin 把 codex 账号从 active 改成
   * disabled 时,主动触发 fanout actor —— 把仍绑该账号的活跃容器 rebind 到
   * 新 active 账号。
   *
   * 装配:`registerCommercial` 启动期闭包 fanoutDeps 后注入。未注入 = 单测 /
   * 早期 boot,acquire / M1 自愈兜底。
   *
   * 透传给 adminPatchAccount 的 AdminAuditCtx.triggerCodexDisableFanout。
   */
  triggerCodexDisableFanout?: (accountId: bigint) => void;
  /**
   * v3 signed-URL media key —— HKDF-SHA256 派生自 bridgeSecret(见 mediaSign.ts)。
   *
   * 注入条件:`bridgeSecret` 加载成功 + `fileProxyEnabled=true`。任一缺失 →
   * 未注入,signed URL endpoints (`/api/media-sign`, `/api/media-signed`)
   * 返 503 SIGN_DISABLED。**没有 cookie fallback**:前端拿到 null 后保持占位
   * (透明 1x1 PNG / 空 src),不会偷偷退回 `<img src="/api/file?path=...">` ——
   * 那条 path 正是 iOS Safari 丢 cookie 的破图根因。
   *
   * key rotation:重启进程即重新派生(bridgeSecret 不变则 key 不变)。要强制
   * rotate 改 `mediaSign.ts` 的 HKDF_INFO,旧 URL 全部失效。
   */
  mediaSignKey?: Buffer;
  /**
   * V3 CC 外接 plan Phase 3(2026-05-18)— public-facing
   * `POST /api/anthropic/v1/messages` 的 anthropic proxy handler。
   *
   * 与 `internalProxyHandler`(私有 18791/18443,容器流量)是**平行实例**;
   * 两者只在 IdentityStrategy 上分歧:
   *   - internal:`ContainerIdentityStrategy`(容器双因子 + recordHostRequest)
   *   - external:`ApiKeyIdentityStrategy`(Bearer `oc-cc.*` + 无 recordHostRequest)
   * 其它依赖(pgPool / pricing / scheduler / refreshDeps / 计费 / 广播)完全共享。
   *
   * **装配失败语义**(Codex Phase 3 plan-review MINOR 1 采纳):
   *   - 装配成功 → router 命中精确 `POST /api/anthropic/v1/messages` 时分发
   *   - 装配失败 / 未注入 → router 同一路径返 **503 EXTERNAL_PROXY_UNAVAILABLE**
   *     而**不是** 404。部署故障不应伪装成"用户 URL 写错了"。
   *
   * router 通过 url 重写 + 合成 ctx 调用本 handler;请求体白名单仍由 handler
   * 内部维护(`/v1/messages`),命名空间映射是 router 职责。
   */
  externalApiKeyProxy?: AnthropicProxyHandler;
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
  // 2026-04-28 (A6):per-email 30min 窗口最多 10 次,补 IP 维度的盲点
  // (攻击者切 IP 池但目标邮箱固定就能撞码)。窗口拉长到 30min 与 code TTL
  // 对齐 —— 一个 code 生命周期内至多 10 次尝试,10^6 空间下成功率 ≈ 0.001%。
  verifyEmailEmail: { scope: "verify_email_email", windowSeconds: 1800, max: 10 } satisfies RateLimitConfig,
  // 04-API §8:同用户 10 次 / 1h
  hupiCreate: { scope: "hupi_create", windowSeconds: 3600, max: 10 } satisfies RateLimitConfig,
  // 2026-04-21 安全审计 HIGH#1:refresh/logout 从不限流,攻击者拿到泄漏的
  // refresh token 可无限撞 grace window 试图刷出新 access。按 IP 每分钟 30
  // 次足够覆盖正常多 tab race(典型 <10),又能堵枚举。
  refresh: { scope: "refresh", windowSeconds: 60, max: 30 } satisfies RateLimitConfig,
  logout: { scope: "logout", windowSeconds: 60, max: 30 } satisfies RateLimitConfig,
  // P1-2:5/min/IP — 反馈是低频操作,匿名也允许,这个上限挡 spam 又不影响真实用户
  feedback: { scope: "feedback", windowSeconds: 60, max: 5 } satisfies RateLimitConfig,
};

/**
 * A6 (2026-04-28):把 email 规范化后取 sha256 前缀作为 rate-limit identifier。
 *
 * 为什么不直接用 email:
 *   - rate_limit_events 表会持久化 identifier 字段,明文邮箱进入运维可读日志
 *     等同 PII 泄漏(GDPR / 国内个保法都要求最小化原则)
 *   - sha256 不可逆,事后只能用同样的 hash 做匹配,不能从日志反推用户邮箱
 *
 * 为什么 trim+lowercase:
 *   - "User@Example.com" 与 "user@example.com" 在邮件投递层是同一个收件人
 *     (RFC5321 域名部分大小写不敏感;本地部分理论敏感但绝大多数 MTA 也不敏感)。
 *     不做归一化 → 攻击者大小写翻转就开新桶,限流形同虚设。
 *
 * 为什么截 16 hex (64 bit):
 *   - 64 bit 空间足够稀疏,常规规模碰撞概率忽略;短串 redis key 友好。
 */
export function hashEmailForRateLimit(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

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
  // V3 Phase 4H+:system_settings.allow_registration=false 时直接 403。
  // 顺序上放在 rate limit 之前 —— 开关关了就别让这条路径消耗限流额度,
  // 也避免 401/400 把真正的"注册关闭"语义掩盖掉。
  const allowReg = await getSystemSetting("allow_registration");
  if (allowReg.value !== true) {
    throw new HttpError(403, "REGISTRATION_DISABLED", "已关闭新用户注册");
  }
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
    //
    // 2026-04-24 "记住我" 语义:unchecked → persistent=false → cookie 不带 Max-Age,
    // 浏览器作为 session cookie 处理,关窗口即清。remember_me 也已落到
    // refresh_tokens.remember_me 列,确保后续 rotate 继承。
    const ttl = Math.max(0, result.refresh_exp - Math.floor(Date.now() / 1000));
    setRefreshCookie(res, result.refresh_token, ttl, {
      secure: deps.refreshCookieSecure,
      persistent: result.remember,
    });
    sendJson(res, 200, {
      user: result.user,
      access_token: result.access_token,
      access_exp: result.access_exp,
      // refresh_exp 仍然回传,前端可凭它显示"会话剩余时间";
      // refresh_token 本身不出现在 body —— XSS 拿不到。
      refresh_exp: result.refresh_exp,
      // 把服务端定稿的 remember 回传;前端据此决定 access token 存 localStorage
      // (persistent)还是 sessionStorage(关窗口即清,与 cookie 同生命周期)。
      remember: result.remember,
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
    // cookie Max-Age = 新 token 真实剩余 TTL;到期时间由 server 主导。
    // 2026-04-24 "记住我":继承 refresh_tokens.remember_me(refresh() 返回),
    // rotate 后 cookie 仍然保持 session / persistent 属性不漂移。
    const cookieTtl = Math.max(1, r.refresh_exp - Math.floor(Date.now() / 1000));
    setRefreshCookie(res, r.refresh_token, cookieTtl, {
      secure: deps.refreshCookieSecure,
      persistent: r.remember,
    });
    // 2026-04-24 回传 remember 让前端 refresh 成功时把 access token 写到
    // 正确的 storage:persistent → localStorage / session → sessionStorage。
    // 不回传的话前端无从得知原登录选择,rotate 后 access 可能错放。
    sendJson(res, 200, {
      access_token: r.access_token,
      access_exp: r.access_exp,
      remember: r.remember,
    });
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
  // A6 (2026-04-28):per-email 限流,补按 IP 限流的盲点。
  // 顺序 IP 限流 → body 校验 → email 限流:
  //   - 必须先过 body shape 校验,否则攻击者发空 body 也会消耗 email 限流额度
  //   - email 维度桶 key 用 sha256 前缀,避免明文邮箱写 rate_limit_events
  const emailCfg = deps.rateLimits?.verifyEmailEmail ?? DEFAULT_RATE_LIMITS.verifyEmailEmail;
  await enforceRateLimit(deps, emailCfg, hashEmailForRateLimit(email));
  try {
    const r = await verifyEmail(email, code);
    // 2026-05-12:首次验证成功 → fire-and-forget 触发 v3 容器 pre-warm。
    // 用"验证 → 首消息"的 p50=215s 间隔覆盖 docker run 冷启,首条消息无等待。
    // `prewarmContainer` 装配层已保证同步 return void / 绝不抛(见 v3prewarm.ts);
    // 未装配(v3Deps 缺)时 optional chain 变 no-op。
    if (r.newly_verified) {
      deps.prewarmContainer?.(BigInt(r.user_id));
    }
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
    created_at: Date;
  }>(
    `SELECT id::text AS id, email, email_verified, role, display_name, avatar_url,
            credits::text AS credits, status, created_at
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
      created_at: u.created_at instanceof Date ? u.created_at.toISOString() : u.created_at,
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
    // FEATURE_REMOTE_SSH 灰度状态 —— 前端据此决定是否渲染执行环境切换器。
    feature_remote_ssh: deps.remoteSshEnabled === true,
  });
}

// ─── GET /api/public/models ─────────────────────────────────────────
// 公开路径,不限流、不需要登录;返回启用模型的公开视图(含 per-ktok 积分估价)。

export async function handleListPublicModels(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.pricing) {
    throw new HttpError(503, "PRICING_NOT_READY", "pricing cache not initialized");
  }
  // 0049/0050:登录用户走 listForUser(visibility OR grants 语义),
  //          匿名 / 无 token / 过期 token 走 listPublic。
  // **不**对 token 失败抛 401:这是公开端点,即便 token 过期也允许列模型,
  // 退化到 public 视图(避免每次登录态过期就 401 把前端 model 列表打没)。
  // jwt 解析走 sync 校验(同 router.ts 的 verifyCommercialJwtSync 路径),
  // 失败/过期/未提供 token 都视作匿名;不验 DB(只读 + listForUser 失败兜底由 grants 空集合保护)。
  const authHeader = req.headers.authorization;
  let token = "";
  if (typeof authHeader === "string") {
    token = authHeader.replace(/^Bearer\s+/i, "").trim();
  }
  const claims = token ? verifyCommercialJwtSync(token, deps.jwtSecret) : null;
  if (!claims) {
    sendJson(res, 200, { models: deps.pricing.listPublic() });
    return;
  }
  // 登录用户 —— 查一次 grants(per-user 表,无 NOTIFY 重载;每次请求查表是合理代价)
  const { listGrantsForUser } = await import("../admin/modelGrants.js");
  const grants = await listGrantsForUser(claims.sub);
  const grantedSet = new Set(grants.map((g) => g.model_id));
  sendJson(res, 200, {
    models: deps.pricing.listForUser({ role: claims.role, grantedModelIds: grantedSet }),
  });
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

// ─── POST /api/feedback (P1-2) ──────────────────────────────────────
//
// 用户反馈入库。匿名 / 已登录均可:
//   - **user_id 关联**:仅认 Bearer token(避免 cookie-only 提交被 CSRF 误绑作者)
//   - 匿名 / 过期 / 伪造 → user_id = null
// 限流 5/min/IP。description 必填(15..10000),meta 必须为 object 且 JSON ≤ 8KB。
// admin 通过 GET /api/admin/feedback + POST /api/admin/feedback/:id/ack 后台流转。
//
// **没有文件 fallback**(与个人版 gateway/server.ts:1325 不同):commercial 全栈
// 依赖 PG,PG 故障期间 auth/sessions 都崩;反馈写不进就返 500,等 PG 恢复用户重试。

export async function handleSubmitFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const cfg = deps.rateLimits?.feedback ?? DEFAULT_RATE_LIMITS.feedback;
  await enforceRateLimit(deps, cfg, ctx.clientIp);

  // **仅 Bearer 关联 user_id**(Codex 审:cookie 关联会被 CSRF 误绑)。
  // 没 token / 校验失败 → 匿名,不抛错,gateway 行为兼容。
  const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, "") ?? "";
  let userId: string | null = null;
  if (authHeader) {
    const claims = verifyCommercialJwtSync(authHeader, deps.jwtSecret);
    if (claims) userId = claims.sub;
  }

  const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "VALIDATION", "invalid body");
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (description.length < 15) {
    throw new HttpError(400, "VALIDATION", "反馈描述至少需要 15 个字符", {
      issues: [{ path: "description", message: "min 15 chars" }],
    });
  }
  if (description.length > 10_000) {
    throw new HttpError(400, "VALIDATION", "description too long (max 10000)", {
      issues: [{ path: "description", message: "max 10000" }],
    });
  }

  // 截断而不抛错:UA 等字段长度可能超限但语义无损;business field (description) 才硬拒
  function strField(v: unknown, max: number): string | null {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t) return null;
    return t.length <= max ? t : t.slice(0, max);
  }

  const category = strField(body.category, 32) ?? "general";
  const requestId = strField(body.request_id, 128);
  const version = strField(body.version, 32);
  const sessionId = strField(body.session_id, 64);
  const userAgent =
    strField(body.user_agent, 512) ?? strField(req.headers["user-agent"], 512);

  let meta: Record<string, unknown> = {};
  if (body.meta !== undefined) {
    if (typeof body.meta !== "object" || body.meta === null || Array.isArray(body.meta)) {
      throw new HttpError(400, "VALIDATION", "meta must be an object", {
        issues: [{ path: "meta", message: "must be object" }],
      });
    }
    const serialized = JSON.stringify(body.meta);
    if (serialized.length > 8192) {
      throw new HttpError(400, "VALIDATION", "meta too large (max 8KB)", {
        issues: [{ path: "meta", message: `${serialized.length} bytes` }],
      });
    }
    meta = body.meta as Record<string, unknown>;
  }

  const r = await insertFeedback({
    user_id: userId,
    category,
    description,
    request_id: requestId,
    version,
    session_id: sessionId,
    user_agent: userAgent,
    meta,
  });

  // 不记 description / meta(可能含 PII / 敏感上下文);仅 id + 关联 user + category
  ctx.log.info("feedback_submitted", { id: r.id, user_id: userId, category });
  sendJson(res, 200, { ok: true, id: r.id });
}

// ─── /api/me/messages — 站内信(in-app inbox)用户侧 ────────────────────
//
// 鉴权:`requireAuth`(JWT only,不查 DB role/status)— 与 /api/me/preferences /
// /api/me/usage 同档。banned 但 access JWT 未到期的用户读自己 inbox 不属于业务
// 风险(读不出别人的、写不动表;reads 表幂等 ON CONFLICT DO NOTHING)。
//
// 路由:
//   GET  /api/me/messages?unread_only=0|1&limit=20&offset=0  → 列表 + unread_count
//   GET  /api/me/messages/unread_count                       → 仅 unread_count(polling 用)
//   POST /api/me/messages/:id/read                           → 标记已读(幂等)
//   POST /api/me/messages/read_all                           → 一次清所有未读
//
// 错误:不可见 / 不存在 → 404 NOT_FOUND;参数非法 → 400 VALIDATION。

function parseInboxLimit(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new HttpError(400, "VALIDATION", "limit must be integer in [1,100]", {
      issues: [{ path: "limit", message: raw }],
    });
  }
  return n;
}

function parseInboxOffset(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    throw new HttpError(400, "VALIDATION", "offset must be non-negative integer", {
      issues: [{ path: "offset", message: raw }],
    });
  }
  return n;
}

export async function handleListMyInbox(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const unreadOnlyRaw = sp.get("unread_only");
  const unreadOnly = unreadOnlyRaw === "1" || unreadOnlyRaw === "true";
  const limit = parseInboxLimit(sp.get("limit"));
  const offset = parseInboxOffset(sp.get("offset"));

  const { listMyInbox } = await import("../inbox/inbox.js");
  const r = await listMyInbox({ userId: user.id, unreadOnly, limit, offset });
  sendJson(res, 200, r);
}

export async function handleCountMyInboxUnread(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const { countMyUnread } = await import("../inbox/inbox.js");
  const n = await countMyUnread(user.id);
  sendJson(res, 200, { unread_count: n });
}

export async function handleMarkInboxRead(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // /api/me/messages/:id/read
  const m = url.pathname.match(/^\/api\/me\/messages\/([1-9][0-9]{0,19})\/read$/);
  if (!m) {
    throw new HttpError(404, "NOT_FOUND", "expected /api/me/messages/:id/read");
  }
  const id = m[1]!;
  const { markRead, InboxError } = await import("../inbox/inbox.js");
  try {
    const r = await markRead(user.id, id);
    sendJson(res, 200, { ok: true, already: r.already });
  } catch (err) {
    if (err instanceof InboxError && err.code === "NOT_FOUND") {
      throw new HttpError(404, "NOT_FOUND", err.message);
    }
    throw err;
  }
}

export async function handleReadAllInbox(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const { readAll } = await import("../inbox/inbox.js");
  const r = await readAll(user.id);
  sendJson(res, 200, { ok: true, inserted: r.inserted });
}

// ─── /api/media-sign + /api/media-signed (v3 signed URL) ───────────────────
//
// 背景:iOS Safari + Cloudflare CDN + SameSite=Strict 场景下,`<img src>` 原生
// 不带 Authorization 头,只能靠 HttpOnly `oc_session` cookie。但 CF edge
// cross-hop 经常 drop 这个 cookie,导致 codex 生成的图片在手机端显示破图。
//
// 业界标准:S3/GCS 风格的 signed URL —— URL 自带 HMAC 签名 + 过期戳 + 用户标识,
// 无需 cookie/Bearer 即可访问。
//
// 路径分工:
//   - `POST /api/media-sign`(Bearer JWT 鉴权) → 输入路径数组,输出 path→signedUrl map
//   - `GET  /api/media-signed?p=&u=&e=&s=` → 验签 + DB active(user/admin)+ 容器路径
//     sanity check(isContainerPathAllowed) → req.url 改成 /api/file?path= + 调
//     containerFileProxy(真正 ACL 由容器内 handleApiFile 把权威)
//
// 维护期:两个路由都已加入 router.ts `prefixes` 数组,maintenance 闸门正常生效。

const MEDIA_SIGN_LOG_USER_RE = /^[1-9]\d{0,18}$/;

/**
 * 从 raw request URL 抽指定 query param 的**未解码**字面值。
 *
 * 用途:`/api/media-signed` 的 `p=...` 是 percent-encoded 路径,
 * `verifySignedUrl` 内部会 `decodeURIComponent` 一次。如果再走 URLSearchParams.get,
 * 等于双解码,会破坏对含字面 `%` 的路径(`100%.png` → 解码错误抛 URIError)
 * 与含字面 `%2F` 的路径(`a%2Fb.png` → `/` 被解出来)的签名 canonicalization。
 *
 * 实现按 `&` 分割原 query string,逐 token 前缀匹配 `<name>=`,返回剩余字符串(不 decode)。
 * 缺失 / 重复 / 空值 → null。
 */
export function extractRawQueryParam(requestUrl: string, name: string): string | null {
  const qi = requestUrl.indexOf("?");
  if (qi < 0) return null;
  // 把 fragment 剥掉(server 通常拿不到 fragment,但稳妥起见)
  const hi = requestUrl.indexOf("#", qi);
  const rawQuery = hi < 0 ? requestUrl.slice(qi + 1) : requestUrl.slice(qi + 1, hi);
  if (rawQuery.length === 0) return null;
  const prefix = `${name}=`;
  let found: string | null = null;
  for (const kv of rawQuery.split("&")) {
    if (kv.startsWith(prefix)) {
      if (found !== null) return null; // duplicated `name=` → 拒绝(防签名走私)
      found = kv.slice(prefix.length);
    } else if (kv === name) {
      // bare `name`(无 `=`)也算重复 — 仍占用一次出现
      if (found !== null) return null;
      found = "";
    }
  }
  // 空值统一返 null(missing-param 与 empty 在 verifySignedUrl 那一层等价,
  // 但 raw extract 层面把 "" 收敛成 null 让 contract 干净 —— `extractRawQueryParam`
  // 返回的非 null 都意味"实际拿到了字符)。
  return found === "" ? null : found;
}

/**
 * 诊断埋点 helper(2026-05-17 v1.0.158):handleMediaSign verify 失败时写
 * 结构化日志,定位 d1193355375 case 的 "retry-after-refresh 仍 401" 根因。
 *
 * 字段约定:
 *   - reason: jwtSync detailed 返回的失败阶段
 *   - token_sub/role/iat/exp: 已 sanitize(只保留 scalar / finite number)
 *   - server_now / clock_skew_sec: 排查时钟漂移(B 假设)
 *   - is_client_retry: x-oc-debug-retry header 标记 retry 路径
 *   - secret_fp: sha256(jwtSecret).slice(0,8) —— 每次现算,捕捉多实例 / rotate
 *   - instance_pid: 区分多 process(单实例不变,多 pod 会差异化)
 *
 * **不写公开 message,reason 不向 client 暴露。** 详情仅进 server 结构化日志。
 */
function _sanitizeClaimScalar(v: unknown): string | number | boolean | null {
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") {
    return v as string | number | boolean;
  }
  return "[non-scalar]";
}
function _sanitizeClaimNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 取第一个 header value(string),Array 取首段,否则 null。 */
function _firstHeader(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

/**
 * Sanitize `x-oc-diag-id` header(前端 `crypto.randomUUID()` 或 fallback
 * `f-<ts>-<rand>` 形态)。允许 `[0-9a-zA-Z-]` 仅 ASCII,1..64 字符,否则 null。
 * 不做 UUID 严格校验,fallback 形式也得过(避免老 Chromium 浏览器 diag 全空)。
 */
function _sanitizeDiagId(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.length === 0 || raw.length > 64) return null;
  if (!/^[0-9a-zA-Z-]+$/.test(raw)) return null;
  return raw;
}

/** sec-ch-ua-mobile 白名单 — 只接 `?0` / `?1` / null,其余视作日志噪音丢掉。 */
function _sanitizeSecChUaMobile(raw: string | null): "?0" | "?1" | null {
  return raw === "?0" || raw === "?1" ? raw : null;
}

function _logMediaSignAuthFail(
  ctx: RequestContext,
  req: IncomingMessage,
  result: Extract<
    ReturnType<typeof verifyCommercialJwtSyncDetailed>,
    { ok: false }
  >,
  jwtSecret: string | Uint8Array,
  source: "bearer" | "cookie",
): void {
  const parsed = result.parsedClaims;
  const tokenExp = _sanitizeClaimNumber(parsed?.exp);
  const tokenIat = _sanitizeClaimNumber(parsed?.iat);
  const now = Math.floor(Date.now() / 1000);
  const secretFp = createHash("sha256")
    .update(jwtSecret as Buffer | string)
    .digest("hex")
    .slice(0, 8);
  const retryHeader = req.headers["x-oc-debug-retry"];
  const isRetry =
    (Array.isArray(retryHeader) ? retryHeader[0] : retryHeader) === "1";
  // 2026-05-18 v1.0.158 device-side diag —— 与前端 `media_sign_fail` web-trace
  // 用同一个 diag_id join。user_agent 走 ctx.userAgent(已经 truncate 512),
  // accept-language 取首段 truncate 128,sec-ch-ua-mobile 白名单到 ?0/?1。
  // 这些字段全部已经在 RequestContext / req.headers 里,**零额外成本**。
  const acceptLangRaw = _firstHeader(req.headers["accept-language"]);
  const acceptLanguage =
    acceptLangRaw === null ? null : acceptLangRaw.slice(0, 128);
  const secChUaMobile = _sanitizeSecChUaMobile(
    _firstHeader(req.headers["sec-ch-ua-mobile"]),
  );
  const diagId = _sanitizeDiagId(_firstHeader(req.headers["x-oc-diag-id"]));
  ctx.log.warn("media_sign_auth_fail", {
    reason: result.reason,
    // v1.0.159 dual verify:同一个 req 可能记两次 fail(bearer + cookie 都败),
    // source 字段区分,便于 jq 分流统计。
    source,
    token_sub: _sanitizeClaimScalar(parsed?.sub),
    token_role: _sanitizeClaimScalar(parsed?.role),
    token_iat: tokenIat,
    token_exp: tokenExp,
    server_now: now,
    clock_skew_sec: tokenExp !== null ? tokenExp - now : null,
    is_client_retry: isRetry,
    secret_fp: secretFp,
    instance_pid: process.pid,
    // 2026-05-18 v1.0.158 device-side join fields
    diag_id: diagId,
    user_agent: ctx.userAgent,
    accept_language: acceptLanguage,
    sec_ch_ua_mobile: secChUaMobile,
  });
}

/**
 * 双凭证 mismatch 告警 —— cookie + bearer 都 verify 通过但 `sub` 不一致
 * (e.g. 多 tab 切账号 race / 旧 Bearer 在 storage 没清干净)。本次架构决定
 * cookie 是浏览器会话权威,**按 cookie 走**,把 bearer 的 sub 记到日志里追踪。
 */
function _logMediaSignSubjectMismatch(
  ctx: RequestContext,
  req: IncomingMessage,
  cookieSub: string,
  bearerSub: string,
): void {
  const diagId = _sanitizeDiagId(_firstHeader(req.headers["x-oc-diag-id"]));
  ctx.log.warn("media_sign_subject_mismatch", {
    chosen: "cookie",
    cookie_sub: cookieSub,
    bearer_sub: bearerSub,
    diag_id: diagId,
    user_agent: ctx.userAgent,
    instance_pid: process.pid,
  });
}

/**
 * POST /api/media-sign
 *
 * 鉴权(v1.0.159 起):**Cookie 优先 + Bearer 兜底 + dual verify**。
 *   1. 读 `oc_session` cookie 和 `Authorization: Bearer ...` 两份凭证
 *   2. cookie 有 → 先 verify cookie;通过即用 cookie 的 claims
 *   3. cookie 无 / 不通过 → verify bearer;通过即用 bearer 的 claims
 *   4. 两者都无 / 都不通过 → 401
 *   5. 两者都通过但 sub 不同 → 选 cookie + 写 mismatch 告警日志
 * 加 `requireActiveAccountVerifyDb` (DB role∈{user,admin} ∧ status='active')。
 *
 * **为什么 cookie 优先**:HttpOnly `oc_session` 是浏览器会话权威源 ——
 *   - JS 不能读/改它,跟 access_token in-memory desync 解耦(d1193355375 v1.0.158 case
 *     正是 state.token 75min 不切但 cookie 始终 fresh)
 *   - mintSessionCookie 跟随每次 refresh 自动更新,生命周期跟 access JWT 绑死
 *   - 跨 tab race 时 cookie 是 last-write-wins,跟当前用户身份对齐更可靠
 *
 * **保留 Bearer 兜底**:API 调用者 / 未冷启动(no cookie)的 webview / curl 脚本
 *   仍走 Bearer。**老 v1.0.158 前端(已部署到用户浏览器)**继续发 stale Bearer +
 *   fresh cookie —— cookie-first 让这种 tab 的 media-sign 立即恢复(本次架构修
 *   存量 stale-Bearer tab 的关键路径)。
 *
 * 入参 body: `{ paths: string[] }`(最多 32 条,见 normalizeSignBatchInput)。
 * 出参: `{ urls: Record<path, signedUrl>, expMs: number }`。
 *
 * 谓词不通过的 path **从 response map 里 drop**,不抛 403 —— 前端按 cache miss
 * 处理。这避免单条非法 path 让整个 batch 失败(媒体 URL 渲染应尽可能优雅)。
 */
export async function handleMediaSign(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.mediaSignKey) {
    throw new HttpError(503, "SIGN_DISABLED", "media signed URL not configured");
  }
  if (!deps.v3Supervisor) {
    // requireActiveAccountVerifyDb 需要 pool;v3Supervisor 未装配 = 整 v3 还没起,503 更准确
    throw new HttpError(503, "SIGN_DISABLED", "media signed URL not configured");
  }

  // 2026-05-18 v1.0.159:cookie 优先 + Bearer 兜底 + dual verify。详见上方 doc。
  // 任一通过即放行;两者都通过但 sub 不同 → 选 cookie(权威源)并打 mismatch warn。
  const cookieToken = getSessionCookieToken(req);
  const bearerToken = getBearerToken(req);

  // 走 detailed 版:失败时把 reason / parsedClaims 一并写结构化日志,定位
  // d1193355375 案这类 401 根因(token 漂移 / clock skew / secret rotate)。
  // 对外 message 始终 "invalid or expired token",reason 不暴露给 client。
  // 详见 jwtSync.ts 顶部 doc。
  let claims: CommercialJwtClaims | null = null;
  let chosenSource: "cookie" | "bearer" | null = null;

  // Step 1: cookie 优先
  if (cookieToken) {
    const r = verifyCommercialJwtSyncDetailed(cookieToken, deps.jwtSecret);
    if (r.ok) {
      claims = r.claims;
      chosenSource = "cookie";
    } else {
      _logMediaSignAuthFail(ctx, req, r, deps.jwtSecret, "cookie");
    }
  }

  // Step 2: cookie 没过 → 试 Bearer。如果 bearer === cookieToken(浏览器同源场景常见),
  // 跳过避免重复验签 + 重复 fail 日志。
  if (!chosenSource && bearerToken && bearerToken !== cookieToken) {
    const r = verifyCommercialJwtSyncDetailed(bearerToken, deps.jwtSecret);
    if (r.ok) {
      claims = r.claims;
      chosenSource = "bearer";
    } else {
      _logMediaSignAuthFail(ctx, req, r, deps.jwtSecret, "bearer");
    }
  }

  if (!claims || !chosenSource) {
    throw new HttpError(401, "UNAUTHORIZED", "invalid or expired token");
  }

  // Step 3: 两者都通过但 sub 不同 → 已选 cookie,记 mismatch warn。
  // 只在 cookie 通过(chosenSource==='cookie')且 bearer 不同 token 时查;
  // cookie 没过则 chosenSource==='bearer',无 mismatch 概念。
  // bearer verify fail 的 case 不写 mismatch(那是常规 stale-Bearer migration,
  // 会刷屏);只有 bearer verify ok 但 sub 不同,才是真"多 tab 切账号"信号。
  if (chosenSource === "cookie" && bearerToken && bearerToken !== cookieToken) {
    const br = verifyCommercialJwtSyncDetailed(bearerToken, deps.jwtSecret);
    if (br.ok && br.claims.sub !== claims.sub) {
      _logMediaSignSubjectMismatch(ctx, req, claims.sub, br.claims.sub);
    }
  }

  // user 和 admin 都允许 sign:cookie-free signed URL 的核心动机就是 iOS Safari +
  // CF CDN 丢 oc_session;admin 在那个环境同样会丢 cookie,以前那条 "admin 走
  // cookie bypass" 假设把 admin 直接锁出。admin/users 共用 active container 流程
  // (id=1 admin DB 验过有 agent_containers active 行),路径空间一致。
  const verified = await requireActiveAccountVerifyDb(
    claims.sub,
    ["user", "admin"],
    deps.v3Supervisor.pool,
  );
  if (!verified) {
    throw new HttpError(403, "FORBIDDEN", "account not active");
  }

  const body = (await readJsonBody(req)) as { paths?: unknown } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "body must be a JSON object");
  }
  const norm = normalizeSignBatchInput(body.paths);
  if (!norm.ok) {
    throw new HttpError(400, "VALIDATION", norm.message);
  }

  // 路径空间:**容器内部**(`/home/agent/...`),与 containerFileProxy 的 path
  // forward 语义对齐。**不再**用 host-volume predicate —— 那一版把 master 的
  // `/var/lib/docker/volumes/...` 路径塞进 container-side 数据通路,导致 codex
  // 合法路径(`/home/agent/.codex/generated_images/...`)被全 drop。真正 ACL
  // 由容器内 handleApiFile(realpathSync + agentCwds + blocklist + fd recheck)做。
  const userId = `c:${claims.sub}`;

  const expMs = Date.now() + DEFAULT_SIGN_TTL_MS;
  const urls: Record<string, string> = {};
  for (const p of norm.paths) {
    let resolved: string;
    try {
      resolved = resolvePath(p);
    } catch {
      continue;
    }
    if (!isContainerPathAllowed(resolved)) continue;
    // sign 用 raw 输入 path(handler 端 decoded 后做 HMAC,verify 端
    // decodeURIComponent 后再算 HMAC,canonicalization 一致)
    const { url } = buildSignedUrl(deps.mediaSignKey, p, userId, DEFAULT_SIGN_TTL_MS);
    urls[p] = url;
  }
  sendJson(res, 200, { urls, expMs });
}

/**
 * GET /api/media-signed?p=&u=&e=&s=
 *
 * 公开端点(无需 cookie / Bearer),由 HMAC 签名 + 过期戳自证身份。
 * 验签通过 → 当作 `/api/file?path=<decodedPath>` 走 containerFileProxy。
 *
 * 不查 DB?——查。即使签 URL 时是 active,签后可能被 ban → 不能因 signed URL 还
 * 在 TTL 内就漏放。`requireActiveAccountVerifyDb(sub, ['user','admin'], pool)`
 * 双检 role 与 status=active。
 *
 * Cache-Control:仅当上游容器返 200/206 + 签名未过期 → public, max-age=剩余 TTL。
 * 4xx/5xx 维持 no-store(避免 CDN 缓存错误响应导致 token rotate 后无法刷新)。
 */
export async function handleMediaSigned(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.mediaSignKey) {
    throw new HttpError(503, "SIGN_DISABLED", "media signed URL not configured");
  }
  if (!deps.v3Supervisor || !deps.bridgeSecret) {
    // file proxy 整体未装配 → signed URL 没意义,503 更准确
    throw new HttpError(503, "SIGN_DISABLED", "media signed URL not configured");
  }

  // **Canonicalization 关键**:`p` 必须从 raw query string 抽,**不能**走 URLSearchParams.get,
  // 否则会被 once-decoded —— verifySignedUrl 还会再 decodeURIComponent 一次 → 双解码,
  // 对于含有字面 `%` / `%2F` 的合法文件名(`100%.png`、`a%2Fb.png`)签名/验签会错位 / 抛错。
  //
  // u/e/s 是 ASCII 安全字段(`c:<digits>`、十进制毫秒戳、hex sig),once-decoded 后形态
  // 不变,继续用 URLSearchParams 取无副作用。
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const u = url.searchParams.get("u");
  const e = url.searchParams.get("e");
  const s = url.searchParams.get("s");
  const pRaw = extractRawQueryParam(req.url ?? "", "p");

  const result = verifySignedUrl(deps.mediaSignKey, { pRaw, u, e, s });
  switch (result.kind) {
    case "bad-request":
      throw new HttpError(400, "BAD_REQUEST", `signed URL: ${result.reason}`);
    case "forbidden":
      throw new HttpError(403, "FORBIDDEN", "signed URL signature invalid");
    case "gone":
      throw new HttpError(410, "GONE", "signed URL expired");
    case "ok":
      break;
  }
  const { userId, expMs, decodedPath } = result;

  // userId 形 `c:<digits>`(USER_ID_RE 已守护)→ sub 是 digits
  const sub = userId.slice(2);
  if (!MEDIA_SIGN_LOG_USER_RE.test(sub)) {
    throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-user-id");
  }

  // DB double-check user/admin still active(签 URL 时是 active,签后被 ban → 现在拒)
  const verified = await requireActiveAccountVerifyDb(
    sub,
    ["user", "admin"],
    deps.v3Supervisor.pool,
  );
  if (!verified) {
    throw new HttpError(403, "FORBIDDEN", "account not active");
  }

  // Path sanity check —— **不是 ACL**,真正访问控制由容器内 handleApiFile 做
  // (realpathSync + agentCwds + blocklist + fd recheck)。这里只挡明显扫描类路径
  // (`/etc/passwd` / `/var/log/...` / `/proc/...`),粗白名单到 `/home/agent/...`。
  // 详见 mediaSign.ts::isContainerPathAllowed 注释。
  let resolved: string;
  try {
    resolved = resolvePath(decodedPath);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-path");
  }
  if (!isContainerPathAllowed(resolved)) {
    throw new HttpError(403, "FORBIDDEN", "signed URL path not authorized");
  }

  // 调 containerFileProxy:它内部从 req.url 解析 path → 我们必须把 req.url 改成
  // `/api/file?path=<encoded decoded path>`,proxy 看到的 pathname 必须是 /api/file
  // (它按 pathname === '/api/file' 走 isFilePath 分支)。try/finally 恢复原值
  // (虽然请求结束后 req 不再用,但符合 hygiene)。
  const log = (_ctx).log;
  const requestId = _ctx.requestId;
  const ctxForProxy: RequestContext = {
    requestId,
    clientIp: _ctx.clientIp,
    authBoundIp: _ctx.authBoundIp,
    userAgent: _ctx.userAgent,
    log,
  };
  const originalUrl = req.url;
  const newPath = `/api/file?path=${encodeURIComponent(decodedPath)}`;
  req.url = newPath;
  try {
    const selfHostIdForProxy = deps.v3Supervisor.selfHostId;
    // Cache-Control 覆盖:仅 200/206 → public, max-age = min(剩余 TTL, 240s)。
    // 240 上限避免 expMs 离现在仍很远时 CDN 大段缓存(虽然签名 TTL 由 sign 端
    // 控制 5min,这里再 clamp 一遍是 defense-in-depth)。
    const cacheControlOverride = (upstreamStatus: number): string | null => {
      if (upstreamStatus !== 200 && upstreamStatus !== 206) return null;
      const remainSec = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
      const ageSec = Math.min(240, remainSec);
      if (ageSec <= 0) return null;
      return `public, max-age=${ageSec}`;
    };
    await containerFileProxy(
      req,
      res,
      ctxForProxy,
      {
        v3: deps.v3Supervisor,
        bridgeSecret: deps.bridgeSecret,
        selfHostId: selfHostIdForProxy,
        getHostById: computePoolGetHostById,
        tunnelDial: defaultTunnelDial,
        capabilityProbe: {
          selfHostId: selfHostIdForProxy,
          tunnelFetchHealthz: (hostId, cid, timeoutMs) =>
            defaultTunnelFetchHealthz(hostId, cid, timeoutMs, {
              getHostById: computePoolGetHostById,
            }),
        },
        responseCacheControlOverride: cacheControlOverride,
      },
      BigInt(sub),
    );
  } finally {
    req.url = originalUrl;
  }
}

// helper for tests / 其他 module
export { clientIpOf, userAgentOf };
