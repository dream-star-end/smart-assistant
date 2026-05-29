/**
 * V3 Phase 2 Task 2E — 用户 WS ↔ 容器 WS 桥接。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §4 / 03-MVP-CHECKLIST.md Task 2E。
 *
 * 拓扑(MVP 单 host monolith):
 *   浏览器 ──TLS WS──▶ Gateway `/ws/user-chat-bridge?token=<jwt>`
 *                       │
 *                       ├─ verifyAccess(jwt) → uid
 *                       ├─ ConnectionRegistry.register({uid})  // 默认每人 3 条
 *                       ├─ const {host, port} = await resolveContainerEndpoint(uid)
 *                       │     ↑ 唯一入口(R6.11 reader 硬约束)。Phase 3 接入
 *                       │       supervisor.ensureRunning(uid);Phase 2 由调用方注入。
 *                       │       throw 503 → 关 ws + close code 4503 + retryAfter 给前端
 *                       └─ 内部 fetch ws://<host>:<port>/ws → 双向 pipe(text + binary)
 *
 * 协议透明:本模块**不解析也不修改**任何 chat / agent / tool 帧 — 只做 byte-exact
 * 帧透传。个人版 `/ws` 协议可演进而无需 commercial 配合。
 *
 * 失败语义:
 *   - JWT 失败  → ws 立刻 send {type:'error',code:'UNAUTHORIZED'} + close(1008)
 *   - 503 容器未就绪 → close(4503, 'migration_in_progress'),前端按 retryAfter 重连
 *   - 容器 WS 拒连(ECONNREFUSED / 4xx)→ close(1011, 'agent unavailable')
 *   - 任一侧 close → 另一侧立刻 close(对端 close code 透传到下游 best-effort)
 *   - buffer 超 maxBufferedBytes → close(1009, 'backpressure')— 防内存爆
 *
 * 不做的(P1+ / 别的 task):
 *   - 不做 ack 屏障 / migrate-aware 重连(R6.11):2E 只做"调一次 ensureRunning,
 *     成功就开桥;失败就 4503"。任何 redirect / 中途切 host 都不在 MVP 范畴
 *   - 不做 metrics 输出:`bufferedBytes` 通过 deps.onMetric 回调暴露,2I-2 接 prom-client
 *   - 不做 audit:个人版 chat 已经在容器内自审,gateway 侧不再额外抓 message body
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID, randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Pool } from "pg";

import { verifyAccess, JwtError, type AccessClaims } from "../auth/jwt.js";
import { ConnectionRegistry, type Conn } from "./connections.js";
import type { Logger } from "../logging/logger.js";
import { isInMaintenance } from "../middleware/maintenanceMode.js";
import type { NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";
import {
  type PreCheckRedis,
  preCheckWithCost,
  releasePreCheck,
  estimateMaxCost,
  InsufficientCreditsError,
} from "../billing/preCheck.js";
import type { PricingCache, ModelPricing } from "../billing/pricing.js";
import {
  getAgentCostMultiplier,
  composeMultiplier,
} from "../billing/agentMultiplier.js";
import {
  startInflightJournal,
  abortInflightJournal,
} from "../billing/proxyBilling.js";
import {
  makeCodexFinalizer,
  type CodexFinalizeHandle,
} from "../billing/codexFinalizer.js";
import type { TokenUsage } from "../billing/calculator.js";
import { maybeUpdateAccountQuotaCodex } from "../account-pool/quota.js";
import { OutboundRingBuffer, DEFAULT_RING_CONFIG } from "@openclaude/gateway";
import {
  newTraceId,
  parseTraceIdCandidate,
  type TraceIdIssue,
} from "@openclaude/protocol";
import type { GithubSelectionRow } from "../github/sessionWorkspaces.js";
import {
  applyStatusFrame,
  buildAutoRebindFrames,
  enrichBindRequest,
  fetchActiveSelectionsForRebind,
  parseBindRequest,
  parseStatusFrame,
  parseUnbindRequest,
} from "./sessionRepoBindBridge.js";

// ---------- 协议 / 常量 -----------------------------------------------------

/** 桥接路径(只此一个,gateway upgrade 路由按 url.pathname 匹配)。 */
export const BRIDGE_WS_PATH = "/ws/user-chat-bridge";

/** WebSocket close codes(自家私有码段:4000-4999)。 */
export const CLOSE_BRIDGE = {
  NORMAL: 1000,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
  /** 容器未就绪 / 迁移中(对应 supervisor.ensureRunning 的 503)。前端按 retryAfter 重试。 */
  CONTAINER_UNREADY: 4503,
  /** V3 Phase 4H+ maintenance_mode=true 时非 admin 的 close code。前端按 retryAfter 重连,
   *  但在维护期内会持续被拒,直到管理员关闭开关。 */
  MAINTENANCE: 4504,
} as const;

/** 入站 / 出站 帧的最大字节数(单帧)。
 * 前端允许附件单文件 200 MiB / 总量 300 MiB (raw),一条 inbound.message 帧一次性打包全部 media,
 * base64 膨胀 4/3 ≈ 400 MiB + JSON/dataURL prefix/文件名 envelope → 448 MiB 圆整。
 * 早期 1 MiB / 80 MiB 会让大附件被 ws 库 Receiver 以 RangeError 直接关连接,消息到不了业务层。
 *
 * 导出供 index.ts 装配 createTunnelContainerSocket 时复用,避免两处 magic number 漂移。 */
export const DEFAULT_MAX_FRAME_BYTES = 448 * 1024 * 1024;

/** 单方向 buffer 上限。超出 = 慢消费者 / 死循环 → close。 */
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** 连接到容器的超时 ms。容器 WS 同机回环,1s 都嫌长。 */
const DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS = 5_000;

/** ConnectionRegistry 默认 maxPerUser(沿用 connections.ts 的 3)。 */
const DEFAULT_MAX_PER_USER = 3;

/**
 * 2026-04-21 安全审计 HIGH#5:WS ping/pong 心跳。
 *
 * 为什么需要:
 *   - 前端移动端 / 家宽 NAT / 运营商透明代理会在 60-180s 无流量时悄悄 half-close,
 *     TCP 层不发 RST,gateway 以为 socket 还活着,持续占用一条 connection pool slot
 *     + uid→ws 表里的死连接会被 broadcastToUser 当作在线在循环里 send 无效字节。
 *   - 前端 webscoket.js onclose 心跳只检到自己这侧的 EOF,中间链路断掉它不感知,
 *     最终靠业务帧失败才发觉,期间用户看到"发完消息没反应"。
 *
 * 实现:
 *   - 每 30s server 向 client 发 ping;上一次 ping 发出后直到 60s 内必须收到 pong
 *     或任何 message(下游正常聊天帧也算"还活着"的证据)。
 *   - 超时 → terminate() + cleanup 走 client_close 路径,不对容器侧造成额外影响。
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

// ---------- 公共类型 --------------------------------------------------------

/**
 * 容器端点解析器 — Phase 2 由测试或外层注入,Phase 3D 由 supervisor.ensureRunning 实现。
 *
 * 抛 `ContainerUnreadyError(retryAfterSec, reason)` → 桥接层 close(4503, reason)
 *   并把 retryAfter 写进 close reason JSON;前端按建议秒数重连
 *
 * 抛任何其他 error → close(1011, 'internal error');不暴露原始 error 到客户端
 */
export type ResolveContainerEndpoint = (
  uid: bigint,
) => Promise<{
  host: string;
  port: number;
  /**
   * agent_containers.id —— 用于 bridge 调用 markContainerActivity 刷
   * last_ws_activity 防 idle sweep 误杀长会话。可选:测试 / 单测 mock 不需要;
   * v3 supervisor 路径会填上。缺失时 bridge 不发活动信号(语义降级)。
   */
  containerId?: number;
  /**
   * 本次 ensureRunning 是否走了 provision 分支(冷启)。
   * - true → bridge 在 containerWs 'open' 时给 userWs 发一帧 `{type:"sys.cold_start"}`,
   *   前端据此把 typing indicator 文案换成"首次加载上下文较慢"提示
   * - false → 不发,前端走标准"思考中"
   *
   * 缺失视同 false(向后兼容,测试 mock 不必填)。
   *
   * 漏标 trade-off:provision 成功但 readiness 超时 → 4503 → 重连后命中 running 分支,
   * 此时 coldStart=false 但用户实际经历了冷启。低概率事件,运维 metric 也会有同样
   * 漏标(ws_bridge_ttft_seconds.kind=warm 不严格等于"未冷启")。
   */
  coldStart?: boolean;
  /**
   * 跨 host 路由信号:set 表示这个容器在远端 host(boundIp/port 不可直达),
   * bridge 必须经 node-agent tunnel 拉 WS。`nodeAgent` 是为本次 bridge 建链
   * 重新 hydrate 的 NodeAgentTarget(短生命周期,bridge 用完就丢) — 不要复用
   * readiness 内部那份(那份 psk 探活完 fill(0) 了)。
   *
   * 未 set → bridge 直接 dial host:port(self-host / 单机 MVP 场景,行为不变)。
   *
   * 历史 bug(2026-04-26):没有这个字段时 bridge 对 remote-host 容器一直
   * EHOSTUNREACH,readiness 通过后立即 4503 重连风暴。
   */
  tunnel?: {
    hostId: string;
    containerInternalId: string;
    nodeAgent: NodeAgentTarget;
  };
}>;

/**
 * 容器未就绪(provision 中 / 迁移中 / 临时不可达)。
 *
 * MVP 单 host 下,主要触发场景:
 *   - 首次连 ws 时容器还没 provision(冷启 5-10s)
 *   - persistent 容器 stop 后正在 startStoppedContainer
 *
 * Phase 3 supervisor.ensureRunning 内部将 throw 这个;Phase 2 测试桩可手 throw。
 */
export class ContainerUnreadyError extends Error {
  constructor(
    /** 前端建议下次尝试的秒数(2-30 之间合理)。 */
    readonly retryAfterSec: number,
    /** 短诊断字符串,例如 "provisioning" / "migration_in_progress" / "starting"。 */
    readonly reason: string,
  ) {
    super(`container not ready: ${reason} (retry after ${retryAfterSec}s)`);
    this.name = "ContainerUnreadyError";
  }
}

/** 测试 / 2I-2 metrics 回调:单事件钩子。 */
export interface BridgeMetricSink {
  /** 一条用户帧已转发到容器(bytes 是 raw 字节数,含 binary)。 */
  onUserFrame?(uid: bigint, bytes: number, isBinary: boolean): void;
  /** 一条容器帧已转发到用户。 */
  onContainerFrame?(uid: bigint, bytes: number, isBinary: boolean): void;
  /**
   * Bridge TTFT:首个 user→container 帧 ↔ 首个 container→user 帧 的间隔。
   * 每个 bridge session 至多触发一次(若用户从未发帧,则不触发)。
   * kind 透 endpoint.coldStart(undefined → "warm",见 ResolveContainerEndpoint 漏标说明)。
   */
  onTtft?(uid: bigint, kind: "cold" | "warm", seconds: number): void;
  /** 当前任意一侧 buffered bytes 取最大值上报(用于 prometheus gauge)。 */
  onBufferedBytes?(uid: bigint, side: "user_to_container" | "container_to_user", bytes: number): void;
  /** 桥关闭时单次,拿到本次会话总字节数 / 时长 / closeCode。 */
  onClose?(stats: {
    uid: bigint;
    connId: string;
    durationMs: number;
    closeCode: number;
    closeReason: string;
    bytesUserToContainer: number;
    bytesContainerToUser: number;
    cause: BridgeCloseCause;
  }): void;
}

/** 桥关闭的根因分类(供 metrics / 日志诊断)。 */
export type BridgeCloseCause =
  | "client_close"           // 用户主动 close
  | "container_close"        // 容器主动 close
  | "container_error"        // 容器 socket 错(ECONNREFUSED 等)
  | "container_unready"      // ensureRunning throw ContainerUnreadyError
  | "auth_failed"            // JWT 验证失败
  | "frame_too_big"          // 单帧超过 maxFrameBytes
  | "binary_unsupported"     // (保留,默认放行 binary)
  | "backpressure"           // buffer 超 maxBufferedBytes
  | "internal_error"         // 兜底
  | "shutdown";              // server.shutdown()

// ---------- Deps + Handler --------------------------------------------------

export interface UserChatBridgeDeps {
  jwtSecret: string | Uint8Array;
  /** 解析 uid → 容器 host/port。Phase 3D 接 supervisor.ensureRunning;Phase 2 单测自行 mock。 */
  resolveContainerEndpoint: ResolveContainerEndpoint;
  /** 可选:每用户最大并发(默认 3)。 */
  maxPerUser?: number;
  /** 可选:单帧上限(双向,默认 1MB)。 */
  maxFrameBytes?: number;
  /** 可选:单方向 buffer 上限(默认 4MB)。 */
  maxBufferedBytes?: number;
  /** 可选:连接到容器的超时(默认 5s)。 */
  containerConnectTimeoutMs?: number;
  /** 可选:心跳 ping 间隔 ms(默认 30s)。设 0 禁用(测试用)。 */
  heartbeatIntervalMs?: number;
  /** 可选:心跳超时 ms(默认 60s),超过未收到 pong/message 即判死链。 */
  heartbeatTimeoutMs?: number;
  /** 可选:metrics 钩子(2I-2 接 prom-client)。 */
  metrics?: BridgeMetricSink;
  /** 可选:logger(2I-1)。不传则静默(降到 noop)。 */
  logger?: Logger;
  /**
   * 可选:覆盖容器 WS 客户端构造,主要给单测注入 ws.Server 双向 mock。
   * 默认实现:`new WebSocket(\`ws://${host}:${port}/ws\`)`。
   * 仅用于 endpoint.tunnel **未** set 的情况(self-host / 单机 MVP)。
   */
  createContainerSocket?: (host: string, port: number, signal: AbortSignal) => WebSocket;
  /**
   * 必选(若任何 endpoint 可能返回 tunnel):跨 host 路径下从 node-agent tunnel 拉
   * 容器 WS。default 装配在 commercial/src/index.ts;单测可注入 mock。
   *
   * async 是因为内部要先 await 完 mTLS+pin TLS 握手才能把 socket 交给 ws 库
   * (避免在 cert 校验未完成时把 PSK 写出去)。bridge 在 await 期间继续接早到帧。
   *
   * 抛错或返 reject 都视作"容器不可达",bridge close(1011)。endpoint.tunnel 已
   * set 但本字段未注入 → 同样按"容器不可达"处理(见 handleUpgrade)。
   */
  createTunnelContainerSocket?: (
    tunnel: { hostId: string; containerInternalId: string; nodeAgent: NodeAgentTarget },
    containerPort: number,
    signal: AbortSignal,
    /**
     * S12e CG4(合同 A):connection-level trace id,bridge 持有的 `connId = randomUUID()`
     * 直传。工厂内部写到 outgoing tunnel WS upgrade 的 `X-Connection-Trace-Id` header,
     * node-agent / in-container gateway 据此关联整条 connection 的 log。
     *
     * 必传 string —— 调用方在 startBridge 一定已经生成 connId(line ~999);测试 mock
     * 也必须传(传 `_connId` 之类参数承接即可)。
     */
    connectionTraceId: string,
  ) => Promise<WebSocket>;
  /**
   * 可选:每收到一帧 client→container 消息时调用,用于刷 last_ws_activity。
   *
   * bridge 内部做了 60s debounce(常量 `ACTIVITY_REFRESH_INTERVAL_MS`),所以 caller
   * 不必再做节流。container→user 帧、ping/pong、心跳**都不刷**(防 chatty 输出
   * 把 idle 假装成活跃)。markContainerActivity 自身要 fire-and-forget(不阻塞 bridge),
   * 异常也要 swallow,典型实现包 `void markV3ContainerActivity(deps, cid)`。
   *
   * 没注入 / endpoint 没返 containerId → bridge 直接跳过这层逻辑(等价空实现)。
   */
  markContainerActivity?: (containerId: number) => void;
  /**
   * 0049 模型授权(plan v3 §B3/§B4 + §F4)—— 桥接层是 v3 commercial **唯一**能
   * 看到 inbound.message 帧并且也能拿到 user role + grants 的位置:
   *   - 容器内 personal-version gateway 没有 commercial DB 连接,查不了 grants
   *   - HTTP message-create handler 在 v3 不存在(用户消息走 WS,不走 REST)
   *
   * caller(commercial/index.ts)在 bridge 启动连接时**只调一次** loadAllowedModelChecker,
   * 拿到一个**已绑定 uid+role+grants 集合**的纯同步 closure;后续每条 user→container
   * 文本帧若是 inbound.message 且带 `model` 字段,就 sync 调一次 checker。返 false →
   * 桥发 error frame + close(1008),不把帧 forward 进容器(避免容器侧 inferAgentForModel
   * 错误信息泄漏 codex agent / config 状态;plan v3 §B4 review v3 补)。
   *
   * loadAllowedModelChecker 失败 throw → 桥关 1011 'agent unavailable'(grants 加载
   * 失败不能 silently 放行,bridge 不区分 DB 故障 vs 用户被禁,统一拒)。
   *
   * 未注入(测试 / 个人版上下文)→ 桥不做模型校验,完全透传(行为与本字段加入前一致)。
   *
   * 为什么不在 bridge 内部直接持 PricingCache + listGrantsForUser:这一层不应耦合
   * billing / admin 子模块;dep injection 把"鉴权策略"留给 caller 拼装,bridge 单测
   * 可注入 mock checker 而不必拖起 PricingCache。
   */
  loadAllowedModelChecker?: (
    uid: bigint,
    role: "user" | "admin",
  ) => Promise<(modelId: string) => boolean>;
  /**
   * Commercial v3 authority for browser chat history lives in master's
   * SQLite, not inside the per-user container. When a browser session switches
   * between providers (e.g. DeepSeek/CCB → Codex native), the container needs
   * a bounded transcript preamble to bridge the provider-local resume gap.
   * The dep returns the raw master messages; this bridge strips/caps them
   * before attaching the private `_masterHistoricalMessages` field.
   */
  loadMasterSessionMessages?: (
    uid: bigint,
    sessionId: string,
  ) => Promise<unknown[] | null>;
  /**
   * plan v3 G5/G7 — codex per-account 并发槽 + 严格单飞 acquire/release。
   *
   * 调用契约:
   *   - bridge 在 inbound.message 帧 + effectiveModel 是 codex 类(`gpt-*` 或
   *     agentImpliedModel='gpt-5.5')时调 `acquire(containerId)`
   *   - acquire 返回:
   *     - `null` → 容器是 legacy NULL(`codex_account_id IS NULL`),走 legacy
   *       `config.auth.codexOAuth` 共享 dir 路径,**不占** per-account 槽(决策 N3)
   *     - `{account_id}` → 已 inc inflight + 通过 lazy migrate(若需要)+ 写
   *       per-container auth.json 并 UPDATE codex_account_id;调用方记下此 id 用于
   *       后续 release
   *   - acquire 抛 `AccountPoolBusyError` → bridge fast-fail(决策 O):error 帧
   *     "codex pool busy",**不 fallback 到 legacy**
   *   - acquire 抛其他 → bridge fast-fail "GPT temporarily unavailable"
   *   - `release(account_id)` 必须用 acquire 时记录的 account_id(决策 N2 MAJOR 3:
   *     不重读 row,防 lazy migrate 漂移导致 release 减错账号槽)
   *
   * **G7 严格单飞**:bridge 内部维护 per-bridge "已持槽" 状态;新 inbound 命中已持
   * 状态 → reject "previous codex turn still in progress"(error 帧),不复用 slot
   * 不并发,frame 不 forward 到容器。
   *
   * 未注入 → bridge 不做 codex 并发管控,inbound 透传(测试 / 个人版上下文)。
   */
  codexBinding?: CodexBindingHandle;
  /** Create an opaque per-turn Codex API relay route. When injected, GPT turns use api_relay groups instead of legacy OAuth codex accounts. */
  createCodexRoute?: (args: {
    containerId: number;
    userId: bigint;
    modelId: string;
  }) => Promise<CodexApiRelayRoute | null>;
  /** Expire an opaque per-turn Codex API relay route after the turn settles or aborts. */
  expireCodexRoute?: (token: string) => Promise<void>;
  /**
   * PR2 v1.0.66 — codex 真扣费三件套(必须同时注入或同时缺省)。
   *
   * - 注入(commercial 路径):codex inbound 帧走 preCheck → inflight journal →
   *   forward → outbound.codex_billing settle → ledger debit + cost_charged 广播
   * - 缺省(测试 / 个人版):codex inbound 仍可走 acquire 占槽,但不 settle,纯透传
   *
   * **创建 handler 时强校验**(见 createUserChatBridge entry):partial 注入
   * (例如只注 pgPool 没注 preCheckRedis)→ 直接 throw,防生产配置错把"漏 settle"
   *  静默隐藏导致 codex 免费。codexBinding 已注 ⇒ 三件套必须全注。
   *
   * settle 路径用法:bridge 内部用 deps.pgPool 写 journal、用 deps.preCheckRedis
   * 跑 preCheckWithCost、用 deps.pricing.get(modelId) 拿 ModelPricing 复合
   * agent multiplier 后给 codexFinalizer 用。
   */
  pgPool?: Pool;
  preCheckRedis?: PreCheckRedis;
  pricing?: PricingCache;
  /**
   * Persist costCredits into master's `client_sessions` blob via storage's
   * `appendCostCredits` helper. Mirror of the same dep on
   * `AnthropicProxyDeps`: bridge in-line持久化 codex 模式扣费,fail-open if
   * not injected. See plan §4.2 改动 4a.
   *
   * Called only on the codex billing commit success branch (debit > 0).
   * Optional in the same way as `appendCostCredits` on anthropicProxy:
   * tests omit, deploy injects.
   */
  appendCostCredits?: (
    requestId: string,
    userId: string,
    costCredits: string,
  ) => Promise<unknown>;
}

/**
 * plan v3 G5/G7 — codex 容器与账号绑定 / per-account 并发槽控制 handle。
 *
 * `acquire`:幂等持锁逻辑(决策 N2):查 row.codex_account_id + status,若 active
 * 则直接 inc inflight slot;若非 active 走 lazy migrate(`pickCodexAccountForBinding`
 * + FOR UPDATE 持锁直到 atomic rename + UPDATE 持锁内同 tx 提交;失败 ROLLBACK
 * 自动回滚 codex_account_id);返回最终 acquire 的 account_id(供 release 用)。
 *
 * `release`:dec inflight slot(scheduler.releaseCodexSlot),不调 health.onSuccess /
 * onFailure(决策 J2:bridge 不知道真实 turn 出参,健康分留给 release 层)。幂等。
 */
export interface CodexBindingHandle {
  acquire(containerId: number): Promise<{ account_id: bigint } | null>;
  release(account_id: bigint): void;
}

export interface CodexApiRelayRoute {
  token: string;
  baseUrl: string;
  modelProvider: string;
  providerName?: string | null;
  wireApi?: "responses" | "chat";
  preferredAuthMethod?: "apikey" | "chatgpt";
  disableResponseStorage?: boolean;
  groupId: string;
  credentialId: string;
}

/**
 * 单连每 N ms 最多调一次 markContainerActivity —— 防 chatty 用户每帧都冲 DB。
 * 60s 与 idle sweep 默认 30min cutoff 之间留够余量(用户哪怕 60s 才发一帧
 * 也不会被误判 idle)。
 */
const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;

/**
 * 0049 模型授权 refresh 间隔(plan v3 review v1 §F4 follow-up)。
 *
 * 桥接连接 lifetime 内,每 N ms 重新调一次 loadAllowedModelChecker 拉最新
 * grants 快照 + visibility,使 admin 取消授权后**无需用户重连**就能在窗口内
 * 失效。30s 足够低延迟(用户感知近实时),又不至于把 PG 打穿(每用户每分钟
 * 2 次 SELECT;1k 在线 ≈ 33 QPS,远低于 PricingCache 的 LISTEN/NOTIFY 路径)。
 *
 * Refresh 失败 → 保留上一次成功的 checker,不切到"全拒"或"全放"。原因:DB
 * 临时抖动比授权状态变化更频繁,把已经授权的连接因为一次抖动踢掉会更糟。
 */
const GRANTS_REFRESH_INTERVAL_MS = 30_000;

/**
 * plan v3 G6 — codex per-account 槽兜底释放上限(默认 10 分钟)。
 *
 * 为什么需要:bridge 是 byte-transparent 的,不解析 outbound SSE 流,因此无法精确
 * 检测"codex turn 完成"信号(personal-version `event:message_stop` 在容器 ws 帧
 * 内,跨多帧拼接)。退而求其次:每次 acquire 同时启动一个 setTimeout,到点强制
 * release。CODEX_SESSION_MAX_MS = 600s 与个人版 codex app-server 单次 turn 实际上限
 * (~5min stream + buffer)对齐。ws close 也会通过 cleanup 路径释放(更早触发)。
 *
 * env `CODEX_SESSION_MAX_MS` 覆盖(测试常用 1000-5000)。
 */
const DEFAULT_CODEX_SESSION_MAX_MS = 600_000;
function readCodexSessionMaxMs(): number {
  const raw = process.env.CODEX_SESSION_MAX_MS;
  if (!raw) return DEFAULT_CODEX_SESSION_MAX_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_CODEX_SESSION_MAX_MS;
}

/**
 * Agent → 隐含 model 授权映射(plan v3 round-2 finding 1 fix)。
 *
 * 为什么需要:用户提交 inbound.message 时可以**只**带 `agentId` 不带 `model`
 * (v3 webchat 的常见情况:用户切到某 agent,不主动选 model)。这种帧到达时:
 *   - bridge 之前只看 frame.model → 没 model 就 skip authz
 *   - 容器内 gateway 把 frame 路由给 agentId='codex' 那个 agent → CodexAppServerRunner
 *     用 agent.model='gpt-5.5' 启动 → 未授权用户拿到 codex API
 *
 * 因此:bridge 看到 agentId 命中本表 → 用对应 modelId 做 authz 校验。本质是
 * "哪些 agentId 一旦使用,等于在用受限 model"的 explicit allowlist。新增 codex
 * agent 必须在此登记。
 *
 * 与 agents.yaml 的关系:agents.yaml 是 runtime 配置,本表是**安全 contract**;
 * 二者偏离不影响安全(本表多列 = 多拦,少列 = 漏拦但 inferAgentForModel 仍兜底)。
 */
const AGENT_AUTHZ_IMPLIED_MODEL: Record<string, string> = {
  codex: "gpt-5.5",
};

/**
 * PR2 v1.0.66 — codex 真扣费 preCheck 估算用的 max output tokens。
 *
 * codex inbound 帧不带 max_tokens 字段(由 codex app-server 内部决定),master 估
 * preCheck 上限只能拍脑袋。64K 是 codex app-server 0.125 默认 max output tokens
 * 的近似上限(实际 32-64K 视模型)。
 *
 * 2026-05-06:preCheck 已移除 ceiling 拒,balance > 0 即放行,reservation cap 到
 * balance — 这个估算只影响 originalMaxCost / capped metric,不再决定放/拒。
 * 真实扣费由 finalizer 拿真 usage 重算。
 */
const CODEX_PRECHECK_TOKEN_ESTIMATE = 64_000;
const MASTER_HISTORY_MAX_MESSAGES = 48;
const MASTER_HISTORY_MAX_CHARS = 18_000;

/**
 * PR2 v1.0.66 — user WS close 后等 codex billing 帧的 drain 窗口。
 *
 * 为什么需要(Codex BLOCKER 1):用户中途断开 → cleanup 立即关 container WS
 * → 容器侧已发出但还在网络/事件循环里的 outbound.codex_billing 帧丢失 → 漏扣。
 * Drain 期保留 container WS 监听不变,只把 user 侧资源(registry slot、heartbeat)
 * 立即让出,billing 帧在 5s 内到达走 settle 正常落账;超时未到则按 fail 收尾,
 * 由 reconciler 后续兜底(已存 inflight 行)。
 *
 * 5s 取舍:codex turn 终态信号 → master 间通常毫秒级;5s 远高于 P99 网络抖动,
 * 又不至于卡死容器 WS 太久导致下个用户连接挤占 host 资源。
 */
const DRAIN_BILLING_MS = 5_000;

/**
 * PR2 v1.0.66 — 32-hex per-turn 标识,master 生成且**强制覆写** client 提供的值。
 *
 * 设计契约:client (浏览器) 不应也无法预测此 id;若 client 把别的 turn 的
 * requestId 塞进 inbound.message 试图错关 inflight 行 → master 直接覆写,
 * 防伪造。容器侧只在 inbound→outbound.codex_billing 透传,不验证。
 */
function ensureRequestIdServerSide(): string {
  return randomBytes(16).toString("hex");
}

/**
 * PR2 v1.0.66 — bridge 持有的 codex inflight turn 快照。
 *
 * 关键:settle 时**只信本快照**,不信 outbound.codex_billing 帧的 model/agentId
 * 字段(防容器侧伪造改账)。frame 只承载 usage 统计 + requestId 关联键。
 */
interface CodexTurnSnapshot {
  finalizer: CodexFinalizeHandle;
  /** server-owned 32-hex id;Map key 与本字段同值,仅冗余便于日志。 */
  requestId: string;
  /** preCheck 时取的 model id(audit / log)。 */
  model: string;
  /** Issue A v1.0.108 — billing 帧的 codex_billing 分支需要根据账号 id 把
   *  rateLimits 落到 claude_accounts.quota_*(maybeUpdateAccountQuotaCodex)。
   *  bigint 0n = legacy 无关联账号(quota writer 内部跳过)。 */
  accountId: bigint;
  /** CG2c — turn 的 canonical traceId(master 在 inbound.message 入口生成,
   *  与本 snapshot 的 requestId 同源固定)。outbound.codex_billing settle 路径用它
   *  派生 billingLog + 注入 outbound.cost_charged 广播帧,实现
   *  inbound→outbound→ledger→broadcast 的 trace 贯穿。
   *  **服务端 trust source**:settle 决策永远只信本字段,不解析 outbound 帧的
   *  frame.traceId(防容器侧伪造影响计费观测)。 */
  traceId: string;
  /** Opaque Codex API relay route token for this turn, if the turn used an API relay group. */
  codexRouteToken: string | null;
}

export interface UserChatBridgeHandler {
  /** Gateway HTTP server 的 'upgrade' 事件入口。返 false → 路径不匹配,gateway 路由别处。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** 优雅关停:踢所有连接 + close ws server。 */
  shutdown(reason?: string): Promise<void>;
  /** 测试 / metrics:获取 ConnectionRegistry。 */
  registry: ConnectionRegistry;
  /**
   * 给指定 uid 的所有活跃 user WS 广播一个 JSON 帧(旁路透传管道,非容器来源)。
   *
   * 场景:anthropicProxy 在 finalize.commit 后想把实际扣费金额推给该用户的前端,
   * 但 bridge 本身是 byte-transparent 的 —— 容器侧不知道扣费细节、也不该改帧。
   * 所以新增此旁路入口,直接把 frame 注入到 user WS。
   *
   * 返回实际发送成功的连接数(用户可能没在线 / 没登录,返 0 是合法状态)。
   * 非 JSON-serializable 输入会吞 JSON.stringify 异常,不抛。
   */
  broadcastToUser(uid: bigint, payload: unknown): number;
}

// ---------- 内部工具 --------------------------------------------------------

function parseWsUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try { return new URL(raw, "http://placeholder"); } catch { return null; }
}

function rejectHttp(socket: Duplex, status: number, body: string): void {
  if (socket.destroyed) return;
  const headers = [
    `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : "Error"}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  try { socket.end(headers.join("\r\n") + "\r\n\r\n" + body); }
  catch { try { socket.destroy(); } catch { /* */ } }
}

function uidFromClaims(claims: AccessClaims): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(claims.sub)) {
    throw new TypeError(`bad uid in claims.sub: ${claims.sub}`);
  }
  return BigInt(claims.sub);
}

function rawDataLen(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((acc, b) => acc + b.length, 0);
  return 0;
}

function extractMasterHistoryText(msg: Record<string, unknown>): string {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function _sanitizeMasterHistoricalMessagesForFrame(
  rawMessages: unknown[],
  opts: { maxMessages?: number; maxChars?: number } = {},
): Array<Record<string, unknown>> {
  const maxMessages = opts.maxMessages ?? MASTER_HISTORY_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? MASTER_HISTORY_MAX_CHARS;
  const rows: Array<Record<string, unknown>> = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const role = msg.role === "user" || msg.role === "assistant" ? msg.role : null;
    if (!role) continue;
    if (msg.system === true) continue;
    const text = extractMasterHistoryText(msg).trim();
    if (!text) continue;
    const out: Record<string, unknown> = { role, text };
    if (typeof msg.id === "string") out.id = msg.id;
    if (typeof msg.status === "string") out.status = msg.status;
    if (typeof msg.ts === "number") out.ts = msg.ts;
    rows.push(out);
  }

  let selected = rows.slice(-maxMessages);
  while (selected.length > 0) {
    const chars = selected.reduce((sum, m) => sum + String(m.text ?? "").length, 0);
    if (chars <= maxChars) break;
    selected = selected.slice(1);
  }
  return selected;
}

function sendErrorFrame(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type: "error", code, message })); }
  catch { /* client gone */ }
}

/**
 * 将 4503 close reason 编码为 JSON 字符串(retryAfterSec + reason),前端 parse 即可拿建议。
 * 注意 close reason 字段有 123 字节上限(WebSocket spec),保持紧凑。
 */
function encode4503Reason(retryAfterSec: number, reason: string): string {
  const safeReason = reason.slice(0, 64);
  return JSON.stringify({ retryAfterSec, reason: safeReason });
}

/**
 * 把对端 close code 净化成"可在 wire 上发送"的值。
 *
 * RFC 6455:1005 / 1006 / 1015 是 reserved,**不能** send;ws lib 会 throw
 * "First argument must be a valid error code number"。其它合法范围:
 *   - 1000-1003, 1007-1011, 1012-1014  (但 1004/1016+ 未使用)
 *   - 3000-4999  (registered + private)
 *
 * 简化策略:落在三个 reserved 码 → 改 1000;否则 1000-4999 内放行,其它一律 1000。
 */
function sanitizeCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) return CLOSE_BRIDGE.NORMAL;
  if (code >= 1000 && code <= 4999) return code;
  return CLOSE_BRIDGE.NORMAL;
}

// ---------- 主入口 ----------------------------------------------------------

export function createUserChatBridge(deps: UserChatBridgeDeps): UserChatBridgeHandler {
  // PR2 v1.0.66 — codex 真扣费三件套一致性强校验(Codex BLOCKER 3 修复)。
  // partial 注入(漏一个)在生产里会让 codex 帧 acquire 但不 settle,等于
  // 静默免费送 token。boot-time fail-closed 防漏注。
  // 测试 mock 三个全 undefined 也合法(纯透传 / 不做计费)。
  const codexBillingDepsCount =
    [deps.pgPool, deps.preCheckRedis, deps.pricing].filter((x) => x !== undefined).length;
  if (codexBillingDepsCount !== 0 && codexBillingDepsCount !== 3) {
    throw new TypeError(
      "createUserChatBridge: pgPool/preCheckRedis/pricing must be all set or all unset " +
      "(partial wiring suggests deployment misconfig that would silently disable codex billing)",
    );
  }
  if (deps.codexBinding !== undefined && codexBillingDepsCount === 0) {
    throw new TypeError(
      "createUserChatBridge: codexBinding requires pgPool+preCheckRedis+pricing " +
      "(otherwise codex turns acquire slots but never settle billing — silent free codex)",
    );
  }
  const codexBillingEnabled = codexBillingDepsCount === 3;

  const maxPerUser = deps.maxPerUser ?? DEFAULT_MAX_PER_USER;
  const maxFrameBytes = deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const connectTimeoutMs = deps.containerConnectTimeoutMs ?? DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const log = deps.logger;
  const metrics = deps.metrics ?? {};
  const createContainerSocket = deps.createContainerSocket
    ?? ((host, port, _signal) =>
        new WebSocket(`ws://${host}:${port}/ws`, { perMessageDeflate: false, maxPayload: maxFrameBytes }));

  const registry = new ConnectionRegistry({ maxPerUser });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });

  /**
   * Phase 0.4 — bridge-layer outbound ring buffer (process-singleton).
   *
   * Personal-master ports its `outboundRing` here so that v3-commercial bridges
   * can serve `inbound.hello.lastFrameSeq` replays close to the client without
   * relying on the embedded container's ring (which sees a different WS socket
   * after every reconnect and has no privileged view of cross-tab state).
   *
   * Storage key:    `${uid}:${containerId}:${sessionKey}`
   *   - `uid` isolates tenants (multiple users share one bridge process)
   *   - `containerId` namespaces a container's lifetime — a fresh container
   *     gets a fresh slot, so seq=1 from a restarted container never collides
   *     with the previous container's seq=1 (no in-band reset signal needed)
   *   - `sessionKey` is the wire-stamped key the personal-master gateway
   *     embedded into the outbound frame (verbatim, NOT recomputed)
   *
   * Container ring still receives hello and may also serve replay; client-side
   * frameSeq dedupe (websocket.js handleOutbound) absorbs any duplicate frames.
   */
  const outboundRing = new OutboundRingBuffer(DEFAULT_RING_CONFIG);

  /**
   * 周期性 lazy prune 兜底。
   *
   * OutboundRingBuffer 的 store / peekReplay 只在被 touch 的 key 上做 prune;
   * 当 containerId 变了之后,旧 `${uid}:${oldCid}:${sessionKey}` 的 key 不再
   * 被任何路径访问,frames 残留 + rings Map entry 不释放,会随容器生命周期累积。
   *
   * 60s 跑一次 pruneAll(now): 对所有 ring 应用 TTL/cap 驱逐,空 ring 从 Map 删除。
   * lastSeq Map 不动 —— 删了会破坏"上次有过 frameSeq>0 但都过期了"的语义,
   * 让冷 tab/state-reset 后 hello cursor=0 + currentLast>0 的 client 拿到
   * ok+[](静默不丢)而不是 resume_failed(no_buffer)→ REST 强同步。
   * lastSeq entry 不带 frame data,单 entry 内存代价 <100B,慢漏可接受。
   */
  const ringPruneTimer: NodeJS.Timeout = setInterval(
    () => { outboundRing.pruneAll(Date.now()); },
    60_000,
  );
  ringPruneTimer.unref?.();

  /**
   * uid(string) → 该用户当前持有的所有正在正常桥接中的 user WS 集合。
   *
   * 为什么单独维护一份而不用 ConnectionRegistry:
   *   - ConnectionRegistry 只存 { id, user_id, opened_at, close } — 没有 ws 句柄引用,
   *     因为原设计保持"关连接靠回调"的抽象,不把 ws lib 泄漏到那层
   *   - broadcastToUser 需要直接 ws.send —— 把 ws 加到 Conn 里会把 registry 接口污染,
   *     所以这里单开一张表。两张表的增删时机严格一致(startBridge 开头加、cleanup 里删),
   *     保持不变量"uidToUserWs[uid] 含的 ws 与 registry[uid] 含的 Conn 一一对应"。
   *
   * 注意:只有**早到帧处理完 + 桥真正开起来**的 ws 才进这张表 —— JWT 失败 / ContainerUnready
   * 期间的 ws 不在这里,因为没有跑到 startBridge 里 registry.register。
   */
  const uidToUserWs = new Map<string, Set<WebSocket>>();

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = parseWsUrl(req);
    if (!url) {
      rejectHttp(
        socket, 400,
        JSON.stringify({ error: { code: "BAD_URL", message: "cannot parse URL" } }),
      );
      return true;
    }
    if (url.pathname !== BRIDGE_WS_PATH) return false;

    // 同 agent.ts:先 upgrade,认证错也走 ws frame 报告,前端体验比 HTTP 401 直接关好。
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 早到帧暂存(auth + ensureRunning 是 async)
      // receivedAtMs 用于 bridge TTFT 起点 — 早到帧也算"用户已发首条消息"。
      const pendingMessages: Array<{ data: RawData; isBinary: boolean; receivedAtMs: number }> = [];
      let earlyClose: { code: number; reason: Buffer } | null = null;
      const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
        pendingMessages.push({ data, isBinary, receivedAtMs: Date.now() });
      };
      const onEarlyClose = (code: number, reason: Buffer): void => {
        earlyClose = { code, reason };
      };
      ws.on("message", onEarlyMessage);
      ws.on("close", onEarlyClose);

      // S12e CG4:connection-scoped trace id 在 handleUpgrade 早期生成。
      // 历史上这行 `randomUUID()` 在 startBridge 顶上(L1008),但 tunnel factory
      // 调用(L896-900,在 startBridge 之前)也需要这个值塞进 X-Connection-Trace-Id
      // 头。把生成挪到 IIFE 起点,保证 tunnel pre-dial / bridge log / 后续 child
      // (turnLog 等)共享同一 UUID;startBridge 内 connId 参数直接收。
      const connId = randomUUID();

      void (async () => {
        // 1) JWT 验证 — token 来源只接受:
        //    Sec-WebSocket-Protocol "bearer, <token>" > Authorization Bearer
        //    前端 `new WebSocket(url, ['bearer', token])` 会发 Sec-WebSocket-Protocol
        //
        // 2026-04-21 安全审计 HIGH#2 修复:此前曾支持 `?token=<jwt>` URL query
        // fallback,但 query string 会落 Caddy / gateway access log + 浏览器
        // 历史 / referrer header,导致 access JWT 泄漏。前端已全部走
        // ['bearer', token] 子协议路径,纯 server-only 的 fallback 直接删除。
        let token = "";
        const protoHeader = req.headers["sec-websocket-protocol"];
        if (typeof protoHeader === "string") {
          const protos = protoHeader.split(",").map((s) => s.trim());
          if (protos.includes("bearer") && protos.length >= 2) {
            token = protos[protos.length - 1] ?? "";
          }
        }
        if (!token) {
          const authHeader = req.headers.authorization;
          if (typeof authHeader === "string") {
            token = authHeader.replace(/^Bearer\s+/i, "").trim();
          }
        }
        if (!token) {
          sendErrorFrame(ws, "UNAUTHORIZED", "missing token (bearer protocol or Authorization header)");
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }
        let claims: AccessClaims;
        try {
          claims = await verifyAccess(token, deps.jwtSecret);
        } catch (err) {
          if (err instanceof JwtError) {
            sendErrorFrame(ws, "UNAUTHORIZED", "invalid or expired token");
          } else {
            sendErrorFrame(ws, "ERR_INTERNAL", "auth failure");
            log?.error("user-chat-bridge: verifyAccess threw", { err });
          }
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }
        let uid: bigint;
        try { uid = uidFromClaims(claims); }
        catch (err) {
          log?.error("user-chat-bridge: bad sub claim", { err });
          sendErrorFrame(ws, "UNAUTHORIZED", "bad uid in token");
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }

        // 1.4) 0049 模型授权 checker —— 在 ensureRunning 之前拉一次 grants。
        //   - load 失败 throw → close(1011)。grants DB 故障期间不做"放行"假设,
        //     不然付费用户能在故障窗口里调到任何 hidden model。
        //   - 测试 / 个人版上下文未注入 deps.loadAllowedModelChecker → handle=null,
        //     桥行为与本字段加入前完全一致(无校验,纯透传)。
        //   - 桥每 GRANTS_REFRESH_INTERVAL_MS ms 重新加载一次,使 admin 取消授权能
        //     在窗口内对**已开 ws 连接**生效(plan v3 review v1 §F4 follow-up)。
        //     refresh 失败保留上次 checker。lifetime 与连接绑定:cleanup() 清 timer。
        let modelCheckerHandle:
          | {
              isAllowed: (modelId: string) => boolean;
              refresh: () => Promise<void>;
            }
          | null = null;
        if (deps.loadAllowedModelChecker) {
          const loader = deps.loadAllowedModelChecker;
          let inner: (modelId: string) => boolean;
          try {
            inner = await loader(uid, claims.role);
          } catch (err) {
            log?.error("user-chat-bridge: loadAllowedModelChecker threw", {
              uid: uid.toString(),
              err,
            });
            sendErrorFrame(ws, "ERR_INTERNAL", "authorization unavailable");
            try { ws.close(CLOSE_BRIDGE.INTERNAL, "authorization unavailable"); } catch { /* */ }
            return;
          }
          modelCheckerHandle = {
            isAllowed: (modelId) => inner(modelId),
            refresh: async () => {
              try {
                const next = await loader(uid, claims.role);
                inner = next;
              } catch (err) {
                // 不切 inner —— 保留上次成功 checker。详见 GRANTS_REFRESH_INTERVAL_MS 注释。
                log?.warn("user-chat-bridge: modelChecker refresh failed (keep last good)", {
                  uid: uid.toString(),
                  err,
                });
              }
            },
          };
        }

        // 1.5) V3 Phase 4H+ maintenance 闸门:非 admin 在维护模式下不得建立新 chat 会话。
        //   - admin 判定只看 claims.role —— WS chat 不是"动账/改配置"的破坏性操作,
        //     按 HTTP 中间件那种 DB double-check 会让每次 handshake 多一次 PG roundtrip。
        //   - admin 降权立即生效由 HTTP 层(requireAdminVerifyDb)承担;WS 最坏场景是
        //     JWT 未过期的原 admin 仍能在维护期开聊,JWT 24h 内自然淘汰,可接受。
        //   - 维护时**不**force close 已在飞的连接:只拦新建。
        if (claims.role !== "admin" && (await isInMaintenance())) {
          log?.info("user-chat-bridge: maintenance block", { uid: uid.toString() });
          sendErrorFrame(ws, "MAINTENANCE", "服务正在维护中,请稍后再试");
          try {
            ws.close(
              CLOSE_BRIDGE.MAINTENANCE,
              JSON.stringify({ retryAfterSec: 60, reason: "maintenance" }),
            );
          } catch { /* */ }
          return;
        }

        // 2) 解析容器端点(ensureRunning)
        let endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>;
        try {
          endpoint = await deps.resolveContainerEndpoint(uid);
        } catch (err) {
          if (err instanceof ContainerUnreadyError) {
            log?.info("user-chat-bridge: container not ready", {
              uid: uid.toString(), reason: err.reason, retryAfterSec: err.retryAfterSec,
            });
            try {
              ws.close(
                CLOSE_BRIDGE.CONTAINER_UNREADY,
                encode4503Reason(err.retryAfterSec, err.reason),
              );
            } catch { /* */ }
            return;
          }
          log?.error("user-chat-bridge: resolveContainerEndpoint threw", {
            uid: uid.toString(), err,
          });
          sendErrorFrame(ws, "ERR_INTERNAL", "agent unavailable");
          try { ws.close(CLOSE_BRIDGE.INTERNAL, "agent unavailable"); } catch { /* */ }
          return;
        }

        // 3) 构造容器 WS — direct(sync)或 tunnel(async pre-dial mTLS+pin)。
        //    早到帧 handler 故意保留挂着,等真正进 startBridge 才解绑;async 拨号期间
        //    用户继续发的帧会进 pendingMessages,startBridge 内 replay。
        const connectAbort = new AbortController();
        let containerWs: WebSocket;
        try {
          if (endpoint.tunnel) {
            if (!deps.createTunnelContainerSocket) {
              // 部署级配置漏注 — 给 4503 让前端别死循环重连(会上报 alert 由 ensureRunning 路径)
              log?.error("user-chat-bridge: tunnel endpoint but factory not injected", {
                uid: uid.toString(),
                hostId: endpoint.tunnel.hostId,
                containerInternalId: endpoint.tunnel.containerInternalId,
              });
              sendErrorFrame(ws, "ERR_INTERNAL", "tunnel not configured");
              try { ws.close(CLOSE_BRIDGE.INTERNAL, "tunnel not configured"); } catch { /* */ }
              return;
            }
            containerWs = await deps.createTunnelContainerSocket(
              endpoint.tunnel,
              endpoint.port,
              connectAbort.signal,
              // S12e CG4:connection-level trace 透传,headers 写 X-Connection-Trace-Id
              connId,
            );
          } else {
            containerWs = createContainerSocket(endpoint.host, endpoint.port, connectAbort.signal);
          }
        } catch (err) {
          log?.error("user-chat-bridge: container socket factory failed", {
            uid: uid.toString(),
            tunnel: !!endpoint.tunnel,
            hostId: endpoint.tunnel?.hostId,
            err,
          });
          sendErrorFrame(ws, "ERR_CONTAINER", "cannot connect");
          try { ws.close(CLOSE_BRIDGE.INTERNAL, "agent unavailable"); } catch { /* */ }
          return;
        }

        // EARLY 'error' handler:ws 在 CONNECTING 阶段被 .terminate()(line ~831
        // earlyClose 路径)时,内部会在 socket 'connect' 异步回调里 throw
        // "WebSocket was closed before the connection was established" 等。
        // startBridge 内部的正式 'error' handler 此时还没挂,无人接 → 升 fatal
        // uncaughtException。挂这个 named handler 兜底;移交 startBridge 时 .off
        // 掉避免双日志,但 earlyClose return 路径保留它直到 ws 自然清理。
        const onEarlyContainerWsError = (err: Error): void => {
          log?.warn("user-chat-bridge: container ws error during connect", {
            uid: uid.toString(),
            tunnel: !!endpoint.tunnel,
            host: endpoint.host,
            port: endpoint.port,
            err: String((err as { message?: string })?.message ?? err),
          });
        };
        containerWs.on("error", onEarlyContainerWsError);

        // 4) 把"早到帧"解绑 + 检查客户端是否已撤,再交给 startBridge
        ws.off("message", onEarlyMessage);
        ws.off("close", onEarlyClose);
        if (earlyClose !== null) {
          // 客户端在 await 期间(ensureRunning 或 tunnel pre-dial)已经撤了
          log?.info("user-chat-bridge: client closed during ensure", {
            uid: uid.toString(),
          });
          // 故意不 .off(onEarlyContainerWsError):terminate() 触发的 async error
          // 仍需被这个 handler 接住。listener 会随 ws 关闭被 GC 清理。
          try { containerWs.terminate(); } catch { /* */ }
          try { connectAbort.abort(); } catch { /* */ }
          return;
        }

        // 移交 startBridge:它会在 line ~1807 挂自己的 'error' handler 接管
        // 容器 ws 生命周期。先解绑 early handler 避免双日志。
        containerWs.off("error", onEarlyContainerWsError);

        startBridge(
          ws,
          uid,
          endpoint,
          pendingMessages,
          endpoint.containerId,
          containerWs,
          connectAbort,
          modelCheckerHandle,
          connId,
        );
      })().catch((err: unknown) => {
        log?.error("user-chat-bridge: upgrade pipeline threw", { err });
        try { ws.close(CLOSE_BRIDGE.INTERNAL, "internal error"); } catch { /* */ }
      });
    });
    return true;
  }

  function startBridge(
    userWs: WebSocket,
    uid: bigint,
    endpoint: { host: string; port: number; coldStart?: boolean },
    earlyMessages: Array<{ data: RawData; isBinary: boolean; receivedAtMs: number }>,
    /**
     * 可选 agent_containers.id。来自 ResolveContainerEndpoint;v3 supervisor
     * 路径填,test mock 路径可不填。无值或 deps.markContainerActivity 未注入
     * → 不刷活动(等价于回到本 PR 之前的行为,只在 ensureRunning 刷一次)。
     */
    containerId: number | undefined,
    /**
     * 已构造好的容器侧 WS(direct 或 tunnel)。caller 在 handleUpgrade 内
     * 完成构造,把成功品交给本函数;失败品 caller 自己 close,不进 bridge。
     */
    containerWs: WebSocket,
    /**
     * caller 持有的 abort controller(同 createXxxContainerSocket 收到的 signal)。
     * cleanup 时调 abort() — 让 tunnel WS 在握手阶段 abort 也能被打断。
     */
    connectAbort: AbortController,
    /**
     * 0049 模型授权 handle —— null 表示本连接不做模型校验(deps 未注入,或
     * caller 显式不要鉴权)。
     *   - `isAllowed(modelId)`:已绑定本连接的 uid + role + grants 集合的 sync 闭包
     *   - `refresh()`:重新拉一次 grants(本桥 lifetime 内每 GRANTS_REFRESH_INTERVAL_MS
     *     ms 调一次,使 admin 取消授权对已开桥也生效)
     * onUserMessage 每条 inbound.message 帧 sync 调一次 isAllowed,且追踪
     * lastSeenModelId 让没带 model 字段的后续帧也参与校验(plan v3 review v1
     * follow-up:防"已用 gpt-5.5 跑起来的桥被撤销后无 model 字段帧透传")。
     */
    modelCheckerHandle:
      | {
          isAllowed: (modelId: string) => boolean;
          refresh: () => Promise<void>;
        }
      | null,
    /**
     * S12e CG4:caller(handleUpgrade)早期生成的 connection-scoped trace。
     * 移到 caller 的原因:tunnel factory 在 startBridge 之前调,需要同一个值
     * 写 outgoing `X-Connection-Trace-Id` 头与 bridge log connection 字段共享。
     * 36 char UUID(`randomUUID()`),过 TRACE_ID_REGEX。
     */
    connId: string,
  ): void {
    // CG2b/CG4 — connection-scoped logger:把 uid + connection-level trace 钉进 bindings,
    // 后续 startBridge 内所有 log call 不必手写这两个字段。turn-scoped(traceId)再从
    // bridgeLog.child 派生。
    //
    // 字段命名(plan §3.5 合同 A):
    // - `connectionTraceId`(camelCase)= 当前 connection 的 connId(UUID),与 node-agent /
    //   in-container gateway 共享同一名字,跨进程 grep 一条 line 就能拿到整个 connection 日志
    // - `connId` 保留为字段别名(behavioral compat:既有 alert / metric 查询基于此名)
    // - **不绑 agentId**:v3 commercial bridge 是 connection-scoped(一用户一容器,not per-agent),
    //   `resolveContainerEndpoint` 也不返 agentId;agentId 是 per-frame 字段,turn 入口
    //   再 child 进去。Plan §3.5 row A.1 列了 agentId 是文档对 connection 概念的笔误
    //   (Codex 同意,见 plan v3 review)。
    //
    // 此 logger 不能用在 broadcastToUser(跨多 ws,不属于单一 connection),也不用在
    // handshake 阶段(那里 connId 已经存在,但 uid 还没解出来)。
    const bridgeLog = log?.child({
      uid: uid.toString(),
      connId,
      connectionTraceId: connId,
    }) ?? null;
    const startedAt = Date.now();
    // PR1:debounced last_ws_activity 刷新窗口。
    // 初始化为 0 → 第一帧 client→container 一定刷一次。
    // ensureRunning 虽然也刷,但是 fire-and-forget(可能静默失败);bridge 自己再
    // 刷一次更稳妥,代价只是握手后多一次 UPDATE,可接受。
    let lastActivityRefreshAt = 0;
    const markActivity = deps.markContainerActivity;
    let bytesUC = 0;
    let bytesCU = 0;
    let bufferedUC = 0; // user → container 待发字节
    let bufferedCU = 0; // container → user 待发字节
    let cause: BridgeCloseCause = "internal_error";
    let cleaned = false;
    // Bridge TTFT:首个 user→container 帧 ↔ 首个 container→user 帧。
    // - firstUserFrameAtMs 由 onUserMessage / earlyMessages replay 第一次进入时设置
    // - firstContainerFrameAtMs 仅作 dedupe(确保只 observe 一次)
    // - 守卫 firstUserFrameAtMs !== null 是防御"容器在用户发帧前主动 push"导致负值
    let firstUserFrameAtMs: number | null = null;
    let firstContainerFrameAtMs: number | null = null;
    const ttftKind: "cold" | "warm" = endpoint.coldStart === true ? "cold" : "warm";
    // plan v3 review v1 §F4 follow-up:per-bridge 最后一次"用户主动声明"的 modelId。
    // 用于在没带 model 字段的后续帧上仍然能用对应 model 校验 grants(防在飞会话
    // 被撤销后还能继续发字)。null = 本桥还没收过任何带 model 的帧。
    let lastSeenModelId: string | null = null;
    // 周期 refresh modelChecker 的定时器;cleanup() 务必清掉。
    let modelCheckerRefreshTimer: ReturnType<typeof setInterval> | null = null;

    // plan v3 G5/G7 — codex per-account 并发槽:per-bridge 状态。
    //   acquiredCodexAccountId !== null → 已持槽,新 codex inbound 应被严格单飞拒绝
    //   codexAcquireInflight = true → acquire promise 在飞,新 codex inbound 拒
    //   legacy 容器(codex_account_id IS NULL,决策 N3):acquire() 返回 null,IIFE 内
    //     不占槽但 PR2 v1.0.66 起每轮仍跑 billing → 不再用 sticky 状态跳过 IIFE。
    //   codexReleaseTimer → CODEX_SESSION_MAX_MS 兜底释放(决策 G6),防 outbound 丢/
    //     ws 异常断后槽永久泄漏
    let acquiredCodexAccountId: bigint | null = null;
    let codexAcquireInflight = false;
    let codexApiRelayTurnInFlight = false;
    let codexApiRelayRouteToken: string | null = null;
    let codexReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    // plan v3 G6 — outbound 终态早释放(Codex review v2 BLOCKER 1):
    //   只靠 600s timer + cleanup 释放,正常完成的 turn 会持槽 ≤ 10min,
    //   单账号 maxConcurrent=10 → 10 个正常 turn 后误判 busy。
    //   方案:acquire 时记 inbound.peer.id;outbound.message + isFinal:true 或
    //   outbound.error 且 peer.id 命中 → 立即 release,timer 退化为兜底。
    //   匹配 peer.id 的原因:同桥可 claude+codex 交错,只看"任意 isFinal"会误释。
    let codexInboundPeerId: string | null = null;
    const expireCodexRouteToken = (token: string | null, reason: string): void => {
      if (token === null) return;
      if (codexApiRelayRouteToken === token) codexApiRelayRouteToken = null;
      const expire = deps.expireCodexRoute;
      if (expire === undefined) return;
      void expire(token).catch((err) => {
        bridgeLog?.warn("user-chat-bridge: expire codex route failed", {
          reason,
          err: (err as Error)?.message ?? String(err),
        });
      });
    };
    const expireActiveCodexRoute = (reason: string): void => {
      expireCodexRouteToken(codexApiRelayRouteToken, reason);
    };

    // Phase 4 — GitHub session-repo auto-rebind:bridge 实例级 cache。
    //   containerWs.on('open') 时 fetch active selections 进 map(无 token);
    //   inbound.hello 到达时记录 peerIds,然后调 flush:对 peers 取交集,async
    //   富化 token + 推 bind 帧。
    //   key = sessionId;value = DB row。bridge close 时随 closure GC,无需手动清。
    //
    //   Codex Phase 4.7 #2 修:flush 必须从两边触发(hello 到达 + open-fetch 完成),
    //   否则 hello 先于 fetch 完成时 map 是空,fetch 之后没人触发,active 选择
    //   永远不会 rebind。pendingRebindMap 存"需 rebind 的 row",
    //   lastHelloPeerIds 存"最近 hello 见到的 peers",flush 时取交集。
    const pendingRebindMap = new Map<string, GithubSelectionRow>();
    let lastHelloPeerIds: Set<string> | null = null;
    let autoRebindFetchDone = false;
    let autoRebindFlushInFlight = false;
    /**
     * 双触发 flush:hello 到达 + fetch 完成 都调一次,真正的工作只在两边都就绪时
     * 发生。重入保护(autoRebindFlushInFlight)防止两端同一 tick 都触发时 doublework。
     */
    const tryAutoRebindFlush = (): void => {
      if (!deps.pgPool) return;
      if (lastHelloPeerIds === null || lastHelloPeerIds.size === 0) return;
      if (!autoRebindFetchDone) return;
      if (pendingRebindMap.size === 0) return;
      if (autoRebindFlushInFlight) return;
      autoRebindFlushInFlight = true;
      const pgPoolBound = deps.pgPool;
      const peers = Array.from(lastHelloPeerIds);
      ;(async () => {
        // v1.0.119 — 微任务死循环根因修复。
        //   旧实现:finally 里只判 size > 0 就同步递归调 tryAutoRebindFlush。
        //   触发条件:hello peers 与 pendingRebindMap.sessionIds 不交集时
        //   buildAutoRebindFrames 返回 matchedSessionIds=[],没消化任何 row,
        //   pendingRebindMap.size 不变,finally 立即再次自调 → V8 microtask
        //   永远 spin(strace 100% getpid),event loop 拿不回控制权 → healthz
        //   timeout → wedge。生产 2026-05-09 多次复发由此 bug 触发。
        //   修复:仅在本轮"取得进展"(至少消化一行 pending row)时才再触发。
        //   未取得进展 = 当前 hello peers 与 map 不重叠,继续 flush 也是 no-op,
        //   等下一次外部信号(新 hello / 新 fetch)即可。
        let progressMade = false;
        try {
          const built = await buildAutoRebindFrames(
            pgPoolBound,
            Number(uid),
            peers,
            pendingRebindMap,
          );
          if (built.matchedSessionIds.length > 0) progressMade = true;
          for (const sid of built.matchedSessionIds) pendingRebindMap.delete(sid);
          for (const f of built.frames) {
            const buf = Buffer.from(JSON.stringify(f), "utf8");
            forwardInboundFrame(buf, false, buf.length);
            // v1.0.94 — 诊断 instrument。auto-rebind 路径在容器重连后自动重发 bind,
            // 与显式 bind 路径用同一日志体便于 grep。
            bridgeLog?.info("user-chat-bridge: repo_bind_auto_rebind_forwarded", {
              sessionId: f.sessionId,
              selectionVersion: f.selectionVersion,
              agentId: f.agentId,
            });
          }
          if (built.errors.length > 0 && userWs.readyState === WebSocket.OPEN) {
            for (const e of built.errors) {
              try { userWs.send(JSON.stringify(e)); } catch { /* */ }
            }
          }
        } catch (err) {
          bridgeLog?.warn("user-chat-bridge: auto-rebind flush failed", { err });
        } finally {
          autoRebindFlushInFlight = false;
          // 仅在本轮真消化了 row(progressMade)时才再触发,否则当前 hello peers
          // 与 pendingRebindMap 不交集,继续 flush 是 no-op 死循环。
          if (
            progressMade &&
            lastHelloPeerIds !== null &&
            lastHelloPeerIds.size > 0 &&
            pendingRebindMap.size > 0
          ) {
            tryAutoRebindFlush();
          }
        }
      })();
    };

    // PR2 v1.0.66 — codex 真扣费 per-bridge inflight Map + drain 状态。
    //   inflightCodexTurns: requestId → snapshot (finalizer + model)
    //     - 由 codex acquire IIFE 在成功路径 set
    //     - 由 onContainerMessage 的 outbound.codex_billing 分支 finally delete
    //     - 由 finalCleanup 兜底 fail-clear(drain 超时 / 容器异常 / shutdown 路径残留)
    //   drainTimer: user_close + Map 非空时启动的 5s 收尾窗口 timer
    //     - settle 把 Map 减到 0 → checkDrainComplete 提前 finalCleanup
    //     - 5s 超时仍未 settle → finalCleanup 走 fail 兜底(reconciler 后续清理)
    //     - 容器异常 / shutdown / force 抢占 drain → 立即 finalCleanup(见 cleanup 状态机)
    //   drainCause: 进入 drain 时的 trigger cause(稳定保留,避免 mutable cause 干扰)
    //   userDetached: 守 detachUserSide 幂等(drain 入口 + finalCleanup 都跑)
    const inflightCodexTurns = new Map<string, CodexTurnSnapshot>();
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let drainCause: BridgeCloseCause | null = null;
    let userDetached = false;

    // 注册到 registry,超额会踢老的
    const conn: Conn = {
      id: connId,
      user_id: uid.toString(),
      opened_at: startedAt,
      close: (reason) => {
        sendErrorFrame(userWs, "ERR_CONN_KICKED", reason);
        try { userWs.close(CLOSE_BRIDGE.POLICY, "kicked"); } catch { /* */ }
      },
    };
    const { unregister } = registry.register(conn);

    // 同步加入 uid→ws 表,broadcastToUser 用得到。cleanup 里务必同步删除。
    {
      const key = uid.toString();
      let set = uidToUserWs.get(key);
      if (!set) { set = new Set(); uidToUserWs.set(key, set); }
      set.add(userWs);
    }

    // 连接超时:N ms 内 containerWs 没 OPEN → 取消 + 关 user
    const connectTimer = setTimeout(() => {
      if (containerWs.readyState !== WebSocket.OPEN) {
        bridgeLog?.warn("user-chat-bridge: container connect timeout", {
          host: endpoint.host, port: endpoint.port,
        });
        try { connectAbort.abort(); } catch { /* */ }
        try { containerWs.terminate(); } catch { /* */ }
        sendErrorFrame(userWs, "ERR_CONTAINER_TIMEOUT", "agent connect timeout");
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent timeout"); } catch { /* */ }
        // 容器都没起来 → 不可能有 inflight billing 帧来,force=true 直接 final
        cleanup("container_error", true);
      }
    }, connectTimeoutMs);

    // ---------- 双向 pipe handlers ----------

    const attachMasterHistoricalMessages = async (
      frameObj: Record<string, unknown>,
      turnLog: Logger | null,
    ): Promise<Record<string, unknown>> => {
      if (!deps.loadMasterSessionMessages) return frameObj;
      const peer = frameObj.peer;
      const peerId =
        peer && typeof peer === "object"
          ? (peer as { id?: unknown }).id
          : undefined;
      if (typeof peerId !== "string" || peerId.length === 0) return frameObj;
      try {
        const raw = await deps.loadMasterSessionMessages(uid, peerId);
        const historical = Array.isArray(raw)
          ? _sanitizeMasterHistoricalMessagesForFrame(raw)
          : [];
        if (historical.length === 0) return frameObj;
        turnLog?.info("user-chat-bridge: attached master history", {
          sessionId: peerId,
          messageCount: historical.length,
        });
        return {
          ...frameObj,
          _masterHistoricalMessages: historical,
        };
      } catch (err) {
        // Fail-open: history bridging is UX context, not authz/billing.
        turnLog?.warn("user-chat-bridge: load master history failed", {
          sessionId: peerId,
          err,
        });
        return frameObj;
      }
    };

    const onUserMessage = (data: RawData, isBinary: boolean): void => {
      const len = rawDataLen(data);
      if (len > maxFrameBytes) {
        sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG",
          `user frame ${len} > max ${maxFrameBytes}`);
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
        // 用户协议错 → force final,不为它 drain
        cleanup("frame_too_big", true);
        return;
      }
      // 0049 模型授权(plan v3 §B3/§B4 + review v1/v2 follow-up):
      //   inbound.message 帧 sync 检查 visibility OR per-user grants。优先级:
      //     (1) frame.model — 用户/前端显式声明 → 必须有授权
      //     (2) AGENT_AUTHZ_IMPLIED_MODEL[frame.agentId] — agentId 隐含 model
      //         (review v2 finding 1:防 agentId='codex' 不带 model 绕过)
      //     (3) lastSeenModelId — 本桥之前出现过的 model(review v1 follow-up:
      //         防"已用 gpt-5.5 跑起来的桥被撤销 grant 后,后续无 model/agentId
      //         的 delta 帧仍能透传"。一旦撤销,继续帧都被拦)
      //     (4) 三者全无 → 透传(本桥从没碰过受限 model,默认 claude-* visibility=
      //         public 不需要 grant)
      //
      //   命中 (1) / (2) 时也更新 lastSeenModelId — 任一形式提到过受限 model
      //   都进入"本桥追踪"状态。
      //
      //   modelChecker 内部由周期 refresh 在背后更新(GRANTS_REFRESH_INTERVAL_MS),
      //   admin 取消授权后下一次 frame check 会用最新快照拦帧。
      //
      //   只检查 text 帧 + JSON parsable + type==='inbound.message'。binary 帧 /
      //   非 JSON / 其他类型 → 透传(不校验)。server.ts ALLOWED_INBOUND_MODELS +
      //   inferAgentForModel fail-closed 是 server 端兜底。
      //
      //   这条 check **故意没 try/catch** 套整个 if 块:JSON.parse 异常下面已处理,
      //   isAllowed 是纯同步(canUseModel 读 PricingCache cache 命中即返),异常仅
      //   可能来自代码 bug,不该静默吞。
      // 把 effectiveModel / 是否 codex 帧 提到外层,后面 codex slot 路径要用
      let effectiveModelForFrame: string | null = null;
      let isCodexInboundFrame = false;
      // plan v3 G6 早释放(BLOCKER 1):codex inbound 帧的 peer.id,acquire 路径捕获后存
      // codexInboundPeerId,匹配 outbound 终态时用。无 peer.id 即保持 null,降级为 timer 兜底。
      let inboundPeerIdForFrame: string | null = null;
      // PR2 v1.0.66 — 把 codex 计费需要用到的 frame 字段提到外层(下面 IIFE 用):
      //   inboundParsedFrame:rewrite 帧塞 server requestId 时复用,免再次 JSON.parse
      //   inboundAgentIdForFrame:agent_cost_overrides 查 multiplier 时用,缺省回退 'codex'
      let inboundParsedFrame: Record<string, unknown> | null = null;
      let inboundAgentIdForFrame: string | null = null;
      // CG2a — 强制 canonical trace。inbound.message 命中时由 master 生成,后续 codex IIFE /
      // 非 codex forwardInboundFrame 共同读注入到 frame.traceId。其他帧(hello / repo_bind /
      // 非 JSON / binary)保持 null,走原 raw 透传(不 rewrite)。
      let turnTraceIdForFrame: string | null = null;
      // CG2b — turn-scoped logger:inbound.message 命中时基于 bridgeLog 派生(child binding 加
      // traceId)。同步与 turnTraceIdForFrame 一起 set / 一起 null,codex IIFE / 非 codex
      // forwardInboundFrame 内的 log call 都用它,不必手写 uid/connId/traceId。
      let turnLogForFrame: Logger | null = null;
      if (!isBinary) {
        let frameStr: string | null = null;
        if (typeof data === "string") frameStr = data;
        else if (Buffer.isBuffer(data)) {
          try { frameStr = data.toString("utf8"); } catch { frameStr = null; }
        }
        if (frameStr !== null) {
          let parsed: unknown = null;
          try { parsed = JSON.parse(frameStr); } catch { /* 非 JSON 帧透传 */ }

          // Phase 4 — GitHub session-repo bind 帧:bridge 富化 + forward
          //   inbound 帧只带 sessionId/version/peer/agentId/channel(token 不在前端);
          //   bridge 用 deps.pgPool 查 selection + link,组装完整 bind 帧再推容器。
          //   错误(stale / link revoked / DB 故障)→ outbound.control.session_repo_bind_error
          //   发回 userWs,**不**转发给容器(防止容器陷在 pending)。
          //   pgPool 未注入(测试)→ skip 富化,**不**透传(防泄漏 raw bind 请求帧到
          //   容器,容器没 token 也处理不了)。
          if (parsed !== null && typeof parsed === "object") {
            const ftype = (parsed as { type?: unknown }).type;
            if (ftype === "inbound.control.session_repo_bind") {
              const bindReq = parseBindRequest(parsed);
              if (bindReq === null) {
                if (userWs.readyState === WebSocket.OPEN) {
                  try {
                    userWs.send(JSON.stringify({
                      type: "outbound.control.session_repo_bind_error",
                      sessionId: typeof (parsed as { sessionId?: unknown }).sessionId === "string"
                        ? (parsed as { sessionId: string }).sessionId
                        : "",
                      selectionVersion: 0,
                      errorCode: "INVALID_BIND_PAYLOAD",
                      errorMessage: "bind frame schema invalid",
                    }));
                  } catch { /* */ }
                }
                return;
              }
              const pgPool = deps.pgPool;
              if (!pgPool) {
                // 生产环境 pgPool 必注入;走到这只能是测试 mock,丢弃且不透传。
                return;
              }
              // async 富化;不阻塞主循环。富化期间 main message 帧可能继续走,
              // bind 因 DB query 抢晚到容器是可接受的(plan v3 修 #4 — 容器侧 bind/
              // message 乱序处理)。
              ;(async () => {
                try {
                  const result = await enrichBindRequest(pgPool, Number(uid), bindReq);
                  if (result.type === "outbound.control.session_repo_bind_error") {
                    if (userWs.readyState === WebSocket.OPEN) {
                      try { userWs.send(JSON.stringify(result)); } catch { /* */ }
                    }
                    return;
                  }
                  // 富化成功 → forward enriched 到容器
                  const enrichedJson = JSON.stringify(result);
                  const buf = Buffer.from(enrichedJson, "utf8");
                  forwardInboundFrame(buf, false, buf.length);
                  // v1.0.94 — 诊断 instrument。bind 帧是关键侧信道,4 个 hop
                  // (前端 → master bridge → 容器 → workspace)只有任一段沉默都会让
                  // 用户卡在「准备中…」。这里记录 bridge → 容器这一段是否真的发出。
                  bridgeLog?.info("user-chat-bridge: repo_bind_forwarded", {
                    sessionId: result.sessionId,
                    selectionVersion: result.selectionVersion,
                    agentId: result.agentId,
                  });
                } catch (err) {
                  bridgeLog?.warn("user-chat-bridge: enrich bind failed", { err });
                  if (userWs.readyState === WebSocket.OPEN) {
                    try {
                      userWs.send(JSON.stringify({
                        type: "outbound.control.session_repo_bind_error",
                        sessionId: bindReq.sessionId,
                        selectionVersion: bindReq.selectionVersion,
                        errorCode: "BRIDGE_ENRICH_FAILED",
                        errorMessage: "internal error during bind enrichment",
                      }));
                    } catch { /* */ }
                  }
                }
              })();
              return; // 同步路径不再 forward 原始帧;async 完成后才推富化版
            }
            if (ftype === "inbound.control.session_repo_unbind") {
              const unbindReq = parseUnbindRequest(parsed);
              if (unbindReq === null) {
                // schema 错 → 静默丢(没必要给前端报错,unbind 是用户操作不应失败)
                return;
              }
              // unbind 不需要富化,直接透传(走 forwardInboundFrame 后续逻辑)
              // fall through to forwardInboundFrame below
            }
          }

          // Phase 0.4 — inbound.hello → bridge ring replay.
          //
          // Each peer in the hello carries `lastFrameSeq` (last outbound seq
          // the tab successfully processed). We peekReplay against the
          // bridge-layer ring; if it satisfies, push the missed frames over
          // userWs. If it can't, emit `outbound.resume_failed` so the client
          // escalates to REST sync (matches personal-master server.ts
          // autoResumeFromHello envelope verbatim — same shape as what the
          // container would have emitted).
          //
          // We do NOT return here: hello must still reach the container so
          // its embedded gateway registers `bridge.containerWs` into
          // `clientsByPeer` for live delivery. Container's own peekReplay
          // may also fire — duplicate frames are deduped client-side via
          // the frameSeq cursor in websocket.js handleOutbound.
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            (parsed as { type?: unknown }).type === "inbound.hello" &&
            containerId !== undefined
          ) {
            const helloPeers = (parsed as { peers?: unknown }).peers;
            const peers = Array.isArray(helloPeers) ? helloPeers : [];
            const cidStr = containerId.toString();
            const uidStr = uid.toString();
            for (const p of peers) {
              if (typeof p !== "object" || p === null) continue;
              const peer = p as {
                peerId?: unknown;
                agentId?: unknown;
                lastFrameSeq?: unknown;
              };
              if (typeof peer.peerId !== "string") continue;
              const aid =
                typeof peer.agentId === "string" && peer.agentId !== ""
                  ? peer.agentId
                  : "main";
              // Match openclaude/packages/gateway server.ts L3459-3460
              // sanitisation verbatim — same regex, same default kind=dm.
              const safeId = peer.peerId.replace(/[^a-zA-Z0-9_-]/g, "_");
              const sessionKey = `agent:${aid}:webchat:dm:${safeId}`;
              const storeKey = `${uidStr}:${cidStr}:${sessionKey}`;
              const cursor =
                typeof peer.lastFrameSeq === "number" ? peer.lastFrameSeq : 0;
              const replay = outboundRing.peekReplay(storeKey, cursor);
              if (replay.ok) {
                for (const f of replay.sent) {
                  try { userWs.send(f.data); } catch { break; }
                }
              } else {
                try {
                  userWs.send(JSON.stringify({
                    type: "outbound.resume_failed",
                    sessionKey,
                    channel: "webchat",
                    peer: { id: peer.peerId, kind: "dm" },
                    from: cursor,
                    to: replay.to,
                    reason: replay.reason,
                    ts: Date.now(),
                  }));
                } catch { /* swallow — userWs may be closing */ }
              }
            }
            // Phase 4 — auto-rebind:记录 hello peers,触发 flush(可能等 fetch 完成)。
            //   双触发设计:hello 端记 peer 集合 → tryAutoRebindFlush;
            //   open 端 fetch 完成 → tryAutoRebindFlush。两边都就绪才真 flush。
            //   Codex Phase 4.7 #2 修:旧实现只在 hello 时同步看 map,fetch 慢于 hello
            //   时 active 选择永不 rebind。
            const helloPeerIds = new Set<string>();
            for (const p of peers) {
              if (typeof p === "object" && p !== null) {
                const pid = (p as { peerId?: unknown }).peerId;
                if (typeof pid === "string") helloPeerIds.add(pid);
              }
            }
            // 多次 hello(reconnect 重发)合并 peer 集合,不丢之前 hello 见过的 peer
            if (lastHelloPeerIds === null) lastHelloPeerIds = helloPeerIds;
            else for (const id of helloPeerIds) lastHelloPeerIds.add(id);
            tryAutoRebindFlush();
            // Fall through to forwardInboundFrame below.
          }
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            (parsed as { type?: unknown }).type === "inbound.message"
          ) {
            const frameModelRaw = (parsed as { model?: unknown }).model;
            const frameModelId = typeof frameModelRaw === "string" ? frameModelRaw : null;
            const frameAgentIdRaw = (parsed as { agentId?: unknown }).agentId;
            const frameAgentId = typeof frameAgentIdRaw === "string" ? frameAgentIdRaw : null;
            const agentImpliedModel =
              frameAgentId !== null ? AGENT_AUTHZ_IMPLIED_MODEL[frameAgentId] : undefined;

            // 选用顺序:frame.model > agent 隐含 model > lastSeenModelId
            let effectiveModel: string | null = null;
            let source: "frame.model" | "agentId.implied" | "lastSeen" | null = null;
            if (frameModelId !== null) {
              effectiveModel = frameModelId;
              source = "frame.model";
            } else if (agentImpliedModel !== undefined) {
              effectiveModel = agentImpliedModel;
              source = "agentId.implied";
            } else if (lastSeenModelId !== null) {
              effectiveModel = lastSeenModelId;
              source = "lastSeen";
            }
            // 命中 frame.model / agentId.implied 时把效果 model 记进 lastSeenModelId,
            // 后续无 model/agentId 帧仍可继续校验。lastSeen 命中时不更新(就是它自己)。
            if (source === "frame.model" || source === "agentId.implied") {
              lastSeenModelId = effectiveModel;
            }
            if (
              modelCheckerHandle !== null &&
              effectiveModel !== null &&
              !modelCheckerHandle.isAllowed(effectiveModel)
            ) {
              bridgeLog?.info("user-chat-bridge: model not authorized", {
                modelId: effectiveModel,
                source,
              });
              sendErrorFrame(
                userWs,
                "UNAUTHORIZED_MODEL",
                `model not authorized for current user: ${effectiveModel}`,
              );
              try { userWs.close(CLOSE_BRIDGE.POLICY, "unauthorized_model"); } catch { /* */ }
              // 策略拒绝 → force final;此前无 codex inflight(本帧才进 acquire 路径),无 drain 价值
              cleanup("client_close", true);
              return;
            }
            effectiveModelForFrame = effectiveModel;
            // codex 判定:只看 effectiveModel 前缀(`gpt-*`) 即可。agentId='codex' 已通过
            // AGENT_AUTHZ_IMPLIED_MODEL 把 effectiveModel 设为 'gpt-5.5',下面的判定一样命中。
            isCodexInboundFrame = effectiveModel !== null && effectiveModel.startsWith("gpt-");
            // 提取 peer.id(用于 outbound 终态早释放匹配)。codex 帧才需要;非 codex
            // 帧不影响 acquiredCodexAccountId,捕不捕没用。
            if (isCodexInboundFrame) {
              const peerObj = (parsed as { peer?: { id?: unknown } }).peer;
              const peerIdRaw = peerObj && typeof peerObj === "object" ? peerObj.id : undefined;
              inboundPeerIdForFrame = typeof peerIdRaw === "string" ? peerIdRaw : null;
              // PR2 v1.0.66 — 把 agentId 提到外层供 codex billing IIFE 用
              // (查 agent_cost_overrides multiplier)。
              inboundAgentIdForFrame = frameAgentId;
            }
            // CG2a — canonical trace 生成 + client observation。
            // 任何 inbound.message(codex / 非 codex)都强制注入 master canonical;
            // client 提供的 clientTraceId 仅 observation:
            //   - 合法 → 进 log
            //   - 非法且 raw !== undefined → 只记 issue 不带 raw(MAJOR 2 防 log injection)
            //     且从 forward 给容器的 frame 中 **strip 掉**(防 raw 进入下游 logger)
            turnTraceIdForFrame = newTraceId();
            const rawClientTrace = (parsed as { clientTraceId?: unknown }).clientTraceId;
            const clientHint = parseTraceIdCandidate(rawClientTrace);
            const clientTraceFields: {
              clientTraceId?: string;
              clientTraceIdIssue?: TraceIdIssue;
            } = {};
            if (clientHint.ok) {
              clientTraceFields.clientTraceId = clientHint.traceId;
            } else if (rawClientTrace !== undefined) {
              clientTraceFields.clientTraceIdIssue = clientHint.issue;
            }
            // sanitize:
            //   - 非法 clientTraceId 不透传给 container — 合法 / undefined 保留原 parsed
            //   - __oc_codex_route 永远是 master-owned 私有字段;client 输入即使形状合法也必须剥离,
            //     后面只有 server 侧 createCodexRoute 成功时才会重新注入。
            let sanitizedParsed = parsed as Record<string, unknown>;
            const hasClientCodexRoute = Object.prototype.hasOwnProperty.call(
              sanitizedParsed,
              "__oc_codex_route",
            );
            if ((rawClientTrace !== undefined && !clientHint.ok) || hasClientCodexRoute) {
              sanitizedParsed = { ...sanitizedParsed };
              if (rawClientTrace !== undefined && !clientHint.ok) {
                delete sanitizedParsed.clientTraceId;
              }
              if (hasClientCodexRoute) {
                delete sanitizedParsed.__oc_codex_route;
              }
            }
            inboundParsedFrame = sanitizedParsed;
            // CG2b — turnLog 派生:traceId 钉进 bindings,后续 turn 内 log 自动带上
            turnLogForFrame = bridgeLog?.child({ traceId: turnTraceIdForFrame }) ?? null;
            turnLogForFrame?.info("user-chat-bridge: inbound turn start", clientTraceFields);
          }
        }
      }

      // plan v3 G5/G7 — codex per-account 槽 acquire / 严格单飞:
      //   - bridge 看到 codex inbound + 有 codexBinding 注入 + 有 containerId
      //   - 容器 codex_account_id 是 NULL(legacy)→ acquire() 返回 null,IIFE 内
      //     不占槽,但 PR2 v1.0.66 起 **billing 路径仍要跑**(每轮 turn 都要扣费 +
      //     落 journal),所以这里**不**用 codexLegacyContainer 当 outer guard 跳过 IIFE。
      //     legacy 每轮多一次廉价 SELECT(codexBinding.acquire 内部 row 查),换不漏扣。
      //   - 已持槽 / acquire 在飞 → reject "previous codex turn still in progress"(G7)
      //   - 否则:async acquire → 成功 forward;Busy / 其他 fail → fast-fail error 帧
      //
      // 非 codex 帧 / 没注入 codexBinding / 没 containerId → 直接走下方原同步 forward
      if (
        isCodexInboundFrame &&
        containerId !== undefined &&
        (deps.codexBinding !== undefined || deps.createCodexRoute !== undefined)
      ) {
        if (acquiredCodexAccountId !== null || codexApiRelayTurnInFlight || codexAcquireInflight) {
          // G7 严格单飞:不 close bridge,让前端等当前 turn 完成后重发
          turnLogForFrame?.info("user-chat-bridge: codex turn busy, rejecting frame");
          sendErrorFrame(
            userWs,
            "CODEX_TURN_BUSY",
            "previous codex turn still in progress, wait for completion",
          );
          return;
        }
        codexAcquireInflight = true;
        const codexBinding = deps.codexBinding;
        const createCodexRoute = deps.createCodexRoute;
        const cid = containerId;
        const sessionMaxMs = readCodexSessionMaxMs();
        // 进 acquire 路径才记 peer.id;G7 拒绝路径(busy)不该覆盖在飞 turn 的 peer.id。
        const peerIdForAcquire = inboundPeerIdForFrame;
        // PR2 v1.0.66 — billing 路径的回滚 helper:任意 await 阶段失败 / cleaned
        // 检测命中时调,把已 set 的 acquiredCodexAccountId / timer / peerId 清理。
        // legacy 路径 acquiredCodexAccountId 始终 null,是 no-op,安全。
        const releaseAcquiredSlotForFailure = (): void => {
          if (codexReleaseTimer !== null) {
            clearTimeout(codexReleaseTimer);
            codexReleaseTimer = null;
          }
          if (acquiredCodexAccountId !== null && codexBinding !== undefined) {
            try { codexBinding.release(acquiredCodexAccountId); } catch { /* */ }
            acquiredCodexAccountId = null;
          }
          expireActiveCodexRoute("failure");
          codexApiRelayTurnInFlight = false;
          codexInboundPeerId = null;
        };
        // PR2 v1.0.66 — 把外层 onUserMessage 抓的 effectiveModel / parsed / agentId
        // 快照进 IIFE 局部,IIFE 跑期间 onUserMessage 不会再修改这几个 let(下一帧
        // 走 G7 busy 拒绝路径,不会到这里),但稳妥起见还是 capture。
        const effectiveModelCapture = effectiveModelForFrame;
        const inboundAgentIdCapture = inboundAgentIdForFrame;
        const inboundParsedCapture = inboundParsedFrame;
        // CG2a — capture canonical traceId 给 IIFE 局部用。inbound.message ⇒ isCodexInboundFrame=true
        // 路径强保证 turnTraceIdForFrame 非 null(invariant 由 IIFE 起手处显式校验)。
        const turnTraceIdCapture = turnTraceIdForFrame;
        // CG2b — capture turn-scoped logger;同步 set 一并 capture。
        const turnLogCapture = turnLogForFrame;
        void (async () => {
          try {
            // CG2a invariant — codex inbound 必经 inbound.message 分支 ⇒ trace + parsed 必非 null。
            // 这里前置校验(acquire 之前),invariant 破坏 → close 1011,无需 release。
            // 若放 acquire 之后再校验,要多一份 releaseAcquiredSlotForFailure() 清理负担。
            if (turnTraceIdCapture === null || inboundParsedCapture === null) {
              // invariant 命中时 turnLogCapture 也必为 null(同步生成),用 bridgeLog 兜底
              bridgeLog?.error("user-chat-bridge: codex frame missing trace invariant");
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(userWs, "ERR_INTERNAL", "trace invariant violated");
                try { userWs.close(CLOSE_BRIDGE.INTERNAL, "trace invariant"); } catch { /* */ }
              }
              return;
            }
            let codexRoute: CodexApiRelayRoute | null = null;
            if (createCodexRoute !== undefined) {
              if (effectiveModelCapture === null) {
                throw new Error("codex route requested without effective model");
              }
              codexRoute = await createCodexRoute({
                containerId: cid,
                userId: uid,
                modelId: effectiveModelCapture,
              });
              if (codexRoute !== null) codexApiRelayRouteToken = codexRoute.token;
            }

            let acquired: { account_id: bigint } | null = null;
            if (codexRoute === null) {
              if (codexBinding === undefined) {
                throw Object.assign(new Error("no enabled Codex API relay group"), { name: "CodexRouteUnavailable" });
              }
              acquired = await codexBinding.acquire(cid);
            }
            if (cleaned) {
              // bridge 在 acquire/route 创建期间被关 — 立即 release 不留泄漏
              if (codexRoute !== null) {
                expireCodexRouteToken(codexRoute.token, "cleanup_during_route_creation");
              }
              if (acquired !== null && codexBinding !== undefined) {
                try { codexBinding.release(acquired.account_id); } catch { /* */ }
              }
              return;
            }
            if (codexRoute !== null) {
              codexApiRelayTurnInFlight = true;
              codexInboundPeerId = peerIdForAcquire;
              codexReleaseTimer = setTimeout(() => {
                expireActiveCodexRoute("timeout");
                codexApiRelayTurnInFlight = false;
                codexInboundPeerId = null;
                codexReleaseTimer = null;
              }, sessionMaxMs);
              codexReleaseTimer.unref?.();
            } else if (acquired === null) {
              // legacy NULL 容器(决策 N3):不占 per-account 槽,billing 路径下面
              // 仍跑(accountIdForLedger=0n 占位)。每轮 turn 都会再走一次 IIFE
              // (acquire() 内部 row 查很轻),持续保持每轮扣费。
            } else {
              acquiredCodexAccountId = acquired.account_id;
              codexInboundPeerId = peerIdForAcquire;
              codexReleaseTimer = setTimeout(() => {
                // 兜底释放:防 outbound 完成信号丢 / ws 异常断 → 槽永久泄漏
                if (acquiredCodexAccountId !== null && codexBinding !== undefined) {
                  try { codexBinding.release(acquiredCodexAccountId); } catch { /* */ }
                  acquiredCodexAccountId = null;
                }
                codexApiRelayTurnInFlight = false;
                codexInboundPeerId = null;
                codexReleaseTimer = null;
              }, sessionMaxMs);
              codexReleaseTimer.unref?.();
            }

            // PR2 v1.0.66 — codex 真扣费 path:preCheck → journal → finalizer →
            //   inflightCodexTurns Map 注册 → frame rewrite 注入 server-owned requestId
            //   → forward。失败任一步:释放已 acquire 的资源 + close ws 关连接。
            //
            //   codexBillingEnabled=false(测试 / 个人版上下文,三件套未注入)→ 走
            //   下方 else 分支:仍 rewrite 注入 traceId(CG2a 合同硬门),只是不动 requestId。
            let frameForwardData: RawData;
            const frameForwardIsBinary = false;
            let frameForwardLen: number;
            if (codexBillingEnabled) {
              // 三件套全注入(createUserChatBridge entry 已强校验)→ non-null assert 安全
              const pgPool = deps.pgPool!;
              const preCheckRedis = deps.preCheckRedis!;
              const pricingCache = deps.pricing!;

              if (effectiveModelCapture === null) {
                // 不该发生(isCodexInboundFrame=true 蕴含 effectiveModel 非空)
                turnLogCapture?.error("user-chat-bridge: codex billing without effective model");
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendErrorFrame(userWs, "CODEX_BILLING", "codex billing internal");
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "codex billing"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              const effectiveModel = effectiveModelCapture;

              const modelPricing = pricingCache.get(effectiveModel);
              if (!modelPricing) {
                // pricing 缓存 miss(authz 通过但 cache 未含此 model — race 窗口
                // / DB 配置漂移)。fail-closed:不放行 codex turn,免漏扣。
                turnLogCapture?.error("user-chat-bridge: codex pricing missing", {
                  model: effectiveModel,
                });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendErrorFrame(userWs, "CODEX_BILLING", `pricing missing for ${effectiveModel}`);
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "pricing missing"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }

              // agent_cost_overrides:frameAgentId 缺省 fallback 'codex'(codex
              // implied via gpt-* 前缀,canonical agentId 即 'codex')。
              const agentForCharge = inboundAgentIdCapture ?? "codex";
              let agentMul: string;
              try {
                agentMul = await getAgentCostMultiplier(pgPool, agentForCharge);
              } catch (err) {
                turnLogCapture?.error("user-chat-bridge: getAgentCostMultiplier failed", {
                  agentId: agentForCharge, err,
                });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendErrorFrame(userWs, "CODEX_BILLING", "billing config unavailable");
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "billing config"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              if (cleaned) {
                releaseAcquiredSlotForFailure();
                return;
              }

              const composedMultiplier = composeMultiplier(modelPricing.multiplier, agentMul);
              const derivedPricing: ModelPricing = {
                ...modelPricing,
                multiplier: composedMultiplier,
              };

              const requestId = ensureRequestIdServerSide();
              let maxCost: bigint;
              try {
                maxCost = estimateMaxCost(CODEX_PRECHECK_TOKEN_ESTIMATE, derivedPricing);
              } catch (err) {
                turnLogCapture?.error("user-chat-bridge: estimateMaxCost failed", { err });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendErrorFrame(userWs, "CODEX_BILLING", "billing internal");
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "billing internal"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }

              let preCheckResult;
              try {
                preCheckResult = await preCheckWithCost(preCheckRedis, {
                  userId: uid,
                  requestId,
                  maxCost,
                });
              } catch (err) {
                if (err instanceof InsufficientCreditsError) {
                  turnLogCapture?.info("user-chat-bridge: codex preCheck insufficient credits", {
                    balance: err.balance.toString(),
                    required: err.required.toString(),
                  });
                  if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                    sendErrorFrame(
                      userWs,
                      "ERR_INSUFFICIENT_CREDITS",
                      `insufficient credits: balance=${err.balance} required=${err.required}`,
                    );
                    try { userWs.close(CLOSE_BRIDGE.POLICY, "insufficient_credits"); } catch { /* */ }
                  }
                } else {
                  turnLogCapture?.error("user-chat-bridge: preCheckWithCost failed", { err });
                  if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                    sendErrorFrame(userWs, "CODEX_BILLING", "preCheck unavailable");
                    try { userWs.close(CLOSE_BRIDGE.INTERNAL, "preCheck unavailable"); } catch { /* */ }
                  }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              if (cleaned) {
                // 已 preCheck;主动 release 不让 lock 在 Redis 卡 5 分钟
                await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
                releaseAcquiredSlotForFailure();
                return;
              }

              // accountId 落 usage_records — legacy(acquired===null)用 0n 占位
              // (DB account_id 列允许 NOT NULL 0,语义"无 per-account 关联",
              //  reconciler / 排账可按 0 过滤 legacy 路径)。
              const accountIdForLedger = acquired !== null ? acquired.account_id : 0n;

              try {
                await startInflightJournal(pgPool, {
                  requestId,
                  userId: uid,
                  containerId: BigInt(cid),
                  model: effectiveModel,
                  precheckCredits: preCheckResult.maxCost,
                  ctxJson: {
                    agentId: agentForCharge,
                    codexAccountId:
                      accountIdForLedger === 0n
                        ? null
                        : accountIdForLedger.toString(),
                    source: "codex_bridge",
                  },
                });
              } catch (err) {
                turnLogCapture?.error("user-chat-bridge: startInflightJournal failed", {
                  requestId, err,
                });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendErrorFrame(userWs, "CODEX_BILLING", "journal unavailable");
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "journal unavailable"); } catch { /* */ }
                }
                await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
                releaseAcquiredSlotForFailure();
                return;
              }
              if (cleaned) {
                // journal 已落 inflight — 主动 abort + release reservation,免 reconciler 等 timeout
                await abortInflightJournal(
                  pgPool,
                  requestId,
                  "bridge_disconnect_before_finalize",
                ).catch(() => {});
                await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
                releaseAcquiredSlotForFailure();
                return;
              }

              const finalizer = makeCodexFinalizer({
                pgPool,
                preCheckRedis,
                userId: uid,
                requestId,
                containerId: cid.toString(),
                model: effectiveModel,
                derivedPricing,
                reservation: preCheckResult.reservation,
                accountId: accountIdForLedger,
              });
              inflightCodexTurns.set(requestId, {
                finalizer,
                requestId,
                model: effectiveModel,
                // Issue A v1.0.108 — codex_billing 分支落 quota 用,与 finalizer
                // closure 里的 accountIdForLedger 同源。
                accountId: accountIdForLedger,
                // CG2c — IIFE 起手 invariant 已校验 turnTraceIdCapture !== null,
                // 这里读出来 TS 推断为 string。本 turn 整个生命周期内固定不可变。
                traceId: turnTraceIdCapture,
                codexRouteToken: codexRoute?.token ?? null,
              });

              // Frame rewrite:server-owned requestId 覆盖 client 任意值。容器侧
              // 把这个 requestId 透传到 outbound.codex_billing,master 用它从
              // inflightCodexTurns Map 找回 finalizer 落账。
              // CG2a — 同时注入 master canonical traceId(IIFE 起手 invariant 保证非 null)
              const enrichedParsed = await attachMasterHistoricalMessages(
                inboundParsedCapture,
                turnLogCapture,
              );
              if (cleaned) {
                await abortInflightJournal(
                  pgPool,
                  requestId,
                  "bridge_disconnect_before_forward",
                ).catch(() => {});
                await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
                releaseAcquiredSlotForFailure();
                return;
              }
              const rewrittenObj = {
                ...enrichedParsed,
                requestId,
                traceId: turnTraceIdCapture,
                ...(codexRoute !== null ? {
                  __oc_codex_route: {
                    baseUrl: codexRoute.baseUrl,
                    modelProvider: codexRoute.modelProvider,
                    providerName: codexRoute.providerName ?? null,
                    wireApi: codexRoute.wireApi ?? "responses",
                    preferredAuthMethod: codexRoute.preferredAuthMethod ?? "apikey",
                    disableResponseStorage: codexRoute.disableResponseStorage ?? true,
                  },
                } : {}),
              };
              const rewrittenStr = JSON.stringify(rewrittenObj);
              const rewrittenLen = Buffer.byteLength(rewrittenStr);
              if (rewrittenLen > maxFrameBytes) {
                // rewriting 只加 ~100 bytes(`,"requestId":"<32hex>","traceId":"<32hex>"`)
                // — 几乎不可能越界。命中 = 用户帧本来就贴边,fail finalizer + close ws。
                turnLogCapture?.error("user-chat-bridge: rewritten codex frame too big", {
                  rewrittenLen, max: maxFrameBytes,
                });
                inflightCodexTurns.delete(requestId);
                finalizer.fail("rewritten_frame_too_big").catch(() => {});
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendErrorFrame(
                    userWs,
                    "ERR_FRAME_TOO_BIG",
                    `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`,
                  );
                  try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              // ws lib RawData = Buffer | ArrayBuffer | Buffer[];string 不匹配。
              // 转 Buffer 走文本帧(isBinary=false)— 接收端 .toString() 行为一致。
              frameForwardData = Buffer.from(rewrittenStr, "utf8");
              frameForwardLen = rewrittenLen;
            } else {
              // CG2a — billing 未启用(legacy NULL 容器无三件套 / 测试)路径仍要 rewrite
              // 注入 traceId(合同硬门);不动 requestId(client 提供的 requestId 保留 raw)。
              const enrichedParsed = await attachMasterHistoricalMessages(
                inboundParsedCapture,
                turnLogCapture,
              );
              if (cleaned) {
                releaseAcquiredSlotForFailure();
                return;
              }
              const rewrittenObj = {
                ...enrichedParsed,
                traceId: turnTraceIdCapture,
                ...(codexRoute !== null ? {
                  __oc_codex_route: {
                    baseUrl: codexRoute.baseUrl,
                    modelProvider: codexRoute.modelProvider,
                    providerName: codexRoute.providerName ?? null,
                    wireApi: codexRoute.wireApi ?? "responses",
                    preferredAuthMethod: codexRoute.preferredAuthMethod ?? "apikey",
                    disableResponseStorage: codexRoute.disableResponseStorage ?? true,
                  },
                } : {}),
              };
              const rewrittenStr = JSON.stringify(rewrittenObj);
              const rewrittenLen = Buffer.byteLength(rewrittenStr);
              if (rewrittenLen > maxFrameBytes) {
                turnLogCapture?.error("user-chat-bridge: rewritten codex frame too big (no billing)", {
                  rewrittenLen, max: maxFrameBytes,
                });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendErrorFrame(
                    userWs,
                    "ERR_FRAME_TOO_BIG",
                    `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`,
                  );
                  try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              frameForwardData = Buffer.from(rewrittenStr, "utf8");
              frameForwardLen = rewrittenLen;
            }

            // 已 acquire(+ billing 注册若启用)完毕,继续同步 forward 路径
            // (等价于"放行 frame")。两条分支都已 rewrite 注入 traceId(CG2a 合同)。
            forwardInboundFrame(frameForwardData, frameForwardIsBinary, frameForwardLen);
          } catch (err) {
            const errName = (err as { name?: string } | null | undefined)?.name ?? "";
            if (errName === "ContainerStaleBindingError") {
              // codexBinding.acquire 探测到 NULL 绑定但池子非空 — 已在 acquire 内
              // mark vanished + await stopAndRemoveV3Container 把 docker 实体清掉。
              // 本 turn 还没 acquire 任何 slot / 没注册 inflight billing(都在 try{}
              // 块里 acquire 之后),因此**不要**调 releaseAcquiredSlotForFailure
              // (no-op 但语义混淆)。直接通知前端 + 关连接 — 用户重发会触发
              // ensureRunning 重 provision,picker 落 per-container mount,然后正常工作。
              turnLogCapture?.info("user-chat-bridge: codex container stale, recycled", {
                err: (err as Error)?.message,
              });
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(
                  userWs,
                  "CODEX_CONTAINER_RECYCLED",
                  "GPT 账号配置已变更,容器已自动重建,请刷新页面后重发",
                );
                try { userWs.close(CLOSE_BRIDGE.POLICY, "codex_container_recycled"); } catch { /* */ }
              }
            } else if (errName === "CodexRouteUnavailable") {
              turnLogCapture?.info("user-chat-bridge: codex api relay route unavailable");
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(
                  userWs,
                  "CODEX_ROUTE_UNAVAILABLE",
                  "no enabled Codex API relay group for this model",
                );
              }
            } else if (errName === "AccountPoolBusyError") {
              turnLogCapture?.info("user-chat-bridge: codex pool busy, fast-fail");
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(
                  userWs,
                  "CODEX_POOL_BUSY",
                  "codex pool busy, retry shortly",
                );
              }
            } else {
              turnLogCapture?.warn("user-chat-bridge: codex acquire failed", { err });
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(
                  userWs,
                  "CODEX_UNAVAILABLE",
                  "GPT temporarily unavailable, retry shortly",
                );
              }
            }
          } finally {
            codexAcquireInflight = false;
          }
        })();
        return; // 同步路径不再 forward,等 async 完成后由 forwardInboundFrame 走
      }
      // 让 unused-locals 检查放过(future:可能加 outbound 解析用 effectiveModelForFrame)
      void effectiveModelForFrame;
      // CG2a — 非 codex 路径(claude-* 文本 / hello / repo_bind / 普通透传):若本帧是
      // inbound.message(已 sanitize parsed + 生成 canonical),把 traceId 注入再 forward;
      // 其他帧(非 JSON / binary / 非 inbound.message)turnTraceIdForFrame === null →
      // 不 rewrite,走原 raw 透传。
      // CG2b — 注意:trace 注入是契约,不能因为 deps.logger 缺失而失效。turnLogForFrame
      // 只用作 best-effort 日志(optional chain),不参与 trace gate;真正的 gate 仍是
      // inboundParsedFrame !== null && turnTraceIdForFrame !== null 这对同步生成的双胞胎。
      if (inboundParsedFrame !== null && turnTraceIdForFrame !== null) {
        const inboundParsedCapture = inboundParsedFrame;
        const turnTraceIdCapture = turnTraceIdForFrame;
        const turnLogCapture = turnLogForFrame;
        void (async () => {
          const enrichedParsed = await attachMasterHistoricalMessages(
            inboundParsedCapture,
            turnLogCapture,
          );
          if (cleaned) return;
          const rewrittenObj = {
            ...enrichedParsed,
            traceId: turnTraceIdCapture,
          };
          const rewrittenStr = JSON.stringify(rewrittenObj);
          const rewrittenLen = Buffer.byteLength(rewrittenStr);
          if (rewrittenLen > maxFrameBytes) {
            turnLogCapture?.error("user-chat-bridge: rewritten inbound frame too big", {
              rewrittenLen, max: maxFrameBytes,
            });
            if (!cleaned && userWs.readyState === WebSocket.OPEN) {
              sendErrorFrame(
                userWs,
                "ERR_FRAME_TOO_BIG",
                `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`,
              );
              try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
            }
            return;
          }
          forwardInboundFrame(Buffer.from(rewrittenStr, "utf8"), false, rewrittenLen);
        })();
        return;
      }
      forwardInboundFrame(data, isBinary, len);
    };

    /**
     * plan v3 G5 — 把"已通过 authz / codex acquire"的 inbound 帧实际推到容器侧。
     *
     * 抽出本函数是因为同一段 forward 逻辑要在两处复用:
     *   (1) onUserMessage 同步路径(非 codex 帧 / 已知 legacy NULL 容器 / 没注 codexBinding)
     *   (2) codex acquire async IIFE 成功分支
     *
     * 责任:
     *   - 设置 firstUserFrameAtMs(TTFT 起点;oversize / authz 拒绝路径已 return)
     *   - 60s debounce 内最多刷一次 last_ws_activity(防 chatty 用户)
     *   - containerWs OPEN → sendToContainer;否则 push 到 preopenQueue(直到容器 OPEN)
     *   - preopenQueue 超 maxBufferedBytes → backpressure 关连接
     *
     * 不重复 frame size / authz / codex 单飞校验:那些必须在帧到达 onUserMessage 时
     * 立刻判定(同步上下文),已在调用本函数前完成。本函数只关心"放行后的物理转发"。
     */
    function forwardInboundFrame(data: RawData, isBinary: boolean, len: number): void {
      if (firstUserFrameAtMs === null) firstUserFrameAtMs = Date.now();
      if (markActivity && containerId !== undefined) {
        const now = Date.now();
        if (now - lastActivityRefreshAt >= ACTIVITY_REFRESH_INTERVAL_MS) {
          lastActivityRefreshAt = now;
          try { markActivity(containerId); } catch { /* swallow — bridge 不挂 */ }
        }
      }
      if (containerWs.readyState !== WebSocket.OPEN) {
        // 容器还没 OPEN(早到帧场景);ws.send 在 CONNECTING 状态下抛
        // → 暂存到 ws lib 的 send buffer 里 = 不可控。这里直接 buffer 起来,
        // OPEN 后冲刷;若超 buffer 上限 → backpressure
        if (bufferedUC + len > maxBufferedBytes) {
          sendErrorFrame(userWs, "ERR_BACKPRESSURE", "agent slow");
          try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
          // backpressure → force final;一般无 inflight,即便有也异常态不 drain
          cleanup("backpressure", true);
          return;
        }
        bufferedUC += len;
        metrics.onBufferedBytes?.(uid, "user_to_container", bufferedUC);
        preopenQueue.push({ data, isBinary, len });
        return;
      }
      sendToContainer(data, isBinary, len);
    }

    const sendToContainer = (data: RawData, isBinary: boolean, len: number): void => {
      try {
        containerWs.send(data, { binary: isBinary }, (err) => {
          if (err) {
            bridgeLog?.warn("user-chat-bridge: container send error", { err });
          }
        });
        bytesUC += len;
        metrics.onUserFrame?.(uid, len, isBinary);
      } catch (err) {
        bridgeLog?.warn("user-chat-bridge: container send threw", { err });
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent send failed"); } catch { /* */ }
        // 容器 send 抛 = 容器 socket 已不可用,billing 帧也来不了 → force final
        cleanup("container_error", true);
      }
    };

    const preopenQueue: Array<{ data: RawData; isBinary: boolean; len: number }> = [];

    const onContainerMessage = (data: RawData, isBinary: boolean): void => {
      const len = rawDataLen(data);
      if (len > maxFrameBytes) {
        bridgeLog?.warn("user-chat-bridge: container frame too big", {
          len, max: maxFrameBytes,
        });
        sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG",
          `container frame ${len} > max ${maxFrameBytes}`);
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
        // 容器协议错 → force final
        cleanup("frame_too_big", true);
        return;
      }
      // Bridge TTFT 终点:首个 container→user 帧。
      // 守卫 firstUserFrameAtMs !== null 防御容器在用户发帧前主动 push(理论不发生,
      // 但保险 — 否则会算负值/无意义观测)。oversize 拒绝路径已 return,不会走到这。
      if (firstContainerFrameAtMs === null && firstUserFrameAtMs !== null) {
        firstContainerFrameAtMs = Date.now();
        metrics.onTtft?.(uid, ttftKind, (firstContainerFrameAtMs - firstUserFrameAtMs) / 1000);
      }
      // PR2 v1.0.66 — outbound.codex_billing 是 container→master 内部侧信道,
      // **绝不**透传给用户浏览器(用户不可见 billing,且帧含 errorReason 等内部串)。
      //
      // **必须在 userWs.readyState 检查之前**:
      //   - drain 期 userWs 已关(detachUserSide → unregister),但 inflightCodexTurns
      //     仍有 turn 等 billing 帧 settle。如果先 readyState gate 就 drop,用户跑路
      //     免费送 token(B.5 plan invariant)
      //   - 与 G6 早释放同一帧(outbound.message isFinal)无冲突 — 那个走 message
      //     type,billing 走 codex_billing type,互斥
      // cheap pre-filter:只对文本帧做 string includes,不解 JSON 影响热路径。
      if (!isBinary) {
        let billingPeek: string | null = null;
        if (typeof data === "string") billingPeek = data;
        else if (Buffer.isBuffer(data)) {
          try { billingPeek = data.toString("utf8"); } catch { billingPeek = null; }
        }
        if (billingPeek !== null && billingPeek.includes('"outbound.codex_billing"')) {
          let parsedBilling: unknown = null;
          try { parsedBilling = JSON.parse(billingPeek); } catch { /* 非 JSON 不该走到这,稳妥起见仍直返 */ }
          if (
            parsedBilling !== null && typeof parsedBilling === "object" &&
            (parsedBilling as { type?: unknown }).type === "outbound.codex_billing"
          ) {
            const billing = parsedBilling as {
              requestId?: unknown;
              status?: unknown;
              errorReason?: unknown;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
                reasoning_output_tokens?: number;
              };
            };
            const reqId = typeof billing.requestId === "string" ? billing.requestId : null;
            if (reqId === null) {
              bridgeLog?.warn("user-chat-bridge: codex_billing missing requestId");
              return;
            }
            const snap = inflightCodexTurns.get(reqId);
            if (snap === undefined) {
              // billing 帧的 requestId 在本桥 inflight Map 里查不到。可能原因:
              //   - 我们已经在处理同 reqId 的另一帧 → Map 已 delete(下方先 delete
              //     再 settle 的 invariant — 防 duplicate 帧重复广播 cost_charged)
              //   - turn 已 settle 后容器又重发(retry / 误重)
              //   - bridge 已 finalCleanup 把 Map 清空 → fail 路径已 abort journal
              //   - 跨桥 misroute(理论不存在,容器只连一个 master 桥)
              bridgeLog?.info("user-chat-bridge: codex_billing for unknown turn", {
                requestId: reqId,
              });
              return;
            }
            // **同步** delete:duplicate billing 帧第二次进这个分支 Map.get 拿
            // undefined 直接 return,不会再起一个 IIFE 重复广播 cost_charged。
            // _done 守门只防 ledger 重复 debit,但两个 IIFE 各自 await commit 后
            // 都会读 result.debitedCredits>0 各广播一次 — 用 Map.delete 早断。
            inflightCodexTurns.delete(reqId);
            // CG2c — billing settle 路径的 log 钉到 turn 的 server-owned trace。
            // child 一次,后续 quota / commit / persist 三个分支都用 billingLog;
            // requestId 经 binding 提供,call-site 不再手写。**只读 snap.traceId,
            // 不解析 frame.traceId** —— 防容器侧伪造影响计费观测。
            const billingLog = bridgeLog?.child({
              traceId: snap.traceId,
              requestId: reqId,
            }) ?? null;
            // Issue A v1.0.108 — codex `account/rateLimits/updated` 通知 piggy-back
            // 到 billing 帧的 rateLimits 字段(runner 已转 Anthropic-shape)。
            // 与 ledger commit 解耦走独立 fire-and-forget,理由:
            //   - quota 是 best-effort 可见性,不应被 ledger commit 结果阻塞
            //   - 写在 commit 之前,避免 commit IIFE swallow exception 时 quota 也被吞
            //   - quota.ts 内部对 accountId === 0n / "0" 跳过(legacy 无关联账号)
            //   - quota.ts 30s SQL+JS 双层 throttle 兜底重复写
            const billingRl = (parsedBilling as { rateLimits?: unknown }).rateLimits;
            if (
              billingRl &&
              typeof billingRl === "object" &&
              deps.pgPool
            ) {
              const r = billingRl as {
                util5h?: number;
                reset5h?: string;
                util7d?: number;
                reset7d?: string;
              };
              void maybeUpdateAccountQuotaCodex(
                deps.pgPool,
                snap.accountId,
                r,
              ).catch((err) => {
                billingLog?.debug("user-chat-bridge: codex quota write failed", {
                  err: (err as Error)?.message,
                });
              });
            }
            const codexStatus: "success" | "error" =
              billing.status === "error" ? "error" : "success";
            const errorReason = typeof billing.errorReason === "string"
              ? billing.errorReason
              : undefined;
            const u = billing.usage ?? {};
            // 防御性 number → 非负整数 BigInt:容器侧理论 emit 合法 number,但坏帧
            // (NaN / Infinity / 字符串 / 对象)若进来,raw `BigInt(Math.trunc(...))`
            // 会同步 throw 打崩 onContainerMessage。统一过 sanitizer 兜底归 0。
            const safeNum = (v: unknown): bigint => {
              if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
                return 0n;
              }
              return BigInt(Math.trunc(v));
            };
            // reasoning_output_tokens 折进 output_tokens — codex 内部把推理 token
            // 单独计,但代理商按总 output 收;cache_*_input_tokens 改名对齐 calculator。
            const usage: TokenUsage = {
              input_tokens: safeNum(u.input_tokens),
              output_tokens:
                safeNum(u.output_tokens) + safeNum(u.reasoning_output_tokens),
              cache_read_tokens: safeNum(u.cache_read_input_tokens),
              cache_write_tokens: safeNum(u.cache_creation_input_tokens),
            };
            // fire-and-forget settle:Map 已 delete,duplicate 帧不会再触发;commit
            // 内部 _done 守门兜底防 finalCleanup 同时调 fail 时重复 debit。
            void (async () => {
              try {
                const result = await snap.finalizer.commit(
                  usage, codexStatus, errorReason,
                );
                // 仅 debit > 0 才广播 cost_charged;0 token / 重入 / settle 失败 /
                // commit-after-fail 合成 skipped(debitedCredits=null) 都不广播,
                // 避免前端误显示 ¥0 扣费条目。
                if (
                  result.debitedCredits !== null &&
                  result.debitedCredits > 0n
                ) {
                  // Plan §4.2 改动 4a: persist FIRST so refresh-after-reply
                  // shows the same value the broadcast carries. Failure is
                  // metric-only — broadcast still fires.
                  if (deps.appendCostCredits) {
                    try {
                      await deps.appendCostCredits(
                        reqId,
                        uid.toString(),
                        result.debitedCredits.toString(),
                      );
                    } catch (err) {
                      billingLog?.warn("user-chat-bridge: codex persist costCredits threw", {
                        err: (err as Error)?.message,
                      });
                    }
                  }
                  // CG2c — broadcast 帧带 traceId 让 outboundRing audit / 前端 trace
                  // 关联到 inbound canonical。snap.traceId 是 server-owned 唯一可信源。
                  broadcastToUser(uid, {
                    type: "outbound.cost_charged",
                    requestId: reqId,
                    traceId: snap.traceId,
                    model: snap.model,
                    costCredits: result.costCredits.toString(),
                    debitedCredits: result.debitedCredits.toString(),
                    balanceAfter: result.balanceAfter !== null
                      ? result.balanceAfter.toString()
                      : null,
                    clamped: result.clamped,
                  });
                }
              } catch (err) {
                billingLog?.error("user-chat-bridge: codex finalizer commit threw", {
                  err: (err as Error)?.message,
                });
              } finally {
                expireCodexRouteToken(snap.codexRouteToken, "billing_settled");
                checkDrainComplete();
              }
            })();
            return;
          }
        }
      }
      // Phase 4 — outbound.control.session_repo_status 侧信道(容器→master→user):
      //   master 须**先**落 DB(applyStatusFrame:更新 status / token_invalid 触发
      //   revoke + clear sessions),再让帧流到 userWs 让前端 UI 反映状态。
      //
      //   设计要点:
      //   - **不进 outbound ring**:status 帧不带 sessionKey/frameSeq,自然通不过下方
      //     ring 写入条件;且重连重放无意义(状态以 DB 为权威源)。
      //   - 与 codex_billing 不同,status 帧**要**透传给 userWs(用户需看到
      //     "cloning" / "ready" / "error" 进度);所以这里只 side-effect,不 return。
      //   - DB 写失败(stale ack 等)→ updateGithubWorkspaceStatusIfVersion 返回
      //     {updated:false},applyStatusFrame swallow,状态帧仍透传(用户至少能看到
      //     "已被新版本覆盖"的语义,不会卡住)。
      //   - cheap pre-filter 同 billing,不解 JSON 影响热路径。
      if (!isBinary) {
        let statusPeek: string | null = null;
        if (typeof data === "string") statusPeek = data;
        else if (Buffer.isBuffer(data)) {
          try { statusPeek = data.toString("utf8"); } catch { statusPeek = null; }
        }
        if (
          statusPeek !== null &&
          statusPeek.includes('"outbound.control.session_repo_status"')
        ) {
          let parsedStatus: unknown = null;
          try { parsedStatus = JSON.parse(statusPeek); } catch { /* 非 JSON 跳过 */ }
          if (parsedStatus !== null && typeof parsedStatus === "object") {
            const statusFrame = parseStatusFrame(parsedStatus);
            if (statusFrame !== null && deps.pgPool) {
              const pgPoolBound = deps.pgPool;
              // fire-and-forget:DB 写后 status 帧仍透传给 userWs(下方 send 路径)。
              ;(async () => {
                try {
                  const r = await applyStatusFrame(pgPoolBound, Number(uid), statusFrame);
                  // v1.0.94 — 诊断 instrument。状态帧从容器到 user 这段也要可见,
                  // 才能区分「容器没推 status」和「bridge 推了但 user 没收到」。
                  bridgeLog?.info("user-chat-bridge: repo_status_forwarded", {
                    sessionId: statusFrame.sessionId,
                    selectionVersion: statusFrame.selectionVersion,
                    status: statusFrame.status,
                    errorCode: statusFrame.errorCode,
                    dbUpdated: r.dbUpdated,
                    revoked: r.revoked,
                  });
                } catch (err) {
                  bridgeLog?.warn("user-chat-bridge: applyStatusFrame failed", {
                    sessionId: statusFrame.sessionId, err,
                  });
                }
              })();
            }
            // 不 return — status 帧继续走透传路径让前端 UI 看到状态变化
          }
        }
      }
      // Phase 0.4 — bridge ring write for stamped outbound frames.
      //
      // Containers stamp `sessionKey + frameSeq` on outbound frames inside
      // the embedded personal-master gateway (see openclaude/packages/gateway
      // server.ts deliver()). We capture that stamp here for late-reconnect
      // replay. Crucially this MUST run before the userWs.readyState gate
      // below — the whole point of buffering is to keep the frame around
      // while the client is briefly absent.
      //
      // Idempotency: when the same user has multiple tabs, the container's
      // deliver() iterates clientsByPeer and broadcasts the same frame to
      // each tab's bridge.containerWs. Each bridge instance shares this
      // process-singleton ring, so we'd see the same `(storeKey, seq)` write
      // multiple times. `storeStamped` skips silently when `seq <= prevLast`.
      //
      // Container reset: a recycled container gets a fresh `containerId`
      // from the supervisor — the storeKey namespace is fresh, so the
      // restarted container's seq=1 never collides with the previous
      // container's seq=1. Old namespaces age out via the 10min TTL.
      if (containerId !== undefined && !isBinary) {
        let frameStr: string | null = null;
        if (typeof data === "string") frameStr = data;
        else if (Buffer.isBuffer(data)) {
          try { frameStr = data.toString("utf8"); } catch { frameStr = null; }
        }
        if (frameStr !== null) {
          let parsedOut: unknown = null;
          try { parsedOut = JSON.parse(frameStr); } catch { /* non-JSON: skip */ }
          if (parsedOut !== null && typeof parsedOut === "object") {
            const wire = parsedOut as { sessionKey?: unknown; frameSeq?: unknown };
            if (
              typeof wire.sessionKey === "string" &&
              typeof wire.frameSeq === "number" &&
              wire.frameSeq > 0
            ) {
              const storeKey = `${uid.toString()}:${containerId.toString()}:${wire.sessionKey}`;
              outboundRing.storeStamped(storeKey, wire.frameSeq, Date.now(), frameStr);
            }
          }
        }
      }
      if (userWs.readyState !== WebSocket.OPEN) {
        // user 已经走了 — billing 帧已在上面分支处理,这里是非 billing 容器帧,丢
        // Note: ring write above ALREADY captured the frame for late-reconnect
        // replay, so dropping the live forward here is the intended behavior
        // (was previously a silent-drop bug because there was no ring layer).
        return;
      }
      // plan v3 G6 early release(BLOCKER 1):outbound.message + isFinal:true 或
      //   outbound.error,且 peer.id 命中本桥在飞 codex turn 的 inbound peer.id →
      //   立即 release codex slot,timer 退化为兜底。
      //   - 必须 acquiredCodexAccountId !== null && codexInboundPeerId !== null:
      //     未持槽 / 没记 peer.id 走纯透传(timer 兜底)
      //   - 仅文本帧 + cheap pre-filter 减少 JSON.parse 开销(claude 流是高频)
      //   - peer.id 严格匹配:claude 流 peer.id 不同 → 不误释
      //   - 释放在 userWs.send 之前完成,失败回滚靠 cleanup 兜底
      if (
        (acquiredCodexAccountId !== null || codexApiRelayTurnInFlight) &&
        codexInboundPeerId !== null &&
        !isBinary
      ) {
        let outText: string | null = null;
        if (typeof data === "string") outText = data;
        else if (Buffer.isBuffer(data)) {
          try { outText = data.toString("utf8"); } catch { outText = null; }
        }
        if (
          outText !== null &&
          (outText.includes('"isFinal":true') || outText.includes('"outbound.error"'))
        ) {
          let parsedOut: unknown = null;
          try { parsedOut = JSON.parse(outText); } catch { /* 非 JSON 透传 */ }
          if (parsedOut !== null && typeof parsedOut === "object") {
            const obj = parsedOut as {
              type?: unknown;
              isFinal?: unknown;
              peer?: { id?: unknown };
            };
            const peerId = obj.peer && typeof obj.peer === "object"
              ? (typeof obj.peer.id === "string" ? obj.peer.id : null)
              : null;
            const isFinalMsg = obj.type === "outbound.message" && obj.isFinal === true;
            const isErr = obj.type === "outbound.error";
            if ((isFinalMsg || isErr) && peerId !== null && peerId === codexInboundPeerId) {
              const accountId = acquiredCodexAccountId;
              acquiredCodexAccountId = null;
              codexApiRelayTurnInFlight = false;
              codexInboundPeerId = null;
              if (codexReleaseTimer !== null) {
                clearTimeout(codexReleaseTimer);
                codexReleaseTimer = null;
              }
              if (accountId !== null && deps.codexBinding !== undefined) {
                try { deps.codexBinding.release(accountId); } catch { /* swallow */ }
              }
              expireActiveCodexRoute(isFinalMsg ? "turn_final" : "turn_error");
            }
          }
        }
      }
      // 简单 backpressure:看 userWs.bufferedAmount(ws lib 维护的 socket 待发量)
      if (userWs.bufferedAmount + len > maxBufferedBytes) {
        bridgeLog?.warn("user-chat-bridge: user-side backpressure", {
          buffered: userWs.bufferedAmount, len,
        });
        sendErrorFrame(userWs, "ERR_BACKPRESSURE", "client slow");
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
        // user-WS 不可写但 container 仍在跑 codex turn → 走 drain 让 billing 落账
        // (broadcast 会 no-op 因 user-WS 已关,但 ledger debit 必须完成)
        cleanup("backpressure");
        return;
      }
      try {
        userWs.send(data, { binary: isBinary }, (err) => {
          if (err) {
            bridgeLog?.warn("user-chat-bridge: user send error", { err });
          }
        });
        bytesCU += len;
        bufferedCU = userWs.bufferedAmount;
        metrics.onContainerFrame?.(uid, len, isBinary);
        metrics.onBufferedBytes?.(uid, "container_to_user", bufferedCU);
      } catch (err) {
        bridgeLog?.warn("user-chat-bridge: user send threw", { err });
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "user send failed"); } catch { /* */ }
        // user-WS send 抛但 container 还在 — billing 帧仍可能到,走 drain 让 ledger
        // debit 落账(broadcast 因 user-WS 死会 no-op,但 settle 不能漏)
        cleanup("internal_error");
      }
    };

    // ---------- container WS 生命周期 ----------

    containerWs.on("open", () => {
      clearTimeout(connectTimer);
      bridgeLog?.debug("user-chat-bridge: container connected", {
        host: endpoint.host, port: endpoint.port,
      });
      // V3 cold-start UX 提示:本次 ensureRunning 走了 provision 分支 → 给前端发
      // 一帧 sidecar,前端把 typing indicator 文案换成"首次加载上下文较慢"。
      // 用 sys.* 命名空间避免与 ccb outbound.* 帧冲突;前端 default case 会忽略未知 type,
      // 加 case 是 additive。
      if (endpoint.coldStart === true && userWs.readyState === WebSocket.OPEN) {
        try {
          userWs.send(JSON.stringify({ type: "sys.cold_start" }));
        } catch { /* swallow — sidecar 提示失败不能影响 bridge */ }
      }
      // 冲刷 preopen queue
      for (const m of preopenQueue) sendToContainer(m.data, m.isBinary, m.len);
      preopenQueue.length = 0;
      bufferedUC = 0;
      metrics.onBufferedBytes?.(uid, "user_to_container", 0);
      // Phase 4 — auto-rebind active GitHub selections after container restart.
      //   触发场景:supervisor 重启容器后,新容器内 git workspace 已丢,但 DB 里
      //   还留着 ready/cloning/pending 的 selection。这里 open 时只 fetch row
      //   (无 token),token 留到 hello 阶段才取(覆盖 open→hello 之间 revoke 风险)。
      //   双触发:fetch 完成后调 tryAutoRebindFlush — 若 hello 已先到记 peers 那
      //   边就是真 flush;若还没到,等 hello 来再触发。
      //   pgPool 未注入(测试)→ 仍标记 fetchDone(避免 flush 永远等)。
      if (deps.pgPool) {
        const pgPoolBound = deps.pgPool;
        ;(async () => {
          try {
            const rows = await fetchActiveSelectionsForRebind(pgPoolBound, Number(uid));
            for (const row of rows) {
              pendingRebindMap.set(row.sessionId, row);
            }
          } catch (err) {
            bridgeLog?.warn("user-chat-bridge: fetch active selections failed", { err });
          } finally {
            autoRebindFetchDone = true;
            tryAutoRebindFlush();
          }
        })();
      } else {
        autoRebindFetchDone = true; // 测试 / 无 pg 路径:不阻塞 flush 语义
      }
    });

    containerWs.on("message", onContainerMessage);

    containerWs.on("error", (err: Error) => {
      bridgeLog?.warn("user-chat-bridge: container ws error", { err });
      sendErrorFrame(userWs, "ERR_CONTAINER", err.message);
      try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent error"); } catch { /* */ }
      // 容器 ws error → 容器侧已不可达,billing 也来不了 → force final
      cleanup("container_error", true);
    });

    containerWs.on("close", (code, reason) => {
      // 容器主动关 → 透传给用户 close,但 reserved code (1005/1006/1015) 不能 send
      const passCode = sanitizeCloseCode(code);
      const passReason = reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "agent closed";
      try { userWs.close(passCode, passReason); } catch { /* */ }
      // 容器 close → billing 帧渠道关了,drain 没意义 → force final
      // (cleanup 函数本身也会在 drain 期遇 container_close 触发 pre-empt)
      cleanup("container_close", true);
    });

    // ---------- user WS 生命周期 ----------

    userWs.on("message", onUserMessage);
    userWs.on("error", (err) => {
      bridgeLog?.warn("user-chat-bridge: user ws error", { err });
    });

    // ---------- 心跳(HIGH#5) ----------
    // 思路:"最后一次活跃" timestamp,每 heartbeatIntervalMs 醒来一次:
    //   - 距上次活跃 > heartbeatTimeoutMs → 判死链,terminate()
    //   - 否则发一个 ping(不等对端 pong 即可刷新 lastAlive,pong 来了也刷)
    // 任意下行/上行消息 / pong 都刷 lastAlive;这样正常聊天的连接根本走不到 terminate 路径。
    let lastAliveAt = Date.now();
    const refreshAlive = (): void => { lastAliveAt = Date.now(); };
    userWs.on("pong", refreshAlive);
    userWs.on("message", refreshAlive); // 绑第二个 message handler 只刷时间戳,不干扰 onUserMessage
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (userWs.readyState !== WebSocket.OPEN) return;
        const idleMs = Date.now() - lastAliveAt;
        if (idleMs > heartbeatTimeoutMs) {
          bridgeLog?.info("user-chat-bridge: heartbeat timeout, terminating", { idleMs });
          try { userWs.terminate(); } catch { /* */ }
          // heartbeat 超时 = 用户失联,但容器仍可能在跑 codex turn,billing 帧还会
          // 到 → 走 drain(force=false),checkDrainComplete / drain timeout 兜底
          cleanup("client_close");
          return;
        }
        try { userWs.ping(); } catch { /* */ }
      }, heartbeatIntervalMs);
    }

    // plan v3 review v1 §F4 follow-up:周期重新拉 grants 让 admin 取消授权能在
    // 已开桥上生效。fire-and-forget;refresh 自己 swallow error,不会 reject。
    if (modelCheckerHandle !== null) {
      modelCheckerRefreshTimer = setInterval(() => {
        // 注意:不绑 await/then;refresh 内部 swallow error,这里只是触发。
        modelCheckerHandle.refresh();
      }, GRANTS_REFRESH_INTERVAL_MS);
      // 不阻塞进程退出 —— bridge 不在则 timer 也无意义。
      modelCheckerRefreshTimer.unref?.();
    }
    userWs.on("close", (code, reason) => {
      // 把客户端关闭原因转给容器(透传 code/reason,容器侧也会触发 cleanup)
      // **注意**:不要在这里 close containerWs。drain 机制需要容器仍开着接收 billing
      // 帧 — 关 container 会让 codex turn 半道崩,billing 帧永远到不了 master。
      // drain timeout (DRAIN_BILLING_MS) / pre-empt (container_close from agent)
      // 会兜底关闭。
      const passCode = sanitizeCloseCode(code);
      const passReason = reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "client closed";
      // 仅在没有 codex inflight 时才透传 close 给容器(走 force final 路径);
      // 有 inflight 时进 drain,container 留着等 billing,drain 收尾时由 finalCleanup
      // 统一 terminate。
      if (inflightCodexTurns.size === 0) {
        try {
          if (containerWs.readyState === WebSocket.OPEN
            || containerWs.readyState === WebSocket.CONNECTING) {
            containerWs.close(passCode, passReason);
          }
        } catch { /* */ }
      }
      cleanup("client_close");
    });

    // 把"upgrade 期间早到的帧"先 emit 一遍 → 走正常 onUserMessage 流程。
    // TTFT 起点用第一条早到帧的 receivedAtMs(更准 — 用户发帧瞬间,而不是 replay 瞬间);
    // 后续帧 onUserMessage 内部的 firstUserFrameAtMs !== null 守卫会跳过覆盖。
    if (earlyMessages.length > 0 && firstUserFrameAtMs === null) {
      firstUserFrameAtMs = earlyMessages[0]!.receivedAtMs;
    }
    for (const m of earlyMessages) {
      onUserMessage(m.data, m.isBinary);
    }

    // ---------- cleanup 状态机(PR2 v1.0.66 drain refactor) ----------
    //
    // 状态:
    //   1. 正常运行:cleaned=false, drainTimer=null
    //   2. drain 期(仅 user_close + 有 inflight codex turn 触发):
    //      cleaned=false, drainTimer!=null, userDetached=true,
    //      container WS 仍开,onContainerMessage 仍处理 billing 帧
    //   3. 完结:cleaned=true,所有资源释放
    //
    // 入口:cleanup(triggerCause, force=false) — 参数化避免依赖外部 mutable cause。
    //   - drain 中再调:container 异常 / shutdown / force 路径 → 立即 finalCleanup
    //     其它(user_close 重入 / heartbeat)忽略,继续等 billing
    //   - 未 drain:non-client_close 或 force 或 inflight 空 → 立即 finalCleanup
    //                client_close + inflight 非空 → 进 drain
    //
    // detachUserSide(立即跑,drain / final 都用):unregister + uidToUserWs.delete +
    //   user-side timer 清 + non-client_close 路径强 terminate userWs(防 heartbeat
    //   timeout 留 socket)
    //
    // checkDrainComplete:billing settle 把 inflightCodexTurns.size→0 时调,提前 final
    function cleanup(triggerCause: BridgeCloseCause, force = false): void {
      if (cleaned) return;

      // 已在 drain 中
      if (drainTimer !== null) {
        if (
          force ||
          triggerCause === "container_close" ||
          triggerCause === "container_error" ||
          triggerCause === "shutdown"
        ) {
          bridgeLog?.info("user-chat-bridge: drain pre-empt", {
            triggerCause, leftover: inflightCodexTurns.size,
          });
          finalCleanup(triggerCause);
        }
        // 其它路径(user_close 重入 / heartbeat 抖动)在 drain 期忽略
        return;
      }

      // 还没进 drain
      // drain 适用条件:user-side 故障(client_close / backpressure / internal_error)
      // 同时有在飞 codex turn → container 仍可发 billing 帧,5s 内能到的就 settle。
      // container_* / shutdown / frame_too_big / auth_failed 等路径不走 drain。
      const shouldDrain =
        !force &&
        (triggerCause === "client_close" ||
          triggerCause === "backpressure" ||
          triggerCause === "internal_error") &&
        inflightCodexTurns.size > 0;

      if (!shouldDrain) {
        finalCleanup(triggerCause);
        return;
      }

      // 进 drain 路径(只有 user 主动 close + 有 codex inflight 才会)
      drainCause = triggerCause;
      detachUserSide(triggerCause);
      bridgeLog?.info("user-chat-bridge: enter drain", {
        inflightCount: inflightCodexTurns.size,
      });
      drainTimer = setTimeout(() => {
        bridgeLog?.warn("user-chat-bridge: drain timeout", {
          leftover: inflightCodexTurns.size,
        });
        finalCleanup(drainCause ?? "client_close");
      }, DRAIN_BILLING_MS);
      drainTimer.unref?.();
    }

    /**
     * billing settle 把 inflightCodexTurns.size 减到 0 时调,提前结束 drain。
     * 不在 drain 期 / Map 非空时 no-op。
     */
    function checkDrainComplete(): void {
      if (drainTimer !== null && inflightCodexTurns.size === 0) {
        clearTimeout(drainTimer);
        drainTimer = null;
        finalCleanup(drainCause ?? "client_close");
      }
    }

    /**
     * 立即让出 user 侧资源(registry 配额、uidToUserWs、user-side timer)。
     *
     * idempotent — drain 进入时跑一次,finalCleanup 也无脑跑(no-op)。
     *
     * **重要**:对非 client_close 路径(heartbeat timeout / force)且 userWs 还活着,
     * 强 terminate;否则 socket 漂在那 60s+ 不释放系统资源(Codex 审计 BLOCKER)。
     * client_close 路径 userWs 已经 close,不重复 terminate。
     */
    function detachUserSide(triggerCause: BridgeCloseCause): void {
      if (userDetached) return;
      userDetached = true;
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (modelCheckerRefreshTimer !== null) {
        clearInterval(modelCheckerRefreshTimer);
        modelCheckerRefreshTimer = null;
      }
      clearTimeout(connectTimer);
      // heartbeat timeout / shutdown / force 路径下 userWs 可能还 OPEN —— terminate
      if (
        triggerCause !== "client_close" &&
        userWs.readyState !== WebSocket.CLOSED &&
        userWs.readyState !== WebSocket.CLOSING
      ) {
        try { userWs.terminate(); } catch { /* */ }
      }
      unregister();
      {
        const key = uid.toString();
        const set = uidToUserWs.get(key);
        if (set) {
          set.delete(userWs);
          if (set.size === 0) uidToUserWs.delete(key);
        }
      }
    }

    /**
     * 真 teardown:释放全部资源 + emit metric/log。idempotent(cleaned 守门)。
     *
     * 调用时机:
     *   - 非 drain 路径直接 final
     *   - drain 超时 / drain 期被 container_close/error/shutdown/force 抢占
     *   - drain 期 inflightCodexTurns 全 settle 完 → checkDrainComplete 触发
     */
    function finalCleanup(finalCause: BridgeCloseCause): void {
      if (cleaned) return;
      cleaned = true;
      cause = finalCause;
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }

      // user 侧 detach(idempotent)
      detachUserSide(finalCause);

      // PR2 v1.0.66 — codex inflight finalize.fail:drain 已超时或没进 drain 的路径,
      // 把 Map 里残留的 turn 标 abort journal + release preCheck。fire-and-forget。
      // commit 与 fail 由 codexFinalizer._done 守门同步幂等,二者命中同一首次 promise,
      // 不会重复 debit。
      for (const [, snap] of inflightCodexTurns) {
        snap.finalizer.fail("bridge_disconnect").catch(() => {});
      }
      inflightCodexTurns.clear();

      // plan v3 G6 — codex 槽兜底释放:bridge 关 = 当前 turn 必然终止(用户 ws / 容器
      //   ws 任一断都进 cleanup)。清掉 timeout timer 后显式 release。即便 acquire 还在
      //   飞(codexAcquireInflight=true),acquire 内部已检查 cleaned 标志,acquire 成功
      //   后会立刻 release 自己,不会泄漏。
      if (codexReleaseTimer !== null) {
        clearTimeout(codexReleaseTimer);
        codexReleaseTimer = null;
      }
      if (acquiredCodexAccountId !== null && deps.codexBinding) {
        try { deps.codexBinding.release(acquiredCodexAccountId); } catch { /* */ }
        acquiredCodexAccountId = null;
      }
      expireActiveCodexRoute("bridge_cleanup");
      codexApiRelayTurnInFlight = false;
      codexInboundPeerId = null;
      try { connectAbort.abort(); } catch { /* */ }
      try {
        // 注意:CLOSING 状态也强 terminate(),不依赖对端 echo,
        // 否则有可能 close 帧丢失或 send 异常导致连接卡死
        if (containerWs.readyState !== WebSocket.CLOSED) {
          containerWs.terminate();
        }
      } catch { /* */ }

      const closeCode = userWs.readyState === WebSocket.CLOSED
        ? (userWs as unknown as { _closeCode?: number })._closeCode ?? CLOSE_BRIDGE.NORMAL
        : CLOSE_BRIDGE.NORMAL;
      const closeReason = userWs.readyState === WebSocket.CLOSED
        ? String((userWs as unknown as { _closeMessage?: string })._closeMessage ?? "")
        : "";

      metrics.onClose?.({
        uid,
        connId,
        durationMs: Date.now() - startedAt,
        closeCode,
        closeReason,
        bytesUserToContainer: bytesUC,
        bytesContainerToUser: bytesCU,
        cause: finalCause,
      });
      bridgeLog?.info("user-chat-bridge: closed", {
        durationMs: Date.now() - startedAt,
        bytesUC, bytesCU, cause: finalCause,
      });
    }
  }

  async function shutdown(reason = "server shutting down"): Promise<void> {
    clearInterval(ringPruneTimer);
    registry.closeAll(reason);
    await new Promise<void>((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
    });
  }

  /**
   * 把 payload 以 JSON text 帧发送给 uid 名下所有 OPEN 状态的 user WS。
   * 非 OPEN 状态的 ws 直接跳过(不是错误)。send 本身异常单独 catch,不连累其他 ws。
   */
  function broadcastToUser(uid: bigint, payload: unknown): number {
    const set = uidToUserWs.get(uid.toString());
    if (!set || set.size === 0) return 0;
    let text: string;
    try { text = JSON.stringify(payload); }
    catch (err) {
      log?.warn("user-chat-bridge: broadcastToUser stringify failed", {
        uid: uid.toString(), err,
      });
      return 0;
    }
    let sent = 0;
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(text, { binary: false }, (err) => {
          if (err) log?.warn("user-chat-bridge: broadcastToUser send error", {
            uid: uid.toString(), err,
          });
        });
        sent += 1;
      } catch (err) {
        log?.warn("user-chat-bridge: broadcastToUser send threw", {
          uid: uid.toString(), err,
        });
      }
    }
    return sent;
  }

  return { handleUpgrade, shutdown, registry, broadcastToUser };
}

// ---------- 测试 re-exports ------------------------------------------------
// 供单测直接拿到内部 helpers,不走 ws upgrade 全链路就能验逻辑

export { rawDataLen as _rawDataLen, encode4503Reason as _encode4503Reason };
