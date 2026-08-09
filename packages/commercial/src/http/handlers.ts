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
  appendSetCookie,
  setLaneCookie,
  clearLaneCookie,
  readLaneCookie,
} from "./cookies.js";
import { evaluateLaneForUser } from "../deploy/laneEvaluate.js";
import { register, RegisterError } from "../auth/register.js";
import { verifyEmail, requestPasswordReset, confirmPasswordReset, resendVerification, VerifyError } from "../auth/verify.js";
import { login, refresh, logout, LoginError, RefreshError } from "../auth/login.js";
import { requireAuth } from "./auth.js";
import type { EngineHttpDeps as ConnectorEngineHttpDeps } from "../connectors/engine/driver.js";
import { query } from "../db/queries.js";
import { insertFeedback } from "../admin/feedback.js";
import { getUserUsageReport, isUsageWindow, type UsageWindow } from "../billing/usageReport.js";
import {
  verifyCommercialJwtSync,
  verifyCommercialJwtSyncDetailed,
  type CommercialJwtClaims,
} from "../auth/jwtSync.js";
import { requireActiveAccountVerifyDb } from "./requireUser.js";
import {
  buildOpaqueSignedUrl,
  buildOpaqueMediaFileUrl,
  buildOpaqueInboxAssetUrl,
  verifySignedUrl,
  normalizeSignBatchInput,
  isContainerPathAllowed,
  isMediaFilenameAllowed,
  extractApiMediaFilename,
  DEFAULT_SIGN_TTL_MS,
} from "./mediaSign.js";
import { containerFileProxy } from "./containerFileProxy.js";
import {
  ThumbnailDiskCache,
  THUMBNAIL_MAX_SOURCE_BYTES,
  parseThumbnailWidth,
  renderThumbnail,
  resizeToWebpThumbnail,
  thumbnailCacheKey,
} from "./mediaThumbnail.js";
import { BufferingResponseSink } from "./bufferingResponseSink.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import { getBearerToken, getSessionCookieToken } from "./authHelpers.js";
import { defaultTunnelFetchHealthz } from "./tunnelHealthzProbe.js";
import { getHostById as computePoolGetHostById } from "../compute-pool/queries.js";
import { dialTunnelSocket as defaultTunnelDial } from "../compute-pool/nodeAgentClient.js";
import { checkRateLimit, recordRateLimitEvent, type RateLimitConfig, type RateLimitDecision, type RateLimitRedis } from "../middleware/rateLimit.js";
import { FallbackRateLimiter } from "./proxy/shared.js";
import { getSystemSetting } from "../admin/systemSettings.js";
import type { Mailer } from "../auth/mail.js";
import { perKtokCredits, type PricingCache, type PublicModel } from "../billing/pricing.js";
import {
  CatalogUnknownError,
  type ModelCatalogSnapshot,
  type UserModelScope,
} from "../billing/modelCatalog.js";
import type { UserModelAuthzLoader } from "../auth/userModelAuthz.js";

/** 匿名 /api/public/models 的展示面 fence 微缓存窗口(方案 §1.2:安全/计费面禁缓存,展示面许)。 */
const PUBLIC_MODELS_FENCE_TTL_MS = 2_000;
import type { CatalogSource } from "./internalModelCatalog.js";
import { findRouteProviderForModel } from "@openclaude/protocol";
import { getDegradedProviders } from "../admin/providerHealthGate.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import { ensureFreeSubscription } from "../billing/subscription.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import type { HupijiaoClient, HupijiaoConfig } from "../payment/hupijiao/client.js";
import type { AgentHttpDeps } from "./agent.js";
import type { V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";
import type { RemoteHostTester } from "../remoteHosts/service.js";
import type { AccountHealthTracker } from "../account-pool/health.js";
import type { AnthropicProxyHandler } from "./proxy/shared.js";
import {
  canAccessInboxAsset,
  inboxAssetIdFromPath,
  readInboxAssetForViewer,
} from "../inbox/assets.js";
import type { ContainerPreviewTicketStore } from '../ws/containerPreviewTickets.js'
import type { DirectContainerPreviewService } from '../ws/directContainerPreview.js'
import type { PluginRuntimeFacade } from '../plugins/runtime.js'
import type { KnowledgePlanetSetupManager } from '../plugins/knowledgePlanetSetup.js'
import type { WeiboSetupManager } from '../plugins/weiboSetup.js'
import type { ZhihuSetupManager } from '../plugins/zhihuSetup.js'
import type { KnowledgePlanetAutomationService } from '../plugins/knowledgePlanetAutomation.js'
import type { GoalStateService } from '../goal/goalStateService.js'
import type { MediaGenerationService } from '../media-generation/service.js'

export interface CommercialHttpDeps {
  jwtSecret: string | Uint8Array;
  /** Durable local H3 jobs and long-form storyboard projects. */
  mediaGeneration?: MediaGenerationService;
  /** Platform-authoritative session GoalState service. */
  goalStateService?: GoalStateService;
  /** Short-lived one-time browser tickets for V5 container-local preview. */
  containerPreviewTickets?: ContainerPreviewTicketStore;
  /** Prevent issuing a ticket until the public WS bridge is fully assembled. */
  containerPreviewAvailable?: () => boolean;
  /** Optional native iframe transport; legacy screencast remains the fallback. */
  directContainerPreview?: DirectContainerPreviewService
  /** Signed Plugin catalog/accounts runtime for the browser management surface. */
  pluginRuntime?: PluginRuntimeFacade
  /** Short-lived managed login coordinator for the official Knowledge Planet Plugin. */
  knowledgePlanetSetup?: KnowledgePlanetSetupManager
  /** Short-lived managed login coordinator for the official Weibo Plugin. */
  weiboSetup?: WeiboSetupManager
  /** Short-lived managed login coordinator for the official Zhihu Plugin. */
  zhihuSetup?: ZhihuSetupManager
  /** Separate high-risk control/rules for official Knowledge Planet unattended replies. */
  knowledgePlanetAutomation?: KnowledgePlanetAutomationService
  mailer: Mailer
  redis: RateLimitRedis
  turnstileSecret?: string
  /**
   * 是否对真实用户强制人机验证(env TURNSTILE_ENFORCE,缺省=强制)。
   * 与 turnstileBypass 是两回事:那个是测试旁路(生产禁用),这个是显式产品配置。
   */
  turnstileEnforce?: boolean
  /** 全局旁路(env TURNSTILE_TEST_BYPASS),仅 dev/CI —— 生产由 config.ts fail-closed 拦死 */
  turnstileBypass?: boolean
  /**
   * 账号级人机验证白名单(env TURNSTILE_BYPASS_ACCOUNTS,config.ts 已规范化)。
   * 生产环境唯一合法的 turnstile 旁路:只对白名单里的自动化账号生效,判定权威在
   * `auth/turnstile.ts` 的 resolveTurnstileBypass,命中会打日志留痕。
   */
  turnstileBypassAccounts?: readonly string[]
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
   * 模型执行 catalog(模型权威批次 · 方案 §6)。**注入后即为 `/api/public/models` 的
   * 唯一投影权威**:行集 = catalog active ∧ 该 uid 可见 ∧ 有价 ——
   * staged/retired/无价行恒不出现,alias 不作为独立条目,provider 归属取 catalog.provider_id
   * (不再用 route registry 的 `findRouteProviderForModel` 推断)。
   *
   * 未注入 → 退回 legacy PricingCache 投影(装配尚未接线的旧路径 / 单测)。生产 master
   * 在 index.ts 注入进程级唯一快照(modelCatalogRuntime 单例)。
   */
  modelCatalog?: CatalogSource;
  /**
   * Production injects the same epoch-aware authz loader used by bridge/egress so
   * `/api/public/models` reflects account-scoped denials as well as grants.
   * Optional only for rolling compatibility and legacy test fixtures.
   */
  loadUserModelAuthz?: UserModelAuthzLoader;
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
    /** 2026-07-02:login per-email 维度(对照 verifyEmailEmail),防 IP 池打单账号。 */
    loginEmail: RateLimitConfig;
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
    // 2026-06-18:前端问题自动上报,匿名可提交,按 IP 限流(比 feedback 宽)
    clientErrors: RateLimitConfig;
    // 2026-07-08:每条响应满意度评分(强制登录),按 user 维度限流
    responseRating: RateLimitConfig;
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
   * 连接器引擎的 HTTP 注入(DNS resolver / fetchImpl)。**生产恒 undefined**(引擎走真实
   * pinnedHttpsFetch 出网);仅集成测试注入受控本地上游 —— 与本接口已有的 `fetchImpl?`
   * (Turnstile 测试注入)同一范式。声明式绑定 / OAuth 回调经它把探针 + token 交换打到 mock server。
   */
  connectorEngineDeps?: ConnectorEngineHttpDeps;
  /**
   * T-53: Agent 运行时(docker + image + network + seccomp + proxy + rpc dir)。
   * 未注入时 `/api/agent/open` 返 503(仍允许 /status 查看过去订阅)。
   */
  agentRuntime?: AgentHttpDeps;
  /**
   * 按需容器路径(v3-supervisor / OC_RUNTIME_IMAGE)是否就绪。true 时 /api/agent/status
   * 返 runtime_ready=true + ondemand(无 legacy 订阅,容器随 user-chat-bridge WS 连接 ensureRunning
   * 起、按 turn 计费)。v5 ccb 单底座走此路;与 legacy agentRuntime 平行。
   */
  containerRuntimeReady?: boolean;
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
   * 装配:v3Deps 配齐时由 `makePrewarmContainer` 复用 `sharedEnsureRunning`(与 WS /
   * media-signed / cronWake 同一 per-uid singleflight in-flight map;2026-07-07 修 Codex MAJOR,
   * 不再独立包装裸 makeV3EnsureRunning)注入(见 commercial/src/index.ts)。v3Deps 未配 →
   * undefined,handler 端 `deps.prewarmContainer?.()` 变 no-op。
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
   * 服务端缩略图磁盘缓存(见 mediaThumbnail.ts)。注入后 `/api/media-signed?w=<640|1280>`
   * 对 image/* 响应缩到 webp 缓存;未注入 → `w` 被忽略,一律回原图(优雅降级,不破坏渲染)。
   * 由 registerCommercial 启动期 `init()` 清零后注入,与 mediaSignKey 同生命周期(依赖 file proxy)。
   */
  thumbnailCache?: ThumbnailDiskCache;
  /**
   * WeChat read-only live-process bearer link key. Derived from bridgeSecret
   * with a separate HKDF info string; absent means `/wx/live` API returns 503.
   */
  wechatLiveLinkKey?: Buffer;
  /**
   * v1.0.191 — `/api/media-signed` 冷启动护栏。
   *
   * 用户 idle 超过 idleSweep 阈值 → 容器被 stop。用户回来 reload 页面时:
   * WS 一路走 bridge → ensureRunning(uid) → 容器自然 boot 起来;
   * 但 `<img src="/api/media-signed?...">` 同时拉,直接命中 handleMediaSigned →
   * containerFileProxy 见容器 `state='stopped'` → 503 CONTAINER_NOT_RUNNING →
   * 浏览器对 <img> 不会自动重试 → 用户看到一堆 broken image。
   *
   * 注入后:handleMediaSigned 在 path sanity 通过 / containerFileProxy 之前
   * `await ensureContainerReady(uid)`,语义同 makeV3EnsureRunning:provision +
   * 等容器 readiness(/healthz + WS upgrade)直至 running,或 throw
   * `ContainerUnreadyError(retryAfterSec, reason)`。
   *
   * 装配端必须做 **per-uid singleflight** 合并(同一用户多图并发只触发一次 provision)
   * 且 **与 WS bridge 共享同一 in-flight map**(否则 reload 时 <img> burst 与 WS
   * connect 之间仍可能在 DB INSERT 上 race,HTTP 一路成为输家被翻 503)。详见
   * commercial/src/index.ts 装配处 `sharedEnsureRunning` 闭包。
   *
   * 未注入(单测 / 早期 boot)→ 退化为旧行为(可能 503 但不阻塞测试)。
   */
  ensureContainerReady?: (uid: bigint) => Promise<void>;
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
  // 2026-07-02:per-email 维度,补 IP 限流盲点(攻击者切 IP 池打单账号)。对照
  // verifyEmailEmail(A6)同款。20/30min 对真实用户宽松(忘密码连错也到不了),
  // 对分布式暴破是硬闸;有 turnstile+argon2 在前,这是第三道防线。
  loginEmail: { scope: "login_email", windowSeconds: 1800, max: 20 } satisfies RateLimitConfig,
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
  // 2026-06-18:前端问题自动上报。比 feedback 宽(30/min/IP)—— 一个坏页面会连发
  // 几条(JS 异常 + 接口失败 + 流式中断),但仍挡住脚本刷日志。前端侧另有签名节流。
  clientErrors: { scope: "client_errors", windowSeconds: 60, max: 30 } satisfies RateLimitConfig,
  // 2026-07-08:每条响应满意度评分(👍/👎)。按 **user** 维度(端点强制登录),60/min ——
  // 评分是逐条响应的高频信号,用户可能快速给多条打分或反复 toggle;宽到不误伤真实交互,
  // 又挡住脚本刷分。identifier=`u:<uid>`(非 IP)。
  responseRating: { scope: "response_rating", windowSeconds: 60, max: 60 } satisfies RateLimitConfig,
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

// B9 — Redis 挂时鉴权/支付限流的 per-process 兜底。
// 此前 checkRateLimit 内 `redis.incr` 无兜底:Redis 不可用即 throw → enforceRateLimit
// 透出 → register/login/reset/refresh/... 全 500(鉴权整体宕机)。聊天代理早有
// FallbackRateLimiter,鉴权端却没接。这里在唯一 choke point 接同一兜底:每个
// (scope+window+max) 一个固定窗口限流器,cap 取 Redis 配额的 ~1/3(下限 1)——
// "降级而非开闸":Redis 盲时收紧挡放大攻击,但鉴权仍可用。per-process(蓝绿不汇总)
// 是可接受降级面;Redis 恢复后自动回到分布式精确限流。
const _rlFallbacks = new Map<string, FallbackRateLimiter>();
let _lastRlFallbackWarnAt = 0;
function _fallbackLimiterFor(cfg: RateLimitConfig): FallbackRateLimiter {
  // 按 scope+window+max+keyPrefix 建键:配置变更则用新限流器,不沿用旧窗口/阈值;
  // 纳入 keyPrefix 与 Redis key 隔离语义对齐(只差 keyPrefix 的配置不共享兜底桶)。
  const key = `${cfg.scope}:${cfg.windowSeconds}:${cfg.max}:${cfg.keyPrefix ?? ""}`;
  let limiter = _rlFallbacks.get(key);
  if (!limiter) {
    const cap = Math.max(1, Math.ceil(cfg.max / 3));
    limiter = new FallbackRateLimiter(cfg.windowSeconds, cap);
    _rlFallbacks.set(key, limiter);
  }
  return limiter;
}

/**
 * 限流帮助:超限抛 HttpError(429),并写一行 rate_limit_events。
 * 导出给 payment / chat 等路由复用。
 * Redis 不可用时降级到 per-process FallbackRateLimiter(B9),不再整体 500。
 */
export async function enforceRateLimit(
  deps: CommercialHttpDeps,
  cfg: RateLimitConfig,
  identifier: string,
): Promise<void> {
  // Codex B9 Finding 1:identifier 是运行时可变入参(clientIp / user:id / email-hash),
  // 非法(空/超长)是上游 bug,应直接抛、不被下面的 Redis 兜底 catch 掩盖。先于 try 校验
  // (与 checkRateLimit 同口径),使 catch 只可能捕获 redis.incr 的连接/命令错误。
  // cfg 来自固定 DEFAULT_RATE_LIMITS/deps(启动期有效),不在此重复 schema 校验。
  if (typeof identifier !== "string" || identifier.length === 0 || identifier.length > 256) {
    throw new Error(
      `enforceRateLimit: invalid identifier (length=${typeof identifier === "string" ? identifier.length : "non-string"})`,
    );
  }
  let decision: RateLimitDecision;
  try {
    decision = await checkRateLimit(deps.redis, cfg, identifier);
  } catch (err) {
    // 到此基本只可能是 Redis 不可用(incr 连接/命令错误)→ per-process 兜底,保鉴权可用。
    const limiter = _fallbackLimiterFor(cfg);
    const allowed = limiter.tryAcquire(identifier);
    decision = {
      allowed,
      count: 0,
      limit: limiter.maxPerKey,
      retryAfterSeconds: cfg.windowSeconds,
      key: `fallback:${cfg.scope}`,
    };
    const now = Date.now();
    if (now - _lastRlFallbackWarnAt > 30_000) {
      _lastRlFallbackWarnAt = now;
      rootLogger.warn("rate-limit Redis unavailable; using per-process fallback (degraded, blue-green not aggregated)", {
        scope: cfg.scope,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
  //
  // 2026-05-22:同步读 register_email_domain_blocklist(反薅羊毛黑名单)。
  // 并行两 setting 走 Promise.all 省一次 DB round-trip;allow_registration
  // 仍单独提前判定以保留"关了直接 403"的语义,只在它放行时才用到 blocklist。
  const [allowReg, blocklistSetting] = await Promise.all([
    getSystemSetting("allow_registration"),
    getSystemSetting("register_email_domain_blocklist"),
  ]);
  // 2026-07-11:拆除 v5 channel bypass(v3/v5 共库过渡期脚手架 —— 当年 v5 放开注册
  // 不能牵连共享 system_settings 的 v3 现网)。v3 已于 2026-07-08 彻底下线,bypass 的
  // 唯一效果变成"让 admin 的 allow_registration 开关在 v5 上永久失效"(admin 显示
  // false、实际注册全开)。恢复 system_settings 为唯一权威,与 socialLogin(linuxdo
  // OAuth allowCreate)对称;上线前先把 DB 值置 true,行为零变化。
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
      turnstileBypassAccounts: deps.turnstileBypassAccounts,
      turnstileEnforce: deps.turnstileEnforce,
      fetchImpl: deps.fetchImpl,
      remoteIp: ctx.clientIp,
      verifyEmailUrlBase: deps.verifyEmailUrlBase,
      emailDomainBlocklist: blocklistSetting.value,
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
        EMAIL_DOMAIN_BLOCKED: { status: 400 },
      };
      const m = map[err.code];
      throw new HttpError(m.status, err.code, err.message, { issues: err.issues });
    }
    throw err;
  }
}

// ─── P3 cohort lane 下发(login/refresh/`/api/me` 三处同构)─────────────
//
// 统一收口:评估 uid 的 lane → candidate 则下发 oc_v5lane cookie;active 则**仅在
// 请求确实带了 oc_v5lane 时**清除(无 cookie 的 active = 零 Set-Cookie,基建版零行为
// 变化)。返回 lane 标签写进响应体供前端 authStore(laneReady gate)。
// fail-closed:评估内部已对 deploy_state 读失败兜底回 active;此处再包一层 try/catch,
// 保证任何 lane 逻辑异常都绝不阻断 login/refresh/me 主流程。
async function resolveLaneAndApply(
  req: IncomingMessage,
  res: ServerResponse,
  uid: string,
  secure: boolean | undefined,
): Promise<"active" | "candidate"> {
  try {
    const decision = await evaluateLaneForUser(uid);
    if (decision.lane === "candidate" && decision.cookieValue) {
      setLaneCookie(res, decision.cookieValue, { secure });
    } else if (readLaneCookie(req) !== null) {
      clearLaneCookie(res, { secure });
    }
    return decision.lane;
  } catch (err) {
    rootLogger.child({ subsys: "laneCookie" }).warn("lane_apply_failed", {
      err: (err as Error).message,
    });
    return "active";
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
  // per-email 限流(顺序同 verifyEmail A6:IP 限流 → body 解析 → email 限流;
  // email 非法形状交给 login() 内 schema 拒,不消耗 email 维度额度)。
  // 桶 key 用 sha256 前缀,明文邮箱不进 rate_limit_events。
  const loginEmail = (body as { email?: unknown } | null)?.email;
  if (typeof loginEmail === "string" && loginEmail.length > 0) {
    const emailCfg = deps.rateLimits?.loginEmail ?? DEFAULT_RATE_LIMITS.loginEmail;
    await enforceRateLimit(deps, emailCfg, hashEmailForRateLimit(loginEmail));
  }
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
      turnstileBypassAccounts: deps.turnstileBypassAccounts,
      turnstileEnforce: deps.turnstileEnforce,
      fetchImpl: deps.fetchImpl,
      remoteIp: ctx.clientIp,
      bindIp: ctx.authBoundIp,
      userAgent: ctx.userAgent ?? undefined,
      requireEmailVerified: deps.requireEmailVerified,
      replaceRefreshToken: readRefreshCookie(req),
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
    // P3 cohort:登录即评估 lane 并(按需)下发 oc_v5lane,前端 laneReady gate 拿到后建 WS。
    const lane = await resolveLaneAndApply(req, res, String(result.user.id), deps.refreshCookieSecure);
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
      // P3 cohort lane 决策(active|candidate),前端 authStore 持有做 laneReady gate。
      lane,
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
    // P3 cohort:静默 refresh 也重评 lane(在线用户随 token 刷新自然收敛到最新 percent)。
    const lane = await resolveLaneAndApply(req, res, r.user_id, deps.refreshCookieSecure);
    // 2026-04-24 回传 remember 让前端 refresh 成功时把 access token 写到
    // 正确的 storage:persistent → localStorage / session → sessionStorage。
    // 不回传的话前端无从得知原登录选择,rotate 后 access 可能错放。
    sendJson(res, 200, {
      access_token: r.access_token,
      access_exp: r.access_exp,
      remember: r.remember,
      lane,
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
  // 2026-05-22:反薅羊毛 — verify 也走一次 domain blocklist。
  // 必须在 verifyEmail() 内 code 校验**通过后**才真的判定(防枚举),所以仅
  // 把规则注入,具体 hook 在 verify.ts 函数内。
  const blocklistSetting = await getSystemSetting("register_email_domain_blocklist");
  try {
    const r = await verifyEmail(email, code, {
      emailDomainBlocklist: blocklistSetting.value,
    });
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
        turnstileBypassAccounts: deps.turnstileBypassAccounts,
        turnstileEnforce: deps.turnstileEnforce,
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
  // 0096：保证每个活跃用户有一行订阅（首次惰性 bootstrap 免费档 + 发首期 300）。快路径已存在即返回。
  await ensureFreeSubscription(user.id);
  // 双钱包：展示「总可用余额」= users.credits 持久钱包 + active 订阅 period_credits 期内桶。
  const r = await query<{
    id: string;
    email: string;
    email_verified: boolean;
    role: "user" | "admin";
    display_name: string | null;
    avatar_url: string | null;
    wallet_credits: string;
    period_credits: string;
    total_credits: string;
    status: string;
    created_at: Date;
    on_v5: boolean;
    // 企业版(P3.1):caller 的 active org 归属(uq_user_active_org 保证至多一行 → 无 cartesian)。
    // org suspended 仍返回(带 status,前端提示用),故 orgs LEFT JOIN 不按 o.status 过滤。
    org_id: string | null;
    org_name: string | null;
    org_role: "owner" | "admin" | "member" | null;
    org_status: string | null;
    org_billing_enabled: boolean | null;
    org_billing_delegate: boolean | null;
  }>(
    `SELECT u.id::text AS id, u.email, u.email_verified, u.role, u.display_name, u.avatar_url,
            u.credits::text AS wallet_credits,
            COALESCE(us.period_credits, 0)::text AS period_credits,
            (u.credits + COALESCE(us.period_credits, 0))::text AS total_credits,
            u.status, u.created_at,
            (u.v5_migrated_at IS NOT NULL) AS on_v5,
            o.id::text AS org_id, o.name AS org_name, om.org_role,
            o.status AS org_status, om.billing_enabled AS org_billing_enabled,
            om.billing_delegate AS org_billing_delegate
       FROM users u
       LEFT JOIN user_subscriptions us
         ON us.user_id = u.id AND us.status = 'active' AND us.period_end > NOW()
       LEFT JOIN org_memberships om
         ON om.user_id = u.id AND om.status = 'active'
       LEFT JOIN orgs o ON o.id = om.org_id
      WHERE u.id = $1`,
    [user.id],
  );
  if (r.rows.length === 0 || r.rows[0].status !== "active") {
    // 用户 token 还有效但账号被删/封 → 401
    throw new HttpError(401, "UNAUTHORIZED", "user is not active");
  }
  const u = r.rows[0];
  // v3→v5 迁移路由(对称于 v3 handleMe):已迁移用户刷新 oc_v5user cookie(路由维持在 v5);
  // 若一个仍带 oc_v5user cookie 的用户其实已被回滚(on_v5=false)命中到 v5,清除 cookie →
  // 下个请求 Caddy 路由回 v3。使回滚无需用户手动清 cookie。cookie 名 oc_v5user 与 canary
  // 的 oc_v5=<secret> 分离,互不清除。
  if (u.on_v5) {
    appendSetCookie(res, "oc_v5user=1; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax");
  } else {
    appendSetCookie(res, "oc_v5user=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
  }
  // P3 cohort:/api/me 是"在线用户重评 lane"的主入口(页面加载 + 定期 session 校验都走它)。
  const lane = await resolveLaneAndApply(req, res, user.id, deps.refreshCookieSecure);
  sendJson(res, 200, {
    lane,
    user: {
      id: u.id,
      email: u.email,
      email_verified: u.email_verified,
      role: u.role,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      // credits = 总可用（前端余额气泡显示总额，向后兼容字段名）。
      credits: u.total_credits,
      wallet_credits: u.wallet_credits,
      period_credits: u.period_credits,
      created_at: u.created_at instanceof Date ? u.created_at.toISOString() : u.created_at,
      // 企业版(P3.1):org 归属。无 active 成员归属 → null。org suspended 仍返回(带 status)。
      org:
        u.org_id !== null
          ? {
              id: u.org_id,
              name: u.org_name,
              role: u.org_role,
              status: u.org_status,
              billing_enabled: u.org_billing_enabled,
              // §17.3 财务委派:前端据此把计费 UI 门从 owner 扩为 owner ∥ delegate。
              // owner 恒视为具备计费权(与 requireOrgRole 归一化一致)。
              billing_delegate: u.org_role === "owner" ? true : u.org_billing_delegate,
            }
          : null,
    },
  });
}

// ─── GET /api/public/config ─────────────────────────────────────────
// 公开路径(Phase 4A:前端 auth 模态启动时拉取)。仅暴露公开值:
//   - turnstile_site_key:Cloudflare 站点公钥,前端 widget 注册时必需
//   - turnstile_bypass:dev/CI 是否允许占位 token
//   - require_email_verified:布尔,影响登录前是否拦截 + 注册成功后是否提示去查邮箱
//   - feature_remote_ssh:FEATURE_REMOTE_SSH 灰度状态
//   - allow_registration:是否允许新用户注册;前端据此显示 banner / 关停 register tab
// 未来扩展(brand_name / contact / commercial_enabled tier 等)在此追加,但绝不放
// secrets/server-side flags(避免给攻击者侦察 surface)。
// 不限流、不验证;`allow_registration` 走 system_settings,加了 5s in-memory cache,
// 匿名公开热路径不直打 DB,admin 改动最坏延迟 5 秒生效。

// 5s 短 TTL cache。允许 admin PUT 后短暂不一致,换匿名 /api/public/config 极快。
// 不做 cross-process 失效(每个 worker 独立),改动后所有 worker 在 5s 内自然收敛。
let _allowRegCache: { value: boolean; expiresAt: number } | null = null;
const _ALLOW_REG_CACHE_TTL_MS = 5_000;

async function _readAllowRegistrationCached(): Promise<boolean> {
  const now = Date.now();
  if (_allowRegCache && _allowRegCache.expiresAt > now) {
    return _allowRegCache.value;
  }
  const r = await getSystemSetting("allow_registration");
  const value = r.value === true;
  _allowRegCache = { value, expiresAt: now + _ALLOW_REG_CACHE_TTL_MS };
  return value;
}

/** 测试专用:清掉 cache,让下一次读 DB。production 代码不应调用。 */
export function _resetAllowRegistrationCacheForTests(): void {
  _allowRegCache = null;
}

export async function handleGetPublicConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  // 2026-07-11:同 handleRegister,拆除 v5 channel bypass(v3 已下线),system_settings
  // 是唯一权威 —— 前端注册入口可见性与后端 403 门必须同源,否则开关半生效。
  const allow_registration = await _readAllowRegistrationCached();
  sendJson(res, 200, {
    turnstile_site_key: deps.turnstileSiteKey ?? "",
    // turnstile_bypass=true → 前端可直接发"占位 token",dev/CI 用;生产必须 false
    // (生产开这个键会被 config.ts 的危险开关扫描 fail-closed 拦在启动期)。
    // **刻意只反映全局旁路,绝不掺入账号级白名单** —— 这个字段在**登录之前**下发,
    // 那时服务端还不知道来访者是谁;若让它随白名单变真,等于把"哪些账号可绕过"
    // 泄露给任意匿名请求,并且真实用户的 widget 也会被误关。账号级放行只发生在
    // 服务端(resolveTurnstileBypass),前端在生产下永远渲染真 widget。
    // 前端据此决定渲染真 widget 还是走占位 token。两种情况都要 true:
    //   ① dev/CI 的全局测试旁路;② 产品配置显式不强制(TURNSTILE_ENFORCE=0)。
    // 否则会出现"服务端不校验、前端却卡在 widget 上"的最坏组合。
    turnstile_bypass: deps.turnstileBypass === true || deps.turnstileEnforce === false,
    require_email_verified: deps.requireEmailVerified === true,
    // FEATURE_REMOTE_SSH 灰度状态 —— 前端据此决定是否渲染执行环境切换器。
    feature_remote_ssh: deps.remoteSshEnabled === true,
    feature_image2: process.env.OC_IMAGE2_ENABLED === "true",
    // system_settings.allow_registration 透传给前端。关停时前端要:
    //   1) 在 register tab 展示 banner + disable 表单 + 不挂 Turnstile
    //   2) 在 login tab 隐藏"立即注册"导航链接(LDC SSO 按钮保留 — 老用户登录用)
    // 后端 /api/auth/register + LDC callback 已有独立强制,这里只是体验侧门。
    allow_registration,
  });
}

// ─── GET /api/public/models ─────────────────────────────────────────
// 公开路径,不限流、不需要登录;返回启用模型的公开视图(含 per-ktok 积分估价)。
//
// **投影权威 = model_catalog(方案 §6;MAJOR-5 收口 2026-07-12)**。此前这里走
// PricingCache.listPublic/listForUser + findRouteProviderForModel 推断 provider 归属 ——
// 那是 legacy 投影:①可用性来自 pricing 的派生镜像语义而非 catalog.state;②supported_efforts
// 来自 protocol 静态 modelReasoningPolicy 而非 catalog 的 capability_profile;③provider 归属
// 靠 route registry 的名字前缀推断,catalog 里自定义 provider_id 的行会被推断错 → degraded
// 注解打在错误的模型上。现在三者全部改由 fenced catalog snapshot + pricing join 派生:
//   · 行集 = snapshot.listForUser(scope) = active ∧ 有价 ∧ (public ∨ granted)
//     → **staged / retired / disabled / 无价行恒不出现**;alias 不是独立条目(只归一,不成行)。
//   · supported_efforts / provider_id 取 catalog;价格取同一事务读进来的 pricing 行。
//   · degraded 按 catalog 的 provider_id 查 provider 健康(只注解不过滤,UX 红线)。
//
// catalog 未注入(装配未接线 / 单测)→ 退回 legacy 投影(下方 legacy 分支),语义与本批次前一致。

export async function handleListPublicModels(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.pricing && !deps.modelCatalog) {
    throw new HttpError(503, "PRICING_NOT_READY", "pricing cache not initialized");
  }
  // 0049/0050:登录用户走 per-uid 投影(visibility OR grants 语义),
  //          匿名 / 无 token / 过期 token 走 public 投影。
  // **不**对 token 失败抛 401:这是公开端点,即便 token 过期也允许列模型,
  // 退化到 public 视图(避免每次登录态过期就 401 把前端 model 列表打没)。
  // jwt 解析走 sync 校验(同 router.ts 的 verifyCommercialJwtSync 路径),
  // 失败/过期/未提供 token 都视作匿名;不验 DB(只读 + 失败兜底由 grants 空集合保护)。
  const authHeader = req.headers.authorization;
  let token = "";
  if (typeof authHeader === "string") {
    token = authHeader.replace(/^Bearer\s+/i, "").trim();
  }
  const claims = token ? verifyCommercialJwtSync(token, deps.jwtSecret) : null;
  // 0108 provider 健康度:degraded provider 的模型附 degraded:true(**只注解不过滤**;
  // 前端标「暂不可用」+ 禁选)。fail-soft:读失败返回空集 → 不误标降级(UX 红线)。
  const degraded = await getDegradedProviders();

  if (deps.modelCatalog) {
    // fence 后取快照(与 /internal/v3/model-catalog 同一道消费契约):admin 刚 disable 的模型
    // 不能还挂在前端选择器里被点。unknown / DB 不可达 → 503(fail-closed;**不**回落 legacy
    // 投影 —— 那会让"第二套判定源"在故障窗口悄悄复活,正是本次收口要消灭的东西)。
    //
    // **纯展示面微缓存(方案 §1.2 明许)**:本端点**匿名且不限流**,逐请求直读 epoch 会把
    // "以前零 DB 查询的匿名路径"变成可被放大的 DB 打点。fence 的"零 stale 窗口"铁律只约束
    // **安全/计费面**(签发/preCheck/journal/egress 每请求);展示面晚 ≤2s 看到 disable 无
    // 金钱/授权后果(真正的执行闸在 bridge 签发与 egress fence,前端点了也跑不了)。
    let snapshot: ModelCatalogSnapshot;
    try {
      // 微缓存不可用(测试 double / 非 cache 实现)→ 退回严格 fence(更保守,不放宽)。
      snapshot = deps.modelCatalog.assertFreshCached
        ? await deps.modelCatalog.assertFreshCached(PUBLIC_MODELS_FENCE_TTL_MS)
        : await deps.modelCatalog.assertFresh();
    } catch (err) {
      const unknown = err instanceof CatalogUnknownError;
      rootLogger
        .child({ subsys: "publicModels" })
        .error("catalog_unavailable", {
          unknown,
          err: (err as Error)?.message ?? String(err),
        });
      throw new HttpError(503, "MODEL_CATALOG_UNAVAILABLE", "model catalog unavailable");
    }
    const effective = claims
      ? await loadPublicModelScope(deps, claims, snapshot.securityEpoch)
      : anonymousModelScope();
    sendJson(res, 200, { models: projectPublicModels(snapshot, effective, degraded) });
    return;
  }

  // ── legacy 投影(catalog 未接线)────────────────────────────────────────
  const pricing = deps.pricing!;
  const scope = claims ? await loadPublicModelScope(deps, claims) : null;
  const models = scope
    ? pricing.listForUser(scope)
    : pricing.listPublic();
  sendJson(res, 200, { models: annotateDegraded(models, degraded) });
}

function anonymousModelScope(): UserModelScope {
  return {
    uid: 0,
    role: "user",
    grantedModelIds: new Set<string>(),
  };
}

async function loadPublicModelScope(
  deps: CommercialHttpDeps,
  claims: CommercialJwtClaims,
  requiredEpoch?: bigint,
): Promise<UserModelScope> {
  if (deps.loadUserModelAuthz) {
    const authz = await deps.loadUserModelAuthz(BigInt(claims.sub), requiredEpoch);
    return {
      uid: claims.sub,
      role: authz.role,
      grantedModelIds: authz.grantedModelIds,
      deniedModelIds: authz.deniedModelIds,
    };
  }
  const { listGrantsForUser } = await import("../admin/modelGrants.js");
  const grants = await listGrantsForUser(claims.sub);
  return {
    uid: claims.sub,
    role: claims.role,
    grantedModelIds: new Set(grants.map((g) => g.model_id)),
  };
}

/** `/api/public/models` 的 catalog 投影行:PublicModel + catalog 的 provider 归属(方案 §6)。 */
export interface PublicModelProjection extends PublicModel {
  /** catalog.provider_id(engine='codex' 的虚拟条目也有值;null = 未归属静态 provider)。 */
  provider_id: string | null;
}

/**
 * active catalog + pricing join → 公共/用户投影(单一权威;不经 PricingCache)。
 *
 * 价格来自快照里随 catalog 同一个 REPEATABLE READ 事务读进来的 pricing 行 —— 与
 * `snapshot.listForUser` 的行集天然一致(不会出现"catalog 说有、pricing 说无"的半行)。
 */
function projectPublicModels(
  snapshot: ModelCatalogSnapshot,
  scope: UserModelScope,
  degraded: ReadonlySet<string>,
): PublicModelProjection[] {
  const out: PublicModelProjection[] = [];
  for (const row of snapshot.listForUser(scope)) {
    // listForUser 已保证可路由(有价);这里 get 只是取值,理论不可能 miss。
    const p = snapshot.pricing.get(row.modelId);
    if (!p) continue;
    out.push({
      id: row.modelId,
      display_name: row.displayName,
      input_per_ktok_credits: perKtokCredits(p.inputPerMtok, p.multiplier),
      output_per_ktok_credits: perKtokCredits(p.outputPerMtok, p.multiplier),
      cache_read_per_ktok_credits: perKtokCredits(p.cacheReadPerMtok, p.multiplier),
      cache_write_per_ktok_credits: perKtokCredits(p.cacheWritePerMtok, p.multiplier),
      multiplier: p.multiplier,
      supported_efforts: [...row.supportedEfforts],
      provider_id: row.providerId,
      ...(row.providerId && degraded.has(row.providerId) ? { degraded: true } : {}),
    });
  }
  return out;
}

/**
 * **legacy 分支专用**(catalog 未接线时)。给受影响模型注解 degraded:true —— 归属靠
 * route registry 推断(findRouteProviderForModel),catalog 自定义 provider_id 的行会推断错;
 * catalog 接线后走 projectPublicModels 的 provider_id 归属,不再经过这里。
 */
function annotateDegraded(models: PublicModel[], degraded: ReadonlySet<string>): PublicModel[] {
  if (degraded.size === 0) return models;
  return models.map((m) => {
    const pid = findRouteProviderForModel(m.id)?.id;
    return pid && degraded.has(pid) ? { ...m, degraded: true } : m;
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
  const { getAutoDreamFeature } = await import("../user/autoDream.js");
  const snap = await getPreferences(user.id);
  const autoDream = await getAutoDreamFeature(
    user.id,
    snap.prefs.auto_dream_enabled === true,
    snap.prefs.auto_optimizer_enabled === true,
  );
  sendJson(res, 200, { ...snap, features: { auto_dream: autoDream } });
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
  const requestedAutoDream = (body as Record<string, unknown>).auto_dream_enabled;
  const requestedOptimizer = (body as Record<string, unknown>).auto_optimizer_enabled;
  if (requestedAutoDream === true || requestedOptimizer === true) {
    const { getAutoDreamFeature } = await import("../user/autoDream.js");
    const feature = await getAutoDreamFeature(user.id, true);
    if (!feature.eligible) {
      throw new HttpError(403, "AUTO_DREAM_MAX_REQUIRED", "Auto-Dream requires Max or above");
    }
    if (!feature.available) {
      throw new HttpError(503, "AUTO_DREAM_UNAVAILABLE", "Auto-Dream model is unavailable");
    }
  }
  const { normalizeAutoDreamPreferencePatch } = await import("../user/autoDream.js");
  const effectiveBody = normalizeAutoDreamPreferencePatch(body as Record<string, unknown>);
  // V2 and V1 are mutually exclusive. Turning on V2 first turns the legacy
  // auto-mutating path off, so rolling back to an older runtime remains safe.
  const { patchPreferences, PreferencesError } = await import("../user/preferences.js");
  try {
    const snap = await patchPreferences(user.id, effectiveBody);
    const { getAutoDreamFeature } = await import("../user/autoDream.js");
    const autoDream = await getAutoDreamFeature(
      user.id,
      snap.prefs.auto_dream_enabled === true,
      snap.prefs.auto_optimizer_enabled === true,
    );
    sendJson(res, 200, { ...snap, features: { auto_dream: autoDream } });
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

// ─── QQ Official Bot binding ─────────────────────────────────────────────

export async function handleGetMyQqBinding(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const [{ getPool }, { readQqBotConfig }, { getQqBindingView }] = await Promise.all([
    import("../db/index.js"),
    import("../qqbot/config.js"),
    import("../qqbot/store.js"),
  ]);
  const config = readQqBotConfig();
  if (!config) {
    sendJson(res, 200, { available: false, bound: false });
    return;
  }
  const view = await getQqBindingView(getPool(), user.id);
  sendJson(res, 200, {
    available: true,
    entry_url: config.entryUrl,
    ...view,
  });
}

export async function handleStartMyQqBinding(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const [{ getPool }, { readQqBotConfig }, { createBindCode }] = await Promise.all([
    import("../db/index.js"),
    import("../qqbot/config.js"),
    import("../qqbot/store.js"),
  ]);
  const config = readQqBotConfig();
  if (!config) {
    throw new HttpError(503, "QQ_BOT_UNAVAILABLE", "QQ Bot is not configured");
  }
  const token = await createBindCode(
    getPool(),
    user.id,
    config.bindingHmacSecret,
  );
  sendJson(res, 200, {
    available: true,
    entry_url: config.entryUrl,
    bind_code: token.code,
    expires_at: token.expiresAt,
  });
}

export async function handleDeleteMyQqBinding(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const [{ getPool }, { unbindQq }] = await Promise.all([
    import("../db/index.js"),
    import("../qqbot/store.js"),
  ]);
  const unbound = await unbindQq(getPool(), user.id);
  sendJson(res, 200, { ok: true, unbound });
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
    // 4) sessions 分页:按「归组键」GROUP BY,稳定排序,LIMIT+1 探 has_more。
    //
    //    归组键(0104 delegate 计费打标的读侧收口):
    //      - mode='delegate' 且 parent_session_id 非空 → parent_session_id
    //        (父**客户端**会话 id,web*)—— delegate 子会话的引擎 UUID 行不再
    //        散落成无名行,并入"一次组队"的父会话行;若父会话自己的行与该键
    //        同键(写侧未来对齐客户端会话 id 时)则自然合并。
    //      - 其余(chat / parent 缺失的 delegate 孤儿行)→ session_id,
    //        与旧行为逐字节一致;孤儿 delegate 行退化为独立行,靠 delegate_only 标注。
    //    delegate_credits / delegate_requests = 组内 delegate 行小计(FILTER),
    //    delegate_only = 组内全为 delegate 行(孤儿行 / 纯组队归组)。
    //
    //    ⚠️ GROUP BY 1 / ORDER BY 1 必须用位置引用:输出别名与源列同名
    //    (session_id),按名引用 PG 会解析回源列,分组退化成旧语义。
    query<{
      session_id: string;
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      billed_credits: string;
      delegate_credits: string;
      delegate_requests: string;
      delegate_only: boolean;
      last_used_at: Date;
    }>(
      `SELECT COALESCE(
                CASE WHEN mode = 'delegate' THEN parent_session_id END,
                session_id
              )                                          AS session_id,
              COUNT(*)::bigint::text                     AS requests,
              COALESCE(SUM(input_tokens),0)::text        AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text       AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text   AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0)::text  AS cache_write_tokens,
              COALESCE(SUM(cost_credits),0)::text        AS billed_credits,
              COALESCE(SUM(cost_credits) FILTER (WHERE mode = 'delegate'),0)::text
                                                         AS delegate_credits,
              COUNT(*) FILTER (WHERE mode = 'delegate')::bigint::text
                                                         AS delegate_requests,
              bool_and(mode = 'delegate')                AS delegate_only,
              MAX(created_at)                            AS last_used_at
         FROM usage_records
        WHERE user_id = $1 AND status = 'success' AND session_id IS NOT NULL
        GROUP BY 1
        ORDER BY MAX(created_at) DESC, 1 DESC
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

  // ── delegate 明细:仅取当前页中含 delegate 行的归组键(纯 chat 用户零开销)──
  //    键表达式与查询 4 的归组键对 delegate 行完全一致:
  //    COALESCE(parent_session_id, session_id)。按 (agent, model) 分桶,
  //    组内按积分降序 —— 前端展开明细直接按序渲染。
  type DelegateDetail = {
    delegate_agent_id: string | null;
    model: string;
    requests: string;
    billed_credits: string;
  };
  const delegatesByKey = new Map<string, DelegateDetail[]>();
  const delegateKeys = rowsPage
    .filter((r) => r.delegate_requests !== "0")
    .map((r) => r.session_id);
  if (delegateKeys.length > 0) {
    const detail = await query<DelegateDetail & { session_key: string }>(
      `SELECT COALESCE(parent_session_id, session_id) AS session_key,
              delegate_agent_id,
              model,
              COUNT(*)::bigint::text                  AS requests,
              COALESCE(SUM(cost_credits),0)::text     AS billed_credits
         FROM usage_records
        WHERE user_id = $1 AND status = 'success' AND mode = 'delegate'
          AND session_id IS NOT NULL
          AND COALESCE(parent_session_id, session_id) = ANY($2::text[])
        GROUP BY 1, 2, 3
        ORDER BY 1, SUM(cost_credits) DESC, 2 NULLS LAST, 3`,
      [uid, delegateKeys],
    );
    for (const d of detail.rows) {
      const list = delegatesByKey.get(d.session_key) ?? [];
      list.push({
        delegate_agent_id: d.delegate_agent_id,
        model: d.model,
        requests: d.requests,
        billed_credits: d.billed_credits,
      });
      delegatesByKey.set(d.session_key, list);
    }
  }

  const sessions = rowsPage.map((r) => {
    const delegates = delegatesByKey.get(r.session_id);
    return {
      session_id: r.session_id,
      requests: r.requests,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      billed_credits: r.billed_credits,
      last_used_at: r.last_used_at.toISOString(),
      // 0104 delegate 归组附加字段(纯增量,不改既有字段语义):
      delegate_credits: r.delegate_credits,
      delegate_requests: r.delegate_requests,
      delegate_only: r.delegate_only,
      ...(delegates && delegates.length > 0 ? { delegates } : {}),
    };
  });

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

/**
 * GET /api/me/usage/report?window=24h|7d|30d —— 个人版用量报表(前端画图表用)。
 *
 * 与 GET /api/me/usage 同鉴权(requireAuth,JWT sub → user_id,无 IDOR)。响应形态对齐
 * 企业版 GET /api/org/usage(summary + 趋势 + 按模型 + 流水),数据层见 billing/usageReport.ts;
 * 窗口/桶语义复用 org/orgReports.ts 的 WINDOW_SPEC / trendBuckets(单一权威)。
 *
 * window 缺省 7d;显式传值必须命中白名单,否则 400(不静默兜底,避免前端窗口切换失灵被吞)。
 * 错误码沿用同族个人端点的 INVALID_USAGE_QUERY。
 */
export async function handleGetMyUsageReport(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const raw = url.searchParams.get("window");
  let window: UsageWindow = "7d";
  if (raw !== null && raw !== "") {
    if (!isUsageWindow(raw)) {
      throw new HttpError(400, "INVALID_USAGE_QUERY", "window must be 24h, 7d or 30d");
    }
    window = raw;
  }
  const report = await getUserUsageReport(user.id, window);
  sendJson(res, 200, report);
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
//   - 完全不带 Bearer → 匿名；显式提供无效/过期 Bearer → 401，让登录前端刷新后重放，
//     避免把已登录用户的反馈静默记成匿名。
// 限流 5/min/IP。description trim 后非空且 ≤10000，meta 必须为 object 且 JSON ≤ 8KB。
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

  // **仅 Bearer 关联 user_id**(Codex 审:cookie 关联会被 CSRF 误绑)。缺 header 仍允许匿名；
  // 但只要调用方显式给了 Authorization，校验失败就必须 401，供 callWithRefresh 恢复身份。
  const authorization = req.headers.authorization;
  const authHeader = authorization?.replace(/^Bearer\s+/, "") ?? "";
  let userId: string | null = null;
  if (authorization) {
    const claims = verifyCommercialJwtSync(authHeader, deps.jwtSecret);
    if (!claims) throw new HttpError(401, "UNAUTHORIZED", "invalid or expired access token");
    userId = claims.sub;
  }

  const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "VALIDATION", "invalid body");
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (description.length === 0) {
    throw new HttpError(400, "VALIDATION", "请填写反馈内容", {
      issues: [{ path: "description", message: "required" }],
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
  let requestId = strField(body.request_id, 128);
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

  if (!userId) {
    requestId = null;
  } else if (requestId) {
    const owned = await query<{ trace_id: string }>(
      `SELECT trace_id
         FROM turn_traces
        WHERE trace_id=$1
          AND user_id=$2::bigint
          AND (
            $3::text IS NULL
            OR session_key LIKE '%:webchat:dm:' || regexp_replace($3, '[^a-zA-Z0-9_-]', '_', 'g')
          )
        LIMIT 1`,
      [requestId, userId, sessionId],
    );
    requestId = owned.rows[0]?.trace_id ?? null;
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
//   - `GET  /api/media-signed?t=` → 验签 + DB active(user/admin)+ 容器路径
//     (旧 `p=&u=&e=&s=` URL 仍兼容校验到过期)
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
    const inboxAssetId = inboxAssetIdFromPath(p);
    if (inboxAssetId) {
      if (await canAccessInboxAsset(verified.id, verified.role, inboxAssetId)) {
        const { url } = buildOpaqueInboxAssetUrl(
          deps.mediaSignKey,
          inboxAssetId,
          userId,
          DEFAULT_SIGN_TTL_MS,
        );
        urls[p] = url;
      }
      continue;
    }
    // 内容寻址媒体(`/api/media/<file>`)与容器绝对路径共用同一签名端点,只是转发目标不同。
    // 存库历史消息里的裸 `/api/media/` URL 在渲染时经此归一为签名 URL,零数据迁移。
    const mediaFile = extractApiMediaFilename(p);
    if (mediaFile) {
      const { url } = buildOpaqueMediaFileUrl(deps.mediaSignKey, mediaFile, userId, DEFAULT_SIGN_TTL_MS);
      urls[p] = url;
      continue;
    }
    let resolved: string;
    try {
      resolved = resolvePath(p);
    } catch {
      continue;
    }
    if (!isContainerPathAllowed(resolved)) continue;
    // sign 用 raw 输入 path(handler 端 decoded 后做 HMAC,verify 端
    // decodeURIComponent 后再算 HMAC,canonicalization 一致)
    const { url } = buildOpaqueSignedUrl(deps.mediaSignKey, p, userId, DEFAULT_SIGN_TTL_MS);
    urls[p] = url;
  }
  sendJson(res, 200, { urls, expMs });
}

/**
 * GET /api/media-signed?t=<opaque>
 *
 * 公开端点(无需 cookie / Bearer),由 opaque 加密 token + 过期戳自证身份。
 * 验签通过 → 当作 `/api/file?path=<decodedPath>` 走 containerFileProxy。
 *
 * 不查 DB?——查。即使签 URL 时是 active,签后可能被 ban → 不能因 signed URL 还
 * 在 TTL 内就漏放。`requireActiveAccountVerifyDb(sub, ['user','admin'], pool)`
 * 双检 role 与 status=active。
 *
 * Cache-Control:仅当上游容器返 200/206 + 签名未过期 → private, max-age=剩余 TTL。
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
  const t = url.searchParams.get("t");
  const u = url.searchParams.get("u");
  const e = url.searchParams.get("e");
  const s = url.searchParams.get("s");
  const pRaw = extractRawQueryParam(req.url ?? "", "p");

  const result = verifySignedUrl(deps.mediaSignKey, { t, pRaw, u, e, s });
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
  const { userId, expMs, decodedPath, mediaKind } = result;

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

  // 站内信图片由 master PG 直接出字节，不触发容器 provision。签名只证明 URL 未篡改；
  // 每次 GET 仍按当前消息可见性复核，所以消息删除/过期会让尚在 TTL 内的 URL 立即失效。
  if (mediaKind === "inbox") {
    const parsedWidth = parseThumbnailWidth(url.searchParams.get("w"));
    if (parsedWidth.kind === "invalid") {
      throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-w");
    }
    const asset = await readInboxAssetForViewer(verified.id, verified.role, decodedPath);
    if (!asset) {
      throw new HttpError(403, "FORBIDDEN", "inbox asset is no longer visible");
    }
    const remainSec = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
    const ageSec = Math.min(240, remainSec);
    const cacheControl = ageSec > 0 ? `private, max-age=${ageSec}` : undefined;

    if (parsedWidth.kind === "width" && deps.thumbnailCache) {
      const cacheKey = thumbnailCacheKey({
        userId,
        mediaKind,
        decodedPath,
        width: parsedWidth.width,
      });
      const cached = await deps.thumbnailCache.get(cacheKey);
      if (cached) {
        sendMediaBytes(res, cached.buffer, "image/webp", cacheControl);
        return;
      }
      try {
        const thumbnail = await resizeToWebpThumbnail(asset.data, parsedWidth.width);
        await deps.thumbnailCache.put(cacheKey, thumbnail);
        sendMediaBytes(res, thumbnail, "image/webp", cacheControl);
        return;
      } catch {
        // 数据入库时已做过 sharp 归一化；缓存/缩略偶发失败时回原图，不把正文渲染打断。
      }
    }
    sendMediaBytes(res, asset.data, asset.mimeType, cacheControl);
    return;
  }

  // Path/filename sanity check —— **不是 ACL**,真正访问控制由容器内 handler 做
  // (realpathSync + agentCwds + blocklist + fd recheck / uploads·generated 双目录 + tenant scope)。
  // 这里只挡明显扫描 / 注入形态。mediaKind 决定转发到容器的哪个端点:
  //   - 'media':decodedPath = 内容寻址文件名 → `/api/media/<file>`(双目录搜索,保留 /api/media 语义)
  //   - 'file' :decodedPath = 容器绝对路径   → `/api/file?path=`(粗白名单到 `/home/agent/...`)
  let forwardPath: string;
  if (mediaKind === "media") {
    if (!isMediaFilenameAllowed(decodedPath)) {
      throw new HttpError(403, "FORBIDDEN", "signed URL media filename not authorized");
    }
    forwardPath = `/api/media/${encodeURIComponent(decodedPath)}`;
  } else {
    let resolved: string;
    try {
      resolved = resolvePath(decodedPath);
    } catch {
      throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-path");
    }
    if (!isContainerPathAllowed(resolved)) {
      throw new HttpError(403, "FORBIDDEN", "signed URL path not authorized");
    }
    forwardPath = `/api/file?path=${encodeURIComponent(decodedPath)}`;
  }

  // ─── 缩略图分级(w 白名单枚举;w 是渲染参数,不进签名,验签后应用)──────────
  // 气泡缩略请求 ?w=640/1280;灯箱/查看器/编辑器/下载取原图(无 w)。非白名单 w → 400
  // (防攻击者用任意值撑爆缓存 / 打 sharp CPU)。thumbnailCache 未注入 → 忽略 w 回原图(降级)。
  const parsedWidth = parseThumbnailWidth(url.searchParams.get("w"));
  if (parsedWidth.kind === "invalid") {
    throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-w");
  }
  const thumbWidth =
    parsedWidth.kind === "width" && deps.thumbnailCache ? parsedWidth.width : null;

  // 缩略 Cache-Control:private, max-age = min(剩余 TTL, 240s)(与原图流式同口径)。
  const thumbCacheControl = (): string | undefined => {
    const remainSec = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
    const ageSec = Math.min(240, remainSec);
    return ageSec > 0 ? `private, max-age=${ageSec}` : undefined;
  };

  // 缩略缓存**命中** → 直接从 master 磁盘出字节:零容器/docker/tunnel 往返(最大提速面),
  // 且不触 ensureContainerReady(命中无需容器活着)。DB active 已在上方校验,足够。
  if (thumbWidth != null && deps.thumbnailCache) {
    const key = thumbnailCacheKey({ userId, mediaKind, decodedPath, width: thumbWidth });
    const cached = await deps.thumbnailCache.get(key);
    if (cached) {
      sendMediaBytes(res, cached.buffer, "image/webp", thumbCacheControl());
      return;
    }
  }

  // v1.0.191 冷启动护栏 —— 见 CommercialHttpDeps.ensureContainerReady JSDoc。
  // 位置在 path sanity + 缩略缓存命中之后:被拒/命中的请求不应触发 provision
  // (浪费 docker 资源 + 给 supervisor 假需求)。装配端的 per-uid singleflight 负责合并
  // 同页多图并发,这里只做"调用 + 错误映射"。
  if (deps.ensureContainerReady) {
    try {
      await deps.ensureContainerReady(BigInt(sub));
    } catch (err) {
      if (err instanceof ContainerUnreadyError) {
        // 503 + Retry-After + 默认 no-store(sendJson 自动加)。
        // <img> 不会自动重试 503;Cache-Control 主要价值是防 CF / 浏览器缓存失败响应;
        // Retry-After 给 fetch / SW / 前端接管路径用。
        sendJson(
          res,
          503,
          {
            error: {
              code: "CONTAINER_UNREADY",
              message: `container not ready: ${err.reason}`,
              retry_after_sec: err.retryAfterSec,
              request_id: _ctx.requestId,
            },
          },
          { "Retry-After": err.retryAfterSec },
        );
        return;
      }
      // 其他 error(supervisor 抖 / DB / docker daemon 不可达 ...)— 不暴露根因
      _ctx.log.warn("handle_media_signed_ensure_container_failed", {
        uid: sub,
        err: (err as Error)?.message ?? String(err),
      });
      throw new HttpError(503, "CONTAINER_NOT_RUNNING", "container ensure failed");
    }
  }

  // 共享:把 forwardPath 喂给 containerFileProxy(容器取字节**唯一权威**)。resLike 可为真
  // ServerResponse(原图流式)或 BufferingResponseSink(缩略缓冲)。containerFileProxy 内部
  // 从 req.url 解析 path,故 try/finally swap req.url。file kind → `/api/file?path=...`;
  // media kind → `/api/media/<file>`(forwardPath 已按 mediaKind 定好)。
  const log = (_ctx).log;
  const requestId = _ctx.requestId;
  const ctxForProxy: RequestContext = {
    requestId,
    clientIp: _ctx.clientIp,
    authBoundIp: _ctx.authBoundIp,
    userAgent: _ctx.userAgent,
    log,
  };
  const v3Supervisor = deps.v3Supervisor;
  const bridgeSecret = deps.bridgeSecret;
  const runProxy = async (
    resLike: ServerResponse,
    cacheOverride?: (upstreamStatus: number) => string | null,
  ): Promise<void> => {
    const originalUrl = req.url;
    req.url = forwardPath;
    try {
      const selfHostIdForProxy = v3Supervisor.selfHostId;
      await containerFileProxy(
        req,
        resLike,
        ctxForProxy,
        {
          v3: v3Supervisor,
          bridgeSecret,
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
          responseCacheControlOverride: cacheOverride,
        },
        BigInt(sub),
      );
    } finally {
      req.url = originalUrl;
    }
  };

  // Cache-Control 覆盖(原图流式路径):仅 200/206 → private, max-age = min(剩余 TTL, 240s)。
  const cacheControlOverride = (upstreamStatus: number): string | null => {
    if (upstreamStatus !== 200 && upstreamStatus !== 206) return null;
    const remainSec = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
    const ageSec = Math.min(240, remainSec);
    if (ageSec <= 0) return null;
    return `private, max-age=${ageSec}`;
  };

  // 缩略缓存 miss:经 sink 缓冲原图 → renderThumbnail(resize webp / 透传 / 降级)→ 出字节。
  if (thumbWidth != null && deps.thumbnailCache) {
    const sink = new BufferingResponseSink(THUMBNAIL_MAX_SOURCE_BYTES);
    await runProxy(sink as unknown as ServerResponse);
    const cap = await sink.completion;
    const rendered = await renderThumbnail(cap, {
      cache: deps.thumbnailCache,
      cacheKey: thumbnailCacheKey({ userId, mediaKind, decodedPath, width: thumbWidth }),
      width: thumbWidth,
    });
    switch (rendered.kind) {
      case "bytes":
        sendMediaBytes(res, rendered.body, rendered.contentType, thumbCacheControl());
        return;
      case "passthrough-error":
        // 上游非 200(403/404/410/503/JSON error)原样回放,不缓存。
        res.writeHead(rendered.statusCode, rendered.headers);
        res.end(rendered.body);
        return;
      case "stream-original":
        // 原图超 32MiB 不缩:回退成原图流式(第二次取字节,罕见)。
        await runProxy(res, cacheControlOverride);
        return;
      case "upstream-error":
        // 已发头后 upstream 中断(缓冲不完整)→ 502,永不出损坏/半截字节。
        _ctx.log.warn("handle_media_signed_thumbnail_upstream_error", { uid: sub });
        throw new HttpError(502, "BAD_GATEWAY", "thumbnail upstream error");
    }
    return;
  }

  // 原图流式(灯箱/查看器/编辑器/下载):既有路径,直接把 res 交给 proxy。
  await runProxy(res, cacheControlOverride);
}

/**
 * 出字节到真 ServerResponse:统一 200 + Content-Type + 正确 Content-Length +
 * inline disposition + Vary。缩略命中/miss 出字节共用。cacheControl 缺省 no-store。
 */
function sendMediaBytes(
  res: ServerResponse,
  body: Buffer,
  contentType: string,
  cacheControl?: string,
): void {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Content-Disposition": "inline",
    Vary: "Authorization, Cookie",
    "Cache-Control": cacheControl ?? "no-store",
  });
  res.end(body);
}

// ─── 用户文献库(research_documents 管理面,ManageCenter「文献库」tab)────────
//
// GET    /api/me/research/library          → 列表(元数据,权威 span 文本不外泄)
// POST   /api/me/research/library          → 上传原始字节入库(?filename=,≤25MiB,
//                                            复用容器路径同一 ingestBlob 铸造链)
// DELETE /api/me/research/library/:docId   → 删单篇(tenant 隔离)
//
// 数据逻辑在 research/library.ts;这里只做鉴权 + 参数/大小校验 + HTTP 形状。

export async function handleListResearchLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const { listLibraryDocuments } = await import("../research/library.js");
  const docs = await listLibraryDocuments(user.id);
  sendJson(res, 200, { documents: docs });
}

export async function handleDeleteResearchLibraryDoc(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const m = (req.url ?? "").match(/^\/api\/me\/research\/library\/([A-Za-z0-9_-]+)(?:\?|$)/);
  const docId = m?.[1] ?? "";
  if (!docId) throw new HttpError(400, "INVALID_DOC_ID", "docId required");
  const { deleteLibraryDocument } = await import("../research/library.js");
  const deleted = await deleteLibraryDocument(user.id, docId);
  if (!deleted) throw new HttpError(404, "NOT_FOUND", "document not found");
  sendJson(res, 200, { ok: true });
}

export async function handleUploadResearchLibraryDoc(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const { MAX_LIBRARY_UPLOAD_BYTES, uploadAndIngestDocument } = await import(
    "../research/library.js"
  );

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_LIBRARY_UPLOAD_BYTES) {
      throw new HttpError(413, "UPLOAD_TOO_LARGE", "document exceeds 25MiB limit");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new HttpError(400, "EMPTY_UPLOAD", "empty body");

  const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
  const rawName = new URL(req.url ?? "/", "http://x").searchParams.get("filename") ?? "";
  // 只取 basename 并限长:filename 仅用于抽取器猜格式/标题,不落盘,防路径注入。
  const filename = rawName ? rawName.replace(/[/\\]/g, "").slice(0, 200) : undefined;

  const outcome = await uploadAndIngestDocument(Number(user.id), bytes, mime, filename);
  if ("disabled" in outcome) {
    throw new HttpError(503, "RESEARCH_DISABLED", "research subsystem is disabled");
  }
  if (!outcome.ok) {
    if (outcome.needsOcr) {
      // 与容器 oc-ingest 同形状:扫描件无文字层 → 明确 needsOcr(前端展示可操作提示)。
      sendJson(res, 200, { needsOcr: true, reason: outcome.reason });
      return;
    }
    throw new HttpError(400, "INGEST_FAILED", outcome.reason);
  }
  sendJson(res, 200, outcome.outline);
}

// helper for tests / 其他 module
export { clientIpOf, userAgentOf };
