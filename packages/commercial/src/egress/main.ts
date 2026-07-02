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
 * 均按 transient 重试);cost 回执进队列重试(120s TTL 覆盖重启窗口)。
 *
 * fail-closed:split 模式必须配齐 INTERNAL_PROXY_* / INTERNAL_CONTROL_* /
 * OC_EGRESS_SECRET,任一缺失拒启(比"静默半配跑起来"好排查)。
 */

import { createServer as createHttpServer } from "node:http";
import IORedis from "ioredis";

import { loadConfig } from "../config.js";
import { getPool } from "../db/index.js";
import { PricingCache } from "../billing/pricing.js";
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
import { ocGatewayIpForChannel, ocInternalProxyPortForChannel } from "../agent-sandbox/v3supervisor.js";
import { getSelfHost } from "../compute-pool/queries.js";
import { rootLogger } from "../logging/logger.js";
import { CostEventSink } from "./costEventSink.js";
import { makeForwarder } from "./forwarder.js";

const log = rootLogger.child({ subsys: "egressMain" });

/** SIGTERM 后给在飞流的 drain 上限(systemd TimeoutStopSec 须 ≥ 此值+缓冲)。 */
const EGRESS_DRAIN_MS = Number(process.env.EGRESS_DRAIN_MS ?? 30 * 60_000);

export async function startEgress(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.OC_EGRESS_SPLIT) {
    throw new Error("[egress] OC_EGRESS_SPLIT!=1 — egress 进程只在 split 模式下运行,拒启");
  }
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

  const proxyHandler = makeAnthropicProxyHandler({
    pgPool: getPool(),
    pricing,
    preCheckRedis,
    scheduler,
    identity: identityStrategy,
    rateLimitRedis,
    refreshDeps: { health: healthTracker },
    // 跨进程 post-commit hooks:两者都收敛到 costSink FIFO(persist 先入队,
    // broadcast 后入队;master 端按序 apply,与原进程内顺序一致)。
    broadcastToUser: (uid, payload) => {
      costSink.enqueue({ kind: "broadcast", uid: uid.toString(), payload: payload as Record<string, unknown> });
    },
    appendCostCredits: async (requestId: string, rawUserId: string, costCredits: string, sessionId?: string | null) => {
      // 裸 uid 原样传;master 侧 appendCostCreditsForUser 统一加 c: 前缀(命名
      // 空间对齐逻辑留在唯一写入方,防两处漂移)。
      costSink.enqueue({
        kind: "persist",
        requestId,
        uid: rawUserId,
        costCredits,
        sessionId: sessionId ?? null,
      });
    },
    staticProviderKeys: {
      deepseek: cfg.DEEPSEEK_API_KEY,
      minimax: cfg.ARK_AGENT_PLAN_KEY,
      ark: cfg.ARK_CODING_PLAN_KEY,
    },
    getPhase6AccountUuidEnforce,
    getSessionPinMode,
    listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
  });

  // self-host uuid 与 master 同权威(PG compute host 表)——identity 双因子里
  // hostUuid 参与 bearer 归属校验,两进程必须同值。取失败拒启(egress 无降级路径)。
  const selfHostUuid = (await getSelfHost()).id;

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
    if (path === "/internal/v5/egress-health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, role: "egress", pendingCostEvents: costSink.pending }));
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
