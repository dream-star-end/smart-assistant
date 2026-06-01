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
import { deriveMediaSignKey } from "./http/mediaSign.js";
import { rootLogger } from "./logging/logger.js";
import { warmupLoginDummyHash } from "./auth/login.js";
import { secretToKey } from "./auth/jwt.js";
import { PricingCache, createModelHintProvider } from "./billing/pricing.js";
import { canUseModel } from "./billing/authzModels.js";
import { ALLOWED_INBOUND_MODELS, setModelHintProvider, setLiteratureSkillProvider } from "@openclaude/gateway";
import { getPreferences } from "./user/preferences.js";
import { getLiteratureSkillConfig } from "./admin/literatureConfig.js";
import {
  getPhase6AccountUuidEnforce,
  getSessionPinMode,
} from "./admin/runtimeFlags.js";
import { renderLiteratureSkillContent } from "./literatureSkill.js";
import { wrapIoredisForPreCheck } from "./billing/preCheck.js";
import { createHttpHupijiaoClient, type HupijiaoClient, type HupijiaoConfig } from "./payment/hupijiao/client.js";
import {
  AccountScheduler,
  ContainerStaleBindingError,
  pickCodexAccountForBindingInTx,
} from "./account-pool/scheduler.js";
import {
  type WriteAuthDeps,
  commitCodexRebindInTx,
  fetchSnapshotAndWriteContainerAuth,
} from "./account-pool/codexLazyMigrate.js";
import {
  type CodexDisableFanoutDeps,
  enqueueCodexDisableFanout,
} from "./account-pool/codexDisableFanout.js";
import { AccountHealthTracker, wrapIoredisForHealth } from "./account-pool/health.js";
import { writeCodexContainerAuthFile } from "./codex-auth/codexAuthFile.js";
import {
  putRemoteCodexContainerAuth,
  deleteRemoteCodexContainerAuth,
} from "./codex-auth/remoteCodexAuth.js";
import { tx } from "./db/queries.js";
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
  startCodexRefreshActor,
  type CodexRefreshActorHandle,
} from "./account-pool/codexAccountActor.js";
import {
  startCooldownRecoveryActor,
  type CooldownRecoveryActorHandle,
} from "./account-pool/cooldownRecoveryActor.js";
import {
  DEFAULT_V3_CODEX_CONTAINER_DIR,
  V3_CONTAINER_PORT,
  stopAndRemoveV3Container,
} from "./agent-sandbox/v3supervisor.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "./agent-sandbox/constants.js";
import {
  startPendingOrdersExpirer,
  type SweeperHandle as PendingOrdersExpirerHandle,
} from "./payment/pendingOrdersExpirer.js";
import {
  startOnboardingScheduler,
  type OnboardingSchedulerHandle,
} from "./inbox/onboarding.js";
import {
  startInboxEmailScheduler,
  type InboxEmailSchedulerHandle,
} from "./inbox/email.js";
import {
  makeAnthropicProxyHandler,
  type AnthropicProxyHandler,
} from "./http/anthropicProxy.js";
import { makePlatformContextLoader } from "./platform/platformContextLoader.js";
import { makeDefaultVolumeContextReader } from "./platform/volumeContextReader.js";
import {
  makeServerAuthoredHandler,
  SERVER_AUTHORED_PATH,
  type ServerAuthoredHandler,
} from "./http/internalServerAuthored.js";
import {
  CODEX_TOKEN_REFRESH_PATH,
  makeCodexTokenRefreshHandler,
  type CodexTokenRefreshHandler,
} from "./http/internalCodexTokenRefresh.js";
import {
  createCodexRouteContextForModel,
  expireCodexRouteContext,
  hasActiveOfficialOAuthAccountInGroup,
  listEnabledGroupsForModel,
} from "./account-pool/groups.js";
import {
  CODEX_RELAY_PREFIX,
  makeCodexRelayHandler,
  makeDefaultCodexRelayDb,
  type CodexRelayHandler,
} from "./http/internalCodexRelay.js";
import {
  appendCostCredits,
  appendServerAuthoredMessage,
  appendServerAuthoredMessageForRequest,
  getClientSession,
  // P1.7 slice 7c — broker assembly 需要的 master sqlite helpers
  upsertMasterClientSession,
  softDeleteMasterSession,
  allMasterWsessRows,
  getWechatBindingByUserId,
} from "@openclaude/storage";
import {
  WECHAT_OUTBOUND_PATH,
  makeOutboundReceiverHandler,
} from "./wechat/outboundReceiver.js";
import { MASTER_USER_PREFIX } from "./wechat/userIds.js";
import {
  LITERATURE_SEARCH_PATH,
  makeLiteratureProxyHandler,
  type LiteratureProxyHandler,
} from "./literatureProxy.js";
import {
  PLATFORM_PROMPT_SLOTS_PATH,
  makePlatformPromptSlotsHandler,
  type PlatformPromptSlotsHandler,
} from "./http/internalPlatformPromptSlots.js";
import { makeInboundDispatcher } from "./wechat/inboundDispatcher.js";
import { pickWechatInboundModel } from "./wechat/modelResolver.js";
import { makeNodeHttpContainerTransport } from "./wechat/nodeHttpContainerTransport.js";
import { makeIlinkSendAdapter } from "./wechat/ilinkSendAdapter.js";
import { createNoopRateLimiter } from "./wechat/rateLimiter.js";
import { makeWechatBroker, type WechatBroker } from "./wechat/broker.js";
import { createPgIdentityRepo } from "./auth/containerIdentity.js";
import { makeContainerIdentityStrategy } from "./auth/proxyIdentity.js";
import { makePgApiKeyRepo } from "./auth/apiKeyRepo.js";
import { makeApiKeyIdentityStrategy } from "./auth/apiKeyIdentity.js";
import {
  createUserChatBridge,
  ContainerUnreadyError,
  DEFAULT_MAX_FRAME_BYTES,
  type ResolveContainerEndpoint,
  type UserChatBridgeHandler,
  type BridgeMetricSink,
  type CodexBindingHandle,
} from "./ws/userChatBridge.js";
import { createTunnelContainerSocket } from "./ws/tunnelContainerSocket.js";
import {
  DEFAULT_V3_CCB_BASELINE_DIR,
  resolveCcbBaselineMounts,
  makePrewarmContainer,
  makeUidSingleflight,
  makeV3EnsureRunning,
  preheatV3Image,
  startIdleSweepScheduler,
  startMigrationReconcileScheduler,
  startOrphanReconcileScheduler,
  markV3ContainerActivity,
  startV3ContainerEventsWorker,
  startVolumeGcScheduler,
  createUserMediaResolver,
  isUserVolumeMediaPath,
  type IdleSweepScheduler,
  type MigrationReconcileScheduler,
  type OrphanReconcileScheduler,
  type UserMediaLocation,
  type V3ContainerEventsWorker,
  type V3SupervisorDeps,
  type VolumeGcScheduler,
} from "./agent-sandbox/index.js";
import {
  observeWsBridgeBuffered,
  observeWsBridgeSessionDuration,
  observeWsBridgeTtft,
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
  getFile as nodeAgentGetFile,
} from "./compute-pool/nodeAgentClient.js";
import { createContainerService } from "./compute-pool/containerService.js";
import { getHealthPoller, type HealthPoller } from "./compute-pool/nodeHealth.js";
import { initComputePool } from "./compute-pool/poolInit.js";
import { getImagePromoteScheduler } from "./compute-pool/imagePromote.js";
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
  /**
   * V3 multi-tenant `/api/uploads` 写入与 `/api/media` 读取的存储路径解析器。
   *
   * 把 `c:<uid>` 形式的 userId 映射到这台 master 上**用户 docker volume 宿主路径**
   * 的 uploads / generated **两个子目录**(同一 docker volume,一次 inspect 同时
   * 确认两 dir 可用)。容器侧 dispatchInbound / codex `image_gen` 通过相同的
   * volume mount 分别看到 `/home/agent/.openclaude/(uploads|generated)/`,从而
   * 消除 "master 写到自己 paths.{uploads,generated}Dir / 容器读自己同名 dir"
   * 的双视图 bug(两次同型回归:2026-05-09 uploads + 2026-05-12 generated)。
   *
   * 装配条件:agentRuntime 起得来(有 docker client)+ pool 已建立。两者任一缺失
   * (e.g. AGENT_IMAGE 没配),resolver 为 undefined,gateway 自动回退到旧的
   * `paths.uploadsDir` / `paths.generatedDir`(personal/单租户兼容)。
   *
   * fail-closed:DB 查无 active container → not-ready;远程 host → remote-host;
   * 多条 active → ambiguous;volume 不存在 → volume-missing。gateway 转译为对应
   * HTTP 4xx/5xx,不做静默回退。
   */
  resolveUserMediaDirs?: (userId: string) => Promise<UserMediaLocation>;
  /**
   * V3 multi-tenant **textual** 谓词:判定一个 resolvedPath 是否长得像
   * `/var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)[/<file>]`。
   *
   * **不是 user-scoped** —— 只检查路径形态,不验证 uid 等于当前请求 userId。
   * gateway HTTP allowlist **不能**用它(会引入 cross-tenant IDOR:用户 A 拿到
   * 用户 B 的绝对路径就能读)。allowlist 的 user-scoped predicate 应该用
   * `resolveUserMediaDirs(userId)` 解析出当前用户的 `{uploads, generated}` 后
   * 自己 closure。
   *
   * 唯一合法用途:启动时 `.tmp-*` orphan sweep(无 userId 上下文,只想匹配
   * docker volumes 根下的 user volume 目录壳子)。
   */
  isUserVolumeMediaPath?: (resolvedPath: string) => boolean;
  /**
   * v1.0.192 — 给 gateway `handleUpload` 在写 user docker volume 之前用的
   * 冷启动护栏。**结构化返回**(不抛 ContainerUnreadyError),让 gateway 保持
   * 零编译期依赖 commercial 子模块的边界(server.ts 头部明确注释:不 import
   * @openclaude/commercial)。
   *
   * 其他 error(DB 抖 / docker daemon 不可达 / supervisor wired-but-broken)
   * 仍然 throw,gateway 端 catch 后兜底 503。
   *
   * 共享同一 per-uid singleflight(与 commercial 内部 `/api/media-signed` +
   * WS bridge 同闭包),reload 时不会让 upload 路径成为 DB INSERT race 输家。
   *
   * 未注入(agentRuntime 没起 / v3Deps 缺) → gateway 直接跳过冷启动护栏,
   * 走原 `_resolveMediaDirs` 行为(personal/legacy 单租户路径)。
   */
  ensureContainerReady?: (
    uid: bigint,
  ) => Promise<{ ok: true } | { ok: false; retryAfterSec: number; reason: string }>;
  /**
   * 2026-05-16 hotfix — remote-host upload push hook。
   *
   * 当 `resolveUserMediaDirs(userId)` 返回 `{kind:"fail", reason:"remote-host",
   * hostUuid, uploads, generated}` 时,gateway 把本地暂存好的字节(stream→
   * digest 校验完成)通过这个 hook 推到 host 上的 docker volume:
   *   `${uploads}/${digest}.${ext}` 或 `${generated}/${name}`
   *
   * 实现:getHostById(hostUuid) → hostRowToTarget → nodeAgentPutFile(target,
   * remotePath, content, 0o644, 1000, 1000) → finally psk.fill(0)。
   *
   * 错误语义:任意阶段失败(row 不存在 / agent 不可达 / HTTP >=400)直接抛,
   * gateway 转 502 "remote storage push failed";frontend 重试合理。
   *
   * 装配条件同 `resolveUserMediaDirs`(agentRuntime 在手),为简化保持总是
   * 装配 —— closure 内部自己用 pool,与上面的 resolver 一致。
   */
  pushRemoteHostUpload?: (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => Promise<void>;
  /**
   * 2026-05-16 hotfix Phase 2 — remote-host **读路径**对称 hook。
   *
   * 当 `resolveUserMediaDirs(userId)` 返回 `remote-host` 失败,gateway 的
   * `handleMediaGet` / `handleApiFile` 通过本 hook 从远端 node-agent /files GET
   * 拉用户卷下的文件回 master,由 master 服给浏览器/API 客户端。
   *
   * 实现:getHostById(hostUuid) → hostRowToTarget → nodeAgentGetFile(target,
   * remotePath) → finally psk.fill(0)。
   *
   * 返回:
   *   - `Buffer` (含空 Buffer = 0 字节文件,合法):远端命中
   *   - `null`:远端 404(node-agent 明确不存在,gateway 可选择 fallback 到另一
   *     目录或最终 404 给用户)
   *
   * 错误:任意阶段失败(row 不存在 / agent 不可达 / mTLS / HTTP >=400 非 404)
   *   直接抛 → gateway 转 502 "remote storage pull failed";frontend 重试合理。
   *
   * 装配条件、psk 清零纪律与 `pushRemoteHostUpload` 完全对称。
   */
  pullRemoteHostMedia?: (args: {
    hostUuid: string;
    remotePath: string;
  }) => Promise<Buffer | null>;
  /**
   * P1.7 slice 7c — WeChat broker 入站入口。
   *
   * 装配条件:
   *   - cfg.WECHAT_BROKER_ENABLED === true (env WECHAT_BROKER_ENABLED=1)
   *   - selfHostUuid / dispatchInternal 等基础设施已就绪
   *
   * gateway 不 import commercial 类型 — 这里只暴露 broker.onInbound 的最小投影
   * (结构对齐 gateway 的 `CommercialHook.wechatBroker.onInbound` 形状)。返回
   * `unknown` 让 caller 不感知 BrokerInboundOutcome 内部 union;broker 自己
   * never-throw,caller 不需要 try/catch。
   */
  wechatBroker?: {
    onInbound(evt: {
      bindingUserId: string;
      accountId?: string;
      senderId: string;
      text: string;
      messageId?: string;
      itemTypes?: string;
      rawPayload?: unknown;
      idempotencyKey: string;
      receivedAt: number;
      channel?: "wechat";
      agentId?: string;
    }): Promise<unknown>;
    cleanupBinding(bindingUserId: string): Promise<unknown>;
  };
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

  // 0042 — agent-uplink-probe 专用快路径:绕过 status='ready' 与 X-V3-Container-IP 校验。
  // 目的:让 quarantined host 也能从 uplink-probe-failed 自愈;同时不开放任何代理能力,
  // 仅返回 200 {ok:true,hostUuid} 让 agent 知道 mTLS+fingerprint 校验通过。
  // 请求路径硬匹配 GET /v3/agent-uplink-probe。
  if (req.method === "GET" && req.url === "/v3/agent-uplink-probe") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, hostUuid }));
    return;
  }

  // 业务流量(/v1/messages 等)需要 host 处于 ready
  if (row.status !== "ready") {
    sendMtlsError(res, 503, "HOST_NOT_READY", { status: row.status });
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

  // 0060 — 把 per-model extra_system_prompt 注入到 gateway promptSlots。
  // gateway 不依赖 commercial(personal 版没这一行);commercial 启动时把 cache 反向暴露。
  // canonicalize 责任在 provider 层(plan):传入 firstParty 带日期 alias 也能命中 DB 短名。
  // PricingCache 缓存空(initial load 失败)时 get() 自然返 null → buildModelHintSlot 落 null,
  // 不会影响 prompt 构建。
  // canonical id 直接取 PricingCache 命中行的 model_id(详见 createModelHintProvider 注释)。
  setModelHintProvider(createModelHintProvider(pricing));

  // 0069 — SKILLS_LITERATURE slot 反向钩子:容器 spawn 重建 system prompt 时读窄配置,
  // admin 改完下次 spawn 自然生效(无 cache / 无 LISTEN/NOTIFY,见 0069 migration 注释)。
  // 关键最小权限分流:这里**只**调 getLiteratureSkillConfig()(不解密 token),bearer
  // plaintext 只在 proxy 路径(getLiteratureConfig(false))才会出现。
  // fail-soft:DB 抖动 → 返 null + warn,prompt 构建照样推进。
  setLiteratureSkillProvider(async () => {
    try {
      const cfg = await getLiteratureSkillConfig();
      if (!cfg.enabled || !cfg.token_set) return null;
      return {
        name: "SKILLS_LITERATURE",
        content: renderLiteratureSkillContent(cfg),
      };
    } catch (err) {
      // 单行 DB 读失败就跳过 slot,不要让 master DB 闪断拖垮容器系统 prompt 构建。
      // 选 warn 不 error:这条 slot 是增强非必需,日志噪声压低。
      // eslint-disable-next-line no-console
      console.warn("[commercial] literatureSkillProvider read failed, skipping slot:", err);
      return null;
    }
  });

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
  // 2026-05-05 v3 commercial server-authored persistence:18791 plain + 18443 mTLS
  // 共享同一个 dispatcher,按 url path 分流到 anthropicProxy 或 internalServerAuthored。
  // 在 internalProxyHandler 构造完毕后赋值;mTLS listener 读它而不是 internalProxyHandler。
  let dispatchInternal: AnthropicProxyHandler | undefined;
  // 前向引用占位:userChatBridge 在下方创建,但 anthropicProxy 在这里就要它的 broadcastToUser。
  // 给 proxy 的 dep 是稳定的闭包(总是调 bridgeBroadcastRef.current),创建 bridge 后赋值。
  // 在 bridge 初始化完成前到达的 cost_charged broadcast 会走到 noop,不 throw 也不落盘(前端
  // 看不到积分显示,但扣费本身仍生效;生产上 proxy 处理请求前 bridge 必已初始化)。
  const bridgeBroadcastRef: { current: (uid: bigint, payload: unknown) => void } = {
    current: () => { /* bridge 还没装好,静默丢弃 */ },
  };
  // P1.7 slice 7c — broker 前向引用。dispatchInternal 在 line ~883 装配,需要路由
  // `/internal/v3/wechat-outbound` → broker.outboundHandler;但 broker 本身依赖
  // resolveContainerEndpoint(line ~1529)装配完才能 makeInboundDispatcher → makeWechatBroker。
  // 这层 ref 把"路由表"(dispatchInternal)与"broker 实例"装配顺序解耦,与
  // bridgeBroadcastRef 同型:proxy 闭包总读 ref.current,broker 未就绪时短路 404 不 throw。
  const wechatBrokerRef: { current: WechatBroker | null } = { current: null };
  // v1.0.120 feat/codex-disable-rebind:fanoutDeps 依赖 v3Deps.putRemoteCodexAuth,
  // 必须在 v3Deps 装配后(line ~1067)才能赋值;但 proxy / codex token refresh
  // handler / commercialHttpDeps 在更早就要拿到 trigger 闭包,故用 ref 打破先后。
  //
  // 装配前到达的事件(理论不可能,proxy 接请求前 v3Deps 已就绪)走 noop。
  const triggerCodexDisableFanoutRef: { current: (accountId: bigint) => void } = {
    current: () => { /* fanoutDeps 还没装好,静默丢弃 */ },
  };
  const triggerCodexDisableFanout = (accountId: bigint): void => {
    triggerCodexDisableFanoutRef.current(accountId);
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

  // V3 CC 外接 plan Phase 3(2026-05-18):rateLimitRedis 与 loadUserModelAuthz
  // 都提到 internal 块外作为外层 const,让 container strategy(私有 18791/18443)
  // 和 api-key strategy(公网 /api/anthropic/v1/messages)共享同一份依赖闭包,
  // 避免两份同型实现长出漂移(Codex Phase 3 plan-review NIT 采纳)。
  //
  // 注:rateLimitRedis 仅在两条 proxy strategy 中消费;放在外层不会额外占资源
  // (redis 客户端是同一个,wrapIoredis 只是 typed-method 投影)。
  const sharedRateLimitRedis = wrapIoredis(redis);
  const loadUserModelAuthz = async (
    uid: bigint,
  ): Promise<{
    role: "user" | "admin";
    grantedModelIds: ReadonlySet<string>;
  }> => {
    const { query } = await import("./db/queries.js");
    const { listGrantsForUser } = await import("./admin/modelGrants.js");
    const r = await query<{ role: string }>(
      "SELECT role FROM users WHERE id = $1",
      [uid],
    );
    if (r.rows.length === 0) {
      // user 在 DB 里不存在(理论被 verifyContainerIdentity 截掉,这里是
      // 防御编程)。fail-closed:认 user role,grants 空集 → 公开 model
      // 还能用,admin/hidden model 一律拒。
      return { role: "user", grantedModelIds: new Set<string>() };
    }
    const roleRaw = r.rows[0].role;
    const role: "user" | "admin" = roleRaw === "admin" ? "admin" : "user";
    const grants = await listGrantsForUser(uid);
    return {
      role,
      grantedModelIds: new Set(grants.map((g) => g.model_id)),
    };
  };

  if (
    !options.skipInternalProxy &&
    proxyBind &&
    proxyPort !== undefined &&
    selfHostUuid
  ) {
    try {
      const identityRepo = createPgIdentityRepo();
      const rateLimitRedis = sharedRateLimitRedis;
      // V3 Phase 2(2026-05-18 anthropicProxy 拆分):身份层 strategy。
      // 把 verify + recordHostRequest + loadUserModelAuthz + canUseModel 收口到
      // IdentityStrategy 单一注入点。loadUserModelAuthz 闭包形状不变(从权威源 DB
      // 读 role + grants,fail-closed throw → handler 500)。
      //
      // V3 CC 外接 plan Phase 3:loadUserModelAuthz 已提到外层共享(见上方注释),
      // 这里直接传引用,与 api-key strategy 走同一份业务规则。
      const identityStrategy = makeContainerIdentityStrategy({
        repo: identityRepo,
        pricing,
        loadUserModelAuthz,
        // recordHostRequest 不显式注入,strategy 内部走模块级 default
        // (../compute-pool/hostReqCounter.recordHostRequest)。
      });
      internalProxyHandler = makeAnthropicProxyHandler({
        pgPool: getPool(),
        pricing,
        preCheckRedis,
        scheduler,
        identity: identityStrategy,
        rateLimitRedis,
        // HOTFIX 2026-04-21: 不传 refreshDeps 导致 anthropicProxy 里
        //   `deps.refreshDeps && pick.expires_at && shouldRefresh(...)` 永远 false,
        // OAuth token 过期后不会自动 refresh,结果上游直接 401。
        // health 注入进来是为了 refresh 失败时按规约走 health.manualDisable。
        // v1.0.120:triggerCodexDisableFanout 注入 — disableOnFailure 内部
        // 按 provider 二次过滤,claude 账号 refresh 失败不会误触发 codex fanout。
        refreshDeps: { health: healthTracker, triggerCodexDisableFanout },
        // 真实扣费积分推送 —— proxy 在 finalize.commit 后调,通过 bridge 把
        // outbound.cost_charged 帧发给用户。bridge 启动顺序在 proxy 之后,
        // 故用 ref 打破先后(构造期调用是 noop,请求期 bridge 必已 wire)。
        broadcastToUser: (uid, payload) => bridgeBroadcastRef.current(uid, payload),
        // Plan §4.2 改动 4 — durable persist of debited costCredits into
        // master's `client_sessions.messages[i].usage.costCredits`. Storage
        // owns the (sessionId, msgId) lookup via `server_authored_request_map`
        // and falls back to `pending_usage_patches` when the assistant sink
        // POST hasn't landed yet.
        appendCostCredits,
        // 2026-05-02 deepseek 接入:cfg 在外层闭包已 loadConfig() 过(line 379),
        // 这里直接读取。未配置 → undefined → proxy 命中 deepseek 模型时 503。
        deepseekApiKey: cfg.DEEPSEEK_API_KEY,
        // v1.0.207 起 Phase 6 account_uuid 锚定(plan §3.0)+ csap session pin 三态
        // (0072+0073+0074),从 env-only 迁到 `system_settings` 表(admin UI 立即可改,
        // 不需要 systemctl restart)。注入 30s TTL cache 的 getter
        // (`admin/runtimeFlags.ts`)— pickUpstream 入口 await 一次冻结到局部常量,
        // scheduler.pick 与 hook 同值消费,保留 plan §5.5.4 竞态防护设计。
        getPhase6AccountUuidEnforce,
        getSessionPinMode,
        listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
      });
      // 2026-05-05 v3 commercial server-authored persistence — 复用 18791/18443
      // 同一个 listener,新加 POST /internal/v3/server-authored-message。
      // 路由由 dispatchInternal 按 url path 分流;仅 path 完全匹配 SERVER_AUTHORED_PATH
      // 才进新 handler,其它路径仍透到 anthropicProxy(其内部还有 /v1/messages 白名单)。
      // 新 handler 与 anthropicProxy 共用 (hostUuid, boundIp) ctx 与 verifyContainerIdentity 双因子。
      // 详见 packages/commercial/src/http/internalServerAuthored.ts。
      const serverAuthoredHandler: ServerAuthoredHandler = makeServerAuthoredHandler({
        identityRepo,
        storage: {
          appendServerAuthoredMessage,
          appendServerAuthoredMessageForRequest,
        },
      });
      // Codex reverse-RPC `account/chatgptAuthTokens/refresh` over HTTP.
      // Container's gateway forwards 401-recovery refresh asks here; we read
      // the bound codex_account, refresh upstream, persist to DB + per-container
      // auth.json under FOR UPDATE, and return the new token. Without this
      // path every codex 401 fails the turn (-32601 method-not-found).
      const codexContainerDirForRefresh =
        process.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
      const codexTokenRefreshHandler: CodexTokenRefreshHandler = makeCodexTokenRefreshHandler({
        identityRepo,
        rateLimitRedis,
        codexContainerDir: codexContainerDirForRefresh,
        containerUid: V3_AGENT_UID,
        containerGid: V3_AGENT_GID,
        // selfHostId 取自外层闭包 selfHostUuid;此分支已 guard 它非空。
        selfHostId: selfHostUuid,
        // refreshDeps 注入 healthTracker — 保持与 anthropicProxy 一致(失败走
        // health.manualDisable 路径)。
        // v1.0.120:triggerCodexDisableFanout — codex token refresh 失败 disable
        // 后立刻 fanout rebind 其他活跃容器,避免老 token 仍被 codex CLI 沿用。
        refreshDeps: { health: healthTracker, triggerCodexDisableFanout },
        db: {
          // 注:两处都 LEFT JOIN claude_accounts 取 ca.status,以让 handler
          // 拒刷 disabled/quarantined/已删 账号 — 见 codex round 2 BLOCKER#2。
          // FOR UPDATE 仍只锁 agent_containers(`OF ac` 显式收窄,避免锁
          // claude_accounts 行,与 lazy migrate 的 `FOR UPDATE OF ac` 兼容)。
          async readContainerAccount(containerId) {
            const r = await getPool().query<{
              codex_account_id: string | null;
              user_id: string;
              state: string;
              host_uuid: string | null;
              account_status: string | null;
            }>(
              `SELECT ac.codex_account_id::text AS codex_account_id,
                      ac.user_id::text AS user_id,
                      ac.state,
                      ac.host_uuid::text AS host_uuid,
                      ca.status AS account_status
                 FROM agent_containers ac
                 LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
                WHERE ac.id = $1`,
              [containerId],
            );
            if (r.rows.length === 0) return null;
            const row = r.rows[0];
            return {
              codexAccountId: row.codex_account_id === null ? null : BigInt(row.codex_account_id),
              userId: BigInt(row.user_id),
              state: row.state,
              hostUuid: row.host_uuid,
              accountStatus: row.account_status,
            };
          },
          async txWithLock(containerId, fn) {
            return await tx(async (client) => {
              const lockRes = await client.query<{
                codex_account_id: string | null;
                user_id: string;
                state: string;
                host_uuid: string | null;
                account_status: string | null;
              }>(
                `SELECT ac.codex_account_id::text AS codex_account_id,
                        ac.user_id::text AS user_id,
                        ac.state,
                        ac.host_uuid::text AS host_uuid,
                        ca.status AS account_status
                   FROM agent_containers ac
                   LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
                  WHERE ac.id = $1
                    FOR UPDATE OF ac`,
                [containerId],
              );
              const row =
                lockRes.rows.length === 0
                  ? null
                  : {
                      codexAccountId:
                        lockRes.rows[0].codex_account_id === null
                          ? null
                          : BigInt(lockRes.rows[0].codex_account_id),
                      userId: BigInt(lockRes.rows[0].user_id),
                      state: lockRes.rows[0].state,
                      hostUuid: lockRes.rows[0].host_uuid,
                      accountStatus: lockRes.rows[0].account_status,
                    };
              return await fn(client, row);
            });
          },
        },
        fileWriter: {
          async writeLocal(args) {
            await writeCodexContainerAuthFile(args);
          },
          // Remote write — same getHostById → hostRowToTarget → putRemote →
          // finally psk.fill(0) shape as v3Deps.putRemoteCodexAuth (line ~883).
          // Constructed inline because v3Deps is initialized *after* this
          // dispatchInternal block; we don't want to depend on declaration
          // order. The handler only invokes this when row.host_uuid !== self.
          async writeRemote(hostUuid, containerId, accessToken, lastRefreshIso) {
            const row = await computeQueries.getHostById(hostUuid);
            if (!row) {
              throw new Error(
                `internalCodexTokenRefresh.writeRemote: compute_host ${hostUuid} not found`,
              );
            }
            const target = hostRowToTarget(row);
            try {
              await putRemoteCodexContainerAuth(
                target,
                containerId,
                accessToken,
                lastRefreshIso,
              );
            } finally {
              target.psk?.fill(0);
            }
          },
        },
      });
      // /v3/literature/search — DeepXiv 文献检索 proxy。复用 identityRepo
      // (同 anthropicProxy 的双因子身份),token 留在 master,容器只走 mTLS 内部 proxy。
      // GET-then-INCR Lua 配额 + per-container 60req/5min in-memory limiter。
      const literatureProxyHandler: LiteratureProxyHandler = makeLiteratureProxyHandler({
        identityRepo,
        redis,
      });
      // /internal/v3/platform-prompt-slots — 容器 → master 拉取平台级 prompt slot
      // (SKILLS_LITERATURE / MODEL_HINT)。镜像 build 排除 packages/commercial,所以
      // 容器进程内的 gateway 看不到 setLiteratureSkillProvider / setModelHintProvider
      // 注册的 hook;这条 endpoint 把 master 持有的 slot 内容 GET 给容器,在容器
      // buildPromptContext 时合并进 extra-prompt.md。详见
      // packages/commercial/src/http/internalPlatformPromptSlots.ts 头注。
      const platformPromptSlotsHandler: PlatformPromptSlotsHandler =
        makePlatformPromptSlotsHandler({
          identityRepo,
          pricingCache: pricing,
        });
      const codexRelayHandler: CodexRelayHandler = makeCodexRelayHandler({
        identityRepo,
        db: makeDefaultCodexRelayDb(),
      });
      dispatchInternal = (req, res, ctx) => {
        const path = (req.url ?? "/").split("?")[0];
        if (path === SERVER_AUTHORED_PATH) {
          return serverAuthoredHandler(req, res, ctx);
        }
        if (path === LITERATURE_SEARCH_PATH) {
          return literatureProxyHandler(req, res, ctx);
        }
        if (path === PLATFORM_PROMPT_SLOTS_PATH) {
          return platformPromptSlotsHandler(req, res, ctx);
        }
        if (path === CODEX_TOKEN_REFRESH_PATH) {
          return codexTokenRefreshHandler(req, res, ctx);
        }
        if (path === CODEX_RELAY_PREFIX || path.startsWith(`${CODEX_RELAY_PREFIX}/`)) {
          return codexRelayHandler(req, res, ctx);
        }
        if (path === WECHAT_OUTBOUND_PATH) {
          // P1.7 slice 7c — wechat broker outbound 接收点
          // broker 自带 brokerEnabled() 短路 403,无需在此重判 cfg.WECHAT_BROKER_ENABLED;
          // 未装配(ref.current=null)时显式 404,避免 caller container 把缺失误读为 503/超时
          // (回 retry,污染 retryQueue)— 404 在 v3WechatOutbound 端被分类为 fatal,直接 drop。
          const broker = wechatBrokerRef.current;
          if (!broker) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({
              error: { code: "WECHAT_BROKER_NOT_ASSEMBLED", message: "wechat broker not assembled" },
            }));
            return Promise.resolve();
          }
          return broker.outboundHandler(req, res, ctx);
        }
        return internalProxyHandler!(req, res, ctx);
      };
      internalProxyServer = createHttpServer((req, res) => {
        // self-host 路径:container → plain HTTP 18791 → 这里。peerIp 就是 container 的 bound_ip,
        // hostUuid 固定 = selfHostUuid(本机容器不需要也不可能带 mTLS cert)。
        // selfHostUuid 在外层闭包已取,保证非 undefined(否则根本走不到 createHttpServer 这行)。
        const peerIp = req.socket.remoteAddress ?? "";
        // dispatchInternal 在外层闭包已被赋值;TS 不能静态证明 closure 内非 undefined,
        // 但 createHttpServer 只能在赋值之后被回调触发,故 ! 安全。
        Promise.resolve(
          dispatchInternal!(req, res, { hostUuid: selfHostUuid!, boundIp: peerIp }),
        ).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[commercial] internal listener handler threw:", err);
          if (!res.headersSent) {
            try {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: { code: "INTERNAL", message: "internal listener error" } }));
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
      dispatchInternal = undefined;
    }
  } else if (!options.skipInternalProxy) {
    // eslint-disable-next-line no-console
    console.log(
      "[commercial] internal anthropic proxy disabled; missing INTERNAL_PROXY_BIND / INTERNAL_PROXY_PORT",
    );
  }

  // V3 CC 外接 plan Phase 3(2026-05-18)— public-facing
  // `POST /api/anthropic/v1/messages` 的第二个 AnthropicProxyHandler 实例。
  //
  // 与 internalProxyHandler 平行装配,**不**依赖 INTERNAL_PROXY_BIND/PORT/selfHostUuid
  // —— external 不监听端口、不需要 selfHostUuid,直接挂在公网 commercialHandler 的
  // pre-route adapter 上(见 http/router.ts 的 `CC 外接 endpoint` 块)。
  //
  // 两实例的唯一差异是 IdentityStrategy:
  //   - internal:`makeContainerIdentityStrategy`(容器双因子 + recordHostRequest)
  //   - external:`makeApiKeyIdentityStrategy`(Bearer `oc-cc.*` token,无 recordHostRequest)
  // 其它依赖(pricing / preCheckRedis / scheduler / refreshDeps / 计费 / 广播)完全
  // 共享 —— 计费 / 账号池 / 上游路由语义两路必须一致,唯一分歧是身份维度。
  //
  // 装配失败语义(Codex Phase 3 plan-review MINOR 1):catch + undefined,router
  // 见 undefined 走 503 EXTERNAL_PROXY_UNAVAILABLE 而非 404(部署故障不该伪装成
  // "用户 URL 写错")。
  let externalApiKeyProxy: AnthropicProxyHandler | undefined;
  if (!options.skipInternalProxy) {
    try {
      const apiKeyRepo = makePgApiKeyRepo(getPool());
      const apiKeyStrategy = makeApiKeyIdentityStrategy({
        repo: apiKeyRepo,
        pricing,
        loadUserModelAuthz,
        logger: rootLogger.child({ subsys: "apiKeyIdentity" }),
      });
      // Phase 5 platform envelope rewriter wiring(2026-05-21)。
      // secret 缺失 → throw → 外层 catch 将 externalApiKeyProxy 置 undefined,
      // 同 hupi/deepseek 已有的"缺配置 → 端点 503"模式一致(non-fatal,主进程继续)。
      // Loader 持有 PlatformContextReader 单例,master 进程生命期与之绑定,无须 close。
      if (!cfg.PLATFORM_HMAC_SECRET) {
        throw new Error(
          "PLATFORM_HMAC_SECRET required for external ApiKey proxy (Phase 5 envelope)",
        );
      }
      const platformContextLoader = makePlatformContextLoader({
        reader: makeDefaultVolumeContextReader(),
      });
      externalApiKeyProxy = makeAnthropicProxyHandler({
        pgPool: getPool(),
        pricing,
        preCheckRedis,
        scheduler,
        identity: apiKeyStrategy,
        rateLimitRedis: sharedRateLimitRedis,
        // 与 internal 同型:OAuth refresh 走 health + codex disable fanout。
        refreshDeps: { health: healthTracker, triggerCodexDisableFanout },
        // bridge broadcastToUser 同型 ref 闭包;externalApiKeyProxy 装配于
        // bridge 之前是正常顺序(请求期 bridge 必已就绪)。
        broadcastToUser: (uid, payload) => bridgeBroadcastRef.current(uid, payload),
        appendCostCredits,
        deepseekApiKey: cfg.DEEPSEEK_API_KEY,
        platformContextLoader,
        platformServerSecret: cfg.PLATFORM_HMAC_SECRET,
        // v1.0.207 — external ApiKey proxy 与 internal proxy 共用 runtime flag getter,
        // 同一个 30s TTL cache(`admin/runtimeFlags.ts`)。
        getPhase6AccountUuidEnforce,
        getSessionPinMode,
        listEnabledAccountGroupsForModel: listEnabledGroupsForModel,
      });
      // eslint-disable-next-line no-console
      console.log(
        "[commercial] external api-key anthropic proxy assembled (POST /api/anthropic/v1/messages)",
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[commercial] external api-key proxy failed to assemble; endpoint will return 503:",
        err,
      );
      externalApiKeyProxy = undefined;
    }
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
    dispatchInternal &&
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
      // 2026-05-05: 用 dispatchInternal 而不是 internalProxyHandler,这样
      // remote-host 容器也能命中 /internal/v3/server-authored-message 路径,
      // 与 self-host 路径行为一致(同一 dispatcher 共享 path 分流逻辑)。
      const capturedHandler = dispatchInternal;
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

  // v3 signed-URL media key —— HKDF(bridgeSecret, info="oc-media-sign-v1") 派生
  // 32-byte 子 key,与 bridgeSecret 同生命周期。bridgeSecret 缺失时 mediaSignKey 也
  // undefined,signed URL endpoints 自动 503 SIGN_DISABLED。
  //
  // **没有 cookie fallback**:前端拿到 503/null 后媒体保持占位(透明 1x1 / 空 src),
  // 不会偷偷退回 `<img src="/api/file?path=...">` —— 那条路径正是 iOS Safari 丢
  // cookie 的根因,绕回去等于把 bug 重新放出来。bridgeSecret 缺失通常意味整个
  // file proxy 都没装配(单租户 personal 版),本来也用不到 commercial 媒体渲染。
  let mediaSignKey: Buffer | undefined;
  if (bridgeSecret) {
    try {
      mediaSignKey = deriveMediaSignKey(bridgeSecret);
      // eslint-disable-next-line no-console
      console.log("[commercial] v3 media signing key derived");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commercial] media sign key derivation failed; signed URL DISABLED", {
        error: (err as Error)?.message ?? String(err),
      });
      mediaSignKey = undefined;
    }
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
            // v1.0.72 — 远端 codex auth 写/删 helper:统一在此一处做
            // getHostById → hostRowToTarget → put/delete → finally psk.fill(0)
            // 三处调用方(provisionV3Container / lazy migrate / stopAndRemove)
            // 都通过这两个回调,避免泄密 buffer 散落。
            //
            // 失败语义:put 抛 → caller fallback NULL bind;delete 抛 → caller
            // 应吞掉(best-effort,与本地 removeCodexContainerAuthDir 一致)。
            // 本闭包不做 catch —— 让 caller 决定。
            putRemoteCodexAuth: async (
              hostUuid: string,
              containerId: string,
              accessToken: string,
              lastRefreshIso: string,
            ) => {
              const row = await computeQueries.getHostById(hostUuid);
              if (!row) {
                throw new Error(
                  `putRemoteCodexAuth: compute_host ${hostUuid} not found`,
                );
              }
              const target = hostRowToTarget(row);
              try {
                await putRemoteCodexContainerAuth(
                  target,
                  containerId,
                  accessToken,
                  lastRefreshIso,
                );
              } finally {
                target.psk?.fill(0);
              }
            },
            deleteRemoteCodexAuth: async (
              hostUuid: string,
              containerId: string,
            ) => {
              const row = await computeQueries.getHostById(hostUuid);
              if (!row) {
                throw new Error(
                  `deleteRemoteCodexAuth: compute_host ${hostUuid} not found`,
                );
              }
              const target = hostRowToTarget(row);
              try {
                await deleteRemoteCodexContainerAuth(target, containerId);
              } finally {
                target.psk?.fill(0);
              }
            },
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

      // 0042 — 启动时 compute pool 初始化:
      //   1. inspect 本地 OC_RUNTIME_IMAGE → 算 desiredImageId
      //   2. setDesiredImage(打开 placement gate)
      //   3. setLoadedImage(self,= master 本机 image)
      //   4. backfill:并发 4 / 单 host 30s / 整体 5min,拉一遍 /health 给非-self host 写各维度
      //   5. 一次 promoteOnce(distribute 把 host 与 desired 对齐)
      //   后台启动 ImagePromoteScheduler — 每 5min 自动 inspect+distribute,补 master image 升级后的状态收敛。
      //
      //  本调用替代旧 distributePreheatToAllHosts startup 调用 —— promoteOnce 内部已经包了
      //  distribute,且会写 loaded_image_id + clear quarantine。
      //  OC_IMAGE_DISTRIBUTE_DISABLED=1 仍可关掉(单机 dev / 测试)。
      if (process.env.OC_IMAGE_DISTRIBUTE_DISABLED !== "1") {
        void initComputePool({ imageTag: cfg.OC_RUNTIME_IMAGE })
          .then((r) => {
            // eslint-disable-next-line no-console
            console.log("[commercial] compute pool init done", {
              desiredImageId: r.desiredImageId,
              selfSynced: r.selfSynced,
              backfillHosts: r.backfillHosts,
              backfillSucceeded: r.backfillSucceeded,
              backfillSkipped: r.backfillSkipped,
              backfillTimedOut: r.backfillTimedOut,
              promoteRan: r.promoteRan,
            });
            // 启动周期性 promote scheduler(60s 后第一 tick,之后每 5min)
            getImagePromoteScheduler({ imageTag: cfg.OC_RUNTIME_IMAGE }).start();
          })
          .catch((err: unknown) => {
            // initComputePool 内部 best-effort 不抛;到这里就是 bug
            // eslint-disable-next-line no-console
            console.warn("[commercial] compute pool init unexpectedly threw", {
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

  // v1.0.120 feat/codex-disable-rebind:fanoutDeps 装配 —— admin disable codex
  // 账号 / refresh.ts 401 自动 disable 后触发后台 actor,把仍绑该账号的容器
  // rebind 到新 active 账号(M2 强一致路径)。
  //
  // 单机 / v3Deps 未装(测试 / 无 docker)时 putRemoteCodexAuth 为 undefined,
  // 走本地 fs 写;若实际 row.host_uuid 是远端但 helper 未注入,
  // fetchSnapshotAndWriteContainerAuth 会抛错 → tx ROLLBACK,符合强一致语义。
  {
    const codexContainerDirForFanout =
      process.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
    const fanoutDeps: CodexDisableFanoutDeps = {
      writeAuth: {
        selfHostId: v3Deps?.selfHostId ?? null,
        containerUid: V3_AGENT_UID,
        containerGid: V3_AGENT_GID,
        codexContainerDir: codexContainerDirForFanout,
        putRemoteCodexAuth: v3Deps?.putRemoteCodexAuth,
      },
      concurrency: 4,
      logger: rootLogger.child({
        subsys: "commercial",
        module: "codexDisableFanout",
      }),
    };
    triggerCodexDisableFanoutRef.current = (accountId: bigint) => {
      enqueueCodexDisableFanout(accountId, fanoutDeps);
    };
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

  // 2026-05-12:邮箱验证成功 → fire-and-forget 触发 v3 容器 pre-warm。
  // 用"验证 → 首消息"的 p50=215s 间隔覆盖 docker run 冷启,首条消息无等待。
  // v3Deps 未配 → undefined → handler 端 deps.prewarmContainer?.() 变 no-op。
  // wrapper 由 makePrewarmContainer 保证同步 return void / 绝不抛(见 v3prewarm.ts)。
  // 注:这里独立调一次 makeV3EnsureRunning(v3Deps),与下方 resolveContainerEndpoint
  // 用的 ensureRunning 是各自闭包,无共享可变状态,语义上等价。
  const prewarmContainer: ((uid: bigint) => void) | undefined = v3Deps
    ? makePrewarmContainer(
        makeV3EnsureRunning(v3Deps),
        rootLogger.child({ subsys: "v3/prewarm" }),
      )
    : undefined;

  // v1.0.191 — /api/media-signed 冷启动护栏 + per-uid singleflight 合并。
  // 详见 handlers.ts ensureContainerReady JSDoc 与 ensureContainerSingleflight.ts。
  //
  // **共享作用域**:WS bridge `resolveContainerEndpoint`(下方 line ~1818)与 HTTP
  // `/api/media-signed` ensureContainerReady 共享同一 in-flight map。
  // 原因:用户 reload 页面瞬间,WS connect 与 <img> burst 是同 process 内的并发拉,
  // 若各自闭包 → makeV3EnsureRunning 的 DB INSERT race(只一个赢家做 provision,
  // 输家被翻 ContainerUnreadyError("provisioning"))会让 HTTP 一路成为输家继续破图。
  // 单 singleflight 把整个 uid 的 ensure call 合并掉这条 race。
  //
  // 注:prewarm(line 1633)有自己的闭包,因为它发生在邮箱验证那一刻,与"reload
  // 同瞬间"不同步,且 makePrewarmContainer 自带 fire-and-forget 包装,共享反而
  // 模糊语义,保留独立闭包。
  const sharedEnsureRunning: ResolveContainerEndpoint | undefined =
    v3Deps ? makeUidSingleflight(makeV3EnsureRunning(v3Deps)) : undefined;

  const ensureContainerReady: ((uid: bigint) => Promise<void>) | undefined = sharedEnsureRunning
    ? async (uid) => {
        await sharedEnsureRunning(uid);
      }
    : undefined;

  // V3 multi-tenant media resolver(`c:<uid>` → user volume {uploads, generated})
  // 仅暴露给 gateway(`RegisterCommercialResult.resolveUserMediaDirs`,装配
  // _resolveMediaDirs 用于 /api/uploads 写路径)。
  //
  // v1.0.131 起 media-sign handler 不再用此 resolver:签 URL / 验签的路径都是
  // 容器内 `/home/agent/...` 命名空间,master 侧只做 `isContainerPathAllowed`
  // sanity check,真正 ACL 由 containerFileProxy 转发到容器内 handleApiFile
  // (走 agentCwds + realpathSync + isFileAllowed) 把权威。
  //
  // 装配条件同旧:agentRuntime 起得来(docker client 在手)。其他 fail-closed 分支
  // 由 resolver 自己返 kind='fail' + reason。
  const userMediaResolver = agentRuntime
    ? createUserMediaResolver({
        pool: getPool(),
        docker: agentRuntime.docker,
      })
    : undefined;

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
    // 2026-05-06:admin reset-cooldown 修 bug 时新接的依赖。adminResetCooldown
    // 在 status='cooldown' 时调 health.recoverFromCooldown 把账号一并 active+50
    // (避免 cooldown_until=NULL ∧ status='cooldown' 的永久卡死)。
    accountHealth: healthTracker,
    hupijiao,
    hupijiaoConfig,
    agentRuntime,
    // HIGH#6:admin/containers v3 行的 stop/remove/restart 走这条 dispatch
    v3Supervisor: v3Deps,
    prewarmContainer,
    // v1.0.191 — /api/media-signed 冷启动护栏。装配端做了 per-uid singleflight 合并,
    // 见上方 ensureContainerReady 构造闭包注释。
    ensureContainerReady,
    // v3 file proxy:root secret 给 containerFileProxy 签 per-request nonce;
    // feature flag 控制 router 是否把 /api/file / /api/media/* 从 BLOCKED 拉进 PROXY 分支
    bridgeSecret,
    fileProxyEnabled: cfg.FILE_PROXY_ENABLED,
    // v3 signed media URL —— HKDF 派生的 32-byte key。
    // 缺失 → /api/media-sign 与 /api/media-signed 返 503,前端拿到 null 即保持占位
    // (透明 PNG / 空 src);**不退回 cookie 路径**,那条 path 正是 iOS Safari 丢
    // cookie 的根因。详见上面 mediaSignKey 注释。
    //
    // 旧版还往这里注入 resolveUserMediaDirs(把 container 路径反解到 host volume
    // 路径再用 makeUserScopedMediaPredicate 做 ACL),v1.0.131 起删除:容器路径与
    // 主机路径同时存在导致两侧语义错位,真正 ACL 由容器内 handleApiFile (走
    // agentCwds + realpathSync + isFileAllowed) 把权威,master 侧只做 sanity check
    // (isContainerPathAllowed)。
    mediaSignKey,
    // v1.0.120 feat/codex-disable-rebind:透传给 admin/accounts handler 的
    // adminPatchAccount ctx,active→disabled 转移触发 fanout actor。
    triggerCodexDisableFanout,
    // V3 CC 外接 plan Phase 3:公网 `POST /api/anthropic/v1/messages` 的 handler
    // 实例。undefined 时 router 该路径返 503 EXTERNAL_PROXY_UNAVAILABLE 而非 404。
    externalApiKeyProxy,
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

  // V3 R6.11 §14.2.6:agent_migrations stale ledger reconciler(gateway 启动立刻 + 60s tick)。
  // 进程崩重启 / 长时间 alive 中途崩过的兜底:扫 `phase NOT IN closed` + updated_at 超
  // `supervisor_stale_migrate_threshold_sec`(默认 600s)的行,planned 阶段直接
  // markRolledBack +(pausedAt 非空时)unpause 旧容器 — 这是 R6.11 reader 二选一硬约束的
  // 单点权威闭环(02-DEVELOPMENT-PLAN.md §14.2.6:2093)。
  // OC_MIGRATION_RECONCILER_DISABLED=1 关闭(运维灾备 / writer 上线前的紧急回滚开关)。
  let migrationReconcileScheduler: MigrationReconcileScheduler | undefined;
  if (v3Deps && process.env.OC_MIGRATION_RECONCILER_DISABLED !== "1") {
    const migrationReconcileLog = rootLogger.child({ subsys: "v3/migrationReconciler" });
    migrationReconcileScheduler = startMigrationReconcileScheduler(v3Deps, {
      logger: migrationReconcileLog,
      // 默认 runOnStart=true + 60s tick + staleSec=600(R6.11 默认)
    });
    migrationReconcileLog.info("scheduler started", {
      tickSec: 60, staleSec: 600, runOnStart: true,
    });
  }

  // fix:HealthPoller(compute-pool/nodeHealth.ts)在 5029a69 引入但从未在 service
  // boot 接 .start() — last_health_at 一直 NULL,自动 quarantine/recovery 状态机失效,
  // mTLS cert 临近过期的自动 renewal 也跟着失效。OC_HEALTH_POLLER_DISABLED=1 给单
  // host / dev 场景保留 disable。
  let healthPoller: HealthPoller | undefined;
  if (v3Deps && process.env.OC_HEALTH_POLLER_DISABLED !== "1") {
    healthPoller = getHealthPoller();
    healthPoller.start();
    rootLogger.child({ subsys: "node-health" }).info("scheduler started", {
      intervalMs: 30_000,
    });
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

  // v1.0.191:复用 sharedEnsureRunning(与 /api/media-signed ensureContainerReady
  // 共享同一 per-uid singleflight,避免 reload 同瞬间 WS+HTTP 各自 DB INSERT race)。
  const resolveContainerEndpoint: ResolveContainerEndpoint =
    options.resolveContainerEndpoint
    ?? sharedEnsureRunning
    ?? (async (_uid: bigint) => {
      throw new ContainerUnreadyError(5, "supervisor_not_wired");
    });

  // ─── P1.7 slice 7c — WeChat broker 装配 ───────────────────────────────────
  //
  // 装配条件:WECHAT_BROKER_ENABLED=1 + bridgeSecret 已加载(对称要求 — broker 给
  // container 发 inbound 时 HMAC 来自这个 root secret)。两者任一缺失 →
  // broker 全程 disabled,wechatBrokerRef.current 保持 null,
  // /internal/v3/wechat-outbound 永远 404、外部 onInbound 也未暴露。
  //
  // 装配后:broker 自带 brokerEnabled() 短路;但本侧已经 gate 过整个装配链
  // (没装就没 onInbound 也没 outboundHandler),所以 callback 直接 () => true。
  // 这样后续若加 ConfigService 热重载,把 callback 换成 ConfigService.get 即可,
  // 不动 broker.ts。
  let wechatBroker: WechatBroker | undefined;
  if (cfg.WECHAT_BROKER_ENABLED && bridgeSecret) {
    // ─ 依赖装配(自下而上):transport → dispatcher → outboundReceiver →
    //   sendText → broker
    const wechatLog = rootLogger.child({ subsys: "wechatBrokerAssembly" });
    const containerTransport = makeNodeHttpContainerTransport();
    const ilinkSendText = makeIlinkSendAdapter();

    const inboundDispatcher = makeInboundDispatcher({
      pgPool: getPool(),
      resolveContainerEndpoint,
      bridgeSecret,
      resolveModel: async (bindingUserId) => {
        const uid = BigInt(bindingUserId);
        const [prefs, authz] = await Promise.all([
          getPreferences(uid),
          loadUserModelAuthz(uid),
        ]);

        return pickWechatInboundModel({
          preferredModel: prefs.prefs.default_model,
          visibleModels: pricing.listForUser(authz),
          canUseModel: (modelId) =>
            canUseModel({ pricing }, { ...authz, modelId }),
          allowedModels: ALLOWED_INBOUND_MODELS,
        });
      },
      // dispatcher Step 2a / 2b — 走 storage helper 写 master sqlite client_sessions。
      upsertMasterClientSession,
      // dispatcher Step 2b 失败 + broker reconcile 共用同一个 soft-delete
      // (返 boolean,broker.softDeleteMasterSession 期待 Promise<void> — 包一层吞掉返回值)
      softDeleteMasterSession: async (sessionId, userId) => {
        await softDeleteMasterSession(sessionId, userId);
      },
      transport: containerTransport,
    });

    const identityRepo = createPgIdentityRepo();
    const rateLimitRedis = wrapIoredis(redis);
    void rateLimitRedis; // P1 占位:noop limiter;P3 真实滑窗时切回 rateLimitRedis 依赖
    const outboundReceiver = makeOutboundReceiverHandler({
      identityRepo,
      pool: getPool(),
      rateLimiter: createNoopRateLimiter(),
    });

    wechatBroker = makeWechatBroker({
      pgPool: getPool(),
      dispatcher: inboundDispatcher,
      outboundReceiver,
      // broker reconcile 一次性读全集 wsess 行,然后内部 diff 出孤儿。
      allMasterWsessRows,
      softDeleteMasterSession: async (sessionId, userId) => {
        await softDeleteMasterSession(sessionId, userId);
      },
      sendText: ilinkSendText,
      // 读 master sqlite wechat_bindings 拿 botToken + contextTokens 给 outboxWorker。
      // 失败 / 不存在 → 返 null,worker 该 row 走 permanent(无可恢复 token)。
      getBinding: async (bindingUserId) => {
        const b = await getWechatBindingByUserId(bindingUserId);
        if (!b) return null;
        return { botToken: b.botToken, contextTokens: b.contextTokens };
      },
      brokerEnabled: () => true, // 装配链已 gate 过整体开关
    });
    wechatBroker.start();
    wechatBrokerRef.current = wechatBroker;
    wechatLog.info("wechat_broker_assembled");
    // eslint-disable-next-line no-console
    console.log("[commercial] wechat broker assembled + started");
  } else {
    // eslint-disable-next-line no-console
    if (cfg.WECHAT_BROKER_ENABLED && !bridgeSecret) {
      console.warn(
        "[commercial] WECHAT_BROKER_ENABLED=1 but bridgeSecret missing; broker NOT assembled",
      );
    } else {
      console.log("[commercial] wechat broker disabled (WECHAT_BROKER_ENABLED!=1)");
    }
  }

  // V3 2I-2:把 buffered_bytes / session_duration 接到 prometheus histogram。
  // 单帧 / per-uid 字节数不进 metrics —— 标签基数太大。
  const bridgeMetrics: BridgeMetricSink = {
    onBufferedBytes: (_uid, side, bytes) => observeWsBridgeBuffered(side, bytes),
    onClose: (stats) => observeWsBridgeSessionDuration(stats.cause, stats.durationMs / 1000),
    onTtft: (_uid, kind, seconds) => observeWsBridgeTtft(kind, seconds),
  };
  // PR1:bridge 拿到 client→container 帧时刷 last_ws_activity(60s debounce)。
  // 防 idle sweep 把"长 WS 单连但持续在用"的会话误判为 idle。fire-and-forget 包到
  // 闭包里;markV3ContainerActivity 自身已 swallow 异常。无 v3Deps(单测 / mock)
  // → 不注入,bridge 退化为 PR1 之前的行为(只 ensureRunning 刷一次)。
  const markActivityForBridge = v3Deps
    ? (cid: number) => { void markV3ContainerActivity(v3Deps!, cid); }
    : undefined;

  // plan v3 G5/G7 — codex per-account 并发槽 + lazy migrate handle。
  //   - acquire(containerId):FOR UPDATE 锁 agent_containers row + LEFT JOIN claude_accounts
  //     看绑定账号状态:
  //       * codex_account_id IS NULL → 返回 null(legacy 容器,mount immutable,决策 N3)
  //       * 已 active → tx 不写,返回 account_id;tx 提交后(无写)再 acquireCodexSlot
  //       * 非 active(disabled / quarantined)→ pickCodexAccountForBinding 重选 →
  //         getCodexTokenSnapshot → writeCodexContainerAuthFile 原子写 → UPDATE
  //         codex_account_id;tx 提交后再 acquireCodexSlot(失败 → bridge fast-fail,
  //         migrate 已落盘永久不回滚:下次重连 active 路径直接走 happy 分支)
  //   - acquireCodexSlot 在 tx **外**调,避免 commit 失败造成的 in-process slot 永久泄漏:
  //     已经持有 slot 但 UPDATE 回滚 → 调用方拿到错误 → bridge.acquiredCodexAccountId
  //     未被赋值 → cleanup() 与 G6 timer 都不知道哪个 account 该 release → 永久泄漏。
  //   - release(account_id):dec inflight,幂等。
  //   - v3Deps 未注入(测试 / 早期 boot 路径)→ codexBinding=undefined,bridge 退化为不做并发管控
  // 闭包外 capture v3Deps 给 stale recycle fire-and-forget 路径用(必须非空)。
  const v3DepsForCodex = v3Deps;
  const codexBinding: CodexBindingHandle | undefined = v3Deps
    ? {
        async acquire(containerId: number, groupId?: string | null) {
          // tx 内做"锁 + 查 + 可能 lazy migrate / stale recycle";acquire slot / 容器 rm 在 tx 外
          type AcquireResult =
            | { kind: "active"; account_id: bigint }
            | { kind: "stale"; containerInternalId: string | null; hostUuid: string | null }
            | null;
          const desiredGroupId = groupId ?? null;
          const result: AcquireResult = await tx<AcquireResult>(async (client) => {
            const lookup = await client.query<{
              account_id: string | null;
              account_status: string | null;
              account_group_id: string | null;
              state: string;
              container_internal_id: string | null;
              host_uuid: string | null;
              age_seconds: string;
            }>(
              `SELECT ac.codex_account_id::text AS account_id,
                      ca.status AS account_status,
                      ca.group_id::text AS account_group_id,
                      ac.state AS state,
                      ac.container_internal_id AS container_internal_id,
                      ac.host_uuid AS host_uuid,
                      EXTRACT(EPOCH FROM (NOW() - ac.created_at))::text AS age_seconds
               FROM agent_containers ac
               LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
               WHERE ac.id = $1
               FOR UPDATE OF ac`,
              [containerId],
            );
            if (lookup.rows.length === 0) {
              // 容器在 acquire 前刚被删了 — 当 legacy 透传(下游 sendToContainer 必失败,
              // 错误从那条路径返回给前端,与本桥状态一致)
              return null;
            }
            const row = lookup.rows[0];
            if (row.state !== "active") {
              // 容器已不再 active(stopped / vanished / removed) — 当 legacy 透传,
              // 让下游 sendToContainer 路径产出标准错误,不在 acquire 这层造一种新的错。
              return null;
            }
            if (row.account_id === null) {
              // v1.0.72:host guard(v1.0.71 临时把"远端 host + NULL bind"硬挡)
              // 替换为下方 **age 守护**(死循环熔断,见 ageSec < 60 注释)。原因 ——
              //   v1.0.71 临时 guard 是因为 provisionV3Container 在远端跳过 codex
              //   绑定,远端 host 上重 provision 仍是 NULL → 死循环。v1.0.72 起远端
              //   provision 路径已能写 per-container auth.json(v3supervisor 的
              //   useRemote codex 分支走 deps.putRemoteCodexAuth),正常路径下
              //   stale recycle + ensureRunning 重 provision 会自然产出 per-container
              //   mount。但 putRemote 短暂故障(node-agent 抖 / fingerprint 错配)
              //   仍可能让 row 又留 NULL —— 此时由 age guard 熔断,不再依赖 host 判定。
              // legacy NULL 绑定 + 任意 host。检查池子里是否有 active codex 账号:
              //   - 没有 → 真 legacy 路径不变,return null(N3 行为兼容)
              //   - 有   → 用户 admin 已加账号但容器 mount immutable 永远 401,
              //            必须 mark vanished + docker rm 让 ensureRunning 重 provision
              //            重新走 picker 路径产出 per-container mount。
              // 池子查询条件必须与 pickCodexAccountForBinding 完全一致(provider='codex'
              // AND status='active'),否则可能误判为"有账号"但 picker 实际拿不到。
              const poolParams: unknown[] = [];
              const poolWhere = ["provider = 'codex'", "status = 'active'"];
              if (desiredGroupId !== null) {
                poolParams.push(desiredGroupId);
                poolWhere.push(`group_id = $${poolParams.length}`);
              }
              const poolCount = await client.query<{ cnt: string }>(
                `SELECT count(*)::text AS cnt
                   FROM claude_accounts
                  WHERE ${poolWhere.join(" AND ")}`,
                poolParams,
              );
              if (Number(poolCount.rows[0]?.cnt ?? "0") === 0) {
                return null;
              }
              // **死循环守护(v1.0.72 Codex review High#1)**:
              // 远端 host 的 putRemoteCodexAuth 短暂故障(node-agent 抖 / fingerprint
              // 错配 / cert 失效)→ provisionV3Container 写 codex auth 失败 → no-mount
              // + codex_account_id NULL → 下次 acquire 看池非空 → 又 recycle → 又重 provision
              // → 又失败 → 死循环烧资源。本地 host 也存在同 case(picker 抛 / write fail),
              // 只是远端故障频率高。
              //
              // 守护:row 才创建 < 60s 又被 stale recycle = 强信号上一轮 provision codex
              // 绑定失败,**这一轮不再 recycle**,return null 走 legacy 透传(N3 行为)。
              // 用户 GPT 请求会失败但容器照常用,不会陷入重建循环。运维通过监控 NULL
              // bind 容器数 + 日志告警感知后,修复 host 后下一轮自然 recycle 自愈
              // (60s 后行不再"年轻")。
              const ageSec = Number(row.age_seconds ?? "0");
              if (Number.isFinite(ageSec) && ageSec < 60) {
                // eslint-disable-next-line no-console
                console.warn(
                  "[codex acquire] skip stale recycle: row too young (likely upstream codex bind failed last provision)",
                  { containerId, ageSec, hostUuid: row.host_uuid },
                );
                return null;
              }
              // 池子非空 — recycle。同 tx 内把 row 标 vanished,与下面 lazy migrate
              // 的 UPDATE 同 commit,避免并发 acquirer 看到 state='active' 走错路径。
              // WHERE state='active' guard 防 race:并发 acquirer/admin/idleSweep
              // 已经把 state 改了的话本 UPDATE rowCount=0,我们也回 null 让 caller
              // 当 legacy 透传(那条路径自然产出错误返给前端)。
              // FOR UPDATE OF ac 已锁住本 row,UPDATE WHERE state='active' 在同 tx
              // 内应永远 rowCount=1。rowCount=0 = 不变量破坏(只可能是更上层 SELECT
              // 时 row.state 已经不是 'active' — 但前面 row.state !== 'active' 早已
              // 拦截)。这里 throw 抬出问题,而不是静默 return null 让 caller 当 legacy
              // 透传 — 那条路径走旧容器仍会 401,只是把问题往后挪。
              const upd = await client.query(
                `UPDATE agent_containers
                    SET state = 'vanished', updated_at = NOW()
                  WHERE id = $1 AND state = 'active'`,
                [containerId],
              );
              if ((upd.rowCount ?? 0) === 0) {
                throw new Error(
                  `codex stale recycle: UPDATE state=vanished rowCount=0 for container ${containerId} (invariant: FOR UPDATE row was active)`,
                );
              }
              return {
                kind: "stale",
                containerInternalId: row.container_internal_id,
                hostUuid: row.host_uuid,
              };
            }
            if (row.account_status === "active" && (desiredGroupId === null || row.account_group_id === desiredGroupId)) {
              return { kind: "active", account_id: BigInt(row.account_id) };
            }
            // disabled / quarantined / 任意非 active → lazy migrate
            //
            // v1.0.120 feat/codex-disable-rebind:把"pick + snapshot + write +
            // UPDATE"这一段 inlined IO 抽到 `codexLazyMigrate` 模块,与 M1
            // (`internalCodexTokenRefresh` in-turn 自愈)+ M2(`codexDisableFanout`
            // 后台 actor)共享同一组 helper。三条路径都靠 `acquireAndPickInTx` 做
            // FOR UPDATE 锁 + 决策,`commitCodexRebindInTx` 做 UPDATE,
            // `fetchSnapshotAndWriteContainerAuth` 做"读 token snapshot + 本地或
            // 远端写 per-container auth.json"。
            //
            // acquire 仍走**强一致**(tx 内 pick + write + UPDATE 一同 COMMIT):
            //   - acquire 是用户 inbound 触发,单容器单流,不像 reverse-RPC 那样
            //     burst,持锁 IO 开销可接受
            //   - 写失败 → tx ROLLBACK → row 仍指 disabled 账号 → 下次 inbound 再 acquire
            //     重试,与本次失败前状态一致(无孤儿 auth.json,因为是先写后 UPDATE
            //     的强一致,但 helper 顺序是 fetch+write → UPDATE,write 成功 → UPDATE
            //     失败极少,失败时 auth.json 是已落盘的新 token 孤儿。**新版顺序略
            //     变**:之前是 write → UPDATE 同 tx;现在是 helper write(物理文件 IO,
            //     非 PG)→ commitCodexRebindInTx UPDATE → tx COMMIT。物理文件 IO 之前
            //     与之后整体语义不变,孤儿 auth.json 行为同 v1.0.72 注释)
            //   - 持锁的 60s remote PUT 风险 v1.0.115 出现过:但当时是
            //     internalCodexTokenRefresh burst,acquire 路径单容器单流不重复;
            //     accept 同型权衡
            const picked = await pickCodexAccountForBindingInTx(client, String(containerId), { groupId: desiredGroupId });
            if (!picked) {
              throw new Error(
                `codex pool empty during lazy migrate for container ${containerId}`,
              );
            }
            const codexContainerDir =
              process.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
            // v1.0.72 host 路由由 helper 内部决定(完全同 selfHostId / host_uuid / putRemote
            // 三选一逻辑,见 codexLazyMigrate.fetchSnapshotAndWriteContainerAuth);
            // 远端 helper 未注入抛错 → tx ROLLBACK,与之前行为一致。
            const writeAuthDeps: WriteAuthDeps = {
              selfHostId: v3DepsForCodex?.selfHostId ?? null,
              containerUid: V3_AGENT_UID,
              containerGid: V3_AGENT_GID,
              codexContainerDir,
              putRemoteCodexAuth: v3DepsForCodex?.putRemoteCodexAuth,
            };
            // 用 client 传入 helper → 走 in-tx snapshot,**不**申请第二个 PG client
            // (避免 burst 时撑大 pool 占用)。
            await fetchSnapshotAndWriteContainerAuth({
              accountId: picked.account_id,
              containerId,
              hostUuidUnderLock: row.host_uuid,
              deps: writeAuthDeps,
              client,
            });
            // FOR UPDATE 持锁内 UPDATE,COMMIT 时一同落盘。失败 → tx 抛出 → ROLLBACK
            // (写入的 auth.json 是孤儿,由 stopAndRemoveV3Container / volume gc / 同
            //  containerId 重 provision 覆盖兜底,与 v3supervisor provision 路径同处理)
            await commitCodexRebindInTx(client, containerId, picked.account_id);
            return { kind: "active", account_id: picked.account_id };
          });
          if (result === null) return null;
          if (result.kind === "stale") {
            // tx 已 commit:row.state 已落 vanished。**必须 await** 把 docker 实体清掉
            // 再返错,否则容器名 oc-v3-u<uid> 是 per-uid 固定,旧实体没 rm 时下条
            // message 触发 ensureRunning 会撞 docker NameConflict 被卡几秒重试,体
            // 验上不"自愈"。await 失败也 throw stale(下次 ensureRunning 仍会自己
            // try stop/remove 旧名字兜底,与今天 orphanReconcile 路径一致),但日志
            // 留 warn 便于诊断。
            try {
              await stopAndRemoveV3Container(v3DepsForCodex!, {
                id: containerId,
                container_internal_id: result.containerInternalId,
                host_uuid: result.hostUuid,
              });
            } catch (err) {
              rootLogger.warn(
                "[commercial] codex stale recycle: stopAndRemoveV3Container failed (continuing — ensureRunning will retry on next message)",
                {
                  containerId,
                  err: (err as Error)?.message ?? String(err),
                },
              );
            }
            throw new ContainerStaleBindingError(containerId);
          }
          // tx 已 commit;现在尝试占 in-process per-account slot。Busy → 抛 AccountPoolBusyError
          // (bridge 转 CODEX_POOL_BUSY)。lazy migrate 已落盘不会回滚,Busy 只影响本 turn。
          scheduler.acquireCodexSlot(result.account_id);
          return { account_id: result.account_id };
        },
        release(account_id: bigint): void {
          try { scheduler.releaseCodexSlot(account_id); } catch { /* */ }
        },
      }
    : undefined;

  const userChatBridge: UserChatBridgeHandler = createUserChatBridge({
    jwtSecret,
    resolveContainerEndpoint,
    metrics: bridgeMetrics,
    markContainerActivity: markActivityForBridge,
    // 跨 host 容器:bridge 用 node-agent tunnel 拉容器 WS(direct dial 必然 EHOSTUNREACH)。
    // 工厂内部走 mTLS+pin 预拨 + ws.createConnection hijack;maxFrameBytes 与 bridge 默认对齐
    // (factory 内会用同一上限;不显式传则 ws 默认无限,有 OOM 风险)。
    createTunnelContainerSocket: (tunnel, port, signal, connectionTraceId) =>
      createTunnelContainerSocket(tunnel.nodeAgent, tunnel.containerInternalId, port, signal, {
        maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
        // S12e CG4:bridge connId(server-side randomUUID)透传到 outgoing tunnel WS
        // upgrade 的 `X-Connection-Trace-Id` header,与 node-agent / in-container gateway
        // 共用同一 connection-scoped trace。
        connectionTraceId,
      }),
    // 注入 logger,让 bridge 把 4503 reason / container error 等关键路径日志写出来。
    // 不传则静默 noop,生产排错时全部不可见(原版 commit 漏了)。
    logger: rootLogger.child({ subsys: "commercial", module: "userChatBridge" }),
    // 0049 模型授权(plan v3 §B3/§B4)— bridge 层是 v3 commercial 唯一同时拿得到
    // user role 与 grants 的位置(容器内个人版 gateway 没 commercial DB 连接)。
    // 每次新桥连接时调一次:拉本 user grants → 返回一个绑定 pricing+role+grants
    // 的 sync closure,后续每条 inbound.message 帧 sync 校验。pricing 是进程级
    // singleton,grants 失败 throw → bridge 关 1011(不做 silent 放行)。
    loadAllowedModelChecker: async (uid, role) => {
      const { listGrantsForUser } = await import("./admin/modelGrants.js");
      const { canUseModel } = await import("./billing/authzModels.js");
      const grants = await listGrantsForUser(uid);
      const grantedSet = new Set(grants.map((g) => g.model_id));
      return (modelId: string) =>
        canUseModel({ pricing }, { role, grantedModelIds: grantedSet, modelId });
    },
    loadMasterSessionMessages: async (uid, sessionId) => {
      const session = await getClientSession(sessionId, MASTER_USER_PREFIX + uid.toString());
      return session?.messages ?? null;
    },
    // plan v3 G5/G7 — codex per-account 并发槽 / lazy migrate / 严格单飞 handle。
    // v3Deps 未注入(测试 mock)→ undefined,bridge 退化为透传不做并发管控(测试默认行为)。
    codexBinding,
    createCodexRoute: async ({ containerId, userId, modelId }) => {
      const groups = await listEnabledGroupsForModel({ modelId, provider: "codex" });
      if (groups.length === 0) return null;
      for (const group of groups) {
        if (group.kind === "api_relay") {
          const route = await createCodexRouteContextForModel({
            containerId,
            userId,
            modelId,
            groupId: group.id,
          });
          if (!route) continue;
          return {
            kind: "api_relay" as const,
            token: route.token,
            baseUrl: `http://127.0.0.1:${V3_CONTAINER_PORT}/internal/v3/codex-relay/route/${route.token}`,
            modelProvider: route.credential.model_provider,
            providerName: route.credential.provider_name,
            wireApi: route.credential.wire_api,
            preferredAuthMethod: route.credential.preferred_auth_method,
            disableResponseStorage: route.credential.disable_response_storage,
            groupId: route.group.id.toString(),
            credentialId: route.credential.id.toString(),
          };
        }
        if (group.kind === "official_oauth") {
          const hasAccount = await hasActiveOfficialOAuthAccountInGroup(group.id, "codex");
          if (!hasAccount) continue;
          return { kind: "official_oauth" as const, groupId: group.id.toString() };
        }
      }
      return { kind: "unavailable" as const, reason: "no usable enabled Codex group" };
    },
    expireCodexRoute: async (token) => {
      await expireCodexRouteContext(token);
    },
    // PR2 v1.0.66 — codex 真扣费三件套:bridge 内部走 preCheckWithCost / startInflightJournal
    //   / settleUsageAndLedger 一条龙。pgPool / preCheckRedis / pricing 都是进程级 singleton,
    //   注入即用。createUserChatBridge entry 已强校验"三件套全有或全无",partial 注入会 throw,
    //   防生产配错让 codex 免费。codexBinding 已注 → 三件套必须全注(见 createUserChatBridge)。
    pgPool: getPool(),
    preCheckRedis,
    pricing,
    // Plan §4.2 改动 4a — codex billing commit 路径同样把 debit 持久化进
    // master's `client_sessions.messages[i].usage.costCredits`。与 anthropicProxy
    // 走同一个 storage helper,签名一致。
    appendCostCredits,
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

  // plan G2/G4 — codex token refresh actor(commercial 单进程独占,60s tick,unref)。
  // 扫 codex 账号 → 提前 15min refresh → 持锁逐容器写 per-container auth.json。
  // 永不写 master 文件 / legacy 共享 dir。详见 codexAccountActor.ts 头注。
  let codexRefreshActor: CodexRefreshActorHandle | undefined;
  if (process.env.COMMERCIAL_CODEX_REFRESH_ACTOR_DISABLED !== "1") {
    const codexContainerDir =
      process.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
    // v1.0.72 多机:把 v3Deps 上的 putRemoteCodexAuth helper(已含
    // getHostById → hostRowToTarget → finally psk.fill(0) 三件套)透传给 actor,
    // actor 自己不持密钥 buffer,泄密面与 lazy migrate / provision 完全一致。
    codexRefreshActor = startCodexRefreshActor({
      codexContainerDir,
      containerUid: V3_AGENT_UID,
      containerGid: V3_AGENT_GID,
      selfHostId: v3Deps?.selfHostId ?? null,
      writeRemoteFn: v3Deps?.putRemoteCodexAuth,
    });
  }

  // 账号池 cooldown 半开恢复 actor —— 周期扫 cooldown_until 已过期的账号 → active。
  // 默认 5min tick(下限 1s 防 typo)。
  // 关闭:`COMMERCIAL_COOLDOWN_RECOVERY_DISABLED=1`(测试 / 应急)。
  let cooldownRecoveryActor: CooldownRecoveryActorHandle | undefined;
  if (process.env.COMMERCIAL_COOLDOWN_RECOVERY_DISABLED !== "1") {
    const raw = Number(process.env.COMMERCIAL_COOLDOWN_RECOVERY_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 5 * 60_000;
    cooldownRecoveryActor = startCooldownRecoveryActor({
      tracker: healthTracker,
      intervalMs,
    });
  }

  // A1 — pending 订单 expirer(默认 60s tick,部署即 boot 跑一次清历史脏单)。
  // markOrderPaid 不在事务内对 expires_at 做硬防线(避免用户超时几秒扫码就硬失败
  // 的体验回归);过期清理由本 sweeper 负责,被推 expired 后 markOrderPaid 自然拒。
  // 非法 / 空 / NaN → 60s;下限 1s(防 typo 把 DB 打穿)
  let pendingOrdersExpirer: PendingOrdersExpirerHandle | undefined;
  if (process.env.COMMERCIAL_PENDING_ORDERS_EXPIRER_DISABLED !== "1") {
    const raw = Number(process.env.COMMERCIAL_PENDING_ORDERS_EXPIRER_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
    pendingOrdersExpirer = startPendingOrdersExpirer({ intervalMs });
  }

  // Onboarding inbox scheduler — 由 system_settings.onboarding_enabled 决定是否真发,
  // 默认 false 上线即静默,boss 显式开启后才触达用户。详见 inbox/onboarding.ts。
  let onboardingScheduler: OnboardingSchedulerHandle | undefined;
  if (process.env.COMMERCIAL_ONBOARDING_DISABLED !== "1") {
    const raw = Number(process.env.COMMERCIAL_ONBOARDING_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 5000 ? raw : 60_000;
    onboardingScheduler = startOnboardingScheduler({ intervalMs });
  }

  // Plan C — inbox 站内信邮件推送 worker.
  // 由 admin 创建消息时勾选「同时发邮件」触发,inbox_email_jobs 表持久化,
  // 本 scheduler 周期 drain;启动时一次 stale cleanup(sending>5min → interrupted).
  // 关闭:COMMERCIAL_INBOX_EMAIL_DISABLED=1.默认 30s tick / 50 条/batch / 600ms 间隔.
  // mailer 走 stub 也能跑(打 stdout),只有禁用 worker 时不跑.
  let inboxEmailScheduler: InboxEmailSchedulerHandle | undefined;
  if (process.env.COMMERCIAL_INBOX_EMAIL_DISABLED !== "1") {
    const raw = Number(process.env.COMMERCIAL_INBOX_EMAIL_INTERVAL_MS);
    const intervalMs = Number.isFinite(raw) && raw >= 5000 ? raw : 30_000;
    inboxEmailScheduler = startInboxEmailScheduler({
      mailer,
      intervalMs,
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
      // P1.7 slice 7c — broker 先停。它会清 reconcile / housekeeping timer +
      // stop outboxWorker;放在 listener 关之前是为了:进行中的 outbox flush
      // 还能借 listener 把已经 admitted 的 outbound 完成最后一搏;同样 broker
      // 内部 fire-and-forget reflection 也能在 listener 拆掉前发送完。
      if (wechatBroker) {
        try { await wechatBroker.stop(); } catch { /* ignore */ }
      }
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
      if (migrationReconcileScheduler) {
        try { await migrationReconcileScheduler.stop(); } catch { /* ignore */ }
      }
      if (healthPoller) {
        try { healthPoller.stop(); } catch { /* ignore */ }
      }
      // 0042 — ImagePromoteScheduler 是 module 级单例,getImagePromoteScheduler() 拿到实例后调 stop
      try { getImagePromoteScheduler().stop(); } catch { /* ignore */ }
      if (containerEventsWorker) {
        try { await containerEventsWorker.stop(); } catch { /* ignore */ }
      }
      if (alertScheduler) {
        try { await alertScheduler.stop(); } catch { /* ignore */ }
      }
      if (refreshEventsSweeper) {
        try { refreshEventsSweeper.stop(); } catch { /* ignore */ }
      }
      if (codexRefreshActor) {
        try { codexRefreshActor.stop(); } catch { /* ignore */ }
      }
      if (cooldownRecoveryActor) {
        try { cooldownRecoveryActor.stop(); } catch { /* ignore */ }
      }
      if (pendingOrdersExpirer) {
        try { pendingOrdersExpirer.stop(); } catch { /* ignore */ }
      }
      if (onboardingScheduler) {
        try { onboardingScheduler.stop(); } catch { /* ignore */ }
      }
      if (inboxEmailScheduler) {
        try { inboxEmailScheduler.stop(); } catch { /* ignore */ }
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
      // 0060 — 清空 model hint provider,避免 shutdown 后还有人持 stale closure
      // (用于测试热重启场景:同一进程多次 register/shutdown 不能让旧 cache 被新 cache 引用)
      try { setModelHintProvider(null); } catch { /* ignore */ }
      // 0069 — 同理清空 literature skill provider(同进程热重启场景,且 closure 持
      // pg pool 句柄,留着会阻止 closePool 释放最后引用)
      try { setLiteratureSkillProvider(null); } catch { /* ignore */ }
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
    // V3 multi-tenant media resolver — 只有 agentRuntime 起得来(docker client 在手)
    // 才注入;否则 gateway 自动回退 paths.{uploads,generated}Dir(单租户兼容)。
    // 详见 RegisterCommercialResult 注释。
    //
    // 注:v1.0.131 起 createCommercialHandler 不再消费此 resolver(media-sign 改用
    // 容器内 ACL),所以唯一消费者是 gateway 自己的 /api/uploads 写路径(由 gateway
    // 持有这个 closure 调 _resolveMediaDirs)。
    resolveUserMediaDirs: userMediaResolver,
    // textual 谓词,无依赖,始终暴露 —— 仅供 orphan sweep 启动时按目录壳子
    // 迭代 user volumes 用。**不要**给 HTTP allowlist 用(cross-tenant IDOR)。
    isUserVolumeMediaPath,
    // v1.0.192 冷启动护栏 hook for gateway handleUpload。
    // 共享 sharedEnsureRunning 同一 per-uid singleflight(详见 line 1655 装配处)。
    // **结构化返回**:不把 ContainerUnreadyError 穿过 gateway 边界(后者零编译期
    // 依赖 commercial,见 server.ts 头部注释),把已知冷启动 "未就绪" 拍平成
    // 普通对象;其他 error(DB / docker daemon 抖)继续 throw 让 gateway 兜底 500。
    ensureContainerReady: sharedEnsureRunning
      ? async (uid) => {
          try {
            await sharedEnsureRunning(uid);
            return { ok: true as const };
          } catch (err) {
            if (err instanceof ContainerUnreadyError) {
              return {
                ok: false as const,
                retryAfterSec: err.retryAfterSec,
                reason: err.reason,
              };
            }
            throw err;
          }
        }
      : undefined,
    // remote-host media push hook(2026-05-16 hotfix):用户容器调度到 remote
    // compute host 时,master 收到 /api/uploads → 本地暂存 → 调本 hook 把字节
    // 推到 host 上的 docker volume(/var/lib/docker/volumes/oc-v3-data-u<uid>/
    // _data/uploads/<digest>.<ext>)。node-agent 的 AllowedDirRegexes 已经放行
    // 这一路径形态(files.go 同 hotfix),mode 0o644 + owner 1000:1000 与
    // self-host 分支等价(容器内 agent uid=1000,确保可读)。
    //
    // 错误语义:row 不存在/agent 不可达/HTTP >=400 都直接抛,gateway 自己
    // 转成 502 "remote storage push failed"。PSK buffer 在 finally 里 fill(0)
    // 清零,与 putRemoteCodexAuth 同纪律。
    pushRemoteHostUpload: async (args: {
      hostUuid: string;
      remotePath: string;
      content: Buffer;
    }) => {
      const row = await computeQueries.getHostById(args.hostUuid);
      if (!row) {
        throw new Error(
          `pushRemoteHostUpload: compute_host ${args.hostUuid} not found`,
        );
      }
      const target = hostRowToTarget(row);
      try {
        await nodeAgentPutFile(
          target,
          args.remotePath,
          args.content,
          0o644,
          1000,
          1000,
        );
      } finally {
        target.psk?.fill(0);
      }
    },
    // 2026-05-16 hotfix Phase 2 — remote-host 读路径对称 closure。
    // 与 pushRemoteHostUpload 同纪律(psk 清零)与同错误语义(throw → gateway 502)。
    // node-agent 404 → 返 null,让 gateway 决定 fallback 还是终态 404。
    pullRemoteHostMedia: async (args: {
      hostUuid: string;
      remotePath: string;
    }) => {
      const row = await computeQueries.getHostById(args.hostUuid);
      if (!row) {
        throw new Error(
          `pullRemoteHostMedia: compute_host ${args.hostUuid} not found`,
        );
      }
      const target = hostRowToTarget(row);
      try {
        return await nodeAgentGetFile(target, args.remotePath);
      } finally {
        target.psk?.fill(0);
      }
    },
    // P1.7 slice 7c — broker 装配成功(WECHAT_BROKER_ENABLED=1 + bridgeSecret 齐)
    // 才暴露。gateway cli 把 commercial.wechatBroker 作为 onInboundOverride 透传给
    // wechat manager;manager 命中普通文本路径时把 evt 喂给 broker.onInbound,
    // broker 自己 never-throw 并按 wsess-* 命名空间走 dispatcher → container 链路。
    //
    // 类型上只暴露 onInbound 的最小投影(不导出 BrokerInboundOutcome 等内部 union)—
    // gateway 不需要也不应消费 outcome 字段,broker 内部已做必要的 log。
    wechatBroker: wechatBroker
      ? {
          onInbound: (evt) => wechatBroker!.onInbound(evt),
          cleanupBinding: (bindingUserId) => wechatBroker!.cleanupBinding(bindingUserId),
        }
      : undefined,
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
  pickWRH,
  computeAccountWeight,
  defaultHash,
} from "./account-pool/scheduler.js";
export type {
  PickInput,
  PickResult,
  ReleaseInput,
  ReleaseResult,
  SchedulerDeps,
  CandidateRow,
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
// V3 anthropicProxy 拆分 Phase 2(2026-05-18):身份层 strategy 物理切出
export {
  makeContainerIdentityStrategy,
  IdentityError,
  AuthzLoadError,
  AuthzDeniedError,
} from "./auth/proxyIdentity.js";
export type {
  IdentityStrategy,
  ProxyIdentity,
  ContainerIdentityStrategyDeps,
} from "./auth/proxyIdentity.js";
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
} from "./http/anthropicProxy.js";
// V3 Phase 1 split: billing 子模块(从 anthropicProxy.ts L956-1485 物理切出)
export {
  startInflightJournal,
  makeFinalizer,
} from "./billing/proxyBilling.js";
export type {
  FinalizeContext,
  FinalizeOutcome,
  FinalizerHandle,
} from "./billing/proxyBilling.js";
// V3 Phase 4 split: upstream round-trip 子模块(从 anthropicProxy.ts L1421-1639 物理切出)
export { runUpstreamRoundTrip } from "./http/proxy/core.js";
export type { RoundTripCtx } from "./http/proxy/core.js";
// V3 Phase 3 split: upstream session 子模块(从 anthropicProxy.ts §3.4 物理切出)
export {
  selectUpstreamRoute,
  validateUpstreamConfig,
  pickUpstream,
  releaseUpstreamSession,
} from "./http/proxy/upstream.js";
export type {
  UpstreamRoute,
  ConfigError,
  PreparedUpstreamSession,
  PickError,
  PickUpstreamDeps,
} from "./http/proxy/upstream.js";
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
