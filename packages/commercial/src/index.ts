/**
 * @openclaude/commercial — OpenClaude 商业化模块入口
 *
 * 启用方式:在 Gateway 中通过环境变量 COMMERCIAL_ENABLED=1 启用,
 * 然后在 gateway/src/server.ts 中条件挂载(见 docs/commercial/02-ARCHITECTURE §8)。
 *
 * T-02 起,本文件在挂载时会自动跑 schema migration(除非 COMMERCIAL_AUTO_MIGRATE=0)。
 * T-16 起,registerCommercial 还会:
 *   - 装配 redis 客户端(REDIS_URL,用于限流)
 *   - 实例化 HTTP 路由处理器,通过 result.handle 暴露给 gateway
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import IORedis from "ioredis";
import Docker from "dockerode";
import { runMigrations } from "./db/migrate.js";
import { closePool, getPool } from "./db/index.js";
import { loadConfig } from "./config.js";
import { stubMailer, createResendMailer } from "./auth/mail.js";
import { wrapIoredis } from "./middleware/rateLimit.js";
import { createCommercialHandler, type CommercialHandler } from "./http/router.js";
import { warmupLoginDummyHash } from "./auth/login.js";
import { PricingCache } from "./billing/pricing.js";
import { wrapIoredisForPreCheck } from "./billing/preCheck.js";
import { createHttpHupijiaoClient, type HupijiaoClient, type HupijiaoConfig } from "./payment/hupijiao/client.js";
import { AccountScheduler } from "./account-pool/scheduler.js";
import { AccountHealthTracker, wrapIoredisForHealth } from "./account-pool/health.js";
import { createAgentWsHandler, type AgentWsHandler } from "./ws/agent.js";
import {
  startLifecycleScheduler,
  checkAgentAccess,
  type LifecycleScheduler,
  type LifecycleLogger,
} from "./agent/index.js";
import type { AgentHttpDeps } from "./http/agent.js";
import { startAlertScheduler, type AlertScheduler } from "./admin/alerts.js";

/**
 * T-02: 是否在 registerCommercial 时自动执行 migrations。
 *
 * 规约:
 *   - 未设 / "" / "1" → true(默认开)
 *   - "0" → false(关)
 *   - 其他值(如 "true"/"false"/"yes"/"no")→ true,但打 warning,
 *     提示运维该值不会被识别为 "关",避免 "以为自己关掉了但其实没关" 的脚枪
 */
function shouldAutoMigrate(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (m) => {
    // eslint-disable-next-line no-console
    console.warn(m);
  },
): boolean {
  const raw = env.COMMERCIAL_AUTO_MIGRATE;
  if (raw === undefined || raw === "" || raw === "1") return true;
  if (raw === "0") return false;
  // 无法识别的值:运维最常见的失误是写成 "true"/"false"/"no" —— 我们继续
  // 执行 migration(默认开),但要 warn。坚持 "只有 0 才关" 的严格口径,
  // 但不让它 fail hard(和 COMMERCIAL_ENABLED 的严格枚举不同)。
  warn(
    `[commercial] COMMERCIAL_AUTO_MIGRATE=${JSON.stringify(raw)} not recognized; ` +
      "auto-migrate remains ON. Use exactly '0' to disable.",
  );
  return true;
}

export interface RegisterCommercialResult {
  /**
   * HTTP 处理器:gateway 在自身 handleHttp 入口前调用,
   * 返回 true 表示已处理完毕,gateway 不再继续路由。
   */
  handle: CommercialHandler;
  /**
   * WebSocket upgrade 处理器:gateway 在 HTTP server 的 `upgrade` 事件里调用。
   * 返回 true → commercial 已处理(可能是鉴权失败 + destroy,也可能是成功 upgrade);
   * 返回 false → 非 commercial 路由(如 `/ws`),gateway 自行处理。
   */
  handleWsUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** 关闭所有商业化资源(pool / redis / ws)。 */
  shutdown: () => Promise<void>;
}

/**
 * 注册商业化模块。
 *
 * 1. 校验 env(loadConfig)— 缺失/非法直接抛 ConfigError
 * 2. 自动跑 schema migrations(除非 COMMERCIAL_AUTO_MIGRATE=0)
 * 3. 装配 ioredis 客户端 + HTTP 处理器
 * 4. warmupLoginDummyHash 提前算 dummy argon2 hash(否则首个错登录请求要等 ~80ms)
 * 5. 返回 { handle, shutdown }
 *
 * @param app — gateway 应用对象;预留参数,目前未直接使用,以便后续 hook
 * @returns 包含 handle 和 shutdown 的对象
 */
export async function registerCommercial(
  app: unknown,
  options: {
    /** 测试可注入 jwt secret 而非从 env 读 */
    jwtSecret?: string | Uint8Array;
  } = {},
): Promise<RegisterCommercialResult> {
  void app;

  const cfg = loadConfig();

  if (shouldAutoMigrate()) {
    // eslint-disable-next-line no-console
    console.log("[commercial] auto-migrate: running...");
    const r = await runMigrations({
      // eslint-disable-next-line no-console
      onApply: (v) => console.log(`[commercial] auto-migrate applied ${v}`),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[commercial] auto-migrate done. applied=${r.applied.length} skipped=${r.skipped.length}`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log("[commercial] auto-migrate disabled (COMMERCIAL_AUTO_MIGRATE=0)");
  }

  const jwtSecret =
    options.jwtSecret ??
    process.env.COMMERCIAL_JWT_SECRET ??
    process.env.JWT_SECRET ??
    "";
  if (typeof jwtSecret === "string" && jwtSecret.length === 0) {
    throw new Error(
      "[commercial] COMMERCIAL_JWT_SECRET (or JWT_SECRET) must be set when COMMERCIAL_ENABLED=1",
    );
  }

  const redis = new IORedis(cfg.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  // 预热 dummy hash:第一次登录无影响
  await warmupLoginDummyHash();

  // T-20: 初始化定价缓存。启动时 load,并开启 LISTEN pricing_changed
  // 以便 admin UI 改价时自动 reload。两步失败都不阻塞启动,让 gateway
  // 继续上线;HTTP handler 在 cache 空时会返 503 PRICING_NOT_READY,
  // 而 pricing 热路径(T-21 计费)会直接得到 "unknown model" —— 比把
  // 整个服务卡死更好。
  const pricing = new PricingCache();
  try {
    await pricing.load();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commercial] pricing initial load failed:", err);
  }
  try {
    await pricing.startListener(cfg.DATABASE_URL);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commercial] pricing LISTEN setup failed:", err);
  }

  // T-24 虎皮椒:三件套齐全 → 生产 client;否则 undefined(handler 会 503)
  let hupijiao: HupijiaoClient | undefined;
  let hupijiaoConfig: Pick<HupijiaoConfig, "appId" | "appSecret"> | undefined;
  if (cfg.HUPIJIAO_APP_ID && cfg.HUPIJIAO_APP_SECRET && cfg.HUPIJIAO_CALLBACK_URL) {
    const fullCfg: HupijiaoConfig = {
      appId: cfg.HUPIJIAO_APP_ID,
      appSecret: cfg.HUPIJIAO_APP_SECRET,
      notifyUrl: cfg.HUPIJIAO_CALLBACK_URL,
      returnUrl: cfg.HUPIJIAO_RETURN_URL,
      endpoint: cfg.HUPIJIAO_ENDPOINT,
    };
    hupijiao = createHttpHupijiaoClient(fullCfg);
    hupijiaoConfig = { appId: fullCfg.appId, appSecret: fullCfg.appSecret };
  }

  const preCheckRedis = wrapIoredisForPreCheck(redis);

  // T-53: 装配 agent 运行时(image + seccomp + rpc dir + lifecycle scheduler)。
  // 任一必要字段缺失 → agentRuntime 置 undefined;/api/agent/open 返 503,/status 仍然可读。
  let agentRuntime: AgentHttpDeps | undefined;
  let lifecycleScheduler: LifecycleScheduler | undefined;
  const agentEnvStatus: Record<string, boolean> = {
    AGENT_IMAGE: !!cfg.AGENT_IMAGE,
    AGENT_NETWORK: !!cfg.AGENT_NETWORK,
    AGENT_PROXY_URL: !!cfg.AGENT_PROXY_URL,
    AGENT_SECCOMP_PATH: !!cfg.AGENT_SECCOMP_PATH,
    AGENT_RPC_SOCKET_DIR: !!cfg.AGENT_RPC_SOCKET_DIR,
  };
  const agentReady = Object.values(agentEnvStatus).every(Boolean);
  if (agentReady) {
    try {
      // Docker:走默认 socketPath 或 AGENT_DOCKER_SOCKET 覆盖
      const docker = cfg.AGENT_DOCKER_SOCKET
        ? new Docker({ socketPath: cfg.AGENT_DOCKER_SOCKET })
        : new Docker();
      // Seccomp profile 一次性读成字符串,后续 provision 直接用
      const seccompProfileJson = fs.readFileSync(cfg.AGENT_SECCOMP_PATH!, "utf8");
      // RPC socket 父目录启动时自愈:mkdir -p + 0700
      fs.mkdirSync(cfg.AGENT_RPC_SOCKET_DIR!, { recursive: true, mode: 0o700 });

      const agentLogger: LifecycleLogger = {
        info: (m, meta) => {
          // eslint-disable-next-line no-console
          console.log(m, meta ?? {});
        },
        warn: (m, meta) => {
          // eslint-disable-next-line no-console
          console.warn(m, meta ?? {});
        },
        error: (m, meta) => {
          // eslint-disable-next-line no-console
          console.error(m, meta ?? {});
        },
      };

      agentRuntime = {
        docker,
        image: cfg.AGENT_IMAGE!,
        network: cfg.AGENT_NETWORK!,
        proxyUrl: cfg.AGENT_PROXY_URL!,
        seccompProfileJson,
        rpcSocketHostDir: cfg.AGENT_RPC_SOCKET_DIR!,
        limits: {
          memoryMb: cfg.AGENT_MEMORY_MB,
          cpus: cfg.AGENT_CPUS,
          pidsLimit: cfg.AGENT_PIDS_LIMIT,
        },
        priceCredits: cfg.AGENT_PLAN_PRICE_CREDITS,
        durationDays: cfg.AGENT_PLAN_DURATION_DAYS,
        logger: agentLogger,
      };

      // Lifecycle scheduler:默认 1h tick,不在启动时跑
      lifecycleScheduler = startLifecycleScheduler(docker, {
        intervalMs: cfg.AGENT_LIFECYCLE_TICK_MS,
        volumeGcDays: cfg.AGENT_VOLUME_GC_DAYS,
        logger: agentLogger,
        runOnStart: false,
      });
      // eslint-disable-next-line no-console
      console.log("[commercial] agent runtime ready", {
        image: cfg.AGENT_IMAGE,
        network: cfg.AGENT_NETWORK,
        rpc_dir: cfg.AGENT_RPC_SOCKET_DIR,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] agent runtime init failed, disabling:", err);
      agentRuntime = undefined;
      if (lifecycleScheduler) {
        try { await lifecycleScheduler.stop(); } catch { /* */ }
      }
      lifecycleScheduler = undefined;
    }
  } else {
    const missing = Object.entries(agentEnvStatus)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    // eslint-disable-next-line no-console
    console.log(
      `[commercial] agent runtime disabled; missing env: ${missing.join(", ")}`,
    );
  }

  // V3: account-pool 仍然装配(供 admin 列表/T-30 store + agent 容器内部 chat 走 anthropic
  // 中央代理时使用),但 v2 的 chat orchestrator(ws/chat + http/chat)已删除 —
  // v3 chat 不在 commercial 进程出口,而是在每个用户的 docker 容器里跑个人版,通过
  // anthropicProxy(2D)统一调上游。
  const healthRedis = wrapIoredisForHealth(
    redis as unknown as Parameters<typeof wrapIoredisForHealth>[0],
  );
  const healthTracker = new AccountHealthTracker({ redis: healthRedis });
  const scheduler = new AccountScheduler({ health: healthTracker });
  void scheduler; // TODO 2D: 注入 anthropicProxy

  // T-12+ 真实 mailer:env 配 RESEND_API_KEY 后切到 Resend,否则保留 stub(dev/测试)。
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const mailFrom = process.env.MAIL_FROM?.trim() || "auth@claudeai.chat";
  const mailer = resendKey
    ? createResendMailer({ apiKey: resendKey, from: mailFrom })
    : stubMailer;
  if (resendKey) {
    console.log(`[commercial] mailer = resend (from=${mailFrom})`);
  } else {
    console.log("[commercial] mailer = stub (RESEND_API_KEY 未设置, 验证邮件只打日志)");
  }

  const handler = createCommercialHandler({
    jwtSecret,
    mailer,
    redis: wrapIoredis(redis),
    turnstileSecret: cfg.TURNSTILE_SECRET,
    turnstileBypass: cfg.TURNSTILE_TEST_BYPASS,
    requireEmailVerified: cfg.REQUIRE_EMAIL_VERIFIED,
    verifyEmailUrlBase: process.env.COMMERCIAL_BASE_URL,
    resetPasswordUrlBase: process.env.COMMERCIAL_BASE_URL,
    pricing,
    // T-23 preCheck 复用限流用的 ioredis 客户端(SCAN / SET EX 都 OK)
    preCheckRedis,
    hupijiao,
    hupijiaoConfig,
    agentRuntime,
  });

  // T-52 /ws/agent:仅在 agent runtime 就绪时启用。
  // 校验:token 合法 + checkAgentAccess 返 ok(active 订阅 + container 可连接)。
  let agentWsHandler: AgentWsHandler | undefined;
  if (agentRuntime) {
    const rpcDir = cfg.AGENT_RPC_SOCKET_DIR!;
    agentWsHandler = createAgentWsHandler({
      jwtSecret,
      pool: getPool(),
      resolveSocketPath: (uid) =>
        path.join(rpcDir, `u${uid.toString()}`, "agent.sock"),
      // 连接前 DB 校验:订阅 + 容器。失败 → 发 error 帧 + close,不建 socket。
      preCheck: async (uid) => await checkAgentAccess(uid as bigint | number),
    });
  }

  // T-62 告警调度器 —— 默认 60s tick,不在启动时立刻跑(避免冷启动误报)
  let alertScheduler: AlertScheduler | undefined;
  if (process.env.COMMERCIAL_ALERTS_DISABLED !== "1") {
    // 非法 / 空 / NaN → 60s;下限 1s(防 typo 写成 "50" ms 把 DB 打穿)
    const raw = Number(process.env.COMMERCIAL_ALERT_TICK_MS);
    const tickMs = Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
    alertScheduler = startAlertScheduler({
      intervalMs: tickMs,
      runOnStart: false,
    });
  }

  return {
    handle: handler,
    handleWsUpgrade: (req, socket, head) => {
      // V3: v2 /ws/chat 已删除;只剩 /ws/agent(legacy)和 P2-2E 的 /ws/user-chat-bridge(待加)。
      if (agentWsHandler && agentWsHandler.handleUpgrade(req, socket, head)) return true;
      return false;
    },
    shutdown: async () => {
      if (agentWsHandler) {
        try { await agentWsHandler.shutdown(); } catch { /* ignore */ }
      }
      if (lifecycleScheduler) {
        try { await lifecycleScheduler.stop(); } catch { /* ignore */ }
      }
      if (alertScheduler) {
        try { await alertScheduler.stop(); } catch { /* ignore */ }
      }
      try { await pricing.shutdown(); } catch { /* ignore */ }
      try { await redis.quit(); } catch { /* ignore */ }
      await closePool();
    },
  };
}

export const COMMERCIAL_VERSION = "0.1.0";
// 便于 gateway / 测试单独访问
export { runMigrations } from "./db/migrate.js";
export { shouldAutoMigrate };
export { createCommercialHandler } from "./http/router.js";
export type { CommercialHandler } from "./http/router.js";
export type { CommercialHttpDeps } from "./http/handlers.js";
export { PricingCache, perKtokCredits } from "./billing/pricing.js";
export type { ModelPricing, PublicModel } from "./billing/pricing.js";
export { computeCost } from "./billing/calculator.js";
export type { TokenUsage, PriceSnapshot, CostResult } from "./billing/calculator.js";
export {
  debit,
  credit,
  adminAdjust,
  getBalance,
  listLedger,
  InsufficientCreditsError,
  LEDGER_REASONS,
} from "./billing/ledger.js";
export type {
  LedgerReason,
  LedgerRef,
  DebitResult,
  AdminAdjustResult,
  LedgerRow,
} from "./billing/ledger.js";
export {
  preCheck,
  releasePreCheck,
  estimateMaxCost,
  InsufficientCreditsError as PreCheckInsufficientCreditsError,
  InMemoryPreCheckRedis,
  wrapIoredisForPreCheck,
} from "./billing/preCheck.js";
export type {
  PreCheckRedis,
  PreCheckInput,
  PreCheckResult,
} from "./billing/preCheck.js";
export {
  signHupijiao,
  verifyHupijiao,
  buildSignBase,
} from "./payment/hupijiao/sign.js";
export type { SignParams } from "./payment/hupijiao/sign.js";
export {
  createHttpHupijiaoClient,
  HupijiaoError,
} from "./payment/hupijiao/client.js";
export type {
  HupijiaoClient,
  HupijiaoConfig,
  CreateQrInput,
  CreateQrResult,
} from "./payment/hupijiao/client.js";
export {
  listPlans,
  getPlanByCode,
  generateOrderNo,
  createPendingOrder,
  getOrderByNo,
  markOrderPaid,
  expirePendingOrders,
  ORDER_STATUSES,
  PlanNotFoundError,
  OrderNotFoundError,
  InvalidOrderStateError,
} from "./payment/orders.js";
export type {
  TopupPlan,
  OrderRow,
  OrderStatus,
  CreatePendingOrderInput,
  MarkOrderPaidInput,
  MarkOrderPaidResult,
} from "./payment/orders.js";
// T-30 账号池 store
export {
  createAccount,
  getAccount,
  listAccounts,
  getTokenForUse,
  updateAccount,
  deleteAccount,
  ACCOUNT_PLANS,
  ACCOUNT_STATUSES,
  AccountNotFoundError,
} from "./account-pool/store.js";
export type {
  AccountPlan,
  AccountStatus,
  AccountRow,
  AccountToken,
  CreateAccountInput,
  UpdateAccountPatch,
  ListAccountsOptions,
} from "./account-pool/store.js";
// T-31 账号池 health
export {
  AccountHealthTracker,
  InMemoryHealthRedis,
  wrapIoredisForHealth,
  healthKey,
  failKey,
  DEFAULT_FAIL_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_HEALTH_TTL_SEC,
  DEFAULT_FAIL_WINDOW_SEC,
} from "./account-pool/health.js";
export type {
  AccountHealth,
  HealthRedis,
  HealthDeps,
} from "./account-pool/health.js";
// T-32 账号池 scheduler
export {
  AccountScheduler,
  AccountPoolUnavailableError,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
  pickSticky,
  pickWeighted,
  defaultHash,
} from "./account-pool/scheduler.js";
export type {
  PickInput,
  PickResult,
  ReleaseInput,
  ReleaseResult,
  SchedulerDeps,
} from "./account-pool/scheduler.js";
// T-33 账号池 refresh + proxy
export {
  refreshAccountToken,
  shouldRefresh,
  defaultHttp,
  RefreshError,
  DEFAULT_REFRESH_SKEW_MS,
  DEFAULT_OAUTH_ENDPOINT,
  DEFAULT_FALLBACK_EXPIRES_MS,
} from "./account-pool/refresh.js";
export type {
  RefreshErrorCode,
  RefreshHttpClient,
  RefreshDeps,
  RefreshedTokens,
} from "./account-pool/refresh.js";
export {
  streamClaude,
  ProxyError,
  ProxyAuthError,
  DEFAULT_CLAUDE_ENDPOINT,
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_MAX_SSE_BUFFER,
} from "./account-pool/proxy.js";
export type {
  ProxyEvent,
  ProxyDeps,
  StreamClaudeInput,
} from "./account-pool/proxy.js";
// V3 Phase 2: T-40/T-40b/T-41 v2 chat orchestrator(chat/orchestrator.ts、chat/debit.ts、
// ws/chat.ts、http/chat.ts)已删除 — v3 chat 不再走 commercial 进程出口,改由用户的
// docker 容器跑个人版 → 经 anthropicProxy(2D 待加)统一访问上游。
// 仍然保留 ws/connections.ts(legacy /ws/agent 用)。
export {
  ConnectionRegistry,
  DEFAULT_MAX_PER_USER,
} from "./ws/connections.js";
export type {
  Conn,
  RegisterResult,
} from "./ws/connections.js";
// V3 Phase 2 Task 2I-1: 结构化 logger
export {
  createLogger,
  rootLogger,
  parseLevel,
  SENSITIVE_KEYS,
} from "./logging/logger.js";
export type {
  Logger,
  LogLevel,
  LoggerOptions,
} from "./logging/logger.js";
// T-53: Agent 订阅 + 生命周期
export {
  openAgentSubscription,
  getAgentStatus,
  cancelAgentSubscription,
  markContainerRunning,
  markContainerError,
  markExpiredSubscriptions,
  markContainerStoppedAfterExpiry,
  listVolumeGcCandidates,
  markContainerRemoved,
  AgentInsufficientCreditsError,
  AgentAlreadyActiveError,
  AgentNotSubscribedError,
  AGENT_PLAN_BASIC,
  DEFAULT_AGENT_PLAN_PRICE_CREDITS,
  DEFAULT_AGENT_PLAN_DURATION_DAYS,
  DEFAULT_AGENT_VOLUME_GC_DAYS,
  provisionContainer,
  runLifecycleTick,
  startLifecycleScheduler,
} from "./agent/index.js";
export type {
  AgentPlan,
  AgentSubscriptionStatus,
  AgentContainerStatus,
  OpenAgentSubscriptionInput,
  OpenAgentSubscriptionResult,
  AgentStatusView,
  CancelAgentSubscriptionResult,
  ExpiredSubscriptionRow,
  GcCandidateRow,
  ProvisionContainerOptions,
  LifecycleTickOptions,
  LifecycleTickResult,
  LifecycleLogger,
  LifecycleScheduler,
  StartLifecycleSchedulerOptions,
} from "./agent/index.js";
export type { AgentHttpDeps } from "./http/agent.js";
// T-62 metrics + alerts
export {
  renderPrometheus,
  incrGatewayRequest,
  incrBillingDebit,
  incrClaudeApi,
  resetMetricsForTest,
  normalizeRoute,
  snapshotForAlerts,
} from "./admin/metrics.js";
export {
  startAlertScheduler,
  createTelegramSender,
  defaultRules,
  ruleAccountPoolAllDown,
  ruleNoAccountsConfigured,
} from "./admin/alerts.js";
export type {
  AlertScheduler,
  AlertSchedulerOptions,
  AlertRule,
  AlertSender,
  Snapshot,
} from "./admin/alerts.js";
