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
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { verifyAccess, JwtError, type AccessClaims } from "../auth/jwt.js";
import { ConnectionRegistry, type Conn } from "./connections.js";
import type { Logger } from "../logging/logger.js";
import { isInMaintenance } from "../middleware/maintenanceMode.js";
import type { NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";

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

        // 4) 把"早到帧"解绑 + 检查客户端是否已撤,再交给 startBridge
        ws.off("message", onEarlyMessage);
        ws.off("close", onEarlyClose);
        if (earlyClose !== null) {
          // 客户端在 await 期间(ensureRunning 或 tunnel pre-dial)已经撤了
          log?.info("user-chat-bridge: client closed during ensure", {
            uid: uid.toString(),
          });
          try { containerWs.terminate(); } catch { /* */ }
          try { connectAbort.abort(); } catch { /* */ }
          return;
        }

        startBridge(
          ws,
          uid,
          endpoint,
          pendingMessages,
          endpoint.containerId,
          containerWs,
          connectAbort,
          modelCheckerHandle,
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
  ): void {
    const connId = randomUUID();
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
    //   codexLegacyContainer = true → 容器 codex_account_id IS NULL(决策 N3 legacy
    //     路径),acquire 返回 null 后置位,后续 codex inbound 直接透传不再调 acquire
    //   codexReleaseTimer → CODEX_SESSION_MAX_MS 兜底释放(决策 G6),防 outbound 丢/
    //     ws 异常断后槽永久泄漏
    let acquiredCodexAccountId: bigint | null = null;
    let codexAcquireInflight = false;
    let codexLegacyContainer = false;
    let codexReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    // plan v3 G6 — outbound 终态早释放(Codex review v2 BLOCKER 1):
    //   只靠 600s timer + cleanup 释放,正常完成的 turn 会持槽 ≤ 10min,
    //   单账号 maxConcurrent=10 → 10 个正常 turn 后误判 busy。
    //   方案:acquire 时记 inbound.peer.id;outbound.message + isFinal:true 或
    //   outbound.error 且 peer.id 命中 → 立即 release,timer 退化为兜底。
    //   匹配 peer.id 的原因:同桥可 claude+codex 交错,只看"任意 isFinal"会误释。
    let codexInboundPeerId: string | null = null;

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
        log?.warn("user-chat-bridge: container connect timeout", {
          uid: uid.toString(), connId, host: endpoint.host, port: endpoint.port,
        });
        cause = "container_error";
        try { connectAbort.abort(); } catch { /* */ }
        try { containerWs.terminate(); } catch { /* */ }
        sendErrorFrame(userWs, "ERR_CONTAINER_TIMEOUT", "agent connect timeout");
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent timeout"); } catch { /* */ }
        cleanup();
      }
    }, connectTimeoutMs);

    // ---------- 双向 pipe handlers ----------

    const onUserMessage = (data: RawData, isBinary: boolean): void => {
      const len = rawDataLen(data);
      if (len > maxFrameBytes) {
        cause = "frame_too_big";
        sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG",
          `user frame ${len} > max ${maxFrameBytes}`);
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
        cleanup();
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
      if (!isBinary) {
        let frameStr: string | null = null;
        if (typeof data === "string") frameStr = data;
        else if (Buffer.isBuffer(data)) {
          try { frameStr = data.toString("utf8"); } catch { frameStr = null; }
        }
        if (frameStr !== null) {
          let parsed: unknown = null;
          try { parsed = JSON.parse(frameStr); } catch { /* 非 JSON 帧透传 */ }
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
              log?.info("user-chat-bridge: model not authorized", {
                uid: uid.toString(),
                modelId: effectiveModel,
                source,
              });
              cause = "client_close"; // user 提交了无权访问的 model,等同被拒
              sendErrorFrame(
                userWs,
                "UNAUTHORIZED_MODEL",
                `model not authorized for current user: ${effectiveModel}`,
              );
              try { userWs.close(CLOSE_BRIDGE.POLICY, "unauthorized_model"); } catch { /* */ }
              cleanup();
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
            }
          }
        }
      }

      // plan v3 G5/G7 — codex per-account 槽 acquire / 严格单飞:
      //   - bridge 看到 codex inbound + 有 codexBinding 注入 + 有 containerId
      //   - 容器 codex_account_id 已知 NULL(legacy)→ 透传不占槽(决策 N3)
      //   - 已持槽 / acquire 在飞 → reject "previous codex turn still in progress"(G7)
      //   - 否则:async acquire → 成功 forward;Busy / 其他 fail → fast-fail error 帧
      //
      // 非 codex 帧 / 没注入 codexBinding / 没 containerId → 直接走下方原同步 forward
      if (
        isCodexInboundFrame &&
        deps.codexBinding !== undefined &&
        containerId !== undefined &&
        !codexLegacyContainer
      ) {
        if (acquiredCodexAccountId !== null || codexAcquireInflight) {
          // G7 严格单飞:不 close bridge,让前端等当前 turn 完成后重发
          log?.info("user-chat-bridge: codex turn busy, rejecting frame", {
            uid: uid.toString(),
            connId,
          });
          sendErrorFrame(
            userWs,
            "CODEX_TURN_BUSY",
            "previous codex turn still in progress, wait for completion",
          );
          return;
        }
        codexAcquireInflight = true;
        const codexBinding = deps.codexBinding;
        const cid = containerId;
        const sessionMaxMs = readCodexSessionMaxMs();
        // 进 acquire 路径才记 peer.id;G7 拒绝路径(busy)不该覆盖在飞 turn 的 peer.id。
        const peerIdForAcquire = inboundPeerIdForFrame;
        void (async () => {
          try {
            const acquired = await codexBinding.acquire(cid);
            if (cleaned) {
              // bridge 在 acquire 期间被关 — 立即 release 不留泄漏
              if (acquired !== null) {
                try { codexBinding.release(acquired.account_id); } catch { /* */ }
              }
              return;
            }
            if (acquired === null) {
              // legacy NULL 容器,不占槽,后续 codex 帧也透传
              codexLegacyContainer = true;
            } else {
              acquiredCodexAccountId = acquired.account_id;
              codexInboundPeerId = peerIdForAcquire;
              codexReleaseTimer = setTimeout(() => {
                // 兜底释放:防 outbound 完成信号丢 / ws 异常断 → 槽永久泄漏
                if (acquiredCodexAccountId !== null) {
                  try { codexBinding.release(acquiredCodexAccountId); } catch { /* */ }
                  acquiredCodexAccountId = null;
                }
                codexInboundPeerId = null;
                codexReleaseTimer = null;
              }, sessionMaxMs);
              codexReleaseTimer.unref?.();
            }
            // 已 acquire 完毕,继续同步 forward 路径(等价于"放行原 frame")。
            // 走 forwardInboundFrame helper 与下方主路径同义。
            forwardInboundFrame(data, isBinary, len);
          } catch (err) {
            const errName = (err as { name?: string } | null | undefined)?.name ?? "";
            if (errName === "AccountPoolBusyError") {
              log?.info("user-chat-bridge: codex pool busy, fast-fail", {
                uid: uid.toString(),
                connId,
              });
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(
                  userWs,
                  "CODEX_POOL_BUSY",
                  "codex pool busy, retry shortly",
                );
              }
            } else {
              log?.warn("user-chat-bridge: codex acquire failed", {
                uid: uid.toString(),
                connId,
                err,
              });
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
          cause = "backpressure";
          sendErrorFrame(userWs, "ERR_BACKPRESSURE", "agent slow");
          try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
          cleanup();
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
            log?.warn("user-chat-bridge: container send error", {
              uid: uid.toString(), connId, err,
            });
          }
        });
        bytesUC += len;
        metrics.onUserFrame?.(uid, len, isBinary);
      } catch (err) {
        log?.warn("user-chat-bridge: container send threw", {
          uid: uid.toString(), connId, err,
        });
        cause = "container_error";
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent send failed"); } catch { /* */ }
        cleanup();
      }
    };

    const preopenQueue: Array<{ data: RawData; isBinary: boolean; len: number }> = [];

    const onContainerMessage = (data: RawData, isBinary: boolean): void => {
      const len = rawDataLen(data);
      if (len > maxFrameBytes) {
        cause = "frame_too_big";
        log?.warn("user-chat-bridge: container frame too big", {
          uid: uid.toString(), connId, len, max: maxFrameBytes,
        });
        sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG",
          `container frame ${len} > max ${maxFrameBytes}`);
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
        cleanup();
        return;
      }
      // Bridge TTFT 终点:首个 container→user 帧。
      // 守卫 firstUserFrameAtMs !== null 防御容器在用户发帧前主动 push(理论不发生,
      // 但保险 — 否则会算负值/无意义观测)。oversize 拒绝路径已 return,不会走到这。
      if (firstContainerFrameAtMs === null && firstUserFrameAtMs !== null) {
        firstContainerFrameAtMs = Date.now();
        metrics.onTtft?.(uid, ttftKind, (firstContainerFrameAtMs - firstUserFrameAtMs) / 1000);
      }
      if (userWs.readyState !== WebSocket.OPEN) {
        // user 已经走了,丢
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
        acquiredCodexAccountId !== null &&
        codexInboundPeerId !== null &&
        !isBinary &&
        deps.codexBinding !== undefined
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
              codexInboundPeerId = null;
              if (codexReleaseTimer !== null) {
                clearTimeout(codexReleaseTimer);
                codexReleaseTimer = null;
              }
              try { deps.codexBinding.release(accountId); } catch { /* swallow */ }
            }
          }
        }
      }
      // 简单 backpressure:看 userWs.bufferedAmount(ws lib 维护的 socket 待发量)
      if (userWs.bufferedAmount + len > maxBufferedBytes) {
        cause = "backpressure";
        log?.warn("user-chat-bridge: user-side backpressure", {
          uid: uid.toString(), connId,
          buffered: userWs.bufferedAmount, len,
        });
        sendErrorFrame(userWs, "ERR_BACKPRESSURE", "client slow");
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
        cleanup();
        return;
      }
      try {
        userWs.send(data, { binary: isBinary }, (err) => {
          if (err) {
            log?.warn("user-chat-bridge: user send error", {
              uid: uid.toString(), connId, err,
            });
          }
        });
        bytesCU += len;
        bufferedCU = userWs.bufferedAmount;
        metrics.onContainerFrame?.(uid, len, isBinary);
        metrics.onBufferedBytes?.(uid, "container_to_user", bufferedCU);
      } catch (err) {
        log?.warn("user-chat-bridge: user send threw", {
          uid: uid.toString(), connId, err,
        });
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "user send failed"); } catch { /* */ }
        cleanup();
      }
    };

    // ---------- container WS 生命周期 ----------

    containerWs.on("open", () => {
      clearTimeout(connectTimer);
      log?.debug("user-chat-bridge: container connected", {
        uid: uid.toString(), connId, host: endpoint.host, port: endpoint.port,
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
    });

    containerWs.on("message", onContainerMessage);

    containerWs.on("error", (err: Error) => {
      log?.warn("user-chat-bridge: container ws error", {
        uid: uid.toString(), connId, err,
      });
      cause = "container_error";
      sendErrorFrame(userWs, "ERR_CONTAINER", err.message);
      try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent error"); } catch { /* */ }
      cleanup();
    });

    containerWs.on("close", (code, reason) => {
      // 容器主动关 → 透传给用户 close,但 reserved code (1005/1006/1015) 不能 send
      const passCode = sanitizeCloseCode(code);
      const passReason = reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "agent closed";
      if (cause === "internal_error") cause = "container_close";
      try { userWs.close(passCode, passReason); } catch { /* */ }
      cleanup();
    });

    // ---------- user WS 生命周期 ----------

    userWs.on("message", onUserMessage);
    userWs.on("error", (err) => {
      log?.warn("user-chat-bridge: user ws error", {
        uid: uid.toString(), connId, err,
      });
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
          log?.info("user-chat-bridge: heartbeat timeout, terminating", {
            uid: uid.toString(), connId, idleMs,
          });
          cause = "client_close";
          try { userWs.terminate(); } catch { /* */ }
          cleanup();
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
      if (cause === "internal_error") cause = "client_close";
      // 把客户端关闭原因转给容器(透传 code/reason,容器侧也会触发 cleanup)
      const passCode = sanitizeCloseCode(code);
      const passReason = reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "client closed";
      try {
        if (containerWs.readyState === WebSocket.OPEN
          || containerWs.readyState === WebSocket.CONNECTING) {
          containerWs.close(passCode, passReason);
        }
      } catch { /* */ }
      cleanup();
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

    // ---------- cleanup(幂等) ----------
    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(connectTimer);
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (modelCheckerRefreshTimer !== null) {
        clearInterval(modelCheckerRefreshTimer);
        modelCheckerRefreshTimer = null;
      }
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
      codexInboundPeerId = null;
      try { connectAbort.abort(); } catch { /* */ }
      try {
        // 注意:CLOSING 状态也强 terminate(),不依赖对端 echo,
        // 否则有可能 close 帧丢失或 send 异常导致连接卡死
        if (containerWs.readyState !== WebSocket.CLOSED) {
          containerWs.terminate();
        }
      } catch { /* */ }
      unregister();
      // 同步从 uid→ws 表中摘掉;即便 registry 的 Conn.close 回调已被 kick 路径触发
      // 过也是幂等的(Set.delete 不存在会返 false)。
      {
        const key = uid.toString();
        const set = uidToUserWs.get(key);
        if (set) {
          set.delete(userWs);
          if (set.size === 0) uidToUserWs.delete(key);
        }
      }

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
        cause,
      });
      log?.info("user-chat-bridge: closed", {
        uid: uid.toString(), connId,
        durationMs: Date.now() - startedAt,
        bytesUC, bytesCU, cause,
      });
    }
  }

  async function shutdown(reason = "server shutting down"): Promise<void> {
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
