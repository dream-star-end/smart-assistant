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
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
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
import { rootLogger } from "./logging/logger.js";
import { warmupLoginDummyHash } from "./auth/login.js";
import { secretToKey } from "./auth/jwt.js";
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
import {
  makeAnthropicProxyHandler,
  type AnthropicProxyHandler,
} from "./http/anthropicProxy.js";
import { createPgIdentityRepo } from "./auth/containerIdentity.js";
import {
  createUserChatBridge,
  ContainerUnreadyError,
  type ResolveContainerEndpoint,
  type UserChatBridgeHandler,
  type BridgeMetricSink,
} from "./ws/userChatBridge.js";
import {
  DEFAULT_V3_CCB_BASELINE_DIR,
  resolveCcbBaselineMounts,
  makeV3EnsureRunning,
  preheatV3Image,
  startIdleSweepScheduler,
  startOrphanReconcileScheduler,
  startVolumeGcScheduler,
  type IdleSweepScheduler,
  type OrphanReconcileScheduler,
  type V3SupervisorDeps,
  type VolumeGcScheduler,
} from "./agent-sandbox/index.js";
import {
  observeWsBridgeBuffered,
  observeWsBridgeSessionDuration,
} from "./admin/metrics.js";

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
  /**
   * V3 2H:内部 anthropic 代理监听地址(`{host, port}`),用于:
   *   - /healthz 反映启用状态
   *   - 测试断言代理已上线
   *   - dev 工具按地址探活
   * 未启用(env 缺失 / skipInternalProxy / 监听失败)时为 undefined。
   */
  internalProxyAddress?: { host: string; port: number };
  /**
   * Commercial access JWT 的 HMAC 密钥(已规范化为 ≥32 byte Uint8Array)。
   *
   * 暴露给 gateway,使其在 checkHttpAuth / getUserId 时能识别 commercial
   * 模块签发的 JWT —— 否则商用版用户登录后调 personal-version 沿用的
   * `/api/agents` `/api/sessions/*` 等路由会一律 401(因为 personal 版
   * checkHttpAuth 用 `gateway.accessToken` 当 HMAC,而 commercial JWT
   * 用 JWT_SECRET,两个 secret 完全不同)。
   *
   * gateway 用同步 HS256 验签(node:crypto.createHmac),不引入 jose 依赖,
   * 也不需要把 checkHttpAuth 链路改 async(改动面太大)。
   */
  jwtSecret: Uint8Array;
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
    /**
     * V3 Phase 2 Task 2H:用户 WS 桥接的容器端点解析器。
     *
     * 默认实现:始终 throw `ContainerUnreadyError(retryAfterSec=5, "supervisor_not_wired")`,
     * 使前端按 4503 重试。Phase 3D 的 supervisor.ensureRunning 应注入实现替换。
     *
     * 测试可注入 stub 直接返回 host/port。
     */
    resolveContainerEndpoint?: ResolveContainerEndpoint;
    /**
     * V3 Phase 2 Task 2H:跳过启动内部 anthropic 代理 listener(测试默认 true 避免抢端口)。
     * 生产侧由 cli launcher 显式置 false 让代理上线;dev/CI 不需要。
     */
    skipInternalProxy?: boolean;
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

  // V3 Phase 2 Task 2H:启动内部 Anthropic 代理监听(供容器内 OpenClaude 出站调用)。
  //
  // 非启用条件(任一即跳过,只 log warn 不阻塞主流程):
  //   - options.skipInternalProxy(测试用)
  //   - 缺 INTERNAL_PROXY_BIND / INTERNAL_PROXY_PORT
  //   - 任何监听异常 → 仅 log + 跳过(/healthz 会反映 internalProxy=false)
  //
  // 强约束:bind 已在 config.ts schema 拒绝 0.0.0.0/::,这里不再二次校验。
  const proxyBind = cfg.INTERNAL_PROXY_BIND;
  const proxyPort = cfg.INTERNAL_PROXY_PORT;
  let internalProxyServer: HttpServer | undefined;
  let internalProxyHandler: AnthropicProxyHandler | undefined;
  let internalProxyAddress: { host: string; port: number } | undefined;
  // 前向引用占位:userChatBridge 在下方创建,但 anthropicProxy 在这里就要它的 broadcastToUser。
  // 给 proxy 的 dep 是稳定的闭包(总是调 bridgeBroadcastRef.current),创建 bridge 后赋值。
  // 在 bridge 初始化完成前到达的 cost_charged broadcast 会走到 noop,不 throw 也不落盘(前端
  // 看不到积分显示,但扣费本身仍生效;生产上 proxy 处理请求前 bridge 必已初始化)。
  const bridgeBroadcastRef: { current: (uid: bigint, payload: unknown) => void } = {
    current: () => { /* bridge 还没装好,静默丢弃 */ },
  };
  if (!options.skipInternalProxy && proxyBind && proxyPort !== undefined) {
    try {
      const identityRepo = createPgIdentityRepo(getPool());
      // proxy 模块需要 RateLimitRedis;wrapIoredis 已经满足 incr/expire/ttl 三方法
      const rateLimitRedis = wrapIoredis(redis);
      internalProxyHandler = makeAnthropicProxyHandler({
        pgPool: getPool(),
        pricing,
        preCheckRedis,
        scheduler,
        identityRepo,
        rateLimitRedis,
        // HOTFIX 2026-04-21: 不传 refreshDeps 导致 anthropicProxy 里
        //   `deps.refreshDeps && pick.expires_at && shouldRefresh(...)` 永远 false,
        // OAuth token 过期后不会自动 refresh,结果上游直接 401。
        // health 注入进来是为了 refresh 失败时按规约走 health.manualDisable。
        refreshDeps: { health: healthTracker },
        // 真实扣费积分推送 —— proxy 在 finalize.commit 后调,通过 bridge 把
        // outbound.cost_charged 帧发给用户。bridge 启动顺序在 proxy 之后,
        // 故用 ref 打破先后(构造期调用是 noop,请求期 bridge 必已 wire)。
        broadcastToUser: (uid, payload) => bridgeBroadcastRef.current(uid, payload),
      });
      internalProxyServer = createHttpServer((req, res) => {
        // peerIp 取 socket.remoteAddress(IP-only,无端口);verifyContainerIdentity 接受 string|undefined
        const peerIp = req.socket.remoteAddress ?? "";
        Promise.resolve(internalProxyHandler!(req, res, peerIp)).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[commercial] anthropicProxy handler threw:", err);
          if (!res.headersSent) {
            try {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: { code: "INTERNAL", message: "proxy error" } }));
            } catch { /* socket gone */ }
          } else {
            try { res.end(); } catch { /* */ }
          }
        });
      });
      // 同步监听 + 转 promise:监听失败立即 throw,主流程 catch 后降级
      await new Promise<void>((resolve, reject) => {
        internalProxyServer!.once("error", reject);
        internalProxyServer!.listen(proxyPort, proxyBind, () => {
          internalProxyServer!.removeListener("error", reject);
          resolve();
        });
      });
      internalProxyAddress = { host: proxyBind, port: proxyPort };
      // eslint-disable-next-line no-console
      console.log(
        `[commercial] internal anthropic proxy listening on ${proxyBind}:${proxyPort}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] internal proxy listener failed; disabling:", err);
      try { internalProxyServer?.close(); } catch { /* */ }
      internalProxyServer = undefined;
      internalProxyHandler = undefined;
      internalProxyAddress = undefined;
    }
  } else if (!options.skipInternalProxy) {
    // eslint-disable-next-line no-console
    console.log(
      "[commercial] internal anthropic proxy disabled; missing INTERNAL_PROXY_BIND / INTERNAL_PROXY_PORT",
    );
  }

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

  // V3 Phase 3 supervisor 装配 —— 必须在 createCommercialHandler 之前构造,
  // 因为 admin/containers HIGH#6 路径要在 deps.v3Supervisor 上 dispatch v3 行。
  // 见下方 idleSweep / volumeGc / orphanReconcile / makeV3EnsureRunning 都复用 v3Deps。
  let v3Deps: V3SupervisorDeps | undefined;
  if (cfg.OC_RUNTIME_IMAGE) {
    // 复用 agentRuntime 路径的 docker socket / 默认逻辑,避免 v2/v3 端再各开一个 docker client
    // (一个进程开多个 dockerode 也无副作用,但同一 socket 没必要)
    const v3Docker = cfg.AGENT_DOCKER_SOCKET
      ? new Docker({ socketPath: cfg.AGENT_DOCKER_SOCKET })
      : new Docker();
    v3Deps = {
      docker: v3Docker,
      pool: getPool(),
      image: cfg.OC_RUNTIME_IMAGE,
    };
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 supervisor wired", { image: cfg.OC_RUNTIME_IMAGE });

    // CCB 基线自检(只读诊断,不自己阻断启动 —— 真正的 fail-closed 发生在
    // provisionV3Container 里抛 SupervisorError("CcbBaselineMissing"))。
    //
    // 这里的作用是给运维在 gateway 启动日志上立刻看见 baseline 是否就绪,
    // 避免"rsync 漏了目录,gateway 跑得好好的但下一个 provision 直接 500"。
    // MISSING 时日志态势明确,不用等用户踩坑才发现。
    {
      const baselineDir = process.env.OC_V3_CCB_BASELINE_DIR?.trim() || DEFAULT_V3_CCB_BASELINE_DIR;
      const resolved = resolveCcbBaselineMounts(baselineDir);
      const optional = process.env.OC_V3_CCB_BASELINE_OPTIONAL?.trim().toLowerCase();
      const optionalFlagOn = optional === "1" || optional === "true" || optional === "yes";
      if (resolved) {
        // eslint-disable-next-line no-console
        console.log("[commercial] v3 ccb baseline ready", {
          baselineDir,
          claudeMd: resolved.claudeMdHostPath,
          skillsDir: resolved.skillsDirHostPath,
          optional: optionalFlagOn,
        });
      } else if (optionalFlagOn) {
        // dev/test 显式允许缺基线,不阻断
        // eslint-disable-next-line no-console
        console.warn(
          "[commercial] v3 ccb baseline missing (OPTIONAL=1) — new containers will spawn WITHOUT platform guardrails",
          { baselineDir },
        );
      } else {
        // 生产路径 —— 下一次 provisionV3Container 将抛 CcbBaselineMissing
        // eslint-disable-next-line no-console
        console.error(
          "[commercial] v3 ccb baseline MISSING — next provisionV3Container will FAIL (fail-closed). Fix baseline rsync or set OC_V3_CCB_BASELINE_OPTIONAL=1 for dev only.",
          { baselineDir },
        );
      }
    }

    // V3 Phase 3I — 启动时镜像预热(fire-and-forget):本地已有 → noop;
    // 没有 → docker pull,把首次 provision 30-60s 拉镜像延迟摊到启动时。
    // OC_PREHEAT_DISABLED=1 关闭(测试 / 网络受限 / CI)。失败不影响 gateway。
    if (process.env.OC_PREHEAT_DISABLED !== "1") {
      void preheatV3Image(v3Docker, cfg.OC_RUNTIME_IMAGE, {
        info: (m, meta) => { /* eslint-disable-next-line no-console */ console.log(m, meta ?? {}); },
        warn: (m, meta) => { /* eslint-disable-next-line no-console */ console.warn(m, meta ?? {}); },
      }).catch((err: unknown) => {
        // preheatV3Image 内部已经吞了所有错;到这里只是兜底防 unhandledRejection
        // eslint-disable-next-line no-console
        console.warn("[commercial] v3 preheat unexpectedly threw", { error: (err as Error)?.message ?? String(err) });
      });
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[commercial] v3 supervisor disabled; missing env: OC_RUNTIME_IMAGE",
    );
  }

  const handler = createCommercialHandler({
    jwtSecret,
    mailer,
    redis: wrapIoredis(redis),
    turnstileSecret: cfg.TURNSTILE_SECRET,
    turnstileBypass: cfg.TURNSTILE_TEST_BYPASS,
    turnstileSiteKey: cfg.TURNSTILE_SITE_KEY,
    requireEmailVerified: cfg.REQUIRE_EMAIL_VERIFIED,
    // HIGH#4:生产 claudeai.chat 全 HTTPS,默认 Secure cookie;
    // 仅当 env COMMERCIAL_INSECURE_COOKIE=1(本地 dev / docker compose)才关
    refreshCookieSecure: process.env.COMMERCIAL_INSECURE_COOKIE === "1" ? false : true,
    verifyEmailUrlBase: process.env.COMMERCIAL_BASE_URL,
    resetPasswordUrlBase: process.env.COMMERCIAL_BASE_URL,
    pricing,
    // T-23 preCheck 复用限流用的 ioredis 客户端(SCAN / SET EX 都 OK)
    preCheckRedis,
    hupijiao,
    hupijiaoConfig,
    agentRuntime,
    // HIGH#6:admin/containers v3 行的 stop/remove/restart 走这条 dispatch
    v3Supervisor: v3Deps,
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

  // V3 Phase 2 Task 2H + Phase 3D:用户 WS ↔ 容器 WS 桥接(/ws/user-chat-bridge)。
  //
  // resolveContainerEndpoint 的解析顺序(高优先 → 低优先):
  //   1. options.resolveContainerEndpoint(测试 / 显式覆盖)
  //   2. v3 supervisor(env 完备 → makeV3EnsureRunning,见上方 v3Deps 装配)
  //   3. stub `supervisor_not_wired`(Phase 2 行为,/healthz 仍报 commercial up)
  //
  // 注:v3Deps 已在 createCommercialHandler 之前装配(HIGH#6 admin v3 dispatch 需要)。

  // V3 Phase 3F:idle 30min stop+remove ephemeral 容器(MVP 单轨)。
  // 仅在 v3 supervisor 装配后启用;cfg.OC_IDLE_SWEEP_DISABLED=1 可手动关掉
  // (运维灾备时用,默认 60s tick / 30min idle cutoff)。
  let idleSweepScheduler: IdleSweepScheduler | undefined;
  if (v3Deps && process.env.OC_IDLE_SWEEP_DISABLED !== "1") {
    idleSweepScheduler = startIdleSweepScheduler(v3Deps, {
      logger: {
        debug: (m, meta) => { /* eslint-disable-next-line no-console */ console.debug(m, meta ?? {}); },
        info:  (m, meta) => { /* eslint-disable-next-line no-console */ console.log(m, meta ?? {}); },
        warn:  (m, meta) => { /* eslint-disable-next-line no-console */ console.warn(m, meta ?? {}); },
        error: (m, meta) => { /* eslint-disable-next-line no-console */ console.error(m, meta ?? {}); },
      },
      runOnStart: false,
    });
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 idle sweep scheduler started (60s tick, 30min cutoff)");
  }

  // V3 Phase 3G:volume GC(banned 7d / no-login 90d)。1h 一跑,删孤立 volume。
  // cfg.OC_VOLUME_GC_DISABLED=1 可手动关掉(运维灾备 / 数据回滚演练时用)。
  let volumeGcScheduler: VolumeGcScheduler | undefined;
  if (v3Deps && process.env.OC_VOLUME_GC_DISABLED !== "1") {
    volumeGcScheduler = startVolumeGcScheduler(v3Deps, {
      logger: {
        debug: (m, meta) => { /* eslint-disable-next-line no-console */ console.debug(m, meta ?? {}); },
        info:  (m, meta) => { /* eslint-disable-next-line no-console */ console.log(m, meta ?? {}); },
        warn:  (m, meta) => { /* eslint-disable-next-line no-console */ console.warn(m, meta ?? {}); },
        error: (m, meta) => { /* eslint-disable-next-line no-console */ console.error(m, meta ?? {}); },
      },
      runOnStart: false,
    });
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 volume gc scheduler started (1h tick, banned 7d / no-login 90d)");
  }

  // V3 Phase 3H:orphan reconcile(gateway 启动立刻 + 1h tick)。docker↔DB 双向对账。
  // cfg.OC_ORPHAN_RECONCILE_DISABLED=1 可关闭(运维灾备 / 数据冷恢复时用)。
  let orphanReconcileScheduler: OrphanReconcileScheduler | undefined;
  if (v3Deps && process.env.OC_ORPHAN_RECONCILE_DISABLED !== "1") {
    orphanReconcileScheduler = startOrphanReconcileScheduler(v3Deps, {
      logger: {
        debug: (m, meta) => { /* eslint-disable-next-line no-console */ console.debug(m, meta ?? {}); },
        info:  (m, meta) => { /* eslint-disable-next-line no-console */ console.log(m, meta ?? {}); },
        warn:  (m, meta) => { /* eslint-disable-next-line no-console */ console.warn(m, meta ?? {}); },
        error: (m, meta) => { /* eslint-disable-next-line no-console */ console.error(m, meta ?? {}); },
      },
      // 默认 runOnStart=true(§3H 明确"gateway 启动 reconcile")
    });
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 orphan reconcile scheduler started (1h tick, runs on start)");
  }

  const resolveContainerEndpoint: ResolveContainerEndpoint =
    options.resolveContainerEndpoint
    ?? (v3Deps
      ? makeV3EnsureRunning(v3Deps)
      : async (_uid: bigint): Promise<{ host: string; port: number }> => {
        throw new ContainerUnreadyError(5, "supervisor_not_wired");
      });
  // V3 2I-2:把 buffered_bytes / session_duration 接到 prometheus histogram。
  // 单帧 / per-uid 字节数不进 metrics —— 标签基数太大。
  const bridgeMetrics: BridgeMetricSink = {
    onBufferedBytes: (_uid, side, bytes) => observeWsBridgeBuffered(side, bytes),
    onClose: (stats) => observeWsBridgeSessionDuration(stats.cause, stats.durationMs / 1000),
  };
  const userChatBridge: UserChatBridgeHandler = createUserChatBridge({
    jwtSecret,
    resolveContainerEndpoint,
    metrics: bridgeMetrics,
    // 注入 logger,让 bridge 把 4503 reason / container error 等关键路径日志写出来。
    // 不传则静默 noop,生产排错时全部不可见(原版 commit 漏了)。
    logger: rootLogger.child({ subsys: "commercial", module: "userChatBridge" }),
  });
  // 把 proxy 的 forward-ref 指向真实 broadcastToUser —— 此刻以后,commit 成功
  // 扣费事件会实时推到用户前端。
  bridgeBroadcastRef.current = (uid, payload) => {
    userChatBridge.broadcastToUser(uid, payload);
  };

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
      // V3: 优先匹配 /ws/user-chat-bridge(2E),其次 /ws/agent(legacy)。
      if (userChatBridge.handleUpgrade(req, socket, head)) return true;
      if (agentWsHandler && agentWsHandler.handleUpgrade(req, socket, head)) return true;
      return false;
    },
    shutdown: async () => {
      try { await userChatBridge.shutdown(); } catch { /* ignore */ }
      if (agentWsHandler) {
        try { await agentWsHandler.shutdown(); } catch { /* ignore */ }
      }
      if (lifecycleScheduler) {
        try { await lifecycleScheduler.stop(); } catch { /* ignore */ }
      }
      if (idleSweepScheduler) {
        try { await idleSweepScheduler.stop(); } catch { /* ignore */ }
      }
      if (volumeGcScheduler) {
        try { await volumeGcScheduler.stop(); } catch { /* ignore */ }
      }
      if (orphanReconcileScheduler) {
        try { await orphanReconcileScheduler.stop(); } catch { /* ignore */ }
      }
      if (alertScheduler) {
        try { await alertScheduler.stop(); } catch { /* ignore */ }
      }
      if (internalProxyServer) {
        await new Promise<void>((resolve) => {
          try {
            internalProxyServer!.close(() => resolve());
            // 主动断现有连接,close 才能尽快回调
            const closeAll = (internalProxyServer as unknown as { closeAllConnections?: () => void }).closeAllConnections;
            if (typeof closeAll === "function") closeAll.call(internalProxyServer);
          } catch { resolve(); }
        });
      }
      try { await pricing.shutdown(); } catch { /* ignore */ }
      try { await redis.quit(); } catch { /* ignore */ }
      await closePool();
    },
    /** V3 2H 测试 / /healthz 探测用:内部代理实际监听地址(undefined = 未启用)。 */
    internalProxyAddress,
    // 已规范化为 ≥32 byte Uint8Array,gateway 可直接喂 createHmac
    jwtSecret: secretToKey(jwtSecret),
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
  preCheckWithCost,
  releasePreCheck,
  estimateMaxCost,
  InsufficientCreditsError as PreCheckInsufficientCreditsError,
  InMemoryPreCheckRedis,
  wrapIoredisForPreCheck,
} from "./billing/preCheck.js";
export type {
  PreCheckRedis,
  PreCheckInput,
  PreCheckWithCostInput,
  PreCheckResult,
  ReservationHandle,
  AtomicReserveResult,
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
// V3 Phase 2 Task 2C: 容器身份双因子校验
export {
  verifyContainerIdentity,
  parseContainerToken,
  hashSecret,
  compareHash,
  createPgIdentityRepo,
  ContainerIdentityError,
} from "./auth/containerIdentity.js";
export type {
  ContainerIdentity,
  ContainerIdentityRepo,
} from "./auth/containerIdentity.js";
// V3 Phase 2 Task 2D: 内部 Anthropic 中央代理(monolith)
export {
  makeAnthropicProxyHandler,
  proxyBodySchema,
  enforceFieldByteBudgets,
  estimateInputTokens,
  estimateMaxCostBothSides,
  buildSafeUpstreamHeaders,
  ConcurrencyLimiter,
  pipeStreamWithUsageCapture,
  startInflightJournal,
  makeFinalizer,
  DEFAULT_UPSTREAM_ENDPOINT,
  ANTHROPIC_VERSION,
  ALLOWED_BETA_VALUES,
  SIZE_LIMITS,
  MAX_BODY_BYTES_DEFAULT,
  MAX_MESSAGES_COUNT,
  MAX_TOOLS_COUNT,
  CHARS_PER_TOKEN_ESTIMATE,
  DEFAULT_PROXY_RATE_LIMIT,
  DEFAULT_MAX_CONCURRENT_PER_UID,
} from "./http/anthropicProxy.js";
export type {
  AnthropicProxyDeps,
  AnthropicProxyHandler,
  ProxyBody,
  UsageObservation,
  PipeStreamResult,
  FinalizeContext,
  FinalizeOutcome,
} from "./http/anthropicProxy.js";
// V3 Phase 2 Task 2E: 用户 WS ↔ 容器 WS 桥接
export {
  createUserChatBridge,
  ContainerUnreadyError,
  CLOSE_BRIDGE,
  BRIDGE_WS_PATH,
} from "./ws/userChatBridge.js";
export type {
  UserChatBridgeDeps,
  UserChatBridgeHandler,
  ResolveContainerEndpoint,
  BridgeMetricSink,
  BridgeCloseCause,
} from "./ws/userChatBridge.js";
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
