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
 *                       ├─ const {host, port, bundleRev} = await resolveContainerEndpoint(uid)
 *                       │     ↑ 唯一入口(R6.11 reader 硬约束)。Phase 3 接入
 *                       │       supervisor.ensureRunning(uid);Phase 2 由调用方注入。
 *                       │       throw 503 → 关 ws + close code 4503 + retryAfter 给前端
 *                       ├─ await loadAgentModelResolver(uid, { bundleRev })   // 必须在 ↑ 之后!
 *                       │     ↑ seed agent 的计费模型 = **该容器实际跑的 bundle rev** 的 seed 声明
 *                       │       (模型权威批次 §5 阶段 B)。提前到 ensureRunning 之前 = master 用
 *                       │       current 声明给跑旧 seed 的容器计费 = 滚动窗口计费分叉。
 *                       └─ 内部 fetch ws://<host>:<port>/ws → 双向 pipe(text + binary)
 *
 * 协议透明为默认路径:非业务控制帧保持 byte-exact 透传；`inbound.message`
 * 会由 master 注入 trace / 授权 / 历史 / 平台能力提示等私有上下文,再转发给容器。
 * 个人版 `/ws` 协议可演进而无需 commercial 配合。
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
import { recordTurnTrace } from "./turnTraces.js";
import { isInMaintenance } from "../middleware/maintenanceMode.js";
import type { NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";
import {
  type PreCheckRedis,
  type ReservationHandle,
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
  ENGINE_SESSION_ID_RE,
  makeCodexFinalizer,
  type CodexFinalizeHandle,
} from "../billing/codexFinalizer.js";
import type { TokenUsage } from "../billing/calculator.js";
import { maybeUpdateAccountQuotaCodex } from "../account-pool/quota.js";
import { OutboundRingBuffer, DEFAULT_RING_CONFIG } from "@openclaude/gateway";
import {
  DEFAULT_CODEX_ENGINE_MODEL,
  MODEL_AUTHORITY_CAPABILITY,
  MODEL_AUTHORITY_FIELD,
  isCodexEngineModel,
  newTraceId,
  parseTraceIdCandidate,
  stripModelAuthorityField,
  type ModelAuthorityBundle,
  type ModelAuthorityEngine,
  type ModelExecutionDescriptor,
  type SysIncident,
  type TraceIdIssue,
} from "@openclaude/protocol";
import type { AuthoritySigner } from "./authoritySigner.js";
import { type AuthorityKeyCensus, authorityKeyCensus } from "./authorityKeyCensus.js";
import { platformAuxModels, readSecurityEpoch } from "../billing/modelCatalog.js";
import type { ModelCatalogCache, ModelCatalogSnapshot } from "../billing/modelCatalog.js";
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
import { appendScanSciPaperIntentHintToFrame } from "./paperIntentHint.js";

// ---------- 协议 / 常量 -----------------------------------------------------

/** 桥接路径(只此一个,gateway upgrade 路由按 url.pathname 匹配)。 */
export const BRIDGE_WS_PATH = "/ws/user-chat-bridge";

/** 五枚举目标画面比例(与 protocol imageEdit.targetAspect / gateway OUTPAINT_ASPECT_RATIOS
 * 同源;master 侧只做识别不算几何,故内联而非跨包 import 保持接帧热路径零新依赖)。 */
const OUTPAINT_ASPECTS = new Set(["16:9", "4:3", "9:16", "3:4", "1:1"]);

/** Strictly recognize a server-completed image-edit envelope before bypassing
 * ordinary Codex precheck/journal plumbing. A loose `imageEdit` presence
 * check would let malformed client frames evade normal chat billing.
 *
 * v5 图片体验:两种直投形态都必须命中此 bypass(否则会被当普通 codex chat turn
 * 预扣槽/开 journal,而 gateway 又永远不发 codex turn → 计费悬挂 / 双计费):
 *   - annotated(笔刷圈选 / 数字锚点评论):带用户 mask,media=[source,mask,guide]
 *     → 3 个互异图片索引(mode 缺省即此,兼容旧前端)。
 *   - outpaint(调整画面比例):无用户 mask,media=[source,guide] → 2 个互异图片
 *     索引 + 合法 targetAspect。计费同 50 积分/张,relay 内完成。 */
export function isValidatedAnnotatedImageInbound(frame: Record<string, unknown>): boolean {
  if (frame.type !== "inbound.message") return false;
  const content = frame.content;
  if (!content || typeof content !== "object") return false;
  const typedContent = content as { text?: unknown; media?: unknown; imageEdit?: unknown };
  if (typeof typedContent.text !== "string" || typedContent.text.trim().length === 0) return false;
  if (!Array.isArray(typedContent.media)) return false;
  const media = typedContent.media;
  const edit = typedContent.imageEdit;
  if (!edit || typeof edit !== "object") return false;
  const value = edit as Record<string, unknown>;
  if (typeof value.clientJobId !== "string" || !/^[0-9a-f]{32}$/.test(value.clientJobId)) return false;
  if (!Number.isInteger(value.width) || Number(value.width) < 1 || Number(value.width) > 8192) return false;
  if (!Number.isInteger(value.height) || Number(value.height) < 1 || Number(value.height) > 8192) return false;
  if (Number(value.width) * Number(value.height) > 16_777_216) return false;
  const isOutpaint = value.mode === "outpaint";
  if (isOutpaint && !OUTPAINT_ASPECTS.has(value.targetAspect as string)) return false;
  const indices = isOutpaint
    ? [value.sourceIndex, value.guideIndex]
    : [value.sourceIndex, value.maskIndex, value.guideIndex];
  const wantDistinct = isOutpaint ? 2 : 3;
  if (
    !indices.every((index) => Number.isInteger(index) && Number(index) >= 0 && Number(index) < media.length)
    || new Set(indices).size !== wantDistinct
  ) return false;
  return indices.every((index) => {
    const item = media[Number(index)];
    return !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "image";
  });
}

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
  /** 同一用户连接数超限踢旧连接。不要用 1008,否则前端会误判为登录过期。 */
  TOO_MANY_CONNECTIONS: 4505,
  /** 计费/余额类策略拒绝。 */
  BILLING_POLICY: 4506,
  /** 用户可调整的产品策略(如模型未授权),不是 access token 失效。 */
  PRODUCT_POLICY: 4507,
  /** GPT/Codex 环境被回收/重建,提示刷新重试。 */
  ENV_RECYCLED: 4508,
  /** 服务重启/发版(shutdown → registry.closeAll)。**瞬态**:前端收此码后静默自动重连,
   *  hello/resume 从容器 ring 续传,不弹错、不进会话正文(web-react pure.ts classifyClose
   *  同步认识此码,两端语义务必同改)。不要复用 4505——那是"连接数超限"的 kick 语义。 */
  SERVER_RESTART: 4509,
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
// turn 在飞最长心跳宽限。CF/Caddy 不转发 WS ping/pong 控制帧 → 浏览器在等长 turn
// (冷启 TTFT / 长生成 / 慢工具 / 静默推理)期间没有任何上行信号刷 lastAlive,会被 60s
// 心跳误杀,连带丢掉响应帧与 cost_charged(计费在 turn 收尾后才广播)。对策:用户发了
// inbound.message 即视为"在等响应",turn 在飞期间不 reap;但这是从 turn 起点算的**硬上限**,
// 防"浏览器真断 + turn 卡死"的连接永不回收(turnActiveUntil 不被下行帧续期,见 Codex 审)。
const MAX_TURN_GRACE_MS = 10 * 60_000;
// turn 收尾(isFinal)后保留的短宽限:cost_charged 在 isFinal 之后才广播,留窗口确保它
// 还能投到 user WS;窗口过后回归正常 idle 回收。取 min(原硬上限剩余, 此值),只缩不延。
const POST_FINAL_GRACE_MS = 90_000;

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
  /**
   * 容器**实际运行**的 platform bundle rev(容器 label `com.openclaude.runtime.bundle_rev`;
   * v3ensureRunning 从 docker inspect labels / provision 实际打的 label 取,不是 master 的
   * desired tuple)。
   *
   * 模型权威批次 §5 阶段 B:bridge 拿它去读**该 rev 的** seed 声明推导 seed agent 计费模型。
   * 正因为需要它,`loadAgentModelResolver` 的调用必须排在 `resolveContainerEndpoint` **之后**
   * —— 否则 master 会用 current 声明给跑旧 seed 的容器计费(滚动窗口分叉)。
   *
   * 缺失(bundle 轴未启用 / 旧容器 / 测试 mock)→ flag `OC_SEED_AUTHORITY_BY_REV` 未开时无害;
   * flag 开启时 resolver loader 抛 SeedDeclarationError → 桥 close(1011) fail-closed。
   */
  bundleRev?: string;
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

// ---------- 模型执行权威(方案 §2 / §7 步 4)---------------------------------

/**
 * bridge 侧的模型权威签发装配(docs/V5_MODEL_AUTHORITY_PLAN.md)。
 *
 * **注入即开启**(index.ts 只在 flag `OC_MODEL_AUTHORITY=1` 时构造并注入):
 *   - 未注入 → bridge 完全走旧路径(不签发、不注入、不做 attestation 门),零行为变化;
 *   - 注入   → ①每条连接要求容器 attest `model_authority_v1`(未 attest 前缓冲用户帧,
 *              有界 + 超时;超时/不支持 → 拒连接 + 触发 stale recycle);
 *              ②每条 forward 的 inbound.message 先 strip 客户端同名字段,再注入
 *              master 签名的 `__oc_model_authority`;
 *              ③codex 计费链的 isCodex 判定改用 **descriptor.engine**(与签发同源,
 *              不再是 baked 的 gpt-* 前缀集合)。
 *
 * fail-closed 边界:catalog 快照 unknown / epoch fence 失败 / 模型不可路由 → **拒帧**,
 * 绝不「降级为不带 envelope 转发」—— 那会让容器回落 baked 判定,而 master 这边可能已按
 * 另一套语义预扣,正是本批次要消灭的计费/执行分裂。
 */
export interface BridgeModelAuthorityDeps {
  /** master 独占私钥的签发器(公钥 keyring 由 supervisor 注入容器 env)。 */
  signer: AuthoritySigner;
  /** ModelExecutionCatalog 快照缓存(epoch fence 的执行体)。 */
  catalog: ModelCatalogCache;
  /**
   * 容器不支持 attestation(旧 release / 旧 env)→ 触发 stale recycle,让用户下次连接
   * 拿到带 keyring 的新容器。未注入 → 只拒连接不 recycle(测试/降级)。
   */
  recycleContainer?: (containerId: number, reason: string) => void;
  /** 等待容器 attestation 的上限(默认 10s)。 */
  attestTimeoutMs?: number;
  /**
   * **签发边界的 epoch 直读**(代码审 R1 MAJOR-2)。默认 = billing/modelCatalog
   * `readSecurityEpoch()`(单行 SELECT,无时间缓存,与 fence 同一权威源)。
   *
   * 为什么签发边界要**再读一次**:`resolveTurnExecution` 的 fence 发生在 turn 起手,
   * 但从那里走到"签票"之间还隔着 route / acquire / preCheck / journal / 历史消息装配
   * 好几个 await —— 安全写(disable 模型 / 撤销授权 / 改价 / bump epoch)完全可能落在
   * 这中间。只在早期 fence 一次,等于用一个**已经过时的快照**签出一张长命票据
   * (lease TTL = 50min),把"安全变更立刻生效"的承诺打穿。
   *
   * 测试注入用。
   */
  readSecurityEpoch?: () => Promise<bigint>;
  /**
   * keyring 覆盖普查(R3-M7 轮换步骤② 的 gate)。缺省 = 进程级单例
   * `ws/authorityKeyCensus.authorityKeyCensus`。测试注入以隔离。
   */
  census?: AuthorityKeyCensus;
}

/**
 * 0049 grants checker 的连接级 handle(**epoch 联动版**,代码审 R1 BLOCKER-1)。
 *
 * 旧形态的洞:checker 每 GRANTS_REFRESH_INTERVAL_MS(30s)刷一次,**刷新失败永久保留旧
 * checker**。撤销授权后:
 *   - CCB 有 egress 的每请求授权兜底(proxy 里重查 role+grants);
 *   - **codex 根本不经 /v1/messages egress** → 唯一的授权闸就是本 checker。
 * 于是「撤权 → 30s 窗口(或 DB 抖动时的**无限**窗口)内旧连接照签票、照执行」。
 *
 * 修法(与 catalog 同一条 fence 语义):
 *   - grants 快照带 **epoch 戳**(= 读 grants 之前观察到的 DB security epoch 的下界);
 *   - 0144 起任何 grant 写(含 DELETE)都 bump epoch;
 *   - 每个 turn 在 catalog epoch fence **之后**比对:checker.epoch < 权威 epoch → 说明
 *     期间发生过安全写(可能就是撤权)→ `reloadAtLeast(权威 epoch)` 同步重载并**重新判定**;
 *   - 重载失败 / 达不到目标 epoch → **拒帧**(禁止 keep-LKG 放行)。
 *
 * 「放宽」与「收窄」两条路分开:周期 refresh 失败仍 keep-LKG(新授权晚点生效可以忍),
 * 收窄面(reloadAtLeast)一律 fail-closed。
 */
export interface ModelCheckerHandle {
  /** 已绑定本连接 uid+DB role+grants+fenced visibility 的 sync 判定闭包。 */
  isAllowed: (modelId: string) => boolean;
  /** 当前 grants 快照的 epoch 下界(0 = 尚未观察到任何 epoch,视作最陈旧)。 */
  epoch: () => bigint;
  /** 周期刷新(放宽面):失败保留上次成功快照,不抛。 */
  refresh: () => Promise<void>;
  /** 严格重载到 ≥ want(收窄面):失败或达不到 → 抛,调用方**必须拒帧**。 */
  reloadAtLeast: (want: bigint) => Promise<void>;
}

/** 容器 attestation 帧 type —— 与 gateway `modelAuthority.CONTAINER_ATTEST_FRAME_TYPE` 同值
 *  (两包不互相 import,parity 由 modelAuthorityBridge.test.ts 锁定)。 */
export const CONTAINER_ATTEST_FRAME_TYPE = "outbound.control.container_attest";

/** 等待容器 attestation 的默认上限。容器 open 后立刻发 attest,10s 已是极宽松的上限。 */
const DEFAULT_ATTEST_TIMEOUT_MS = 10_000;

/**
 * slice1 catalog descriptor → protocol 签名载荷 descriptor(wire 形状)。
 *
 * 两个 `ModelExecutionDescriptor` 是**有意不同**的类型:
 *   - commercial/billing/modelCatalog 的那份是 DB 投影(带 providerId / upstreamModelId
 *     —— **路由**语义,只有 master/egress 需要,容器不该看见上游身份);
 *   - protocol 的那份是**容器执行**语义(capability / context / effort / vision)。
 * 这里做一次显式收窄 = 「凭据与路由不进容器」这条边界在类型层的落点。
 *
 * `contextWindow` 的 null 原样进入签名载荷；0 不是合法窗口，不能拿哨兵值混淆语义。
 */
function toProtocolDescriptor(
  d: import("../billing/modelCatalog.js").ModelExecutionDescriptor,
): ModelExecutionDescriptor {
  const profile = d.capabilityProfile;
  return {
    capabilityProfile: {
      supportsVision: profile.supportsVision,
      reasoning: {
        supported: [...profile.reasoning.supported],
        codexModelDefault: profile.reasoning.codexModelDefault,
      },
      ccb: {
        capabilityZero: profile.ccb.capabilityZero,
        supportsThinking: profile.ccb.supportsThinking,
      },
    },
    capabilitySchemaVersion: d.capabilitySchemaVersion,
    contextWindow: d.contextWindow,
    supportedEfforts: [...profile.reasoning.supported],
    ...(profile.reasoning.codexModelDefault === null
      ? {}
      : { codexDefaultEffort: profile.reasoning.codexModelDefault }),
    supportsVision: profile.supportsVision,
  };
}

/** 一个 turn 的执行解析结果(epoch fence 已过 → 可以签)。 */
interface ResolvedTurnExecution {
  canonicalModel: string;
  engine: ModelAuthorityEngine;
  descriptor: ModelExecutionDescriptor;
  /** 与 descriptor / epoch 来自同一个 fenced snapshot generation 的原始模型价格。 */
  pricing: ModelPricing;
  /** 只进 journal/audit，不对容器暴露。 */
  billingRevision: string;
  /** 该 turn 的平台次级模型放行集(见 billing/modelCatalog.ts platformAuxModels)。 */
  auxModels: string[];
  executionRevision: string;
  securityEpoch: number;
}

/** 模型不可路由(catalog 无 active 行 / 无价 / capability schema 未来版本)。 */
class ModelNotAvailableError extends Error {
  constructor(readonly modelId: string) {
    super(`model not available: ${modelId}`);
    this.name = "ModelNotAvailableError";
  }
}

/**
 * epoch fence + 解析执行 descriptor(方案 §1.2 R3-B2:签发 authority **之前**必须 fence)。
 *
 * `catalog.assertFresh()` 语义:快照 epoch 与 DB 单行 epoch 比对(**无时间缓存**),
 * 不等 → 同步重建;重建失败 / DB 不可达 → 抛 → 调用方拒帧(fail-closed)。
 */
async function resolveTurnExecution(
  catalog: ModelCatalogCache,
  modelIdOrAlias: string,
): Promise<ResolvedTurnExecution> {
  const snapshot: ModelCatalogSnapshot = await catalog.assertFresh();
  const canonicalModel = snapshot.aliasToCanonical(modelIdOrAlias);
  const descriptor = snapshot.resolve(canonicalModel);
  const pricing = snapshot.billingPricingFor(canonicalModel);
  if (descriptor === null || pricing === null) throw new ModelNotAvailableError(modelIdOrAlias);
  return {
    canonicalModel: descriptor.canonicalModel,
    engine: descriptor.engine,
    descriptor: toProtocolDescriptor(descriptor),
    pricing,
    billingRevision: snapshot.billingRevision,
    // 次级模型只对 **ccb** 引擎有意义:CCB 的 WebFetch/WebSearch 等隐藏调用读
    // ANTHROPIC_SMALL_FAST_MODEL 打 anthropic proxy;codex turn 走 /internal/v3/codex-relay,
    // 根本不产生 `/v1/messages` —— 给它签 aux 只会白白撑大放行集合(最小权限)。
    // platformAuxModels 对"aux 不在 catalog active"fail-closed 抛 → 调用方拒帧。
    auxModels: descriptor.engine === "ccb" ? platformAuxModels(snapshot) : [],
    executionRevision: snapshot.executionRevision,
    securityEpoch: Number(snapshot.securityEpoch),
  };
}

/**
 * journal 中的 server-owned 精确定价。BigInt 显式转十进制串，确保 JSON 可序列化；这里
 * 持久化的是已复合 agent multiplier 的最终价格，所以跨 bridge 恢复时不能再查当前
 * PricingCache / agent override（两者都可能已换 generation）。
 */
interface PersistedBillingPricingV1 {
  v: 1;
  modelId: string;
  displayName: string;
  inputPerMtok: string;
  outputPerMtok: string;
  cacheReadPerMtok: string;
  cacheWritePerMtok: string;
  multiplier: string;
}

function serializeBillingPricing(pricing: ModelPricing): PersistedBillingPricingV1 {
  return {
    v: 1,
    modelId: pricing.model_id,
    displayName: pricing.display_name,
    inputPerMtok: pricing.input_per_mtok.toString(),
    outputPerMtok: pricing.output_per_mtok.toString(),
    cacheReadPerMtok: pricing.cache_read_per_mtok.toString(),
    cacheWritePerMtok: pricing.cache_write_per_mtok.toString(),
    multiplier: pricing.multiplier,
  };
}

const BILLING_AMOUNT_RE = /^\d+$/;
const BILLING_MULTIPLIER_RE = /^\d+(?:\.\d{1,3})?$/;

/** 严格解析 journal 定价；任何畸形都返回 null，由 authority 恢复路径 fail-closed 免单。 */
function parseBillingPricing(raw: unknown, expectedModel: string): ModelPricing | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (
    p.v !== 1 ||
    p.modelId !== expectedModel ||
    typeof p.displayName !== "string" ||
    typeof p.inputPerMtok !== "string" || !BILLING_AMOUNT_RE.test(p.inputPerMtok) ||
    typeof p.outputPerMtok !== "string" || !BILLING_AMOUNT_RE.test(p.outputPerMtok) ||
    typeof p.cacheReadPerMtok !== "string" || !BILLING_AMOUNT_RE.test(p.cacheReadPerMtok) ||
    typeof p.cacheWritePerMtok !== "string" || !BILLING_AMOUNT_RE.test(p.cacheWritePerMtok) ||
    typeof p.multiplier !== "string" || !BILLING_MULTIPLIER_RE.test(p.multiplier)
  ) {
    return null;
  }
  return {
    model_id: expectedModel,
    display_name: p.displayName,
    input_per_mtok: BigInt(p.inputPerMtok),
    output_per_mtok: BigInt(p.outputPerMtok),
    cache_read_per_mtok: BigInt(p.cacheReadPerMtok),
    cache_write_per_mtok: BigInt(p.cacheWritePerMtok),
    multiplier: p.multiplier,
    enabled: true,
    sort_order: 0,
    visibility: "hidden",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(0),
  };
}

// ---------- Deps + Handler --------------------------------------------------

export interface UserChatBridgeDeps {
  jwtSecret: string | Uint8Array;
  /**
   * 模型执行权威签发(方案 §2)。注入即开启 flag —— 见 BridgeModelAuthorityDeps。
   * 缺省(v3 / 测试 / flag 未开)→ bridge 行为与本批次之前**完全一致**。
   */
  modelAuthority?: BridgeModelAuthorityDeps;
  /** 解析 uid → 容器 host/port。Phase 3D 接 supervisor.ensureRunning;Phase 2 单测自行 mock。 */
  resolveContainerEndpoint: ResolveContainerEndpoint;
  /**
   * 版本握手(v5 spa):返回当前 dist 前端构建 id(index.html `<meta name="oc-build">`,
   * 见 ws/frontendBuild.ts probe)。注入后 bridge 在每个 userWs accept 时发一帧
   * `{type:"sys.frontend_build", build}` —— 客户端 reload governor 据此在安全点软刷新,
   * 收敛"长驻旧 bundle 撞新服务端语义"(2026-07-07 CODEX_BILLING_GUARD 旧前端复发事故)。
   * 未注入(v3 / 测试)或返回 null → 不发帧,零行为变化。
   */
  getFrontendBuildId?: () => string | null;
  /**
   * V5 自愈体系(RFC-v5-selfheal-ops §5)— 当前活跃事故快照 provider。
   * 注入后 bridge 在**每个 userWs 完成 JWT + 封号复核 + WS 注册之后**(不在 pre-auth
   * 的 sys.frontend_build 处,否则向未认证连接泄漏事故)对新连接逐条补发 `sys.incident`
   * open 帧,让刚上线的前端立即看到已存在的横幅。
   *
   * 返回的每一项即一枚完整 `sys.incident` 帧(含 type/status:'open'/rev/ts…),bridge 直接
   * `JSON.stringify` 发出。快照经此 provider 闭包获取(与 getFrontendBuildId 同注入范式),
   * **不让 bridge 直连 PG**:集成者在 index.ts 从 selfheal sweeper 的内存快照 forward-ref
   * 装配。未注入(v3 / 测试)→ 不补发,零行为变化。
   */
  /** Returns the active incidents VISIBLE TO this uid (audience-filtered), for
   *  post-auth backfill. Must never return another user's targeted incident
   *  (Codex B2) — the provider filters by recipient. */
  incidentSnapshotProvider?: (uid: string) => SysIncident[];
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
   * caller(commercial/index.ts)在 bridge 启动连接时加载 checker，拿到一个**已绑定
   * uid+DB role+grants+catalog visibility**的纯同步 closure;后续每条 user→container
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
    /** checker 必须至少绑定到该 security epoch；未启模型权威时为 undefined。 */
    requiredEpoch?: bigint,
  ) => Promise<(modelId: string) => boolean>;
  /**
   * P0 计费旁路封堵(bridge 可信模型推导)—— master 侧 agent 权威:
   * 「该 uid 语境下 agentId 的有效模型」的 sync 快照 closure。
   *
   * 为什么需要:M1a 起容器 gateway 的 engine 判定按 model(resolveEngine),
   * 帧不带 model 时回落 **agent.model**。bridge 若只信 frame.model /
   * agentId==='codex' / lastSeenModelId,则「agent.model=gpt-5.5 + 帧无 model」
   * 的 turn 会被 bridge 当非 codex 透传 —— 不 preCheck、不开 inflight journal、
   * 不注 server-owned requestId → 免费 codex。bridge 必须用 master 自己的
   * agent 权威推导有效模型参与 codex 分类,推导不出且帧无 model → fail-closed
   * 拒帧(不放行)。
   *
   * caller(commercial/index.ts)的权威组成(与容器 agents.yaml 的 master 侧
   * 权威源一一对应):
   *   - 内置 seed agents:main → PLATFORM_DEFAULT_MODEL、codex → gpt-5.5、
   *     hidden-reviewer → PLATFORM_HIDDEN_REVIEWER_MODEL(entrypoint
   *     desiredSeedAgents 的 master 侧镜像);
   *   - marketplace 平台预设 + 用户已装 agent:manifest.model
   *     (internalMarketplaceSync 同源:listPlatformPresetAgents ∪
   *     listActiveInstalledAgents,同 slug 预设优先)。
   * 容器侧用户手改 agents.yaml 的 agent 不在权威内 → 推导失败 → 拒
   * (gateway seam 的 requestId fail-closed guard 是同问题的容器侧兜底)。
   *
   * 生命周期(**模型权威批次 §5 阶段 B 重排**):**必须在 `resolveContainerEndpoint`
   * 之后**加载 —— seed agent 的执行三元组权威 = 该容器实际跑的 bundle rev 的 seed 声明,
   * 而 rev 只有 ensureRunning 返回容器 label 之后才知道。载入失败(含 seed 声明读不出的
   * SeedDeclarationError)→ 桥关 1011,**不静默放行、不回落 master 常量**(回落 = 滚动窗口
   * 里 master 按 current 声明计费、容器按旧 seed 执行的分叉重现)。
   *
   * 桥 lifetime 内随 GRANTS_REFRESH_INTERVAL_MS 周期刷新(新装 agent 在窗口内生效;推导 miss
   * 时也会即时补触发一次 refresh,用户重发即可)。**refresh 复用同一 `bundleRev`**:容器在连接
   * 存续期内不变(被 recycle → 桥断 → 新连接重取 label);refresh 失败保留上次快照。
   *
   * 未注入(测试 / 旧装配)→ 桥不做推导,行为与本字段加入前一致。
   */
  loadAgentModelResolver?: (
    uid: bigint,
    opts: {
      /** 容器 label 上的 platform bundle rev(见 ResolveContainerEndpoint.bundleRev)。 */
      bundleRev?: string;
    },
  ) => Promise<(agentId: string) => string | null>;
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
   *   - `release(account_id, slotId)` 必须用 acquire 时记录的 (account_id, slotId)(决策 N2
   *     MAJOR 3:不重读 row,防 lazy migrate 漂移;slotId 精确还槽,不误伤同账号其它在途槽)
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
  }) => Promise<CodexRouteDecision | null>;
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
   * settle 路径用法(M2 v5 形态):bridge 用 deps.pgPool 写 journal、用
   * deps.preCheckRedis 跑 preCheckWithCost、用 deps.pricing.get(modelId) 拿
   * ModelPricing 复合 agent multiplier;settle 收口在 billing/codexFinalizer
   * (settleUsageAndLedger → spendTwoBucket 双钱包,零输出免单,account_id NULL,
   * session_id = billing 帧 engineSessionId)。
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
    sessionId?: string | null,
    parentSessionId?: string | null,
    delegateAgentId?: string | null,
    turnKey?: string | null,
    parentTurnKey?: string | null,
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
  /** 成功返回 {account_id, slotId};legacy NULL 容器返 null。slotId 为 per-slot 租约 id。 */
  acquire(containerId: number, groupId?: string | null): Promise<{ account_id: bigint; slotId: string } | null>;
  /** 必须用 acquire 时记录的 (account_id, slotId) 成对还槽(精确 + reaper 兜底)。 */
  release(account_id: bigint, slotId: string): void;
}

export interface CodexApiRelayRoute {
  kind?: "api_relay";
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

export interface CodexOfficialOAuthRoute {
  kind: "official_oauth";
  groupId: string;
}

export interface CodexRouteUnavailable {
  kind: "unavailable";
  reason: string;
}

export type CodexRouteDecision = CodexApiRelayRoute | CodexOfficialOAuthRoute | CodexRouteUnavailable;

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
 *   - 容器内 gateway 把 frame 路由给 agentId='codex' 那个 agent → CodexAdapter
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
  codex: DEFAULT_CODEX_ENGINE_MODEL,
};

// Hidden system agents are callable by trusted in-container delegation only.
// User-facing WebSocket frames must never be allowed to select them directly.
const HIDDEN_REVIEWER_AGENT_ID = "hidden-reviewer";

/**
 * PR2 v1.0.66 — codex 真扣费 preCheck 估算用的 max output tokens。
 *
 * codex inbound 帧不带 max_tokens 字段(由 codex app-server 内部决定),master 估
 * preCheck 上限只能拍脑袋。64K 是 codex app-server 默认 max output tokens
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
 *
 * M2:改为 env `DRAIN_BILLING_MS` 可覆盖(读时求值;测试用短窗口验证 timeout
 * 路径,生产不设置 → 5s。旧版模块级常量导致 1167 行测试套只能真等 5s)。
 */
const DEFAULT_DRAIN_BILLING_MS = 5_000;
function readDrainBillingMs(): number {
  const raw = process.env.DRAIN_BILLING_MS;
  if (!raw) return DEFAULT_DRAIN_BILLING_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 50 ? n : DEFAULT_DRAIN_BILLING_MS;
}

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
 * PR2 v1.0.66 → M2 — bridge 持有的 codex inflight turn 快照。
 *
 * 关键:settle 时**只信本快照**,不信 outbound.codex_billing 帧的 model/agentId
 * 字段(防容器侧伪造改账)。frame 承载 usage 统计 + requestId 关联键 +
 * engineSessionId 记账键。
 *
 * M2 变化:finalizer **延迟到 billing 帧到达时构造** —— usage_records.session_id
 * 的权威值 = 帧上的 engineSessionId(gateway 唯一 helper engineSessionId(sessionKey)
 * 产物,与 idle-timeout waive 上报同值,方案红线)。inbound 时 bridge 不可靠知道
 * gateway 侧 sessionKey(agent 路由可改写),自行派生会破坏 settle=waive 同值
 * 不变量,故不在 inbound 期构造。
 */
interface CodexTurnSnapshot {
  /** server-owned 32-hex id;Map key 与本字段同值,仅冗余便于日志。 */
  requestId: string;
  /** preCheck 时取的 model id(audit / log)。 */
  model: string;
  /** Issue A v1.0.108 — billing 帧的 codex_billing 分支需要根据账号 id 把
   *  rateLimits 落到 claude_accounts.quota_*(maybeUpdateAccountQuotaCodex)。
   *  bigint 0n = legacy / api_relay 无关联账号(quota writer 内部跳过)。 */
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
  /** 计费留证；flag 未开的 legacy/shadow turn 为 null。 */
  authority: import("../billing/proxyBilling.js").BillingAuthorityStamp | null;
  authorityTurnId: string | null;
  /**
   * M2 — 首次调用用 billing 帧的 engineSessionId 构造 codexFinalizer 并 memoize
   * (同 handle 复用 → _done 幂等语义与旧"构造期单 finalizer"完全一致)。
   * 已走过 abandon() → 返 null(belt-and-braces:Map.delete 纪律下不可达,
   * 防未来改动引入 abandon 后再 settle 的错账路径)。
   */
  getFinalizer(engineSessionId: string): CodexFinalizeHandle | null;
  /**
   * M2 — 不扣费收尾:billing 帧缺失/engineSessionId 口径非法(fail-closed 免单)
   * 或 cleanup fail-abort(drain 超时 / bridge 断)路径。
   * 语义 = codexFinalizer.fail:abort inflight journal + release preCheck
   * reservation;若 finalizer 已构造则直接委托其 fail(fail-after-commit 由
   * _done 守门 no-op)。幂等。
   */
  abandon(reason: string): Promise<void>;
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
  /**
   * V5 自愈体系(RFC-v5-selfheal-ops §5)— 全站广播:给**所有**在线用户的每个 OPEN
   * user WS 发一帧 JSON payload(遍历 uidToUserWs)。selfheal sweeper 用它推 audience=all
   * 的 `sys.incident`。返回实际发送成功的连接数。非 JSON-serializable 输入吞异常返 0,不抛。
   */
  broadcastAll(payload: unknown): number;
  /**
   * V5 自愈体系(RFC-v5-selfheal-ops §5)— 定向广播:只给 uids 集合中在线用户的 OPEN
   * user WS 发 payload(audience=user_ids / surface_cohort)。uid 以字符串给出(uidToUserWs
   * 的 key 口径)。返回实际发送成功的连接数。非 JSON-serializable 输入吞异常返 0,不抛。
   */
  broadcastToUsers(uids: string[], payload: unknown): number;
  /** Return only requested users that currently own at least one OPEN user websocket. */
  onlineUserSubset(uids: string[]): string[];
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
      // 版本握手:accept 即发当前前端构建 id(auth 之前——build id 本就公开,任何人
      // GET / 都能看到 meta;放在 auth 前保证"拿着过期 token 的旧前端"也能收到并自救,
      // 401 重试环里的旧客户端正是最需要刷新的那批)。失败/未注入 → 静默跳过,
      // 版本握手是 best-effort 自愈通道,绝不影响桥主链路。
      try {
        const feBuild = deps.getFrontendBuildId?.();
        if (feBuild) ws.send(JSON.stringify({ type: "sys.frontend_build", build: feBuild }));
      } catch { /* best-effort */ }
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

        // 1.35) 封号即时生效:WS 建连时复核 users.status(每连接一次,非每 turn,低成本)。
        //   封号后持有效 access token(≤15min)仍能建新桥聊天/扣费是历史缺口;admin patchUser
        //   封号已同步撤 refresh(≤15min 后自愈),此处再堵住"建连"这条最直接的花钱入口。
        //   deps.pgPool 未注入(测试/个人版)→ 跳过(行为与本检查加入前一致)。
        //   status 查询失败(DB 抖动)→ fail-open 放行 + 告警:封号非实时安全闸(refresh 撤销
        //   已是主机制),不为一次 DB 故障把全体用户锁在门外(可用性优先,与 model-authz 的
        //   fail-closed 取舍不同——那是防 hidden model 数据/成本泄漏,权重更高)。
        if (deps.pgPool) {
          try {
            const st = await deps.pgPool.query<{ status: string }>(
              "SELECT status FROM users WHERE id = $1",
              [uid.toString()],
            );
            const status = st.rows[0]?.status;
            if (status !== undefined && status !== "active") {
              log?.info("user-chat-bridge: rejected non-active user", { uid: uid.toString(), status });
              sendErrorFrame(ws, "FORBIDDEN", "account is not active");
              try { ws.close(CLOSE_BRIDGE.POLICY, "account inactive"); } catch { /* */ }
              return;
            }
          } catch (err) {
            log?.warn("user-chat-bridge: user status check failed (fail-open)", {
              uid: uid.toString(), err: (err as Error).message,
            });
          }
        }

        // 1.4) 0049 模型授权 checker —— 在 ensureRunning 之前拉一次 grants。
        //   - load 失败 throw → close(1011)。grants DB 故障期间不做"放行"假设,
        //     不然付费用户能在故障窗口里调到任何 hidden model。
        //   - 测试 / 个人版上下文未注入 deps.loadAllowedModelChecker → handle=null,
        //     桥行为与本字段加入前完全一致(无校验,纯透传)。
        //   - 桥每 GRANTS_REFRESH_INTERVAL_MS ms 重新加载一次,使 admin 取消授权能
        //     在窗口内对**已开 ws 连接**生效(plan v3 review v1 §F4 follow-up)。
        //     refresh 失败保留上次 checker(**放宽面**的可用性取舍)。
        //   - **epoch 联动(0144 / 代码审 R1 BLOCKER-1)**:周期刷新 + keep-LKG 对
        //     「撤权」是不够的 —— 见 ModelCheckerHandle 头注。
        let modelCheckerHandle: ModelCheckerHandle | null = null;
        if (deps.loadAllowedModelChecker) {
          const loader = deps.loadAllowedModelChecker;

          // grants 快照的 epoch 戳 = **读 grants 之前**观察到的 DB epoch 的保守下界。
          //   · catalog 快照 epoch ≤ DB epoch(单调、只会落后)→ 用它盖戳只会盖低,不会盖高;
          //   · 盖低 = 多做一次重载(安全方向);盖高 = 撤权被永久漏掉(BLOCKER-1 的形态)。
          // 所以取戳**必须发生在 loader() 之前**,绝不能读完 grants 再补一个"当前 epoch"。
          const observeEpoch = (): bigint =>
            deps.modelAuthority?.catalog.peek()?.securityEpoch ?? 0n;

          let inner: (modelId: string) => boolean = () => false; // 载入成功前一律不放行
          let checkerEpoch = 0n;
          const applyLoad = (stamp: bigint, next: (modelId: string) => boolean): void => {
            // 迟到的旧班车(stamp 更小)不得把新快照换回旧的。
            if (stamp < checkerEpoch) return;
            inner = next;
            checkerEpoch = stamp;
          };
          let loadInflight: { minEpoch: bigint; p: Promise<void> } | null = null;
          const startLoad = (minEpoch: bigint): Promise<void> => {
            const entry: { minEpoch: bigint; p: Promise<void> } = { minEpoch, p: Promise.resolve() };
            entry.p = (async () => {
              const next = await loader(uid, minEpoch === 0n ? undefined : minEpoch);
              applyLoad(minEpoch, next);
            })().finally(() => {
              if (loadInflight === entry) loadInflight = null;
            });
            loadInflight = entry;
            return entry.p;
          };

          try {
            await startLoad(observeEpoch());
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
            epoch: () => checkerEpoch,
            refresh: async () => {
              try {
                await startLoad(observeEpoch());
              } catch (err) {
                // 不切 inner —— 保留上次成功 checker。详见 GRANTS_REFRESH_INTERVAL_MS 注释。
                // (这是**放宽面**的兜底:新授权晚 30s 生效可以忍;**收窄面**由
                //  reloadAtLeast 的 fail-closed 路径接管,不共用这条 keep-LKG。)
                log?.warn("user-chat-bridge: modelChecker refresh failed (keep last good)", {
                  uid: uid.toString(),
                  err,
                });
              }
            },
            reloadAtLeast: async (want) => {
              if (checkerEpoch >= want) return;
              // 只搭「启动时刻已观察到 epoch ≥ want」的车 —— 更早启动的那班可能读的是
              // 撤权之前的 grants,搭上去等于把撤权漏掉。否则自己开一班(grants 是一条
              // 轻 SELECT,多几班的代价远低于把安全结论押在别人的时序上)。
              const cur = loadInflight;
              await (cur !== null && cur.minEpoch >= want ? cur.p : startLoad(want));
              if (checkerEpoch < want) {
                throw new Error(
                  `grants snapshot did not reach epoch ${want} (at ${checkerEpoch})`,
                );
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

        // 2b) P0 计费旁路封堵 —— agent→model 权威快照(bridge 可信模型推导)。
        //
        //   **顺序是硬约束(模型权威批次 §5 阶段 B / 设计审 R2-B3)**:本块必须排在
        //   `resolveContainerEndpoint`(= ensureRunning)**之后** —— seed agent
        //   (main/codex/hidden-reviewer)的执行三元组权威是「该容器实际跑的那个 bundle rev 的
        //   platform-seed 声明」,而 rev 只有 ensureRunning 返回容器 label(endpoint.bundleRev)
        //   之后才知道。若在之前 load,master 只能用自己的 current 常量/声明 → 滚动窗口里
        //   「master 按新声明计费、旧容器按旧 seed 执行」的**计费分叉**原样复活。
        //
        //   语义/生命周期与 modelCheckerHandle 同构:load 失败 close(1011) 不静默放行
        //   (flag 开启时 SeedDeclarationError 走同一条 catch —— 绝不回落 master 常量);
        //   refresh 失败保留上次快照。未注入 → null(测试 / 旧装配,桥不做推导,行为不变)。
        //
        //   **refresh 复用同一 endpoint.bundleRev**:容器在本连接存续期内不会换 rev
        //   (被 recycle → 桥断)。新容器 = 新连接 = 重新取 label,不存在"连接中途换 rev"。
        const connectionBundleRev = endpoint.bundleRev;
        let agentModelResolverHandle:
          | {
              resolve: (agentId: string) => string | null;
              refresh: () => Promise<void>;
            }
          | null = null;
        if (deps.loadAgentModelResolver) {
          const loadResolver = deps.loadAgentModelResolver;
          const resolverOpts: { bundleRev?: string } = connectionBundleRev !== undefined
            ? { bundleRev: connectionBundleRev }
            : {};
          let innerResolve: (agentId: string) => string | null;
          try {
            innerResolve = await loadResolver(uid, resolverOpts);
          } catch (err) {
            // 含阶段 B 的 SeedDeclarationError(rev 缺失 / bundle 被篡改 / schema 不认):
            // fail-closed 拒连接,不放行到容器(放行 = 按未知声明计费)。
            log?.error("user-chat-bridge: loadAgentModelResolver threw", {
              uid: uid.toString(),
              bundleRev: connectionBundleRev ?? null,
              err,
            });
            sendErrorFrame(ws, "ERR_INTERNAL", "authorization unavailable");
            try { ws.close(CLOSE_BRIDGE.INTERNAL, "authorization unavailable"); } catch { /* */ }
            return;
          }
          // refresh 去重:miss 补触发 + 周期 timer 可能并发,同一时刻只放一个在飞
          // (DB 查询很轻,但没必要放大;后到的直接搭前一班车)。
          // 注意:此处刻意不写 `finally { }` 块 —— userChatBridge.test.ts 的
          // tryAutoRebindFlush 源码 tripwire 以「文件内第一个 `finally {`」定位
          // 目标块,在它之前新增 finally 块会让 tripwire 锚错。.finally() 等价。
          let refreshInflight: Promise<void> | null = null;
          agentModelResolverHandle = {
            resolve: (agentId) => innerResolve(agentId),
            refresh: async () => {
              if (refreshInflight !== null) return refreshInflight;
              refreshInflight = (async () => {
                try {
                  // 同一 bundleRev:连接存续期内容器不变 ⇒ seed 声明不变(LRU 命中,零 IO)。
                  const next = await loadResolver(uid, resolverOpts);
                  innerResolve = next;
                } catch (err) {
                  // 保留上次成功快照(与 modelChecker.refresh 同语义)。
                  log?.warn("user-chat-bridge: agentModelResolver refresh failed (keep last good)", {
                    uid: uid.toString(),
                    err,
                  });
                }
              })().finally(() => {
                refreshInflight = null;
              });
              return refreshInflight;
            },
          };
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
          agentModelResolverHandle,
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
     * caller 显式不要鉴权)。语义见 `ModelCheckerHandle`(含 R1 BLOCKER-1 的 epoch 联动)。
     *
     * onUserMessage 每条 inbound.message 帧 sync 调一次 isAllowed,且追踪
     * lastSeenModelId 让没带 model 字段的后续帧也参与校验(plan v3 review v1
     * follow-up:防"已用 gpt-5.5 跑起来的桥被撤销后无 model 字段帧透传");
     * 权威开启时,每 turn 还会在 catalog epoch fence 之后跑一次 grants epoch fence
     * (resolveAuthorityExecOrReject 尾部)。
     */
    modelCheckerHandle: ModelCheckerHandle | null,
    /**
     * P0 计费旁路封堵 —— master 侧 agent→model 权威快照 handle(bridge 可信模型
     * 推导;null = deps 未注入,桥不做推导,行为与字段加入前一致)。
     *   - `resolve(agentId)`:已绑定本连接 uid 的 sync 快照 closure;null = 权威
     *     推导不出(未知 agentId)
     *   - `refresh()`:重拉快照(周期 timer 与推导 miss 时补触发,幂等去重)
     * onUserMessage 的 inbound.message 分类用它推导「帧无 model 时该 agent 的
     * 有效模型」,与容器 gateway resolveEngine 的判定保持同构。
     */
    agentModelResolverHandle:
      | {
          resolve: (agentId: string) => string | null;
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

    // 客户端存活时间戳(只由 pong / 用户上行消息刷新 —— 真·client liveness)。
    // **不**被下行帧刷新(否则容器持续吐帧会架空下面的硬上限,Codex 审 MEDIUM)。
    let lastAliveAt = Date.now();
    // turn 在飞的心跳放行截止点(绝对时刻)。inbound.message 到达 → now+MAX_TURN_GRACE_MS(硬上限);
    // isFinal 到达 → 收窄到 now+POST_FINAL_GRACE_MS(只缩不延);心跳 now<turnActiveUntil 即放行。
    let turnActiveUntil = 0;

    // ── 模型执行权威:per-connection attestation 门 + 签发(方案 §7 步 4)──────
    //
    // attestation 是**连接级持续门**而非一次性 census(R2-B5):stopped 旧容器复活 /
    // 检查窗口内新建的旧容器 / 早到帧,三类竞态全部由「未 attest 前缓冲、超时即拒 +
    // recycle」覆盖 —— 不靠"部署时数一遍容器"这种会过期的证据。
    const authorityDeps = deps.modelAuthority;
    const authorityOn = authorityDeps !== undefined;
    /** 轮换步骤② 的 keyring 覆盖普查(缺省 = 进程级单例);flag 关 → 不登记。 */
    const authorityCensus =
      authorityDeps !== undefined ? (authorityDeps.census ?? authorityKeyCensus) : null;
    /**
     * **签发边界**的 epoch 直读(MAJOR-2)。默认 = catalog 的单行 SELECT(无时间缓存),
     * 与 turn 起手 fence 用的是同一个权威源 —— 两次读之间的任何安全写都会被这次读看见。
     */
    const readEpochAtSign = authorityDeps?.readSecurityEpoch ?? readSecurityEpoch;
    /** 容器 attest 帧携带的 challenge(gateway 每连接现铸)。签进每份 authority payload。 */
    let containerChallenge: string | null = null;
    /** pending = 缓冲用户帧;ok = 放行;failed = 连接已判死(帧丢弃,close 在飞)。 */
    let attestState: "pending" | "ok" | "failed" = authorityOn ? "pending" : "ok";
    let attestTimer: ReturnType<typeof setTimeout> | null = null;
    const attestQueue: Array<{ data: RawData; isBinary: boolean }> = [];
    let attestQueuedBytes = 0;

    /** 容器不支持 / 不及时 attest → 拒连接 + 触发 stale recycle(下次连接拿到新容器)。 */
    const failAttestation = (reason: string): void => {
      if (attestState === "failed") return;
      attestState = "failed";
      if (attestTimer !== null) {
        clearTimeout(attestTimer);
        attestTimer = null;
      }
      attestQueue.length = 0;
      attestQueuedBytes = 0;
      bridgeLog?.error("user-chat-bridge: model authority attestation failed", {
        reason,
        containerId,
      });
      if (containerId !== undefined && authorityDeps?.recycleContainer !== undefined) {
        try {
          authorityDeps.recycleContainer(containerId, reason);
        } catch (err) {
          bridgeLog?.warn("user-chat-bridge: recycle request failed", { err });
        }
      }
      if (!cleaned && userWs.readyState === WebSocket.OPEN) {
        sendErrorFrame(
          userWs,
          "CONTAINER_OUTDATED",
          "运行环境需要更新,已自动重建,请刷新页面后重发",
        );
        try {
          userWs.close(CLOSE_BRIDGE.ENV_RECYCLED, "model_authority_unsupported");
        } catch { /* */ }
      }
    };

    /** 容器 attest 帧到达(bridge 拦截消费,**绝不**透传给浏览器)。 */
    const onContainerAttest = (frame: Record<string, unknown>): void => {
      if (!authorityOn || attestState !== "pending") return;
      const capsRaw = frame.capabilities;
      const caps = Array.isArray(capsRaw) ? capsRaw : [];
      const challenge =
        typeof frame.connectionChallenge === "string" ? frame.connectionChallenge : "";
      if (!caps.includes(MODEL_AUTHORITY_CAPABILITY) || challenge === "") {
        // 容器广播不出 capability = 它**验不了签**(旧 release 或旧 env 无 keyring)。
        // 放它过去就等于让 master 与容器各判各的 —— 正是本批次要消灭的双信任源。
        failAttestation("model_authority_capability_missing");
        return;
      }
      // ── keyring 自述(R3-M7 轮换步骤②)────────────────────────────────────
      // 容器上报自己 env ring 的 keyId 集合 + 指纹。两个用处:
      //   (a) **立即门**:ring 里没有 master 当前的 activeKeyId → 这条连接上我们签的每
      //       一张票它都验不过(UnknownKey)。与其让用户撞一整轮 403,不如当场判死 +
      //       recycle,让它带新 env 重建 —— 与"capability 缺失"同一类故障,同一种处置。
      //   (b) **census**:全站覆盖统计,给轮换步骤②(切私钥前的 gate)提供证据。
      // 旧容器(本批次之前的 release)不带 keyIds 字段 → keyIdsUnknown,**不**当场判死
      // (它可能 ring 完全正确,只是不会自报),但 census 把它算作"不覆盖",轮换 gate
      // 因此不会误判为可以切钥。
      const keyIdsRaw = frame.keyIds;
      const keyIdsUnknown = !Array.isArray(keyIdsRaw);
      const attestedKeyIds = Array.isArray(keyIdsRaw)
        ? keyIdsRaw.filter((k): k is string => typeof k === "string")
        : [];
      if (!keyIdsUnknown && !attestedKeyIds.includes(authorityDeps!.signer.activeKeyId)) {
        failAttestation("model_authority_active_key_missing");
        return;
      }
      containerChallenge = challenge;
      attestState = "ok";
      if (attestTimer !== null) {
        clearTimeout(attestTimer);
        attestTimer = null;
      }
      authorityCensus?.record(connId, {
        uid: Number(uid),
        containerId: containerId ?? null,
        keyIds: attestedKeyIds,
        fingerprint:
          typeof frame.keyringFingerprint === "string" ? frame.keyringFingerprint : "",
        keyIdsUnknown,
        attestedAt: Date.now(),
      });
      const queued = attestQueue.splice(0, attestQueue.length);
      attestQueuedBytes = 0;
      bridgeLog?.debug("user-chat-bridge: container attested model authority", {
        containerId,
        queuedFrames: queued.length,
        keyIds: attestedKeyIds,
        keyIdsUnknown,
      });
      // 原样重放:缓冲的是**未处理的原始帧**,重放即走完整 onUserMessage 流程
      // (authz / codex 分类 / 计费编排 / 签发注入),不存在"半处理帧"的中间态。
      for (const m of queued) onUserMessage(m.data, m.isBinary);
    };

    /**
     * 签票(纯 crypto,无 I/O)。**唯一调用方 = sealAuthorityFieldsOrReject**——
     * 私有化是有意的:任何绕过它的签发路径都会跳过签发边界的 epoch 重读(MAJOR-2)。
     * containerChallenge / containerId 缺失 = 装配 bug(attest 门已保证它们就位)→ 抛。
     */
    const signAuthorityBundle = (
      exec: ResolvedTurnExecution,
      billingRequestId?: string,
      authorityTurnId?: string,
    ): ModelAuthorityBundle => {
      if (authorityDeps === undefined || containerChallenge === null || containerId === undefined) {
        throw new Error(
          "[model-authority] sign called before attestation (challenge/containerId missing)",
        );
      }
      return authorityDeps.signer.signBundle({
        uid: Number(uid),
        containerId,
        connectionChallenge: containerChallenge,
        canonicalModel: exec.canonicalModel,
        engine: exec.engine,
        executionDescriptor: exec.descriptor,
        auxModels: exec.auxModels,
        executionRevision: exec.executionRevision,
        securityEpoch: exec.securityEpoch,
        ...(authorityTurnId === undefined ? {} : { authorityTurnId }),
        ...(billingRequestId === undefined ? {} : { billingRequestId }),
      }).bundle;
    };

    /**
     * **签发边界**(代码审 R1 MAJOR-2 的整改单点)——「重读 epoch → 一致才签」。
     *
     * 为什么早期 fence 不够:`resolveAuthorityExecOrReject` 的 fence 发生在 turn 起手,
     * 之后还要走 createCodexRoute → acquire → getAgentCostMultiplier → preCheck →
     * startInflightJournal → attachMasterHistoricalMessages 一连串 await(codex 路径实测
     * 可达数十~数百 ms,慢 DB / 大历史时更长)。管理员在这中间禁用模型 / 撤销授权 / 改价
     * 都会 bump epoch,而旧实现会拿**那个已经过时的快照**签出票据 —— 并且 turn lease 的
     * TTL 是 50min。于是"安全变更立刻生效"这条承诺在最要紧的那条路径上被打穿:
     * journal(按旧价开的)照样落、票照样签、容器照样跑。
     *
     * 现在:签之前**直接单行重读 DB epoch**(与 fence 同一权威源,无时间缓存),
     *   - 相等   → 签。此刻之后再发生的安全变更由 egress 的每请求 fence + 容器的 epoch
     *              单调水位接住(方案 §1.2 R3-B2:那是 turn 内后续请求的防线);
     *   - 不等   → **拒帧**(MODEL_CONFIG_CHANGED_RETRY_TURN),
     *   - 读不到(DB 挂)→ **拒帧**(fail-closed;绝不"读不到就当没变")。
     *
     * 拒帧时调用方**必须**跑补偿(`compensate`):这一步之前 codex 路径可能已经开了
     * inflight journal + 占了 preCheck 预扣 + 占了并发槽。留着不管 = 悬空 journal
     * (reconciler 30min 后才终态化)+ 预扣卡 5min + 槽泄漏。补偿路径复用既有的
     * `snap.abandon()`(abort journal + release reservation)与 `releaseAcquiredSlotForFailure()`
     * —— 不新造第二套回滚语义。
     *
     * @returns 注入 frame 的字段(model 归一 + envelope)| null = 已拒帧,调用方立即 return。
     */
    const sealAuthorityFieldsOrReject = async (args: {
      exec: ResolvedTurnExecution;
      billingRequestId?: string;
      authorityTurnId?: string;
      log: Logger | null;
      /** 拒帧时的补偿(abort journal / release preCheck / 还槽);无预扣的路径不传。 */
      compensate?: (reason: string) => Promise<void> | void;
    }): Promise<Record<string, unknown> | null> => {
      const reject = async (code: string, message: string, reason: string): Promise<null> => {
        try {
          await args.compensate?.(reason);
        } catch (err) {
          // 补偿失败不改变"拒帧"这个结论,但必须响亮:悬空 journal 由 reconciler 兜底。
          args.log?.error("user-chat-bridge: authority sign-boundary compensation failed", {
            reason,
            err,
          });
        }
        if (!cleaned && userWs.readyState === WebSocket.OPEN) {
          sendErrorFrame(userWs, code, message);
        }
        return null;
      };

      let dbEpoch: bigint;
      try {
        dbEpoch = await readEpochAtSign();
      } catch (err) {
        args.log?.error("user-chat-bridge: sign-boundary epoch read failed", { err });
        return await reject(
          "MODEL_AUTHORITY_UNAVAILABLE",
          "model catalog unavailable, retry shortly",
          "sign_boundary_epoch_read_failed",
        );
      }
      if (Number(dbEpoch) !== args.exec.securityEpoch) {
        args.log?.warn("user-chat-bridge: security epoch changed before signing — refusing turn", {
          fencedEpoch: args.exec.securityEpoch,
          dbEpoch: dbEpoch.toString(),
          model: args.exec.canonicalModel,
        });
        return await reject(
          "MODEL_CONFIG_CHANGED_RETRY_TURN",
          "model configuration changed, please resend",
          "sign_boundary_epoch_changed",
        );
      }
      // 注意:**不**在这里查 `cleaned`。调用方在 seal 之后紧接着就有自己的 cleaned 分支
      // (带各自完整的补偿),在这里提前 return null 会让"已拒(补偿过)"与"桥关了
      // (还没补偿)"两种 null 语义混在一起 —— 正是漏账最爱的那种歧义。
      return {
        model: args.exec.canonicalModel,
        [MODEL_AUTHORITY_FIELD]: signAuthorityBundle(
          args.exec,
          args.billingRequestId,
          args.authorityTurnId,
        ),
      };
    };

    /**
     * 三条 forward 路径共用的前置:epoch fence → resolve descriptor → 与同步分类对账。
     *
     * @returns exec(可签) | null = **已拒帧**(error 帧已发),调用方必须立即 return。
     *
     * 「与同步分类对账」是必须的:codex/非 codex 的**计费路径**在同步上下文里就已按
     * peek 快照选定(preCheck / journal / 单飞槽都挂在那条路上)。若 fence 后的权威快照
     * 判出另一个 engine,说明 catalog 在这两步之间变了 —— 继续跑就是「按 A 计费、按 B 执行」。
     * 此时返回 MODEL_CONFIG_CHANGED_RETRY_TURN(R3-m12),让前端重开 turn。
     */
    const resolveAuthorityExecOrReject = async (args: {
      model: string | null;
      classifiedCodex: boolean;
      log: Logger | null;
    }): Promise<ResolvedTurnExecution | null> => {
      const reject = (code: string, message: string): null => {
        if (!cleaned && userWs.readyState === WebSocket.OPEN) {
          sendErrorFrame(userWs, code, message);
        }
        return null;
      };
      if (authorityDeps === undefined) return null;
      if (args.model === null) {
        args.log?.info("user-chat-bridge: model authority unresolved model");
        return reject(
          "UNRESOLVED_AGENT_MODEL",
          "cannot resolve execution model for this turn — retry shortly or specify a model",
        );
      }
      let exec: ResolvedTurnExecution;
      try {
        exec = await resolveTurnExecution(authorityDeps.catalog, args.model);
      } catch (err) {
        if (err instanceof ModelNotAvailableError) {
          args.log?.info("user-chat-bridge: model not available", { model: args.model });
          return reject("MODEL_NOT_AVAILABLE", `model not available: ${args.model}`);
        }
        // catalog unknown / epoch fence 重建失败 / DB 不可达 → fail-closed 拒帧。
        // **不降级为"不带 envelope 转发"** —— 那会让容器回落 baked 判定(双信任源)。
        args.log?.error("user-chat-bridge: model authority fence failed", { err });
        return reject("MODEL_AUTHORITY_UNAVAILABLE", "model catalog unavailable, retry shortly");
      }
      if (cleaned) return null;
      const execIsCodex = exec.engine === "codex";
      if (execIsCodex !== args.classifiedCodex) {
        args.log?.warn("user-chat-bridge: engine reclassified mid-turn", {
          model: args.model,
          canonicalModel: exec.canonicalModel,
          engine: exec.engine,
          classifiedCodex: args.classifiedCodex,
        });
        return reject(
          "MODEL_CONFIG_CHANGED_RETRY_TURN",
          "model configuration changed, please resend",
        );
      }

      // ── grants 授权快照的 epoch fence(代码审 R1 BLOCKER-1)────────────────
      // 上面 fence 的是 **catalog**(模型是否可执行);授权(visibility ∨ per-user grants)
      // 是**另一份**快照 —— 连接级 checker,原本只有 30s 周期刷新 + 刷新失败 keep-LKG。
      // 0144 起任何 grant 写(尤其 DELETE = 撤权)都 bump security epoch,于是:
      //   checker.epoch < 权威 epoch  ⟺  自本连接读 grants 之后发生过安全写
      //                                  (可能就是针对本用户的撤权)
      // → 同步重载 grants 并**用新快照重新判定**;重载失败 → 拒帧(**不 keep-LKG 放行**:
      //   codex turn 不经 egress 的每请求授权,这里放行 = 撤权后旧连接仍能签票执行)。
      // 命中 reload 的代价只在「epoch 刚变过」的那一两帧,稳态零额外开销。
      if (modelCheckerHandle !== null) {
        const wantEpoch = BigInt(exec.securityEpoch);
        if (modelCheckerHandle.epoch() < wantEpoch) {
          try {
            await modelCheckerHandle.reloadAtLeast(wantEpoch);
          } catch (err) {
            args.log?.error("user-chat-bridge: grants checker reload failed (fail-closed)", {
              wantEpoch: wantEpoch.toString(),
              err,
            });
            return reject(
              "MODEL_AUTHORITY_UNAVAILABLE",
              "authorization unavailable, retry shortly",
            );
          }
          if (cleaned) return null;
          if (!modelCheckerHandle.isAllowed(exec.canonicalModel)) {
            args.log?.info("user-chat-bridge: model authorization revoked mid-connection", {
              model: exec.canonicalModel,
              epoch: wantEpoch.toString(),
            });
            return reject(
              "UNAUTHORIZED_MODEL",
              `model not authorized for current user: ${exec.canonicalModel}`,
            );
          }
        }
      }
      return exec;
    };

    // plan v3 G5/G7 — codex per-account 并发槽:per-bridge 状态。
    //   acquiredCodexAccountId !== null → 已持槽,新 codex inbound 应被严格单飞拒绝
    //   codexAcquireInflight = true → acquire promise 在飞,新 codex inbound 拒
    //   legacy 容器(codex_account_id IS NULL,决策 N3):acquire() 返回 null,IIFE 内
    //     不占槽但 PR2 v1.0.66 起每轮仍跑 billing → 不再用 sticky 状态跳过 IIFE。
    //   codexReleaseTimer → CODEX_SESSION_MAX_MS 兜底释放(决策 G6),防 outbound 丢/
    //     ws 异常断后槽永久泄漏
    let acquiredCodexAccountId: bigint | null = null;
    // B7 per-slot 租约 id,与 acquiredCodexAccountId 同生死(成对 set/reset)。
    // release 必须传它精确还槽;reaper 兜底"timer 也没跑到"的极端泄漏。
    let acquiredCodexSlotId: string | null = null;
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
    //   inflightCodexTurns: requestId → snapshot (deferred finalizer + model)
    //     - 由 codex acquire IIFE 在成功路径 set
    //     - 由 onContainerMessage 的 outbound.codex_billing 分支**同步先 delete** 再 settle
    //     - 由 finalCleanup 兜底清空(**只清本地簿记,不 abort journal** —— P0 修复
    //       2026-07-03:桥关 ≠ turn 终止,权威裁决收敛 request_finalize_journal,
    //       见 finalCleanup 内注释与 handleCrossBridgeCodexBilling)
    //   drainTimer: user_close + Map 非空时启动的 5s(env DRAIN_BILLING_MS)收尾窗口 timer
    //     - settle 把 Map 减到 0 → checkDrainComplete 提前 finalCleanup
    //     - 超时仍未 settle → finalCleanup(journal 保持 inflight;billing 帧后续到
    //       任意新桥走跨桥 settle,真死则 reconciler 终态化)
    //     - 容器异常 / shutdown / force 抢占 drain → 立即 finalCleanup(见 cleanup 状态机)
    //   drainCause: 进入 drain 时的 trigger cause(稳定保留,避免 mutable cause 干扰)
    //   userDetached: 守 detachUserSide 幂等(drain 入口 + finalCleanup 都跑)
    const inflightCodexTurns = new Map<string, CodexTurnSnapshot>();
    // P0 修复(2026-07-03)— 跨桥 settle 的同步去重簿记:同 requestId 的 duplicate
    // billing 帧在 journal 回查/settle 在途期间直接丢弃(与主路径 Map.delete 先行
    // 的单次门控同构)。跨进程/跨桥并发仍由 journal CAS + usage_records UNIQUE 兜底。
    const pendingJournalSettles = new Set<string>();
    // P0 修复(2026-07-03)— 本桥已进入 settle/abandon 的 requestId 簿记:主路径
    // Map.delete 后,同桥 duplicate 帧会掉进 unknown-turn 分支;没有这本账,它们会
    // 走 journal 回查再撞一次 settle(靠 DB UNIQUE 兜底虽不会重复扣,但多一次无谓
    // settle 尝试 + 依赖时序)。记下后同桥 duplicate 恢复旧语义:同步 info 丢弃。
    // per-connection 生命周期,量级 = 本连接 turn 数,无泄漏。
    const locallySettledCodexTurns = new Set<string>();
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let drainCause: BridgeCloseCause | null = null;
    let userDetached = false;

    // 注册到 registry,超额会踢老的。连接态信号只走 close code,**不发 turn 级 error 帧**
    // (曾经 kick/shutdown 共用"error 帧 + 4505",部署一次=全线会话钉红卡+误报连接数超限;
    // close code 语义拆分后前端按码分流:4505=提示关多余标签页,4509=静默重连+resume 续传)。
    const conn: Conn = {
      id: connId,
      user_id: uid.toString(),
      opened_at: startedAt,
      close: (_reason, cause) => {
        if (cause === "shutdown") {
          try { userWs.close(CLOSE_BRIDGE.SERVER_RESTART, "server_restart"); } catch { /* */ }
        } else {
          try { userWs.close(CLOSE_BRIDGE.TOO_MANY_CONNECTIONS, "too_many_connections"); } catch { /* */ }
        }
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

    // V5 自愈体系(RFC-v5-selfheal-ops §5)— 认证后补发当前活跃事故快照。
    //   安全红线:此处已过 JWT 验证 + 封号复核 + registry.register(WS 注册)——**绝不**能
    //   把补发挪到 pre-auth 的 sys.frontend_build(handleUpgrade 内 :982),那会向未认证连接
    //   泄漏事故内容。快照经注入的 provider 闭包获取(不让 bridge 直连 PG;集成者从 selfheal
    //   sweeper 内存快照 forward-ref 装配),未注入 → 跳过(向后兼容,零行为变化)。
    //   provider 返回的即完整 sys.incident 帧(active 即 status:'open'),逐条直发。
    //   best-effort:provider 抛错 / 单帧 send 失败都只记日志,绝不影响桥主链路。
    if (deps.incidentSnapshotProvider) {
      try {
        // Per-uid: only incidents THIS user may see (audience-filtered), never a
        // global snapshot (Codex B2 — targeted incidents leaked to all).
        const activeIncidents = deps.incidentSnapshotProvider(uid.toString());
        for (const incident of activeIncidents) {
          if (userWs.readyState !== WebSocket.OPEN) break;
          try { userWs.send(JSON.stringify(incident)); }
          catch (err) {
            bridgeLog?.warn("user-chat-bridge: incident backfill send failed", {
              incidentId: incident.incidentId, err,
            });
          }
        }
      } catch (err) {
        bridgeLog?.warn("user-chat-bridge: incidentSnapshotProvider threw", { err });
      }
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
      // ── attestation 门(方案 §7 步 4)────────────────────────────────────────
      // 未 attest 前**缓冲**用户帧 —— 三个选项里只有这个是对的:
      //   - 放行 → 容器可能是旧的(不认 envelope,按 baked 判定跑)= 判定源分裂;
      //   - 丢弃 → 用户的第一条消息静默消失;
      //   - 缓冲 → attest 到达即原样重放(容器 open 后立刻 attest,实际延迟 ~ms)。
      // 有界(maxBufferedBytes)+ 有超时(attestTimeoutMs)—— 缓冲不是无限等待。
      if (authorityOn && attestState !== "ok") {
        if (attestState === "failed") return; // 连接已判死(close 在飞),丢弃
        if (attestQueuedBytes + len > maxBufferedBytes) {
          // 背压=连接态瞬态信号:只走 close code,不发 turn 级 error 帧。
          try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
          cleanup("backpressure", true);
          return;
        }
        attestQueuedBytes += len;
        attestQueue.push({ data, isBinary });
        return;
      }
      let passthroughData: RawData = data;
      let passthroughLen = len;
      // 0049 模型授权(plan v3 §B3/§B4 + review v1/v2 follow-up)+ P0 计费旁路
      // 封堵(agent 权威推导):
      //   inbound.message 帧 sync 检查 visibility OR per-user grants。优先级:
      //     (1) frame.model — 用户/前端显式声明 → 必须有授权
      //     (2) AGENT_AUTHZ_IMPLIED_MODEL[frame.agentId] — agentId 隐含 model
      //         (review v2 finding 1:防 agentId='codex' 不带 model 绕过)
      //     (3) agentModelResolverHandle.resolve(frame.agentId) — master agent
      //         权威推导「该 agent 的有效模型」(P0:帧无 model 时容器回落
      //         agent.model 判 engine,bridge 必须同构分类);带 agentId 但推导
      //         不出且帧无 model → fail-closed 拒帧(不放行、不猜)
      //     (4) lastSeenModelId — 本桥之前出现过的 model(review v1 follow-up:
      //         防"已用 gpt-5.5 跑起来的桥被撤销 grant 后,后续无 model/agentId
      //         的 delta 帧仍能透传"。一旦撤销,继续帧都被拦;仅辅助兜底,
      //         不作 codex 分类的唯一权威)
      //     (5) 全无 → 透传(本桥从没碰过受限 model,默认 claude-* visibility=
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
      // 模型执行权威签发用的 model(= effectiveModel,帧完全无线索时回落默认 agent 的模型)。
      let authorityModelForFrame: string | null = null;
      let isCodexInboundFrame = false;
      let isAnnotatedImageInboundFrame = false;
      // plan v3 G6 早释放(BLOCKER 1):codex inbound 帧的 peer.id,acquire 路径捕获后存
      // codexInboundPeerId,匹配 outbound 终态时用。无 peer.id 即保持 null,降级为 timer 兜底。
      let inboundPeerIdForFrame: string | null = null;
      // PR2 v1.0.66 — 把 codex 计费需要用到的 frame 字段提到外层(下面 IIFE 用):
      //   inboundParsedFrame:rewrite 帧塞 server requestId 时复用,免再次 JSON.parse
      //   inboundAgentIdForFrame:agent_cost_overrides 查 multiplier 时用,缺省回退 'codex'
      let inboundParsedFrame: Record<string, unknown> | null = null;
      let inboundAgentIdForFrame: string | null = null;
      // CG2a — 强制 canonical trace。inbound.message 命中时由 master 生成,后续
      // forwardInboundFrame 读注入到 frame.traceId。其他帧(hello / repo_bind /
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

          // ── 模型执行权威:一切入口的**第一动作** = 无条件 strip 同名字段(方案 §2)──
          // 客户端自带的 `__oc_model_authority` 必须先死,再谈注入。这里 strip 的是
          // **解析后的对象**;下面所有 inbound.message 路径都从它重新序列化转发,
          // 因此原始 raw(带伪造字段)不会被透传。非 inbound.message 的 JSON 帧若带了
          // 该字段,也在此处剥离后重新序列化(passthrough 不再用原 raw)—— 容器侧只在
          // inbound.message 上消费 authority,但"入口无条件 strip"是一条不留缺口的铁律。
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            const parsedObj = parsed as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(parsedObj, MODEL_AUTHORITY_FIELD)) {
              stripModelAuthorityField(parsedObj);
              bridgeLog?.warn("user-chat-bridge: client-supplied model authority field stripped");
              const strippedStr = JSON.stringify(parsedObj);
              passthroughData = Buffer.from(strippedStr, "utf8");
              passthroughLen = Buffer.byteLength(strippedStr);
            }
          }

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
            const visiblePeers = peers.filter((p) => {
              if (typeof p !== "object" || p === null) return true;
              return (p as { agentId?: unknown }).agentId !== HIDDEN_REVIEWER_AGENT_ID;
            });
            if (visiblePeers.length !== peers.length) {
              const sanitizedHello = {
                ...(parsed as Record<string, unknown>),
                peers: visiblePeers,
              };
              const sanitizedStr = JSON.stringify(sanitizedHello);
              passthroughData = Buffer.from(sanitizedStr, "utf8");
              passthroughLen = Buffer.byteLength(sanitizedStr);
              parsed = sanitizedHello;
            }
            const cidStr = containerId.toString();
            const uidStr = uid.toString();
            for (const p of visiblePeers) {
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
              }
              // miss 时【刻意不发 resume_failed】—— replay 的唯一裁决者是容器:
              // hello 会原样转发给容器,其 ring 与 master 生命周期解耦(master 重启
              // 容器不重启),能重放就重放、真不能才由容器发 resume_failed。
              // 旧行为(bridge miss 即抢发)在 master 重启后必然触发:bridge ring
              // 新进程恒空 → 客户端被 resume_failed 打断(游标重置 + REST 快照覆盖
              // 本地流中 partial),容器随后完好的重放反而作废 —— boss 实测:重启时
              // 响应中的消息内容永久丢失,只剩重连后的续帧(2026-07-02)。
              // bridge ring 的定位收敛为「hit 时的近端加速」,不再参与失败裁决;
              // 容器不可达的场景由既有连接超时/relay 断开路径关闭 userWs → 客户端
              // 重连,不会死等。
            }
            // Phase 4 — auto-rebind:记录 hello peers,触发 flush(可能等 fetch 完成)。
            //   双触发设计:hello 端记 peer 集合 → tryAutoRebindFlush;
            //   open 端 fetch 完成 → tryAutoRebindFlush。两边都就绪才真 flush。
            //   Codex Phase 4.7 #2 修:旧实现只在 hello 时同步看 map,fetch 慢于 hello
            //   时 active 选择永不 rebind。
            const helloPeerIds = new Set<string>();
            for (const p of visiblePeers) {
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
            const teamModeRequested = (parsed as { teamMode?: unknown }).teamMode === true;
            if (frameAgentId === HIDDEN_REVIEWER_AGENT_ID) {
              bridgeLog?.info("user-chat-bridge: hidden system agent direct frame rejected", {
                agentId: frameAgentId,
              });
              sendErrorFrame(
                userWs,
                "AGENT_NOT_FOUND",
                "agent not found",
              );
              try { userWs.close(CLOSE_BRIDGE.PRODUCT_POLICY, "hidden_agent_direct_chat"); } catch { /* */ }
              cleanup("client_close", true);
              return;
            }
            const frameAgentAuthorityModel: string | null =
              frameAgentId !== null && agentModelResolverHandle !== null
                ? agentModelResolverHandle.resolve(frameAgentId)
                : null;
            // Gateway 对 unknown explicit agentId 会降级为 default/main。bridge 必须用同
            // 一谓词:团队模式下 unknown agent 也按 main 队长强制 GPT,否则客户端可传
            // agentId="bogus"+model="glm-5.2" 让 master 以 GLM 放行、容器却跑 main。
            // 若测试/旧装配没有 agentModelResolver,bridge 无法证明 explicit non-main
            // agent 真实存在;teamMode 是 main 队长语义,因此也 fail-safe 归一为 main。
            const teamModeNonMainAgentDemotesToMain =
              teamModeRequested &&
              frameAgentId !== null &&
              frameAgentId !== "main" &&
              (agentModelResolverHandle === null || frameAgentAuthorityModel === null);
            const teamModeMain =
              teamModeRequested &&
              (frameAgentId === "main" || frameAgentId === null || teamModeNonMainAgentDemotesToMain);
            const effectiveFrameAgentId = teamModeMain ? "main" : frameAgentId;
            const agentImpliedModel =
              effectiveFrameAgentId !== null ? AGENT_AUTHZ_IMPLIED_MODEL[effectiveFrameAgentId] : undefined;
            // P0 计费旁路封堵 —— master agent 权威推导:帧无 model 时容器 gateway
            // 会回落 agent.model 做 engine 判定(resolveEngine),bridge 必须用
            // master 自己的 agent 权威(seed 常量 + marketplace manifest)推导同一
            // 份「有效模型」,分类才与容器同构。null = 权威推导不出(未知 agentId)。
            const agentAuthorityModel: string | null =
              effectiveFrameAgentId !== null && agentModelResolverHandle !== null
                ? effectiveFrameAgentId === frameAgentId
                  ? frameAgentAuthorityModel
                  : agentModelResolverHandle.resolve(effectiveFrameAgentId)
                : null;

            // 选用顺序:teamMode main 强制 GPT > frame.model > agent 隐含 model
            // (安全 contract)> master agent 权威 > lastSeenModelId(仅辅助:帧连
            // agentId 都没带时的兜底,不作 codex 分类的唯一权威)
            let effectiveModel: string | null = null;
            let source:
              | "frame.model"
              | "agentId.implied"
              | "agentAuthority"
              | "teamMode.main"
              | "lastSeen"
              | null = null;
            if (teamModeMain) {
              // v5 团队模式方案 B:队长固定用 GPT 5.5,隐藏审查员用 GLM。
              // 这里必须在 auth/codex 分类前覆盖 effectiveModel,并在下方 rewrite
              // forwarded frame.model,确保 master 计费链路与容器执行模型一致。
              effectiveModel = DEFAULT_CODEX_ENGINE_MODEL;
              source = "teamMode.main";
            } else if (frameModelId !== null) {
              effectiveModel = frameModelId;
              source = "frame.model";
            } else if (agentImpliedModel !== undefined) {
              effectiveModel = agentImpliedModel;
              source = "agentId.implied";
            } else if (agentAuthorityModel !== null) {
              effectiveModel = agentAuthorityModel;
              source = "agentAuthority";
            } else if (effectiveFrameAgentId !== null && agentModelResolverHandle !== null) {
              // fail-closed:帧无 model + agentId 在 master agent 权威里推导不出。
              // 容器侧会把该 agentId 解析成 agents.yaml 里的某个 agent(未知 id 才
              // 降级 default),其 agent.model 可能是 gpt-5.5 → 免 requestId 落
              // codex(计费旁路)。master 推导不出就不放行 —— 与 UNAUTHORIZED_MODEL
              // 同款拒帧路径。先补触发一次权威快照 refresh(新装 agent 的窗口期
              // miss,用户重发即可命中),再拒本帧。
              void agentModelResolverHandle.refresh();
              bridgeLog?.info("user-chat-bridge: agent model unresolved, frame rejected", {
                agentId: effectiveFrameAgentId,
              });
              sendErrorFrame(
                userWs,
                "UNRESOLVED_AGENT_MODEL",
                `cannot resolve model for agent '${effectiveFrameAgentId}' — retry shortly or specify a model`,
              );
              try { userWs.close(CLOSE_BRIDGE.PRODUCT_POLICY, "unresolved_agent_model"); } catch { /* */ }
              // 策略拒绝 → force final;此前无 codex inflight(本帧才进 acquire 路径),无 drain 价值
              cleanup("client_close", true);
              return;
            } else if (lastSeenModelId !== null) {
              effectiveModel = lastSeenModelId;
              source = "lastSeen";
            }
            // 命中 frame.model / agentId.implied 时把效果 model 记进 lastSeenModelId,
            // 后续无 model/agentId 帧仍可继续校验。lastSeen 命中时不更新(就是它自己);
            // agentAuthority 命中时也不更新 —— 权威快照每帧现算,无需二次缓存,且
            // agent 卸载后不该靠 stale lastSeen 复活。
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
              try { userWs.close(CLOSE_BRIDGE.PRODUCT_POLICY, "unauthorized_model"); } catch { /* */ }
              // 策略拒绝 → force final;此前无 codex inflight(本帧才进 acquire 路径),无 drain 价值
              cleanup("client_close", true);
              return;
            }
            effectiveModelForFrame = effectiveModel;
            // ── 模型执行权威:待签发的 model(方案 §2 步 ②)────────────────────
            // 复用上面既有的 effectiveModel 推导链。它为 null 的唯一场景 = 帧既无
            // model 也无 agentId 且本桥从没见过 model —— 此时容器会落到默认 agent
            // (通常 'main'),故用 master agent 权威解析 'main' 补齐,推不出则由
            // resolveAuthorityExecOrReject fail-closed 拒帧(不猜、不放行)。
            authorityModelForFrame =
              effectiveModel ?? agentModelResolverHandle?.resolve("main") ?? null;
            // codex 判定的**单一权威**:
            //   - flag 开 → catalog 快照的 engine(与签发同源;alias 归一后查 active 行)。
            //     baked 的 gpt-* 前缀集合从此不参与判定 —— 它与 catalog 必然漂移
            //     (catalog 里 engine 迁移 / 新增 codex 系模型,旧镜像的前缀表不认识)。
            //   - flag 关 → 旧的 isCodexEngineModel(零行为变化)。
            // peek() 为 null(快照 unknown)时回落 baked **仅用于选路**:真正的判定发生在
            // IIFE 里的 epoch fence,fence 不过一律拒帧,故错选路不会造成错计费。
            isCodexInboundFrame =
              authorityOn && authorityModelForFrame !== null
                ? (authorityDeps?.catalog.peek()?.isCodexModel(authorityModelForFrame) ??
                   isCodexEngineModel(effectiveModel))
                : isCodexEngineModel(effectiveModel);
            // 提取 peer.id(用于 outbound 终态早释放匹配)。codex 帧才需要;非 codex
            // 帧不影响 acquiredCodexAccountId,捕不捕没用。
            if (isCodexInboundFrame) {
              const peerObj = (parsed as { peer?: { id?: unknown } }).peer;
              const peerIdRaw = peerObj && typeof peerObj === "object" ? peerObj.id : undefined;
              inboundPeerIdForFrame = typeof peerIdRaw === "string" ? peerIdRaw : null;
              // PR2 v1.0.66 — 把 agentId 提到外层供 codex billing IIFE 用
              // (查 agent_cost_overrides multiplier)。
              inboundAgentIdForFrame = effectiveFrameAgentId;
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
            //   - teamMode main 固定 GPT 队长:即使客户端传/省略其它 model 或省略
            //     agentId,转发给容器的 frame.agentId/model 也必须归一为
            //     main/DEFAULT_CODEX_ENGINE_MODEL,否则 master 已按 GPT 预扣/注 requestId,
            //     容器却可能按 main 默认 GLM 或路由规则执行。
            let sanitizedParsed = parsed as Record<string, unknown>;
            const hasClientCodexRoute = Object.prototype.hasOwnProperty.call(
              sanitizedParsed,
              "__oc_codex_route",
            );
            if (
              (rawClientTrace !== undefined && !clientHint.ok) ||
              hasClientCodexRoute ||
              teamModeMain
            ) {
              sanitizedParsed = { ...sanitizedParsed };
              if (rawClientTrace !== undefined && !clientHint.ok) {
                delete sanitizedParsed.clientTraceId;
              }
              if (hasClientCodexRoute) {
                delete sanitizedParsed.__oc_codex_route;
              }
              if (teamModeMain) {
                sanitizedParsed.agentId = "main";
                sanitizedParsed.model = DEFAULT_CODEX_ENGINE_MODEL;
              }
            }
            // Chat-native paper integration: keep browser/session text unchanged,
            // but enrich the master→container frame with a bounded ScanSci PDF
            // usage hint when the user's message is clearly a paper task.
            inboundParsedFrame = appendScanSciPaperIntentHintToFrame(sanitizedParsed);
            isAnnotatedImageInboundFrame = isValidatedAnnotatedImageInbound(inboundParsedFrame);
            // CG2b — turnLog 派生:traceId 钉进 bindings,后续 turn 内 log 自动带上
            turnLogForFrame = bridgeLog?.child({ traceId: turnTraceIdForFrame }) ?? null;
            turnLogForFrame?.info("user-chat-bridge: inbound turn start", clientTraceFields);
            // CG2d — traceId 唯一持久登记(fire-and-forget):UI 底部展示的请求ID就是
            // 这个 traceId,不落库运维就无从定位(usage_records.request_id 是上游 id,
            // 另一套 id 空间)。sessionKey 派生与 hello replay 路径同一约定
            // (gateway server.ts sanitisation verbatim:agent:<aid>:webchat:dm:<safeId>)。
            {
              const peerObj = (parsed as { peer?: { id?: unknown } }).peer;
              const peerIdRaw =
                peerObj && typeof peerObj === "object" ? peerObj.id : undefined;
              const traceSessionKey =
                typeof peerIdRaw === "string" && peerIdRaw !== ""
                  ? `agent:${effectiveFrameAgentId}:webchat:dm:${peerIdRaw.replace(/[^a-zA-Z0-9_-]/g, "_")}`
                  : "(unknown-peer)";
              recordTurnTrace(
                deps.pgPool,
                (msg, fields) => turnLogForFrame?.warn(msg, fields),
                {
                  traceId: turnTraceIdForFrame,
                  userId: uid,
                  sessionKey: traceSessionKey,
                  agentId: effectiveFrameAgentId,
                  model: effectiveModelForFrame,
                },
              );
            }
            // turn 在飞起点:用户已发消息在等响应,心跳在 turn 期间不得 reap(见 MAX_TURN_GRACE_MS 硬上限)。
            turnActiveUntil = Date.now() + MAX_TURN_GRACE_MS;
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
        isAnnotatedImageInboundFrame &&
        containerId !== undefined
      ) {
        const inboundParsedCapture = inboundParsedFrame;
        const turnTraceIdCapture = turnTraceIdForFrame;
        const turnLogCapture = turnLogForFrame;
        const authorityModelCapture = authorityModelForFrame;
        void (async () => {
          if (turnTraceIdCapture === null || inboundParsedCapture === null) {
            bridgeLog?.error("user-chat-bridge: annotated image frame missing trace invariant");
            if (!cleaned && userWs.readyState === WebSocket.OPEN) {
              sendErrorFrame(userWs, "ERR_INTERNAL", "trace invariant violated");
              try { userWs.close(CLOSE_BRIDGE.INTERNAL, "trace invariant"); } catch { /* */ }
            }
            return;
          }
          // 模型执行权威:epoch fence + descriptor(拒帧 → 直接 return,本路径尚无预扣)。
          let authorityExec: ResolvedTurnExecution | null = null;
          if (authorityOn) {
            authorityExec = await resolveAuthorityExecOrReject({
              model: authorityModelCapture,
              classifiedCodex: true,
              log: turnLogCapture,
            });
            if (authorityExec === null) return;
          }
          const enrichedParsed = await attachMasterHistoricalMessages(
            inboundParsedCapture,
            turnLogCapture,
          );
          if (cleaned) return;
          // Image 2 owns its exact 50-credit reservation inside the trusted
          // relay. Do not acquire a chat slot, open a Codex journal, or create
          // a chat Redis reservation for a turn the gateway intentionally
          // completes without starting Codex. The relay resolves the active
          // container binding/account independently.
          const requestId = ensureRequestIdServerSide();
          // 签发边界(MAJOR-2):重读 epoch → 一致才签。本路径的计费在可信 relay 内自持
          // (不开 journal、不占 chat 槽)→ 无需补偿,拒帧的代价是零。
          let authorityFields: Record<string, unknown> = {};
          if (authorityExec !== null) {
            const sealed = await sealAuthorityFieldsOrReject({
              exec: authorityExec,
              billingRequestId: requestId,
              log: turnLogCapture,
            });
            if (sealed === null) return;
            authorityFields = sealed;
          }
          if (cleaned) return;
          const rewrittenObj = {
            ...enrichedParsed,
            requestId,
            traceId: turnTraceIdCapture,
            // 注入签名执行权威 + 把 frame.model 归一为 canonical(容器侧断言
            // descriptor.canonicalModel === frame.model,不一致即拒)。
            ...authorityFields,
          };
          const rewrittenStr = JSON.stringify(rewrittenObj);
          const rewrittenLen = Buffer.byteLength(rewrittenStr);
          if (rewrittenLen > maxFrameBytes) {
            turnLogCapture?.error("user-chat-bridge: rewritten annotated image frame too big", {
              rewrittenLen, max: maxFrameBytes,
            });
            if (!cleaned && userWs.readyState === WebSocket.OPEN) {
              sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG", `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`);
              try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
            }
            return;
          }
          forwardInboundFrame(Buffer.from(rewrittenStr, "utf8"), false, rewrittenLen);
        })();
        return;
      }
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
          if (acquiredCodexAccountId !== null && acquiredCodexSlotId !== null && codexBinding !== undefined) {
            try { codexBinding.release(acquiredCodexAccountId, acquiredCodexSlotId); } catch { /* */ }
            acquiredCodexAccountId = null;
            acquiredCodexSlotId = null;
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
        const authorityModelCapture = authorityModelForFrame;
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
            // ── 模型执行权威:epoch fence + descriptor(方案 §1.2 R3-B2)─────────
            // **必须在 acquire / preCheck / journal 之前**:此刻拒帧的代价是零(没占槽、
            // 没预扣、没开 journal)。放到后面拒 = 要写一堆补偿回滚,而补偿路径正是漏账
            // 的常见来源。fence 失败(catalog unknown / DB 不可达 / 模型不可路由)一律拒。
            let authorityExec: ResolvedTurnExecution | null = null;
            if (authorityOn) {
              authorityExec = await resolveAuthorityExecOrReject({
                model: authorityModelCapture,
                classifiedCodex: true,
                log: turnLogCapture,
              });
              if (authorityExec === null) return;
            }
            let codexRoute: CodexApiRelayRoute | null = null;
            let officialOAuthGroupId: string | null = null;
            if (createCodexRoute !== undefined) {
              if (effectiveModelCapture === null) {
                throw new Error("codex route requested without effective model");
              }
              const decision = await createCodexRoute({
                containerId: cid,
                userId: uid,
                modelId: effectiveModelCapture,
              });
              if (decision !== null) {
                if (decision.kind === "official_oauth") {
                  officialOAuthGroupId = decision.groupId;
                } else if (decision.kind === "unavailable") {
                  throw Object.assign(new Error(decision.reason), { name: "CodexRouteUnavailable" });
                } else {
                  codexRoute = decision;
                  codexApiRelayRouteToken = decision.token;
                }
              }
            }

            let acquired: { account_id: bigint; slotId: string } | null = null;
            if (codexRoute === null) {
              if (codexBinding === undefined) {
                throw Object.assign(new Error("no enabled Codex API relay group"), { name: "CodexRouteUnavailable" });
              }
              acquired = await codexBinding.acquire(cid, officialOAuthGroupId);
              if (officialOAuthGroupId !== null && acquired === null) {
                throw Object.assign(new Error("selected Codex OAuth group unavailable"), { name: "CodexRouteUnavailable" });
              }
            }
            if (cleaned) {
              // bridge 在 acquire/route 创建期间被关 — 立即 release 不留泄漏
              if (codexRoute !== null) {
                expireCodexRouteToken(codexRoute.token, "cleanup_during_route_creation");
              }
              if (acquired !== null && codexBinding !== undefined) {
                try { codexBinding.release(acquired.account_id, acquired.slotId); } catch { /* */ }
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
              // 仍跑(accountIdForQuota=0n 占位)。每轮 turn 都会再走一次 IIFE
              // (acquire() 内部 row 查很轻),持续保持每轮扣费。
            } else {
              acquiredCodexAccountId = acquired.account_id;
              acquiredCodexSlotId = acquired.slotId;
              codexInboundPeerId = peerIdForAcquire;
              codexReleaseTimer = setTimeout(() => {
                // 兜底释放:防 outbound 完成信号丢 / ws 异常断 → 槽永久泄漏
                if (acquiredCodexAccountId !== null && acquiredCodexSlotId !== null && codexBinding !== undefined) {
                  try { codexBinding.release(acquiredCodexAccountId, acquiredCodexSlotId); } catch { /* */ }
                  acquiredCodexAccountId = null;
                  acquiredCodexSlotId = null;
                }
                codexApiRelayTurnInFlight = false;
                codexInboundPeerId = null;
                codexReleaseTimer = null;
              }, sessionMaxMs);
              codexReleaseTimer.unref?.();
            }

            // PR2 v1.0.66 → M2 — codex 真扣费 path:preCheck → journal → snapshot
            //   (finalizer 延迟到 billing 帧构造)→ inflightCodexTurns Map 注册 →
            //   frame rewrite 注入 server-owned requestId → forward。
            //   失败任一步:释放已 acquire 的资源 + close ws 关连接。
            //
            //   codexBillingEnabled=false(测试 / 个人版上下文,三件套未注入)→ 走
            //   下方 else 分支:仍 rewrite 注入 traceId(CG2a 合同硬门),只是不动 requestId。
            const codexRouteFrame = codexRoute !== null ? {
              baseUrl: codexRoute.baseUrl,
              modelProvider: codexRoute.modelProvider,
              providerName: codexRoute.providerName ?? null,
              wireApi: codexRoute.wireApi ?? "responses",
              preferredAuthMethod: codexRoute.preferredAuthMethod ?? "apikey",
              disableResponseStorage: codexRoute.disableResponseStorage ?? true,
            } : officialOAuthGroupId !== null ? {
              kind: "official_oauth" as const,
            } : null;
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

              // authority turn 的执行、授权、基础价格必须来自同一个 fenced snapshot；
              // PricingCache 只服务 flag 关闭的 legacy 路径。
              const modelPricing = authorityExec !== null
                ? authorityExec.pricing
                : pricingCache.get(effectiveModel);
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
              // 先铸 turnId 再落 journal；随后签票必须复用同一值，并把 billingRequestId
              // 绑到 requestId。这样进程崩溃后只读 journal 也能复原“哪张票对应哪笔账”。
              const authorityTurnId = authorityExec !== null
                ? authorityDeps!.signer.mintAuthorityTurnId()
                : null;
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

              let preCheckResult: Awaited<ReturnType<typeof preCheckWithCost>>;
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
                    try { userWs.close(CLOSE_BRIDGE.BILLING_POLICY, "insufficient_credits"); } catch { /* */ }
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

              // M2:usage_records.account_id 恒写 SQL NULL(codexFinalizer v5 形态,
              // 弃 v3 的 0n 假账号)。这里的 accountIdForQuota **只**服务 rateLimits
              // 落 claude_accounts.quota_*(maybeUpdateAccountQuotaCodex 对 0n 跳过):
              // legacy(acquired===null)/ api_relay 路由用 0n 占位 = 无关联账号。
              const accountIdForQuota = acquired !== null ? acquired.account_id : 0n;

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
                      accountIdForQuota === 0n
                        ? null
                        : accountIdForQuota.toString(),
                    source: "codex_bridge",
                    // 已复合 agent override 的最终价格。跨 bridge 恢复必须用这份
                    // server-owned 快照，不能在结算时回读已换代的 cache/override。
                    billingPricing: serializeBillingPricing(derivedPricing),
                    // P0 修复(2026-07-03)— 跨桥 settle 需要:billing 帧到达新桥
                    // (旧桥已关)时,journal ctx 是恢复 settle 的唯一权威上下文,
                    // traceId 让跨桥的 cost_charged 广播 / billing 日志仍钉回本
                    // turn 的 canonical trace。CG2c invariant 保证此处非 null。
                    traceId: turnTraceIdCapture,
                    ...(authorityExec === null
                      ? {}
                      : {
                          authorityKind: "bridge_signed",
                          authorityTurnId,
                          billingRequestId: requestId,
                          executionRevision: authorityExec.executionRevision,
                          billingRevision: authorityExec.billingRevision,
                          securityEpoch: String(authorityExec.securityEpoch),
                        }),
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

              // M2 — inflight snapshot:finalizer 延迟到 billing 帧构造(engineSessionId
              // 权威来自帧,settle=waive 同值红线);abandon 承接旧 finalizer.fail 语义
              // (abort journal + release reservation,不扣费)。snapState 单一状态机
              // 保证 getFinalizer/abandon 互斥幂等,与旧"构造期单 finalizer + _done
              // 守门"钱安全不变量等价。
              const reservationForTurn: ReservationHandle = preCheckResult.reservation;
              type SnapState =
                | { kind: "handle"; handle: CodexFinalizeHandle }
                | { kind: "abandoned"; promise: Promise<void> };
              let snapState: SnapState | null = null;
              const snap: CodexTurnSnapshot = {
                requestId,
                model: effectiveModel,
                // Issue A v1.0.108 — codex_billing 分支落 quota 用。
                accountId: accountIdForQuota,
                // CG2c — IIFE 起手 invariant 已校验 turnTraceIdCapture !== null,
                // 这里读出来 TS 推断为 string。本 turn 整个生命周期内固定不可变。
                traceId: turnTraceIdCapture,
                codexRouteToken: codexRoute?.token ?? null,
                authority: authorityExec === null
                  ? null
                  : {
                      executionRevision: authorityExec.executionRevision,
                      projectionRevision: null,
                      securityEpoch: BigInt(authorityExec.securityEpoch),
                      kind: "bridge_signed",
                    },
                authorityTurnId,
                getFinalizer(engineSessionIdFromFrame: string): CodexFinalizeHandle | null {
                  if (snapState !== null) {
                    return snapState.kind === "handle" ? snapState.handle : null;
                  }
                  const handle = makeCodexFinalizer({
                    pgPool,
                    preCheckRedis,
                    userId: uid,
                    requestId,
                    engineSessionId: engineSessionIdFromFrame,
                    model: effectiveModel,
                    derivedPricing,
                    reservation: reservationForTurn,
                    authority: snap.authority,
                  });
                  snapState = { kind: "handle", handle };
                  return handle;
                },
                async abandon(reason: string): Promise<void> {
                  if (snapState !== null) {
                    if (snapState.kind === "handle") {
                      // finalizer 已构造:委托其 fail(fail-after-commit 由 _done 守门,
                      // 已扣过费不会再 abort journal)。
                      await snapState.handle.fail(reason);
                      return;
                    }
                    await snapState.promise.catch(() => {});
                    return;
                  }
                  const promise = (async (): Promise<void> => {
                    try {
                      await abortInflightJournal(pgPool, requestId, reason.slice(0, 500));
                    } catch {
                      // journal abort 失败 — reconciler 会扫到 stuck inflight 兜底。
                    } finally {
                      await releasePreCheck(preCheckRedis, reservationForTurn).catch(() => {});
                    }
                  })();
                  snapState = { kind: "abandoned", promise };
                  await promise;
                },
              };
              inflightCodexTurns.set(requestId, snap);

              // 从 journal/map 注册完成起，到物理 forward 被本桥接受为止，任何 return/throw
              // 都必须走同一补偿状态机。历史装配、签发、JSON 序列化、帧上限、socket 同步
              // send 任一失败都不能把 journal / reservation / codex slot 留在半态。
              let forwardCommitted = false;
              let abandonReason = "codex_forward_not_committed";
              try {

              // Frame rewrite:server-owned requestId 覆盖 client 任意值。容器侧
              // 把这个 requestId 透传到 outbound.codex_billing,master 用它从
              // inflightCodexTurns Map 找回 snapshot 落账。
              // CG2a — 同时注入 master canonical traceId(IIFE 起手 invariant 保证非 null)
              const enrichedParsed = await attachMasterHistoricalMessages(
                inboundParsedCapture,
                turnLogCapture,
              );
              // ── 签发边界(MAJOR-2)────────────────────────────────────────────
              // 这里是 turn 里**最后一个还能无痛掉头**的点:票还没签、帧还没进容器。
              // 从起手 fence 到这一行之间已经跑完 route/acquire/preCheck/journal/历史装配
              // 全部 await —— 安全写完全可能落在中间。重读 epoch,不一致就**整单放弃**:
              // abort journal(否则悬空 = 漏账/错账,要等 reconciler 30min 兜底)+ 释放
              // preCheck 预扣 + 还 codex 槽,一步都不能少。
              let authorityFields: Record<string, unknown> = {};
              if (authorityExec !== null) {
                const sealed = await sealAuthorityFieldsOrReject({
                  exec: authorityExec,
                  billingRequestId: requestId,
                  ...(authorityTurnId === null ? {} : { authorityTurnId }),
                  log: turnLogCapture,
                  // seal 只报告拒因；真正的资源补偿统一由下方 finally 状态机执行。
                  compensate: (reason) => { abandonReason = reason; },
                });
                if (sealed === null) {
                  return;
                }
                authorityFields = sealed;
              }
              if (cleaned) {
                abandonReason = "bridge_disconnect_before_forward";
                return;
              }
              const rewrittenObj = {
                ...enrichedParsed,
                requestId,
                traceId: turnTraceIdCapture,
                ...(codexRouteFrame !== null ? { __oc_codex_route: codexRouteFrame } : {}),
                // 模型执行权威:签票绑定本 turn 的 server-owned requestId(billingRequestId),
                // 并把 frame.model 归一为 canonical(容器断言 canonicalModel === frame.model)。
                ...authorityFields,
              };
              const rewrittenStr = JSON.stringify(rewrittenObj);
              const rewrittenLen = Buffer.byteLength(rewrittenStr);
              if (rewrittenLen > maxFrameBytes) {
                // rewriting 只加 ~100 bytes(`,"requestId":"<32hex>","traceId":"<32hex>"`)
                // — 几乎不可能越界。命中 = 用户帧本来就贴边,abandon(不扣费)+ close ws。
                turnLogCapture?.error("user-chat-bridge: rewritten codex frame too big", {
                  rewrittenLen, max: maxFrameBytes,
                });
                abandonReason = "rewritten_frame_too_big";
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
              // ws lib RawData = Buffer | ArrayBuffer | Buffer[];string 不匹配。
              // 转 Buffer 走文本帧(isBinary=false)— 接收端 .toString() 行为一致。
              frameForwardData = Buffer.from(rewrittenStr, "utf8");
              frameForwardLen = rewrittenLen;
              forwardCommitted = forwardInboundFrame(
                frameForwardData,
                frameForwardIsBinary,
                frameForwardLen,
              );
              if (!forwardCommitted) abandonReason = "container_forward_rejected";
              } finally {
                if (!forwardCommitted) {
                  inflightCodexTurns.delete(requestId);
                  await snap.abandon(abandonReason).catch((err) => {
                    turnLogCapture?.error(
                      "user-chat-bridge: pre-forward billing compensation failed",
                      { requestId, abandonReason, err },
                    );
                  });
                  releaseAcquiredSlotForFailure();
                }
              }
              return;
            } else {
              // CG2a — billing 未启用(legacy NULL 容器无三件套 / 测试)路径仍要 rewrite
              // 注入 traceId(合同硬门);不动 requestId(client 提供的 requestId 保留 raw)。
              const enrichedParsed = await attachMasterHistoricalMessages(
                inboundParsedCapture,
                turnLogCapture,
              );
              // 签发边界(MAJOR-2):本分支没开 journal / 没预扣,但**占了 codex 槽** ——
              // 拒帧必须还槽,否则该用户后续 codex turn 全被 G7 单飞门挡住。
              let authorityFields: Record<string, unknown> = {};
              if (authorityExec !== null) {
                const sealed = await sealAuthorityFieldsOrReject({
                  exec: authorityExec,
                  log: turnLogCapture,
                  compensate: () => releaseAcquiredSlotForFailure(),
                });
                if (sealed === null) return;
                authorityFields = sealed;
              }
              if (cleaned) {
                releaseAcquiredSlotForFailure();
                return;
              }
              const rewrittenObj = {
                ...enrichedParsed,
                traceId: turnTraceIdCapture,
                ...(codexRouteFrame !== null ? { __oc_codex_route: codexRouteFrame } : {}),
                // billing 未启用(legacy NULL 容器 / 测试):无 server requestId 可绑,
                // 仍必须签票 —— 容器侧(flag 开)对无 envelope 的帧一律拒。
                ...authorityFields,
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
                try { userWs.close(CLOSE_BRIDGE.ENV_RECYCLED, "codex_container_recycled"); } catch { /* */ }
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
        const authorityModelCapture = authorityModelForFrame;
        const classifiedCodexCapture = isCodexInboundFrame;
        void (async () => {
          // 模型执行权威:epoch fence + descriptor。CCB turn 的计费在 egress 侧按请求
          // 结算(见方案 §4),此处拒帧无需任何回滚。
          //
          // classifiedCodex 传**同步分类结果**而不是 false:走到这条路径的 codex 帧
          // 是"没注 codexBinding/createCodexRoute"的降级形态(测试 / 个人版),它的
          // engine 确实是 codex —— 传 false 会把这类帧误判成 engine 漂移。
          let authorityExec: ResolvedTurnExecution | null = null;
          if (authorityOn) {
            authorityExec = await resolveAuthorityExecOrReject({
              model: authorityModelCapture,
              classifiedCodex: classifiedCodexCapture,
              log: turnLogCapture,
            });
            if (authorityExec === null) return;
          }
          const enrichedParsed = await attachMasterHistoricalMessages(
            inboundParsedCapture,
            turnLogCapture,
          );
          // 签发边界(MAJOR-2):CCB turn 的计费在 egress 逐请求结算,此处无预扣/无 journal
          // → 无需补偿;但 epoch 重读一样不能省 —— 拿过时快照签出的票 lease 长达 50min,
          // 会让「刚被 admin 撤销的模型」在这条 turn 里继续跑到 egress 的下一次 fence 才拦下。
          let authorityFields: Record<string, unknown> = {};
          if (authorityExec !== null) {
            const sealed = await sealAuthorityFieldsOrReject({
              exec: authorityExec,
              log: turnLogCapture,
            });
            if (sealed === null) return;
            authorityFields = sealed;
          }
          if (cleaned) return;
          const rewrittenObj = {
            ...enrichedParsed,
            traceId: turnTraceIdCapture,
            ...authorityFields,
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
      forwardInboundFrame(passthroughData, isBinary, passthroughLen);
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
    function forwardInboundFrame(data: RawData, isBinary: boolean, len: number): boolean {
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
          // 背压=连接态瞬态信号:只走 close code,不发 turn 级 error 帧(重连+resume 自愈,
          // 不在会话正文钉卡)。
          try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
          // backpressure → force final;一般无 inflight,即便有也异常态不 drain
          cleanup("backpressure", true);
          return false;
        }
        bufferedUC += len;
        metrics.onBufferedBytes?.(uid, "user_to_container", bufferedUC);
        preopenQueue.push({ data, isBinary, len });
        return true;
      }
      return sendToContainer(data, isBinary, len);
    }

    const sendToContainer = (data: RawData, isBinary: boolean, len: number): boolean => {
      try {
        containerWs.send(data, { binary: isBinary }, (err) => {
          if (err) {
            bridgeLog?.warn("user-chat-bridge: container send error", { err });
          }
        });
        bytesUC += len;
        metrics.onUserFrame?.(uid, len, isBinary);
        return true;
      } catch (err) {
        bridgeLog?.warn("user-chat-bridge: container send threw", { err });
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent send failed"); } catch { /* */ }
        // 容器 send 抛 = 容器 socket 已不可用,billing 帧也来不了 → force final
        cleanup("container_error", true);
        return false;
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
      // ── 容器 attestation 帧(方案 §7 步 3/4)────────────────────────────────
      // container→master 的内部控制帧,**绝不**透传给浏览器(与 outbound.codex_billing
      // 同款拦截:cheap string 预筛,不解 JSON 影响热路径)。必须在 TTFT 观测之前处理 ——
      // attest 是连接握手的一部分,不是"容器的第一帧响应"。
      if (!isBinary) {
        let attestPeek: string | null = null;
        if (typeof data === "string") attestPeek = data;
        else if (Buffer.isBuffer(data)) {
          try { attestPeek = data.toString("utf8"); } catch { attestPeek = null; }
        }
        if (attestPeek !== null && attestPeek.includes(`"${CONTAINER_ATTEST_FRAME_TYPE}"`)) {
          let parsedAttest: unknown = null;
          try { parsedAttest = JSON.parse(attestPeek); } catch { /* 非 JSON → 落回常规路径 */ }
          if (
            parsedAttest !== null && typeof parsedAttest === "object" &&
            (parsedAttest as { type?: unknown }).type === CONTAINER_ATTEST_FRAME_TYPE
          ) {
            onContainerAttest(parsedAttest as Record<string, unknown>);
            return;
          }
        }
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
              turnKey?: unknown;
              parentTurnKey?: unknown;
              parentSessionId?: unknown;
              delegateAgentId?: unknown;
              engineSessionId?: unknown;
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
            const billingTurnKey =
              typeof billing.turnKey === "string" && /^[0-9a-f]{64}$/.test(billing.turnKey)
                ? billing.turnKey
                : null;
            const billingParentTurnKey =
              typeof billing.parentTurnKey === "string" && /^[0-9a-f]{64}$/.test(billing.parentTurnKey)
                ? billing.parentTurnKey
                : null;
            const billingParentSessionId =
              typeof billing.parentSessionId === "string" &&
              billing.parentSessionId.length > 0 && billing.parentSessionId.length <= 256
                ? billing.parentSessionId
                : null;
            const billingDelegateAgentId =
              typeof billing.delegateAgentId === "string" &&
              /^[A-Za-z0-9_-]{1,64}$/.test(billing.delegateAgentId)
                ? billing.delegateAgentId
                : null;
            // —— 与 snapshot 无关的帧字段解析(主路径与跨桥 fallback 共用)——
            // M2 — engineSessionId fail-closed 校验(方案 §D 红线 2)。
            // settle 落 usage_records.session_id 的**唯一**权威 = 帧上的
            // engineSessionId(gateway 经 engineSessionId(sessionKey) 派生,与
            // idle-timeout waive 上报同值)。缺失(旧容器镜像)/ 形状非法(伪造/
            // 漂移)→ **不扣费**(见下方两个消费点)。
            const engineSidRaw = billing.engineSessionId;
            const engineSid =
              typeof engineSidRaw === "string" && ENGINE_SESSION_ID_RE.test(engineSidRaw)
                ? engineSidRaw
                : null;
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
            const billingRl = (parsedBilling as { rateLimits?: unknown }).rateLimits;

            const snap = inflightCodexTurns.get(reqId);
            if (snap === undefined) {
              // billing 帧的 requestId 在本桥 inflight Map 里查不到。两类成因:
              //   - **同桥 duplicate**:同 reqId 的另一帧已进 settle/abandon(下方
              //     Map.delete + locallySettledCodexTurns.add 先行)→ 同步 info
              //     丢弃,不重复广播 cost_charged(旧语义保留);
              //   - **跨桥重连(P0 修复 2026-07-03)**:turn 在旧桥开启(journal
              //     inflight),用户断 WS 重连后容器把 billing 帧发到了新桥。旧实现
              //     只打日志丢帧 = 整 turn 免费(收入漏洞)。现在按 request_id 回查
              //     request_finalize_journal 裁决:inflight 行用 journal ctx 恢复
              //     settle,committed/finalizing 幂等忽略,aborted 免单 + 告警。
              if (locallySettledCodexTurns.has(reqId)) {
                bridgeLog?.info("user-chat-bridge: codex_billing duplicate for locally settled turn — dropped", {
                  requestId: reqId,
                });
                return;
              }
              handleCrossBridgeCodexBilling({
                requestId: reqId,
                engineSid,
                engineSidRaw,
                codexStatus,
                errorReason,
                usage,
                billingRl,
                turnKey: billingTurnKey,
                parentTurnKey: billingParentTurnKey,
                parentSessionId: billingParentSessionId,
                delegateAgentId: billingDelegateAgentId,
              });
              return;
            }
            // **同步** delete:duplicate billing 帧第二次进这个分支 Map.get 拿
            // undefined,由上方 locallySettledCodexTurns 门控直接 return,不会再起
            // 一个 IIFE 重复广播 cost_charged。finalizer._done 守门只防 ledger 重复
            // debit,但两个 IIFE 各自 await commit 后都会读 result.debitedCredits>0
            // 各广播一次 — 用 Map.delete + 本地簿记早断。
            inflightCodexTurns.delete(reqId);
            locallySettledCodexTurns.add(reqId);
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
            // engineSessionId fail-closed(解析已上移):缺失 / 形状非法 →
            // **不扣费**:abandon(abort journal + release reservation)+ error
            // 告警。宁可少收不可乱扣 —— 口径错的 session_id 一旦入库,waive 退款
            // 窗口(refund.refundSessionWindow)永远圈不到,会变成"该退不退"的
            // 乱扣。与 usage 缺失的 fail-safe 策略(免单并告警)对齐。
            if (engineSid === null) {
              billingLog?.error("user-chat-bridge: codex_billing engineSessionId missing/invalid — waiving turn (fail-closed)", {
                engineSessionId: typeof engineSidRaw === "string" ? engineSidRaw.slice(0, 80) : typeof engineSidRaw,
              });
              void (async () => {
                try {
                  await snap.abandon("codex_billing_engine_session_id_invalid");
                } catch (err) {
                  billingLog?.error("user-chat-bridge: codex abandon threw", {
                    err: (err as Error)?.message,
                  });
                } finally {
                  expireCodexRouteToken(snap.codexRouteToken, "billing_engine_session_id_invalid");
                  checkDrainComplete();
                }
              })();
              return;
            }
            // codexStatus / errorReason / usage 解析已上移(主路径与跨桥 fallback 共用)。
            // fire-and-forget settle:Map 已 delete,duplicate 帧不会再触发;commit
            // 内部 _done 守门兜底防 finalCleanup 同时调 fail 时重复 debit。
            // M2:settle 收口 = codexFinalizer → settleUsageAndLedger → spendTwoBucket
            // (双钱包:期内桶优先/钱包兜底);零输出免单在 finalizer 层;
            // usage_records.account_id 恒 NULL;session_id = engineSid(上方已校验)。
            void (async () => {
              try {
                const finalizer = snap.getFinalizer(engineSid);
                if (finalizer === null) {
                  // abandon 已跑过(Map.delete 纪律下不可达)— 不再 settle,防错账。
                  billingLog?.error("user-chat-bridge: codex billing after abandon — skip settle");
                  return;
                }
                const result = await finalizer.commit(
                  usage, codexStatus, errorReason,
                  {
                    turnKey: billingTurnKey,
                    parentTurnKey: billingParentTurnKey,
                    parentSessionId: billingParentSessionId,
                    delegateAgentId: billingDelegateAgentId,
                  },
                );
                // 仅 debit > 0 才广播 cost_charged;0 token / 零输出免单 / 重入 /
                // settle 失败 / commit-after-fail 合成 skipped(debitedCredits=null)
                // 都不广播,避免前端误显示 ¥0 扣费条目。
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
                        engineSid,
                        billingParentSessionId,
                        billingDelegateAgentId,
                        billingTurnKey,
                        billingParentTurnKey,
                      );
                    } catch (err) {
                      billingLog?.warn("user-chat-bridge: codex persist costCredits threw", {
                        err: (err as Error)?.message,
                      });
                    }
                  }
                  // CG2c — broadcast 帧带 traceId 让 outboundRing audit / 前端 trace
                  // 关联到 inbound canonical。snap.traceId 是 server-owned 唯一可信源。
                  // M2:balanceAfter = **双钱包总可用**(spendTwoBucket.totalAfter,
                  // period_credits + users.credits),对齐前端余额气泡口径。
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
        // turn 收尾(isFinal 帧)→ 把 turn 宽限收窄到 POST_FINAL_GRACE_MS(只缩不延):既给
        // cost_charged(isFinal 之后才广播)留投递窗口,又不让已结束 turn 的连接(浏览器可能已离开)
        // 长期占用到 10min 硬上限。仅在 turn 在飞时收窄(turnActiveUntil>0)。cheap 子串预筛。
        if (turnActiveUntil > 0 && statusPeek !== null && statusPeek.includes('"isFinal":true')) {
          turnActiveUntil = Math.min(turnActiveUntil, Date.now() + POST_FINAL_GRACE_MS);
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
              const slotId = acquiredCodexSlotId;
              acquiredCodexAccountId = null;
              acquiredCodexSlotId = null;
              codexApiRelayTurnInFlight = false;
              codexInboundPeerId = null;
              if (codexReleaseTimer !== null) {
                clearTimeout(codexReleaseTimer);
                codexReleaseTimer = null;
              }
              if (accountId !== null && slotId !== null && deps.codexBinding !== undefined) {
                try { deps.codexBinding.release(accountId, slotId); } catch { /* swallow */ }
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
        // 背压=连接态瞬态信号:只走 close code,不发 turn 级 error 帧(同 agent-slow 侧)。
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
        // user-WS 不可写但 container 仍在跑 codex turn → 走 drain 让 billing 落账
        // (broadcast 会 no-op 因 user-WS 已关,但 ledger debit 必须完成)
        cleanup("backpressure");
        return;
      }
      // 容器 → user 默认**透传**:除上面显式拦下的 outbound.codex_billing(内部计费
      // 侧信道,绝不给浏览器)外,其余帧一律照发。长会话热尾巴+归档的 sys.context_rebuilt
      // 提示帧(容器 gateway deliver() 产生、带 sessionKey+frameSeq)就走这条路到达 user
      // —— 上面 ring 写入已捕获它供重连重放,这里 live 透传。
      // **契约红线**:未来若在此加"按 type 的转发白名单/丢弃表",必须放行 sys.* 命名空间
      // (含 sys.context_rebuilt),否则用户上下文重建提示会被静默吞掉(帧被吞前科)。
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
      // attestation 超时:容器 open 后应**立刻**发 attest 帧(gateway 在 ws connection
      // 建立时同步 send)。超时 = 旧 release(没这段代码)→ 拒连接 + stale recycle。
      // 计时起点放在 open 而不是 upgrade:连接还没建立就开始计时会把慢网络误判成旧容器。
      if (authorityOn && attestState === "pending" && attestTimer === null) {
        attestTimer = setTimeout(
          () => failAttestation("attestation_timeout"),
          authorityDeps?.attestTimeoutMs ?? DEFAULT_ATTEST_TIMEOUT_MS,
        );
      }
      // V3 cold-start UX 提示:本次 ensureRunning 走了 provision 分支 → 给前端发
      // 一帧 sidecar,前端把 typing indicator 文案换成"首次加载上下文较慢"。
      // 用 sys.* 命名空间避免与 ccb outbound.* 帧冲突;前端 default case 会忽略未知 type,
      // 加 case 是 additive。
      if (endpoint.coldStart === true && userWs.readyState === WebSocket.OPEN) {
        try {
          userWs.send(JSON.stringify({ type: "sys.cold_start" }));
        } catch { /* swallow — sidecar 提示失败不能影响 bridge */ }
      }
      // relay 真建立(containerWs open = bridge↔容器双向通)→ 给前端发"就绪"单一权威信号。
      // 冷暖都发(sys.cold_start 仅冷启)。这是 readiness 权威统一:前端把"relay 已就绪"只认
      // 这一个信号,据此立刻排空离线队列 —— 冷启时握手完成(前端 onopen)早于 relay 就绪,
      // 期间发的消息经 P7.8 进离线队列等待;收到 relay_ready 即发,不再靠 4503 reconnect 反弹。
      // sys.* 命名;前端 default case 忽略未知 type,加 case 是 additive。
      if (userWs.readyState === WebSocket.OPEN) {
        try {
          userWs.send(JSON.stringify({ type: "sys.relay_ready" }));
        } catch { /* swallow */ }
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
    // lastAliveAt 已在连接状态区提前声明(onContainerMessage 复用)。
    const refreshAlive = (): void => { lastAliveAt = Date.now(); };
    userWs.on("pong", refreshAlive);
    userWs.on("message", refreshAlive); // 绑第二个 message handler 只刷时间戳,不干扰 onUserMessage
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (userWs.readyState !== WebSocket.OPEN) return;
        const idleMs = Date.now() - lastAliveAt;
        // turn 在飞宽限:CF/Caddy 不转发 ping/pong,长 turn 期间浏览器无上行刷 lastAlive。
        // 用户已发 inbound.message 即在等响应,turn 期间(含冷启 TTFT 静默 + 流式)不 reap。
        // turnActiveUntil 是绝对截止点(turn 起点 +硬上限,isFinal 收窄),**不被下行帧续期**,
        // 故"浏览器真断 + turn 卡死"的连接到点必回收(Codex 审 MEDIUM:硬上限是真硬)。
        const turnGraceActive = Date.now() < turnActiveUntil;
        if (idleMs > heartbeatTimeoutMs && !turnGraceActive) {
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
    // P0 计费旁路封堵:agent→model 权威快照共用同一班 timer 刷新(新装/卸载
    // marketplace agent 在窗口内对已开桥生效;miss 时另有即时补触发)。
    if (modelCheckerHandle !== null || agentModelResolverHandle !== null) {
      modelCheckerRefreshTimer = setInterval(() => {
        // 注意:不绑 await/then;refresh 内部 swallow error,这里只是触发。
        modelCheckerHandle?.refresh();
        void agentModelResolverHandle?.refresh();
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
      // 同时有在飞 codex turn → container 仍可发 billing 帧,窗口内能到的就 settle。
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
      }, readDrainBillingMs());
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
     * P0 收入漏洞修复(2026-07-03)— codex billing 帧撞上"本桥不认识的 requestId"
     * 时,按 request_finalize_journal(唯一权威源)回查裁决,而不是丢帧。
     *
     * 背景:inflightCodexTurns 是 per-连接闭包 Map,而 v5 断流续写语义下 codex
     * turn 跨 WS 重连存活 —— 用户中途断线重连后,容器把 outbound.codex_billing
     * 发到**新桥**,新桥 Map 查不到 → 旧实现只打日志 = 整 turn 免费。修复后按
     * journal state 裁决:
     *   - 'inflight'   → 用 journal ctx(model/agentId/codexAccountId/traceId,
     *     startInflightJournal 落笔)重构 finalizer 完成 settle —— 双钱包扣费、
     *     零输出免单、cost_charged 持久化+广播口径与主路径完全一致;
     *   - 'committed' / 'finalizing' → 幂等忽略(duplicate 帧 / 旧桥 drain 窗口已
     *     settle / 并发 settle 在途);
     *   - 'aborted'    → **免单 + error 告警,不补收**。钱安全红线"宁少收不乱扣":
     *     aborted 行的 preCheck reservation 已释放、免单决策(engineSessionId
     *     fail-closed / reconciler_timeout / commit 失败等)已对外生效,此处补收
     *     会绕过既有免单口径;且 journal CAS 不允许 aborted→committed,强行
     *     settle 会让 ledger 与 journal 终态脱钩。本修复已同时移除 finalCleanup
     *     的 bridge_disconnect abort,常态下不应再出现 billing 撞 aborted ——
     *     出现即异常,error 级告警留人工核账(存量 bridge_disconnect abort 行为
     *     修复前已发生的损失,按"接受不可追回"口径处理,与 reconciler 一致);
     *   - 无行 → warn 丢弃(容器伪造 / 非本 master 生成的 requestId)。
     *
     * 并发/幂等防线(与主路径 Map.delete 单次门控同构):
     *   1. pendingJournalSettles 同步去重 —— 同 reqId duplicate 帧在 settle 在途
     *      期间直接丢弃;
     *   2. settleUsageAndLedger 的 (user_id, request_id) UNIQUE + journal CAS ——
     *      跨桥并发(旧桥 drain settle vs 新桥 fallback)由 DB 层兜底,后到的
     *      settle 拿 debitedCredits=null,不重复扣也不重复广播。
     *
     * 安全:journal.user_id 必须等于本桥 uid(容器 per-user,不等即伪造/串桥,
     * 直接拒绝);settle 参数全部取自 journal ctx(master 落笔),不信帧上的
     * model/agentId(与主路径"只信 snapshot"红线同构);preCheck reservation
     * handle 按 (userId, requestId) 重建 —— 与原桥 preCheckWithCost 返回的
     * handle 同值(ReservationHandle 本就只是这两个字段)。
     */
    function handleCrossBridgeCodexBilling(frame: {
      requestId: string;
      engineSid: string | null;
      engineSidRaw: unknown;
      codexStatus: "success" | "error";
      errorReason: string | undefined;
      usage: TokenUsage;
      billingRl: unknown;
      turnKey: string | null;
      parentTurnKey: string | null;
      parentSessionId: string | null;
      delegateAgentId: string | null;
    }): void {
      const { requestId } = frame;
      if (!codexBillingEnabled) {
        // 计费未启用(个人版上下文 / 纯透传测试)— 无 journal 可查,保持旧日志语义。
        bridgeLog?.info("user-chat-bridge: codex_billing for unknown turn (billing disabled)", {
          requestId,
        });
        return;
      }
      // server-owned requestId 恒为 32-hex(ensureRequestIdServerSide;gateway 侧
      // billing guard 是同一 seam 合同)。形状不符 = 容器伪造/坏帧,不值得打 DB。
      if (!/^[0-9a-f]{32}$/.test(requestId)) {
        bridgeLog?.warn("user-chat-bridge: codex_billing unknown turn with malformed requestId — dropped", {
          requestId: requestId.slice(0, 64),
        });
        return;
      }
      if (pendingJournalSettles.has(requestId)) {
        bridgeLog?.info("user-chat-bridge: codex_billing duplicate while cross-bridge settle in flight — dropped", {
          requestId,
        });
        return;
      }
      pendingJournalSettles.add(requestId);
      // 三件套非空由 codexBillingEnabled(boot-time 全有或全无强校验)保证。
      const pgPool = deps.pgPool!;
      const preCheckRedisBound = deps.preCheckRedis!;
      const pricingCache = deps.pricing!;
      void (async (): Promise<void> => {
        try {
          const res = await pgPool.query<{
            state: string;
            user_id: string;
            ctx: unknown;
          }>(
            `SELECT state, user_id::text AS user_id, ctx
               FROM request_finalize_journal
              WHERE request_id = $1`,
            [requestId],
          );
          const row = res.rows[0];
          if (row === undefined) {
            bridgeLog?.warn("user-chat-bridge: codex_billing for unknown turn — no journal row, dropped", {
              requestId,
            });
            return;
          }
          if (row.user_id !== uid.toString()) {
            // 容器只服务单用户;journal 行归属他人 = 伪造 requestId / 串桥,拒绝。
            bridgeLog?.error("user-chat-bridge: codex_billing journal user mismatch — refusing settle", {
              requestId,
              journalUserId: row.user_id,
            });
            return;
          }
          if (row.state === "committed" || row.state === "finalizing") {
            bridgeLog?.info("user-chat-bridge: codex_billing for already-settled journal — idempotent ignore", {
              requestId,
              state: row.state,
            });
            return;
          }
          if (row.state === "aborted") {
            // 见函数头注释:免单 + 告警,不补收(钱安全红线)。
            bridgeLog?.error("user-chat-bridge: codex_billing hit aborted journal — turn waived, needs investigation (money-safety: never charge over an aborted journal)", {
              requestId,
            });
            return;
          }
          // state === 'inflight' — 跨桥恢复 settle。
          const ctx = (row.ctx !== null && typeof row.ctx === "object"
            ? row.ctx
            : {}) as Record<string, unknown>;
          const model = typeof ctx.model === "string" ? ctx.model : null;
          const agentId = typeof ctx.agentId === "string" ? ctx.agentId : "codex";
          const ctxTraceId = typeof ctx.traceId === "string" ? ctx.traceId : null;
          const reservation: ReservationHandle = {
            userId: uid.toString(),
            requestId,
          };
          const billingLog = bridgeLog?.child({
            ...(ctxTraceId !== null ? { traceId: ctxTraceId } : {}),
            requestId,
          }) ?? null;
          // 配置类不可恢复错误 → 与主路径 abandon 同语义:免单(abort journal)
          // + 释放软预扣 + error 告警。宁可少收不可乱扣。
          const waive = async (reason: string): Promise<void> => {
            await abortInflightJournal(pgPool, requestId, reason).catch(() => {});
            await releasePreCheck(preCheckRedisBound, reservation).catch(() => {});
          };

          // journal 的创建代次由**持久字段**裁决，不能看接收 billing 帧的这个新 bridge
          // 当前 flag。否则 enable 后会把存量 legacy journal 当 authority 拒掉；disable 后又会
          // 把存量 authority journal 当 legacy，用新 PricingCache 结算另一代价格。
          const journalAuthority = ctx.authorityKind === "bridge_signed";
          const authorityMetadataPresent = [
            "authorityTurnId",
            "billingRequestId",
            "executionRevision",
            "billingRevision",
            "securityEpoch",
          ].some((key) => Object.prototype.hasOwnProperty.call(ctx, key));
          if (
            (ctx.authorityKind !== undefined && !journalAuthority) ||
            (!journalAuthority && authorityMetadataPresent)
          ) {
            billingLog?.error(
              "user-chat-bridge: cross-bridge journal authority classification invalid — waiving turn",
              { authorityKind: ctx.authorityKind },
            );
            await waive("cross_bridge_authority_classification_invalid");
            return;
          }

          let recoveredAuthority: import("../billing/proxyBilling.js").BillingAuthorityStamp | null = null;
          if (journalAuthority) {
            const bindingOk =
              typeof ctx.authorityTurnId === "string" &&
              /^[0-9a-f]{32}$/.test(ctx.authorityTurnId) &&
              ctx.billingRequestId === requestId &&
              typeof ctx.executionRevision === "string" &&
              /^[0-9a-f]{64}$/.test(ctx.executionRevision) &&
              typeof ctx.billingRevision === "string" &&
              /^[0-9a-f]{64}$/.test(ctx.billingRevision) &&
              typeof ctx.securityEpoch === "string" &&
              /^\d+$/.test(ctx.securityEpoch);
            if (!bindingOk) {
              bridgeLog?.error(
                "user-chat-bridge: cross-bridge journal authority binding invalid — waiving turn",
                { requestId },
              );
              await abortInflightJournal(
                pgPool,
                requestId,
                "cross_bridge_authority_binding_invalid",
              ).catch(() => {});
              await releasePreCheck(preCheckRedisBound, reservation).catch(() => {});
              return;
            }
            recoveredAuthority = {
              executionRevision: ctx.executionRevision as string,
              projectionRevision: null,
              securityEpoch: BigInt(ctx.securityEpoch as string),
              kind: "bridge_signed",
            };
          }
          if (frame.engineSid === null) {
            billingLog?.error("user-chat-bridge: cross-bridge codex_billing engineSessionId missing/invalid — waiving turn (fail-closed)", {
              engineSessionId: typeof frame.engineSidRaw === "string"
                ? frame.engineSidRaw.slice(0, 80)
                : typeof frame.engineSidRaw,
            });
            await waive("codex_billing_engine_session_id_invalid");
            return;
          }
          if (model === null) {
            billingLog?.error("user-chat-bridge: cross-bridge codex_billing journal ctx missing model — waiving turn");
            await waive("cross_bridge_journal_ctx_model_missing");
            return;
          }
          let derivedPricing = parseBillingPricing(ctx.billingPricing, model);
          if (derivedPricing === null && journalAuthority) {
            // authority journal 缺/坏精确定价时绝不回退异步 cache：那会把同一笔 turn
            // 跨到另一 billing generation。钱安全方向取免单 + 响亮日志。
            billingLog?.error(
              "user-chat-bridge: cross-bridge authority billing pricing invalid — waiving turn",
              { model, billingRevision: ctx.billingRevision },
            );
            await waive("cross_bridge_authority_billing_pricing_invalid");
            return;
          }
          if (derivedPricing === null && ctx.billingPricing !== undefined) {
            // 本版本起 legacy journal 也会持久化最终价格；字段存在但畸形说明 journal
            // 已损坏，不能伪装成“上线前旧 journal”回退当前 cache。只有字段完全缺失的
            // pre-deployment legacy 行保留兼容回退。
            billingLog?.error(
              "user-chat-bridge: cross-bridge persisted billing pricing invalid — waiving turn",
              { model },
            );
            await waive("cross_bridge_billing_pricing_invalid");
            return;
          }
          if (derivedPricing === null) {
            // 仅兼容本版本上线前遗留、完全没有 billingPricing 字段的 legacy inflight
            // journal；新 journal（含 legacy）都持久化最终价格，不会走这条分支。
            const modelPricing = pricingCache.get(model);
            if (!modelPricing) {
              billingLog?.error("user-chat-bridge: cross-bridge codex_billing pricing missing — waiving turn", {
                model,
              });
              await waive("cross_bridge_pricing_missing");
              return;
            }
            let agentMul: string;
            try {
              agentMul = await getAgentCostMultiplier(pgPool, agentId);
            } catch (err) {
              // 瞬态 DB 错误:**不** abort —— journal 保持 inflight,reconciler 兜底
              // 终态化(与"桥断不 abort 存活 turn"同一裁决权归属),不把临时故障
              // 固化成免单。
              billingLog?.error("user-chat-bridge: cross-bridge getAgentCostMultiplier failed — journal left inflight for reconciler", {
                agentId,
                err: (err as Error)?.message,
              });
              return;
            }
            derivedPricing = {
              ...modelPricing,
              multiplier: composeMultiplier(modelPricing.multiplier, agentMul),
            };
          }
          // rateLimits piggyback(best-effort,与主路径同语义;accountId 权威取
          // journal ctx.codexAccountId —— null = legacy / api_relay 无关联账号)。
          if (frame.billingRl && typeof frame.billingRl === "object") {
            const accStr = typeof ctx.codexAccountId === "string" ? ctx.codexAccountId : null;
            if (accStr !== null && /^[0-9]{1,19}$/.test(accStr)) {
              void maybeUpdateAccountQuotaCodex(
                pgPool,
                BigInt(accStr),
                frame.billingRl as {
                  util5h?: number;
                  reset5h?: string;
                  util7d?: number;
                  reset7d?: string;
                },
              ).catch((err) => {
                billingLog?.debug("user-chat-bridge: cross-bridge codex quota write failed", {
                  err: (err as Error)?.message,
                });
              });
            }
          }
          const finalizer = makeCodexFinalizer({
            pgPool,
            preCheckRedis: preCheckRedisBound,
            userId: uid,
            requestId,
            engineSessionId: frame.engineSid,
            model,
            derivedPricing,
            reservation,
            authority: recoveredAuthority,
          });
          const result = await finalizer.commit(
            frame.usage, frame.codexStatus, frame.errorReason,
            {
              turnKey: frame.turnKey,
              parentTurnKey: frame.parentTurnKey,
              parentSessionId: frame.parentSessionId,
              delegateAgentId: frame.delegateAgentId,
            },
          );
          // settle 已收口 → 后续同桥 duplicate 帧同步丢弃(与主路径簿记同构)。
          locallySettledCodexTurns.add(requestId);
          billingLog?.info("user-chat-bridge: codex cross-bridge settle done (recovered turn billing)", {
            model,
            debitedCredits: result.debitedCredits?.toString() ?? null,
            costCredits: result.costCredits.toString(),
          });
          // 广播口径与主路径一致:仅 debit>0 才 persist + 广播。
          if (result.debitedCredits !== null && result.debitedCredits > 0n) {
            if (deps.appendCostCredits) {
              try {
                await deps.appendCostCredits(
                  requestId,
                  uid.toString(),
                  result.debitedCredits.toString(),
                  frame.engineSid,
                  frame.parentSessionId,
                  frame.delegateAgentId,
                  frame.turnKey,
                  frame.parentTurnKey,
                );
              } catch (err) {
                billingLog?.warn("user-chat-bridge: cross-bridge persist costCredits threw", {
                  err: (err as Error)?.message,
                });
              }
            }
            broadcastToUser(uid, {
              type: "outbound.cost_charged",
              requestId,
              traceId: ctxTraceId,
              model,
              costCredits: result.costCredits.toString(),
              debitedCredits: result.debitedCredits.toString(),
              balanceAfter: result.balanceAfter !== null
                ? result.balanceAfter.toString()
                : null,
              clamped: result.clamped,
            });
          }
        } catch (err) {
          // settle 抛错:commitOnce 内部已 abort journal(codex_commit_failed)
          // 兜底并 release reservation,这里只 log(与主路径 commit throw 同语义)。
          bridgeLog?.error("user-chat-bridge: codex cross-bridge settle failed", {
            requestId,
            err: (err as Error)?.message,
          });
        } finally {
          pendingJournalSettles.delete(requestId);
        }
      })();
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
      // attestation 门的超时 timer:连接一走就必须清(否则 timer 到点后对一条已关的
      // 连接触发 recycle —— 把用户容器无辜换掉)。
      if (attestTimer !== null) {
        clearTimeout(attestTimer);
        attestTimer = null;
      }
      attestQueue.length = 0;
      attestQueuedBytes = 0;
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

      // keyring 普查:连接终结 = 这个容器的这条连接不再在册。留着不摘 = 轮换步骤② 的
      // 覆盖率会被已经断开的连接稀释(永远收敛不到 100%,或反过来把已下线的旧 env
      // 容器算进"已覆盖")。幂等。
      authorityCensus?.drop(connId);

      // user 侧 detach(idempotent)
      detachUserSide(finalCause);

      // P0 修复(2026-07-03)— **桥关 ≠ turn 终止,finalCleanup 不再 abort 残留
      // inflight turn**。v5 断流续写语义下(turn 跨 WS 重连存活 + ring 重放),用户
      // 断线/重连/displacement/master 平滑重启后,容器侧 codex turn 继续跑;旧实现
      // 在这里把残留 snapshot 全部 abandon(abort journal + release reservation),
      // billing 帧随后到达**新桥**时撞上 aborted journal → 整 turn 免费(收入漏洞,
      // e2e 实测复现)。桥对"容器侧 turn 是否存活"不可知,裁决权交给权威源:
      //   - billing 帧到达任意桥(旧桥 drain 窗口 / 新桥 journal 回查)→ settle;
      //   - turn 真死(容器崩 / billing 帧永失)→ finalizeJournalReconciler 在
      //     stuck 阈值(≥30min,COMMERCIAL_FINALIZE_RECONCILER_*)后终态化:有
      //     usage_records 补 committed,无则 aborted('reconciler_timeout',不扣费)
      //     —— 不产生永久 inflight 泄漏;
      //   - preCheck 软预扣不在此处提前释放:settle 时由 finalizer release,否则
      //     Redis TTL(300s)自然回收。代价 = 低余额用户断线后至多 5min 内新 turn
      //     可能被软预扣挡住 —— 但该 turn 确实仍在消耗,语义正确且有界。
      // 已 settle 的 turn 由 Map.delete 纪律先行摘除;这里只清本地帧路由簿记,
      // **不动 journal 权威状态**。
      if (inflightCodexTurns.size > 0) {
        bridgeLog?.info("user-chat-bridge: bridge closed with surviving codex turns — journal left inflight (cross-bridge settle / reconciler will adjudicate)", {
          finalCause,
          leftover: inflightCodexTurns.size,
          requestIds: [...inflightCodexTurns.keys()],
        });
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
      if (acquiredCodexAccountId !== null && acquiredCodexSlotId !== null && deps.codexBinding) {
        try { deps.codexBinding.release(acquiredCodexAccountId, acquiredCodexSlotId); } catch { /* */ }
        acquiredCodexAccountId = null;
        acquiredCodexSlotId = null;
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
    // 可观测:cost_charged 投递命中情况(per-turn 低频)。set 为空=该 uid 当前无注册 user WS
    // (cost 帧投不出,前端无 live 积分徽章)。排查"积分有时不显示"用得到。
    if ((payload as { type?: string } | null)?.type === "outbound.cost_charged") {
      // 可观测(per-turn 低频):cost_charged 投递命中。recipients=0 表示该 uid 当前无注册 user WS
      // (cost 帧投不出 → 前端无 live 积分徽章)——排查"积分有时不显示"的关键信号。
      log?.info("user-chat-bridge: cost_charged broadcast", {
        uid: uid.toString(),
        recipients: set ? set.size : 0,
        registeredUids: uidToUserWs.size,
      });
    }
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

  /**
   * V5 自愈体系(§5)— 全站广播。把 payload 以 JSON text 帧发给**所有**在线 uid 名下所有
   * OPEN user WS。非 OPEN 跳过;单 ws send 异常单独 catch,不连累其他连接。返回成功连接数。
   * stringify 只做一次(payload 全站同一份);stringify 失败返 0。
   */
  function broadcastAll(payload: unknown): number {
    let text: string;
    try { text = JSON.stringify(payload); }
    catch (err) {
      log?.warn("user-chat-bridge: broadcastAll stringify failed", { err });
      return 0;
    }
    let sent = 0;
    for (const set of uidToUserWs.values()) {
      for (const ws of set) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        try {
          ws.send(text, { binary: false }, (err) => {
            if (err) log?.warn("user-chat-bridge: broadcastAll send error", { err });
          });
          sent += 1;
        } catch (err) {
          log?.warn("user-chat-bridge: broadcastAll send threw", { err });
        }
      }
    }
    return sent;
  }

  /**
   * V5 自愈体系(§5)— 定向广播。只给 uids 集合中在线用户的 OPEN user WS 发 payload
   * (audience=user_ids / surface_cohort)。uid 以字符串给出(uidToUserWs key 口径)。
   * 非 OPEN / 未在线 uid 跳过;单 ws 异常单独 catch。返回成功连接数;stringify 失败返 0。
   */
  function broadcastToUsers(uids: string[], payload: unknown): number {
    let text: string;
    try { text = JSON.stringify(payload); }
    catch (err) {
      log?.warn("user-chat-bridge: broadcastToUsers stringify failed", { err });
      return 0;
    }
    let sent = 0;
    for (const uid of uids) {
      const set = uidToUserWs.get(uid);
      if (!set || set.size === 0) continue;
      for (const ws of set) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        try {
          ws.send(text, { binary: false }, (err) => {
            if (err) log?.warn("user-chat-bridge: broadcastToUsers send error", { uid, err });
          });
          sent += 1;
        } catch (err) {
          log?.warn("user-chat-bridge: broadcastToUsers send threw", { uid, err });
        }
      }
    }
    return sent;
  }

  function onlineUserSubset(uids: string[]): string[] {
    const out: string[] = [];
    for (const uid of new Set(uids)) {
      const set = uidToUserWs.get(uid);
      if (set && [...set].some((ws) => ws.readyState === WebSocket.OPEN)) out.push(uid);
    }
    return out;
  }

  return { handleUpgrade, shutdown, registry, broadcastToUser, broadcastAll, broadcastToUsers, onlineUserSubset };
}

// ---------- 测试 re-exports ------------------------------------------------
// 供单测直接拿到内部 helpers,不走 ws upgrade 全链路就能验逻辑

export { rawDataLen as _rawDataLen, encode4503Reason as _encode4503Reason };
