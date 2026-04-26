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
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";
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
  startRefreshEventsSweeper,
  type SweeperHandle as RefreshEventsSweeperHandle,
} from "./account-pool/refreshEventsSweeper.js";
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
  markV3ContainerActivity,
  startV3ContainerEventsWorker,
  startVolumeGcScheduler,
  type IdleSweepScheduler,
  type OrphanReconcileScheduler,
  type V3ContainerEventsWorker,
  type V3SupervisorDeps,
  type VolumeGcScheduler,
} from "./agent-sandbox/index.js";
import {
  observeWsBridgeBuffered,
  observeWsBridgeSessionDuration,
} from "./admin/metrics.js";
import { loadOrCreateBridgeSecret, DEFAULT_BRIDGE_SECRET_PATH } from "./bridgeSecret.js";
import { setRemoteMuxDeps } from "./remoteHosts/sshMux.js";
import { RemoteHostError } from "./remoteHosts/service.js";
import * as computeQueries from "./compute-pool/queries.js";
import {
  hostRowToTarget,
  startSshControlMaster,
  stopSshControlMaster,
  putFile as nodeAgentPutFile,
  deleteFile as nodeAgentDeleteFile,
} from "./compute-pool/nodeAgentClient.js";
import { createContainerService } from "./compute-pool/containerService.js";
import { distributePreheatToAllHosts } from "./compute-pool/imageDistribute.js";
import {
  getBaselineServer,
  type BaselineServer,
} from "./compute-pool/baselineServer.js";
import {
  ensureCa,
  ensureMasterLeaf,
  extractSpiffeUris,
  extractHostUuidFromSpiffe,
} from "./compute-pool/certAuthority.js";
import type { ServerResponse } from "node:http";

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
   * V3 D.1b:外部 mTLS 监听地址(18443)。remote-host node-agent L7 反代从这里进。
   * 未启用(EXTERNAL_MTLS_ENABLED != 1 / 缺 bind/port / 监听失败)时为 undefined。
   */
  externalMtlsAddress?: { host: string; port: number };
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

// ─── D.1b: 18443 mTLS 反代前置校验 ─────────────────────────────────────────
//
// remote-host 的 node-agent 通过 mTLS 把容器出站 POST 反代到 master:18443。
// 入口做四件事:
//   1. TLS 层已经验了证书链;我们还要从 SAN URI 解出 host uuid
//   2. DB 查 `compute_hosts.id = hostUuid`:确认 status='ready' + fingerprint pin
//      (fingerprint 校验是撤销机制 —— cert 泄露时 admin 轮换 db 行的 fp 即时生效)
//   3. 校验 X-V3-Container-IP 头:只允许单一字符串、不含 CR/LF、且是合法 IPv4
//   4. 去掉 X-V3-Container-IP 头,再把请求以 { hostUuid, boundIp } ctx 交给 proxyHandler
//
// 任意校验失败都直接以 JSON error 结束;不进 proxy,不消耗 account,不扣分。

/** Raw DER → PEM。node TLSSocket.getPeerCertificate(true).raw 是 DER Buffer。 */
function derToPem(der: Buffer): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function sendMtlsError(
  res: ServerResponse,
  status: number,
  code: string,
  extra?: Record<string, unknown>,
): void {
  if (res.headersSent) {
    try { res.end(); } catch { /* socket gone */ }
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: { code, ...(extra ?? {}) } }));
}

async function handleExternalMtls(
  req: IncomingMessage,
  res: ServerResponse,
  proxyHandler: AnthropicProxyHandler,
): Promise<void> {
  const socket = req.socket as TLSSocket;
  // TLS 层已经 rejectUnauthorized:true,到这里 authorized 理论必真;额外 belt-and-suspenders
  if (!socket.authorized) {
    sendMtlsError(res, 401, "PEER_UNAUTHORIZED", { reason: socket.authorizationError?.message });
    return;
  }
  const peerCert = socket.getPeerCertificate(true);
  if (!peerCert || !peerCert.raw || peerCert.raw.length === 0) {
    sendMtlsError(res, 401, "NO_PEER_CERT");
    return;
  }

  // SPIFFE URI → host uuid
  const certPem = derToPem(peerCert.raw);
  let uris: string[];
  try {
    uris = await extractSpiffeUris(certPem);
  } catch {
    sendMtlsError(res, 403, "CERT_PARSE_FAIL");
    return;
  }
  const hostUri = uris.find((u) => u.startsWith("spiffe://openclaude/host/"));
  if (!hostUri) {
    sendMtlsError(res, 403, "NO_HOST_SPIFFE");
    return;
  }
  const hostUuid = extractHostUuidFromSpiffe(hostUri);
  if (!hostUuid) {
    sendMtlsError(res, 403, "BAD_SPIFFE_URI");
    return;
  }

  // DB state + fingerprint pin。**不做 in-proc cache**,每请求一查 —— admin 轮换 fp 就即时生效
  const row = await computeQueries.getHostById(hostUuid);
  if (!row) {
    sendMtlsError(res, 403, "HOST_NOT_FOUND");
    return;
  }
  if (row.status !== "ready") {
    sendMtlsError(res, 503, "HOST_NOT_READY", { status: row.status });
    return;
  }
  const expectedFp = row.agent_cert_fingerprint_sha256;
  if (!expectedFp) {
    sendMtlsError(res, 403, "NO_PINNED_FP");
    return;
  }
  // peerCert.fingerprint256 是 "AA:BB:..." 冒号分隔大写 hex。
  // 异常 TLS 对象形态下可能为 undefined/"",统一落 401 而非走到后面抛 500。
  if (!peerCert.fingerprint256 || typeof peerCert.fingerprint256 !== "string") {
    sendMtlsError(res, 401, "NO_PEER_FINGERPRINT");
    return;
  }
  const presentedFp = peerCert.fingerprint256.replace(/:/g, "").toLowerCase();
  const pBuf = Buffer.from(presentedFp, "hex");
  const eBuf = Buffer.from(expectedFp.toLowerCase(), "hex");
  if (pBuf.length !== eBuf.length || pBuf.length === 0 || !timingSafeEqual(pBuf, eBuf)) {
    sendMtlsError(res, 403, "FINGERPRINT_MISMATCH");
    return;
  }

  // X-V3-Container-IP 校验:三重防御(数组 / CRLF header-folding / 非 IPv4)
  const rawIp = req.headers["x-v3-container-ip"];
  if (Array.isArray(rawIp)) {
    sendMtlsError(res, 400, "IP_HEADER_ARRAY");
    return;
  }
  if (!rawIp || typeof rawIp !== "string") {
    sendMtlsError(res, 400, "IP_HEADER_MISSING");
    return;
  }
  if (rawIp.includes("\r") || rawIp.includes("\n")) {
    sendMtlsError(res, 400, "IP_HEADER_CRLF");
    return;
  }
  if (!isIPv4(rawIp)) {
    sendMtlsError(res, 400, "IP_HEADER_NOT_IPV4");
    return;
  }

  // 剥掉 X-V3-Container-IP 头,防止透传到 anthropic 上游
  delete req.headers["x-v3-container-ip"];
  await proxyHandler(req, res, { hostUuid, boundIp: rawIp });
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
  let externalMtlsServer: HttpsServer | undefined;
  let externalMtlsAddress: { host: string; port: number } | undefined;
  // 前向引用占位:userChatBridge 在下方创建,但 anthropicProxy 在这里就要它的 broadcastToUser。
  // 给 proxy 的 dep 是稳定的闭包(总是调 bridgeBroadcastRef.current),创建 bridge 后赋值。
  // 在 bridge 初始化完成前到达的 cost_charged broadcast 会走到 noop,不 throw 也不落盘(前端
  // 看不到积分显示,但扣费本身仍生效;生产上 proxy 处理请求前 bridge 必已初始化)。
  const bridgeBroadcastRef: { current: (uid: bigint, payload: unknown) => void } = {
    current: () => { /* bridge 还没装好,静默丢弃 */ },
  };
  // D.1b: self host uuid 取失败只降级多机路径(proxy / v3Deps.containerService /
  // baselineServer),不牵连整个 commercial 启动。多处共用,提前一次性取。
  let selfHostUuid: string | undefined;
  try {
    selfHostUuid = (await computeQueries.getSelfHost()).id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[commercial] getSelfHost failed; multi-host routing + internal proxy disabled",
      { err: (err as Error)?.message ?? String(err) },
    );
    // selfHostUuid 保持 undefined;下面 proxy / v3Deps / baselineServer 全部靠 guard 跳过
  }

  if (
    !options.skipInternalProxy &&
    proxyBind &&
    proxyPort !== undefined &&
    selfHostUuid
  ) {
    try {
      const identityRepo = createPgIdentityRepo();
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
        // self-host 路径:container → plain HTTP 18791 → 这里。peerIp 就是 container 的 bound_ip,
        // hostUuid 固定 = selfHostUuid(本机容器不需要也不可能带 mTLS cert)。
        // selfHostUuid 在外层闭包已取,保证非 undefined(否则根本走不到 createHttpServer 这行)。
        const peerIp = req.socket.remoteAddress ?? "";
        Promise.resolve(
          internalProxyHandler!(req, res, { hostUuid: selfHostUuid!, boundIp: peerIp }),
        ).catch((err) => {
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

  // V3 D.1b: 18443 mTLS listener。remote-host node-agent 走 L7 反代过来,master 这边
  // 用 master leaf cert 作服务端 cert,并要求对端出示 host leaf cert(SPIFFE host/<uuid>)。
  // 通过 handleExternalMtls 做 cert + fingerprint + container-ip 头三级校验后,
  // 走到同一个 internalProxyHandler(和 self-host plain 18791 共用)。
  //
  // 启用条件:EXTERNAL_MTLS_ENABLED=1 + bind + port 都配齐 + internalProxyHandler 已就绪。
  // 关掉 / 配不齐 / 监听失败 → 单边降级,remote host 出不来但 self host 不受影响。
  if (
    internalProxyHandler &&
    cfg.EXTERNAL_MTLS_ENABLED &&
    cfg.EXTERNAL_MTLS_BIND &&
    cfg.EXTERNAL_MTLS_PORT !== undefined
  ) {
    const mtlsBind = cfg.EXTERNAL_MTLS_BIND;
    const mtlsPort = cfg.EXTERNAL_MTLS_PORT;
    try {
      const caMat = await ensureCa();
      const masterLeaf = await ensureMasterLeaf();
      const caPem = await fs.promises.readFile(caMat.caCertPath, "utf8");
      const masterKey = await fs.promises.readFile(masterLeaf.keyPath, "utf8");
      const capturedHandler = internalProxyHandler;
      externalMtlsServer = createHttpsServer(
        {
          key: masterKey,
          cert: masterLeaf.certPem,
          ca: caPem,
          requestCert: true,
          rejectUnauthorized: true,
          // master + node-agent 都我们自己控(Node 18+ / Go 1.22 均原生 TLS 1.3),
          // 没有历史客户端兼容性包袱,直接 hard-require 1.3。
          minVersion: "TLSv1.3",
        },
        (req, res) => {
          Promise.resolve(handleExternalMtls(req, res, capturedHandler)).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("[commercial] external mTLS handler threw:", err);
            if (!res.headersSent) {
              try {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: { code: "INTERNAL", message: "mtls error" } }));
              } catch { /* socket gone */ }
            } else {
              try { res.end(); } catch { /* */ }
            }
          });
        },
      );
      await new Promise<void>((resolve, reject) => {
        externalMtlsServer!.once("error", reject);
        externalMtlsServer!.listen(mtlsPort, mtlsBind, () => {
          externalMtlsServer!.removeListener("error", reject);
          resolve();
        });
      });
      externalMtlsAddress = { host: mtlsBind, port: mtlsPort };
      // eslint-disable-next-line no-console
      console.log(
        `[commercial] external mTLS listening on ${mtlsBind}:${mtlsPort}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] external mTLS listener failed; disabling:", err);
      try { externalMtlsServer?.close(); } catch { /* */ }
      externalMtlsServer = undefined;
      externalMtlsAddress = undefined;
    }
  } else if (internalProxyHandler && !cfg.EXTERNAL_MTLS_ENABLED) {
    // eslint-disable-next-line no-console
    console.log("[commercial] external mTLS listener disabled (EXTERNAL_MTLS_ENABLED != 1)");
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

  // v3 file proxy:HOST bridge root secret。加载/生成 `/var/lib/openclaude/.v3-bridge-secret`。
  // 任何失败(权限 / 磁盘 / 路径)→ fail-closed 只警告,让 supervisor 不注入 env,file
  // proxy 整体降级为 CONTAINER_OUTDATED 503,不会阻止 gateway 启动。
  let bridgeSecret: string | undefined;
  try {
    bridgeSecret = loadOrCreateBridgeSecret();
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 bridge secret loaded", { path: DEFAULT_BRIDGE_SECRET_PATH });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[commercial] v3 bridge secret load/create failed; file proxy will be DISABLED",
      { path: DEFAULT_BRIDGE_SECRET_PATH, error: (err as Error)?.message ?? String(err) },
    );
    bridgeSecret = undefined;
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
      // bridgeSecret 注入后,provisionV3Container 会写 OC_CONTAINER_ID / OC_BRIDGE_NONCE
      // 到容器 env;未注入则容器侧 /healthz 不广播 file-proxy-v1,代理自动 OUTDATED。
      bridgeSecret,
      // 多机路由 wiring:selfHostUuid 取到才同时注入 containerService + selfHostId,
      // 避免出现 "containerService 注入但 selfHostId undefined" 的半 wire 状态
      // (provisionV3Container 的 useRemote 判定依赖 selfHostId 非空)。
      ...(selfHostUuid
        ? {
            containerService: createContainerService(v3Docker),
            selfHostId: selfHostUuid,
          }
        : {}),
    };
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 supervisor wired", {
      image: cfg.OC_RUNTIME_IMAGE,
      multiHost: Boolean(selfHostUuid),
      selfHostId: selfHostUuid ?? null,
    });

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

      // 多机分发:把 image 推到所有 ready 的远端 host。
      // 启动时 fire-and-forget(3.5GB stream 不阻塞 ws 接入)。
      // 失败 best-effort —— 兜底是 wrapDockerError 把 RUN_FAIL/Unable-to-find-image
      // 翻译成 ImageNotFound,前端 5min retry 而非 5s 风暴。
      // OC_IMAGE_DISTRIBUTE_DISABLED=1 关(单机部署 / 测试)。
      if (process.env.OC_IMAGE_DISTRIBUTE_DISABLED !== "1") {
        void distributePreheatToAllHosts(cfg.OC_RUNTIME_IMAGE, {
          logger: rootLogger.child({ subsys: "image-distribute-startup" }),
        })
          .then((results) => {
            const summary = results.map((r) => `${r.hostName}:${r.outcome}`).join(",");
            // eslint-disable-next-line no-console
            console.log("[commercial] v3 image distribute summary", { results: summary, count: results.length });
            const failed = results.filter((r) => r.outcome === "error");
            if (failed.length > 0) {
              // eslint-disable-next-line no-console
              console.warn("[commercial] v3 image distribute had failures", {
                failed: failed.map((r) => ({ host: r.hostName, source: r.errorSource, error: r.error })),
              });
            }
          })
          .catch((err: unknown) => {
            // distributePreheatToAllHosts 内部应该 best-effort 不抛;真抛了就是 bug
            // eslint-disable-next-line no-console
            console.warn("[commercial] v3 image distribute unexpectedly threw", {
              error: (err as Error)?.message ?? String(err),
            });
          });
      }
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[commercial] v3 supervisor disabled; missing env: OC_RUNTIME_IMAGE",
    );
  }

  // V3 多机路由:启动 BaselineServer,给远端 node-agent 提供
  // /internal/v3/baseline-{version,tarball} 端点。只在 v3Deps + selfHostUuid
  // 都就绪时起(多机 wiring 前置条件),失败不阻断 gateway —— remote host 拉
  // baseline 失败时 provisionV3Container 会走 CcbBaselineMissing fail-closed。
  // bind 0.0.0.0 + mTLS + PSK 双因子认证;GCP default-allow-internal 挡公网。
  let baselineSrv: BaselineServer | undefined;
  if (v3Deps && selfHostUuid) {
    try {
      const baselineDir =
        process.env.OC_V3_CCB_BASELINE_DIR?.trim() || DEFAULT_V3_CCB_BASELINE_DIR;
      baselineSrv = getBaselineServer({
        baselineDir,
        bind: "0.0.0.0",
        port: 18792,
      });
      await baselineSrv.start();
      // eslint-disable-next-line no-console
      console.log("[commercial] baseline server started", {
        bind: "0.0.0.0",
        port: 18792,
        baselineDir,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] baseline server start failed", {
        err: (err as Error)?.message ?? String(err),
      });
      baselineSrv = undefined;
    }
  }

  // C.3 — 向 sshMux 注入 remote-aware 依赖。不注入时 acquireMux 的 remote 分支
  // 会抛 "RPC fns not configured"(sshMux.ts defaultDeps),等价于死代码。此处必须
  // 在 createCommercialHandler / sessionManager 初始化之前完成注入。
  //
  // resolvePlacement 合约(sshMux.ts):按 userId 查 sticky compute_host;self → {kind:'self'},
  // 其它 → {kind:'remote', target}。fail-closed:DB 错 / 无 active 容器 → 抛
  // RemoteHostError("INTERNAL", "NO_CONTAINER: ...")。sshMux caller 会把异常 propagate。
  //
  // 注:M1 语义是"一个 user 最多占一台 compute_host"(findUserStickyHost LIMIT 1),故 hostId
  // 参数目前只用于日志;未来若放宽"单用户多容器",此处要重新 keyed by (userId, hostId)。
  setRemoteMuxDeps({
    async resolvePlacement(userId, hostId) {
      const uidInt = Number.parseInt(userId, 10);
      if (!Number.isFinite(uidInt) || uidInt <= 0 || String(uidInt) !== userId) {
        throw new RemoteHostError(
          "INTERNAL",
          `resolvePlacement: userId not positive integer: ${userId}`,
        );
      }
      const sticky = await computeQueries.findUserStickyHost(uidInt);
      if (!sticky) {
        throw new RemoteHostError(
          "INTERNAL",
          `NO_CONTAINER: user ${userId} has no active container (hostId=${hostId})`,
        );
      }
      const hostRow = await computeQueries.getHostById(sticky.hostUuid);
      if (!hostRow) {
        throw new RemoteHostError(
          "INTERNAL",
          `compute_host ${sticky.hostUuid} not found (userId=${userId} hostId=${hostId})`,
        );
      }
      rootLogger.debug("sshMux resolvePlacement", {
        subsys: "remote-ssh",
        userId,
        hostId,
        resolvedHostUuid: hostRow.id,
        resolvedName: hostRow.name,
      });
      if (hostRow.name === "self") return { kind: "self" };
      return { kind: "remote", target: hostRowToTarget(hostRow) };
    },
    startSshControlMaster,
    stopSshControlMaster,
    putRemoteFile: nodeAgentPutFile,
    deleteRemoteFile: nodeAgentDeleteFile,
  });
  // eslint-disable-next-line no-console
  console.log("[commercial] sshMux remote deps wired");

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
    // v3 file proxy:root secret 给 containerFileProxy 签 per-request nonce;
    // feature flag 控制 router 是否把 /api/file / /api/media/* 从 BLOCKED 拉进 PROXY 分支
    bridgeSecret,
    fileProxyEnabled: cfg.FILE_PROXY_ENABLED,
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
    const idleSweepLog = rootLogger.child({ subsys: "v3/idleSweep" });
    idleSweepScheduler = startIdleSweepScheduler(v3Deps, {
      logger: idleSweepLog,
      runOnStart: false,
    });
    idleSweepLog.info("scheduler started", { tickSec: 60, idleCutoffMin: 30 });
  }

  // V3 Phase 3G:volume GC(banned 7d / no-login 90d)。1h 一跑,删孤立 volume。
  // cfg.OC_VOLUME_GC_DISABLED=1 可手动关掉(运维灾备 / 数据回滚演练时用)。
  let volumeGcScheduler: VolumeGcScheduler | undefined;
  if (v3Deps && process.env.OC_VOLUME_GC_DISABLED !== "1") {
    const volumeGcLog = rootLogger.child({ subsys: "v3/volumeGc" });
    volumeGcScheduler = startVolumeGcScheduler(v3Deps, {
      logger: volumeGcLog,
      runOnStart: false,
    });
    volumeGcLog.info("scheduler started", {
      tickSec: 3600, bannedDays: 7, noLoginDays: 90,
    });
  }

  // V3 Phase 3H:orphan reconcile(gateway 启动立刻 + 1h tick)。docker↔DB 双向对账。
  // cfg.OC_ORPHAN_RECONCILE_DISABLED=1 可关闭(运维灾备 / 数据冷恢复时用)。
  let orphanReconcileScheduler: OrphanReconcileScheduler | undefined;
  if (v3Deps && process.env.OC_ORPHAN_RECONCILE_DISABLED !== "1") {
    const orphanReconcileLog = rootLogger.child({ subsys: "v3/orphanReconcile" });
    orphanReconcileScheduler = startOrphanReconcileScheduler(v3Deps, {
      logger: orphanReconcileLog,
      // 默认 runOnStart=true(§3H 明确"gateway 启动 reconcile")
    });
    orphanReconcileLog.info("scheduler started", { tickSec: 3600, runOnStart: true });
  }

  // T-63 Phase 2:订阅 docker container events → `container.oom_exited` 告警。
  // cfg.OC_CONTAINER_EVENTS_DISABLED=1 可关闭(运维灾备 / docker daemon 异常时用)。
  let containerEventsWorker: V3ContainerEventsWorker | undefined;
  if (v3Deps && process.env.OC_CONTAINER_EVENTS_DISABLED !== "1") {
    containerEventsWorker = startV3ContainerEventsWorker({
      docker: v3Deps.docker,
      logger: {
        debug: (m, meta) => { /* eslint-disable-next-line no-console */ console.debug(m, meta ?? {}); },
        info:  (m, meta) => { /* eslint-disable-next-line no-console */ console.log(m, meta ?? {}); },
        warn:  (m, meta) => { /* eslint-disable-next-line no-console */ console.warn(m, meta ?? {}); },
        error: (m, meta) => { /* eslint-disable-next-line no-console */ console.error(m, meta ?? {}); },
      },
    });
    // eslint-disable-next-line no-console
    console.log("[commercial] v3 container events worker started (oom/die → alerts)");
  }

  const resolveContainerEndpoint: ResolveContainerEndpoint =
    options.resolveContainerEndpoint
    ?? (v3Deps
      ? makeV3EnsureRunning(v3Deps)
      : async (_uid: bigint) => {
        throw new ContainerUnreadyError(5, "supervisor_not_wired");
      });
  // V3 2I-2:把 buffered_bytes / session_duration 接到 prometheus histogram。
  // 单帧 / per-uid 字节数不进 metrics —— 标签基数太大。
  const bridgeMetrics: BridgeMetricSink = {
    onBufferedBytes: (_uid, side, bytes) => observeWsBridgeBuffered(side, bytes),
    onClose: (stats) => observeWsBridgeSessionDuration(stats.cause, stats.durationMs / 1000),
  };
  // PR1:bridge 拿到 client→container 帧时刷 last_ws_activity(60s debounce)。
  // 防 idle sweep 把"长 WS 单连但持续在用"的会话误判为 idle。fire-and-forget 包到
  // 闭包里;markV3ContainerActivity 自身已 swallow 异常。无 v3Deps(单测 / mock)
  // → 不注入,bridge 退化为 PR1 之前的行为(只 ensureRunning 刷一次)。
  const markActivityForBridge = v3Deps
    ? (cid: number) => { void markV3ContainerActivity(v3Deps!, cid); }
    : undefined;
  const userChatBridge: UserChatBridgeHandler = createUserChatBridge({
    jwtSecret,
    resolveContainerEndpoint,
    metrics: bridgeMetrics,
    markContainerActivity: markActivityForBridge,
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

  // M6/P1-9 — account_refresh_events 28 天 retention sweeper(24h interval,unref)。
  // boot 不立即跑,等 24h 后第一次 tick(不会冲启动 DB 负载)。
  let refreshEventsSweeper: RefreshEventsSweeperHandle | undefined;
  if (process.env.COMMERCIAL_REFRESH_EVENTS_SWEEP_DISABLED !== "1") {
    refreshEventsSweeper = startRefreshEventsSweeper();
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
      if (containerEventsWorker) {
        try { await containerEventsWorker.stop(); } catch { /* ignore */ }
      }
      if (alertScheduler) {
        try { await alertScheduler.stop(); } catch { /* ignore */ }
      }
      if (refreshEventsSweeper) {
        try { refreshEventsSweeper.stop(); } catch { /* ignore */ }
      }
      if (baselineSrv) {
        try { await baselineSrv.stop(); } catch { /* ignore */ }
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
      if (externalMtlsServer) {
        await new Promise<void>((resolve) => {
          try {
            externalMtlsServer!.close(() => resolve());
            const closeAll = (externalMtlsServer as unknown as { closeAllConnections?: () => void }).closeAllConnections;
            if (typeof closeAll === "function") closeAll.call(externalMtlsServer);
          } catch { resolve(); }
        });
      }
      try { await pricing.shutdown(); } catch { /* ignore */ }
      try { await redis.quit(); } catch { /* ignore */ }
      await closePool();
    },
    /** V3 2H 测试 / /healthz 探测用:内部代理实际监听地址(undefined = 未启用)。 */
    internalProxyAddress,
    /** V3 D.1b 测试 / /healthz 探测用:外部 mTLS 监听地址(undefined = 未启用)。 */
    externalMtlsAddress,
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
  AccountPoolBusyError,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
  ERR_ACCOUNT_POOL_BUSY,
  DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
  parseMaxConcurrentEnv,
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
