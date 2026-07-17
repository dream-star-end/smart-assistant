/**
 * V5 egress 进程(独立 systemd 服务 openclaude-v5-egress)——
 * 根治"master 部署重启掐断在飞 LLM 生成流"。
 *
 * 职责(且仅此):
 *   1. 监听容器出站地址 INTERNAL_PROXY_BIND:INTERNAL_PROXY_PORT(172.31.0.1:18892);
 *   2. POST /v1/messages → 本进程内 anthropicProxy 全链(身份/限流/preCheck/账号池/
 *      上游流/计费 finalize)—— 状态全在 PG/Redis,跨进程天然一致;
 *   3. 其余路径 → 透明转发 master 控制口(forwarder.ts,deny /internal/v5/*);
 *   4. finalize 后的 cost 回执(SQLite 持久化 + WS 广播)打包 POST 回 master
 *      (costEventSink.ts → master http/internalCostEvent.ts)。
 *
 * 部署语义:deploy-v5.sh 默认只重启 master;egress 只在其相关代码变更时显式重启
 * (--egress),重启前 SIGTERM 走 drain(停接新连接,在飞流最多等 EGRESS_DRAIN_MS)。
 * master 重启期间:/v1/messages 完全无感;转发路径 503 transient(容器侧调用方
 * 均按 transient 重试);cost 持久化回执先 fsync 到本地 outbox,无 TTL 重试到 ACK。
 *
 * fail-closed:split 模式必须配齐 INTERNAL_PROXY_* / INTERNAL_CONTROL_* /
 * OC_EGRESS_SECRET,任一缺失拒启(比"静默半配跑起来"好排查)。
 */

import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";

import { loadConfig } from "../config.js";
import { getPool } from "../db/index.js";
import { PricingCache } from "../billing/pricing.js";
import {
  authorityKeyringProvider,
  getModelCatalogCache,
  isModelAuthorityEnforced,
} from "../billing/modelCatalogRuntime.js";
import { wrapIoredisForPreCheck } from "../billing/preCheck.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { AccountHealthTracker, wrapIoredisForHealth } from "../account-pool/health.js";
import { AccountScheduler } from "../account-pool/scheduler.js";
import { listEnabledGroupsForModel } from "../account-pool/groups.js";
import { getPhase6AccountUuidEnforce, getSessionPinMode } from "../admin/runtimeFlags.js";
import { createPgIdentityRepo } from "../auth/containerIdentity.js";
import { makeContainerIdentityStrategy } from "../auth/proxyIdentity.js";
import { makeLoadUserModelAuthz } from "../auth/userModelAuthz.js";
import { makeAnthropicProxyHandler } from "../http/anthropicProxy.js";
import { assertPlatformDefaultModelConfigured } from "../http/proxy/staticProviderMeta.js";
import { startLatencyProber } from "./latencyProber.js";
import { snapshotInflight } from "../http/proxy/inflightTracker.js";
import {
  EGRESS_CAPABILITIES,
  assertModelAuthorityCutoverFloor,
} from "../runtimeCapabilities.js";
import { ocGatewayIpForChannel, ocInternalProxyPortForChannel } from "../agent-sandbox/v3supervisor.js";
import { getSelfHost } from "../compute-pool/queries.js";
import { rootLogger } from "../logging/logger.js";
import { CODEX_TOKEN_REFRESH_PATH } from "../http/internalCodexTokenRefresh.js";
import { CODEX_RELAY_PREFIX } from "../http/internalCodexRelay.js";
import {
  buildCodexRelayHandler,
  buildCodexTokenRefreshHandler,
  putRemoteCodexAuthViaServiceableHost,
  readCodexContainerDir,
} from "../http/codexInternalAssembly.js";
import {
  type CodexDisableFanoutDeps,
  enqueueCodexDisableFanout,
} from "../account-pool/codexDisableFanout.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "../agent-sandbox/constants.js";
import { CostEventSink } from "./costEventSink.js";
import { makeForwarder } from "./forwarder.js";

const log = rootLogger.child({ subsys: "egressMain" });

/** SIGTERM 后给在飞流的 drain 上限(systemd TimeoutStopSec 须 ≥ 此值+缓冲)。 */
const EGRESS_DRAIN_MS = Number(process.env.EGRESS_DRAIN_MS ?? 30 * 60_000);

export async function startEgress(): Promise<void> {
  // D3④:进程实例标识 —— 优先 systemd invocation id(每次 (re)start 变化),否则随机
  // UUID。finalize 门槛用它区分"队列自然排空"与"egress 中途重启计数归零假绿"。
  const processStartId = process.env.INVOCATION_ID ?? randomUUID();
  // 出口拓扑与拆分前的 master 完全对齐(packages/cli gateway.ts 同款):
  // 有 HTTP(S)_PROXY env(日本 sing-box 节点)→ 装全局 EnvHttpProxyAgent,给
  // Anthropic/OpenAI 等出海上游用;国内静态 provider(ark glm/deepseek/minimax)
  // 在 makeStaticKeyUpstream 里显式挂 directEgressDispatcher() 直连,不受全局
  // 代理影响(staticProviderMeta egress="direct" 是那条链的单一权威)。
  // 漏装的后果:出海上游从 egress 进程直连出境 → 风控/地域封锁风险。
  if (
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
  ) {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
    log.info("egress_global_proxy_agent_installed", {});
  }
  const cfg = loadConfig();
  if (!cfg.OC_EGRESS_SPLIT) {
    throw new Error("[egress] OC_EGRESS_SPLIT!=1 — egress 进程只在 split 模式下运行,拒启");
  }
  // 步骤 5 兼容地板(方案 §7 步 5,R4-M2:egress 是四面之一)。marker 置位却 flag 关 = 拒启。
  assertModelAuthorityCutoverFloor();
  const bind = cfg.INTERNAL_PROXY_BIND;
  const port = cfg.INTERNAL_PROXY_PORT;
  const controlBind = cfg.INTERNAL_CONTROL_BIND;
  const controlPort = cfg.INTERNAL_CONTROL_PORT;
  const secret = cfg.OC_EGRESS_SECRET;
  if (!bind || port === undefined) throw new Error("[egress] INTERNAL_PROXY_BIND/PORT 必配,拒启");
  if (!controlBind || controlPort === undefined) {
    throw new Error("[egress] INTERNAL_CONTROL_BIND/PORT 必配(master 控制口转发目标),拒启");
  }
  if (!secret) throw new Error("[egress] OC_EGRESS_SECRET 必配,拒启");
  // 与 master 同款双权威错位防护:容器 egress 目标(supervisor 注入 env 的单一权威
  // helper)必须与本进程实际 bind 一致,否则容器一调用就挂。
  const expectBind = ocGatewayIpForChannel();
  const expectPort = ocInternalProxyPortForChannel();
  if (bind !== expectBind || port !== expectPort) {
    throw new Error(
      `[egress] bind 与 channel 期望不符:${bind}:${port}(期望 ${expectBind}:${expectPort}),拒启`,
    );
  }
  // 平台默认模型 key 缺失 → loud fail(与 master 同款 guard)。
  assertPlatformDefaultModelConfigured(cfg);

  const redis = new IORedis(cfg.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  const pricing = new PricingCache();
  try {
    await pricing.load();
  } catch (err) {
    // 与 master 同语义:不阻塞启动,cache 空时 handler 返 503 PRICING_NOT_READY。
    log.error("pricing_initial_load_failed", { err: (err as Error).message });
  }
  try {
    await pricing.startListener(cfg.DATABASE_URL);
  } catch (err) {
    log.error("pricing_listener_failed", { err: (err as Error).message });
  }

  const preCheckRedis = wrapIoredisForPreCheck(redis);
  const rateLimitRedis = wrapIoredis(redis);
  const healthTracker = new AccountHealthTracker({
    redis: wrapIoredisForHealth(redis as unknown as Parameters<typeof wrapIoredisForHealth>[0]),
  });
  const scheduler = new AccountScheduler({ health: healthTracker });
  const identityRepo = createPgIdentityRepo();
  const loadUserModelAuthz = makeLoadUserModelAuthz();
  const identityStrategy = makeContainerIdentityStrategy({
    repo: identityRepo,
    pricing,
    loadUserModelAuthz,
  });

  const controlBaseUrl = `http://${controlBind}:${controlPort}`;
  const costSink = new CostEventSink({ controlBaseUrl, secret });
  await costSink.init();

  // 静态 key 解析表 —— proxyHandler 与延迟探测器(0105)共用同一份,防两处漂移。
  const staticProviderKeys = {
    deepseek: cfg.DEEPSEEK_API_KEY,
    // 2026-07-07:切回 MiniMax 官方(回退 06-30 火山迁移;火山 Ark 大图识图挂死,官方 4.9s)。
    minimax: cfg.MINIMAX_TOKEN_PLAN_KEY,
    ark: cfg.ARK_CODING_PLAN_KEY,
    // 2026-07-05:OpenCode Go(qwen3.7-max/plus)。与 master internalProxyHandler 同口径注入。
    opencodego: cfg.OPENCODE_GO_API_KEY,
    // 2026-07-06:火山 Agent Plan Kimi(kimi-k2.7-code),与 minimax 共 ARK_AGENT_PLAN_KEY。
    kimi: cfg.ARK_AGENT_PLAN_KEY,
    // 2026-07-17:Moonshot 官方 Kimi For Coding(kimi-k3),独立订阅独立 key。
    moonshot: cfg.MOONSHOT_CODING_PLAN_KEY,
  };

  // ── 模型执行 catalog(模型权威批次 · 方案 §1.2/§4)────────────────────────────
  //
  // **这里才是 fence 真正生效的地方**:生产的 `/v1/messages` 全部走本进程,每个独立 HTTP
  // 请求在授权/路由前做一次 epoch fence(单行 SELECT,不做时间微缓存)+ authority 校验。
  // master 侧的同一份 handler 只服务非 split 拓扑。
  //
  // 两个模式都加载 catalog(影子期用真实流量证明"切判定源不改变任何请求的命运");
  // 加载失败 → 抛 → egress 拒启(fail-closed:半开状态会让每条请求都被 fence 拒)。
  // **生效面**:改本段或 gate/路由代码,部署必须 `deploy-v5.sh --egress`。
  const modelCatalog = await getModelCatalogCache();
  const modelAuthorityEnforce = isModelAuthorityEnforced();
  log.info("model_catalog_ready", {
    enforce: modelAuthorityEnforce,
    securityEpoch: modelCatalog.current().securityEpoch.toString(),
    executionRevision: modelCatalog.current().executionRevision.slice(0, 12),
  });

  const proxyHandler = makeAnthropicProxyHandler({
    pgPool: getPool(),
    pricing,
    preCheckRedis,
    scheduler,
    identity: identityStrategy,
    loadUserModelAuthz,
    rateLimitRedis,
    modelCatalog,
    modelAuthorityEnforce,
    // 公钥 keyring(验签用)。每请求现取:轮换五步期间 ring 会变,闭包快照会认不出新签名。
    authorityKeyring: authorityKeyringProvider(),
    refreshDeps: { health: healthTracker },
    // 跨进程 post-commit hooks:两者都收敛到 costSink FIFO(persist 先入队,
    // broadcast 后入队;master 端按序 apply,与原进程内顺序一致)。
    broadcastToUser: (uid, payload) => {
      costSink.enqueue({ kind: "broadcast", uid: uid.toString(), payload: payload as Record<string, unknown> });
    },
    appendCostCredits: async (
      requestId: string,
      rawUserId: string,
      costCredits: string,
      sessionId?: string | null,
      parentSessionId?: string | null,
      delegateAgentId?: string | null,
      turnKey?: string | null,
      parentTurnKey?: string | null,
    ) => {
      // 裸 uid 原样传;master 侧 appendCostCreditsForUser 统一加 c: 前缀(命名
      // 空间对齐逻辑留在唯一写入方,防两处漂移)。parentSessionId(委派父客户端会话)
      // 随 persist 事件过 egress→master,不能在 egress 边界丢弃否则 durable 归并失效。
      await costSink.enqueueDurable({
        kind: "persist",
        requestId,
        uid: rawUserId,
        costCredits,
        sessionId: sessionId ?? null,
        parentSessionId: parentSessionId ?? null,
        delegateAgentId: delegateAgentId ?? null,
        turnKey: turnKey ?? null,
        parentTurnKey: parentTurnKey ?? null,
      });
    },
    staticProviderKeys,
    getPhase6AccountUuidEnforce,
    getSessionPinMode,
    listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
  });

  // 0105:上游延迟探测器(admin「模型与服务商」页数据源)。挂 egress 因为这里才是真实 LLM
  // 流量的出口进程(dispatcher direct/proxy 语义一致);任何失败只告警,不影响在飞流主职。
  const latencyProber = startLatencyProber({ staticProviderKeys, log });

  // self-host uuid 与 master 同权威(PG compute host 表)——identity 双因子里
  // hostUuid 参与 bearer 归属校验,两进程必须同值。取失败拒启(egress 无降级路径)。
  const selfHostUuid = (await getSelfHost()).id;

  // ── codex 内部端点(M1b 架构决策:relay 归属 egress 进程)──────────────────
  // /internal/v3/codex-relay(流式)与 /internal/v3/codex/token-refresh(401 自愈)
  // 在 egress 本地处理,与 /v1/messages 同理:状态全在 PG,master 重启不掐断 codex
  // 在飞流/续 token。装配收口 http/codexInternalAssembly.ts(与 master 同一份实现)。
  // refresh 失败 disable 后的 fanout rebind 在本进程直接跑(FOR UPDATE 串行,
  // 与 master 的 drift reconciler 跨进程并发安全;两侧都收敛到 codexLazyMigrate helper)。
  const codexFanoutDeps: CodexDisableFanoutDeps = {
    writeAuth: {
      selfHostId: selfHostUuid,
      containerUid: V3_AGENT_UID,
      containerGid: V3_AGENT_GID,
      codexContainerDir: readCodexContainerDir(),
      putRemoteCodexAuth: putRemoteCodexAuthViaServiceableHost,
    },
    concurrency: 4,
    logger: rootLogger.child({ subsys: "egress", module: "codexDisableFanout" }),
  };
  const codexTokenRefreshHandler = buildCodexTokenRefreshHandler({
    identityRepo,
    rateLimitRedis,
    healthTracker,
    selfHostId: selfHostUuid,
    triggerCodexDisableFanout: (accountId) => {
      enqueueCodexDisableFanout(accountId, codexFanoutDeps);
    },
  });
  const codexRelayHandler = buildCodexRelayHandler({
    identityRepo,
    preCheckRedis,
    pgPool: getPool(),
    onImageCharge: (uid, charge) => {
      costSink.enqueue({
        kind: "broadcast",
        uid: uid.toString(),
        payload: {
          type: "outbound.cost_charged",
          costCredits: charge.costCredits,
          balanceAfter: charge.balanceAfter,
        },
      });
    },
  });

  const forward = makeForwarder({ controlBaseUrl });

  const server = createHttpServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const peerIp = req.socket.remoteAddress ?? "";
    if (path === "/v1/messages") {
      Promise.resolve(
        proxyHandler(req, res, { hostUuid: selfHostUuid, boundIp: peerIp }),
      ).catch((err) => {
        log.error("proxy_handler_threw", { err: (err as Error).message });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "INTERNAL", message: "egress handler error" } }));
        } else {
          try {
            res.destroy();
          } catch {
            /* */
          }
        }
      });
      return;
    }
    if (path === CODEX_TOKEN_REFRESH_PATH) {
      Promise.resolve(
        codexTokenRefreshHandler(req, res, { hostUuid: selfHostUuid, boundIp: peerIp }),
      ).catch((err) => {
        log.error("codex_token_refresh_handler_threw", { err: (err as Error).message });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "INTERNAL", message: "egress handler error" } }));
        } else {
          try { res.destroy(); } catch { /* */ }
        }
      });
      return;
    }
    if (path === CODEX_RELAY_PREFIX || path.startsWith(`${CODEX_RELAY_PREFIX}/`)) {
      Promise.resolve(
        codexRelayHandler(req, res, { hostUuid: selfHostUuid, boundIp: peerIp }),
      ).catch((err) => {
        log.error("codex_relay_handler_threw", { err: (err as Error).message });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "INTERNAL", message: "egress handler error" } }));
        } else {
          try { res.destroy(); } catch { /* */ }
        }
      });
      return;
    }
    if (path === "/internal/v5/egress-health") {
      // D3④:finalize 门槛差分数据源。processStartId + 单调计数器一并暴露,
      // 部署脚本据此判断队列真排空(startId 未变 ∧ pendingEnd=0 ∧ enqueuedDelta==sentDelta
      // ∧ expired/overflow delta=0)。
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      // capabilities:**构建级事实**(本 egress 版本实现了模型权威协议:每请求 epoch fence +
      // catalog 数据驱动路由)。deploy 的四面守卫在开 flag / 走 cutover 前读它 —— 一个旧
      // egress 进程(无 fence)会让 master 签发的权威在出站面失效,必须在启用前被拒。
      // enforced 是**开关态**(诊断用),与 capability 语义正交。
      res.end(
        JSON.stringify({
          ok: true,
          role: "egress",
          processStartId,
          ...costSink.healthCounters(),
          capabilities: [...EGRESS_CAPABILITIES],
          modelAuthority: { enforced: isModelAuthorityEnforced() },
        }),
      );
      return;
    }
    // 0106 — per-model 在飞快照(admin 容量面;master 的 model-ops 端点拉取,egress 是
    // /v1/messages 的独占进程,这里的计数即全量权威)。与 egress-health 同级内网只读面。
    if (path === "/internal/v5/egress-stats") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, role: "egress", inflight: snapshotInflight() }));
      return;
    }
    forward(req, res, peerIp);
  });
  // LLM 流可长达数十分钟,禁 socket 空闲超时误杀(与 master internal listener 同语义)。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  log.info("egress_listening", { bind, port, control: controlBaseUrl });
  // eslint-disable-next-line no-console
  console.log(`[egress] listening on ${bind}:${port} → control ${controlBaseUrl}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    latencyProber?.stop();
    // eslint-disable-next-line no-console
    console.log(`[egress] SIGTERM — draining in-flight streams (max ${EGRESS_DRAIN_MS}ms)…`);
    // close() 停接新连接,已建立连接(在飞流)自然完结;到 drain 上限强制退出。
    server.close(() => {
      void costSink.flush().finally(() => process.exit(0));
    });
    setTimeout(() => {
      // eslint-disable-next-line no-console
      console.log("[egress] drain timeout — force exit");
      process.exit(0);
    }, EGRESS_DRAIN_MS).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// 直接执行(systemd ExecStart=npx tsx packages/commercial/src/egress/main.ts)
const isDirectRun = process.argv[1]?.endsWith("egress/main.ts") || process.argv[1]?.endsWith("egress/main.js");
if (isDirectRun) {
  startEgress().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[egress] fatal:", err);
    process.exit(1);
  });
}
