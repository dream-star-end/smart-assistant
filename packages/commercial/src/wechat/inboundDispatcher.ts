/**
 * v3 commercial WeChat broker — inbound dispatcher。
 *
 * 详见 docs/v3/wechat-broker-design.md §4.2 / §7 Phase 1 #7 / R3 / R4。
 *
 * **职责**:把已通过 manager.onInbound 接到的 WeChat inbound text 事件,
 * 编排成下面一串副作用:
 *
 *   0. 命令短路:text 以 "/" 开头 → 本地反射回 "暂不支持命令" 文案,**不**触容器
 *   1. resolveContainerEndpoint(uid) — cold-start 抛 ContainerUnreadyError → 反射 "正在唤醒,稍等几秒"
 *   2. pointer lookup:`getCurrentSessionId(pgPool, bindingUserId)`;null → allocate new `wsess-…`
 *   3. **Step 1**:POST 容器 `/internal/v3/wechat-inbound`(带 HMAC nonce + container-id 头);
 *      容器侧 handler 单调原子地做 (a) `INSERT OR IGNORE client_sessions` row + (b) 构造
 *      `InboundMessage` 帧调 `dispatchInbound`(S3 spike 修正:无需模拟 hello/bind)
 *   4. **Step 2a**(仅 newSession):master sqlite `upsertMasterClientSession` 写 row
 *      (`originChannel:'wechat'`,`userId:'c:'+bindingUserId` 与 web owner id 字节级一致)
 *   5. **Step 2b**:PG `setCurrentSessionId`(updated_at guard 防回退)
 *
 * **失败回滚**(R4):
 *   - Step 1 fail:dispatcher 啥也不写,outcome.retryable 字段为 P1.7+ pending-inbound 状态机预留;
 *     **P1.6 broker.ts 仅返回 outcome,不入 pending 队列、不自动重投递**(见模块头 §"当前 slice 4c 行为")
 *   - Step 2a fail:调容器 `/internal/v3/wechat-inbound-compensate`(idempotent / always-200)
 *     把容器侧那条 client_sessions row soft-delete;dispatcher 仅 best-effort,不阻塞 outcome
 *   - Step 2b fail:同上 + 额外 `softDeleteMasterSession` 撤 master sqlite row(若 newSession)
 *   - Step 2b fail **且 reuseSession**:**不**调 compensation(容器侧 row 是合法在用的活会话,
 *     soft-delete 会破坏未来 inbound dispatch)— outcome.compensation='skipped_reuse',让
 *     reconcile 兜底修 pointer
 *
 * **trust 边界**:`bindingUserId` 由 broker 上游(`manager.onInbound` 把 binding 表行转
 * 出来)决定,本 dispatcher **不**信任客户端传来的任何 userId 字段。
 *
 * **不持有 retry 状态机**:dispatcher 是纯单次编排器,仅返 outcome,不做任何后台 retry。
 * **当前 slice 4c 的 broker.ts 实际行为**:对 `command_echo` / `cold_start` 走 fire-and-forget
 * `sendText` 立即反射文案;对 `transport_failed` / `container_rejected` / `step2_failed`
 * **透传**给上游 caller,**不**入任何 pending 队列、**不**自动重投递。"broker 自带 pending
 * inbound 重试 + outbox 状态机" 在 P1.7+ 引入(届时会消化这些 outcome 的 retryable 字段);
 * 本 dispatcher 提前声明 outcome 字段是为该状态机预留接口,不代表 P1.6 已经接上。
 *
 * **不做的事**(显式画线,避免被误改):
 *   - 不做 audit 行 INSERT(broker.ts 集中做)
 *   - 不做反射文案发送(broker.ts 拿 outcome.coldStartReply / command_echo.reply 后 fire-and-forget
 *     走 sendText 直接发给用户。**反射不入 outbox**:outbox.session_id NOT NULL,而反射无 wsess;
 *     性质上也不该走 enqueue→drain 二段延迟)
 *   - 不做 binding 表 SELECT(`bindingUserId` 已经是事实,binding row 由 manager 上游持有)
 */

import { computeInboundNonce } from "../bridgeSecret.js"
import type { WechatImageAttachment, WechatMediaAttachment } from "@openclaude/channel-wechat"
import { rootLogger, type Logger } from "../logging/logger.js"
import type { ContainerUnreadyError, ResolveContainerEndpoint } from "../ws/userChatBridge.js"
import {
  clearRunningSession,
  getCurrentSessionId,
  getCurrentSessionPointer,
  listRunningSessions,
  markRunningSession,
  newWechatSessionId,
  setCurrentSessionId,
  type PgConn,
} from "./sessionPointer.js"
import { isWechatSessionId, type WechatSessionId } from "./types.js"
import { MASTER_USER_PREFIX } from "./userIds.js"

/** 容器侧 inbound handler 路径(master POST → 容器 18789 内 gateway 接)。 */
export const WECHAT_INBOUND_CONTAINER_PATH = "/internal/v3/wechat-inbound"

/** 容器侧 WeChat stop handler 路径(master POST → 容器内 interrupt)。 */
export const WECHAT_STOP_CONTAINER_PATH = "/internal/v3/wechat-stop"

/**
 * 容器侧 inbound 补偿(回滚)路径;handler 必须 idempotent + always-200。
 *
 * **P1.6 → P1.7 契约**:本路径在 P1.6 (slice 4b) 仅在 dispatcher 侧定义并按约调 POST,
 * 容器侧 handler **由 P1.7 落地**(`packages/gateway/src/server.ts` 新加 `handleWechatInboundCompensate`)。
 * P1.6 单测试通过 ContainerTransport mock 验证 dispatcher 调用契约;P1.6 上线但 P1.7 未落地
 * 期间,真实路径会因 gateway 404 而记 `step2_failed.compensation="failed"`。Reconcile 循环
 * (slice 4c)+ grace 期兜底,不会留永久孤儿;仅观测信号会临时弱化。
 */
export const WECHAT_INBOUND_COMPENSATE_PATH = "/internal/v3/wechat-inbound-compensate"

/** Step 1 默认 HTTP 超时(S2 实测:keep-alive 热连 ~200-300ms,5s 足够覆盖网络抖动)。 */
const DEFAULT_STEP1_TIMEOUT_MS = 5_000
/** Step 1 失败后 1 次退避重试的间隔(短退避避免 user 体感卡顿)。 */
const DEFAULT_STEP1_RETRY_BACKOFF_MS = 250
/** Compensation 默认超时;补偿是 best-effort,短超时避免拖慢 dispatcher 返回。 */
const DEFAULT_COMPENSATE_TIMEOUT_MS = 3_000

/** Cold-start 默认 retryAfter(S0 数据驱动:5-10s 冷启,3s 是首次重试的合理切点)。 */
const DEFAULT_COLD_START_RETRY_AFTER_SEC = 3

/** Cold-start 反射给用户的提示文案。文案稳定 — 测试断言依赖。 */
const COLD_START_REPLY = "正在唤醒你的 OpenClaude 容器，通常几秒钟。请稍后再发一次消息。"

/** 命令短路反射文案。文案稳定 — 测试断言依赖。 */
const COMMAND_ECHO_REPLY = "暂不支持这个命令。发送 /help 查看微信里可用的命令，或直接发送问题。"
const CODEX_TEMP_UNAVAILABLE_REPLY = "GPT 模型通道暂时不可用，请稍后再试，或发送 /model 切换到其它模型。"

/** 默认 session title fallback(空白文本 / 全 emoji 截断后空时使用)。 */
const DEFAULT_SESSION_TITLE = "微信会话"

/** 容器侧 handleWechatInbound 对 content.text 的 schema 上限。 */
const WECHAT_INBOUND_TEXT_MAX_CHARS = 65_536

const WECHAT_OUTBOUND_MEDIA_HINT = [
  "",
  "---",
  "【OpenClaude 微信通道系统提示：发送附件】",
  "如果用户要你“发/发送/传/导出/下载/分享”文件、图片、视频、语音或附件，不要只读取或口头描述。",
  "请先把要发给用户的资源创建或复制到当前容器的顶层目录：`/home/agent/.openclaude/generated/<安全文件名.ext>`；也可以复用已存在的 `/home/agent/.openclaude/uploads/<安全文件名.ext>`。",
  "最终回复里必须单独写出这个绝对路径，例如：`/home/agent/.openclaude/generated/example.txt`。微信网关会自动把该路径转换成真实附件发送给用户；路径不要只放在思考过程或工具调用说明里。",
  "安全文件名只能匹配 `[A-Za-z0-9._@+=,-]{1,180}`；不要使用子目录。支持示例：txt, md, pdf, csv, json, docx, xlsx, pptx, zip, png/jpg, mp4, mp3。",
  "如果用户说“随便发我一个文件”，请生成一个小的 txt 或 md 文件后再给出路径。没有创建/复制文件并给出上述路径前，不要声称已经发给用户。",
].join("\n")

// `MASTER_USER_PREFIX` 是 PG-side raw digit ↔ sqlite-side `c:<digit>` 命名约定的边界
// 常量,集中在 `userIds.ts` 维护;outboxWorker 也用同一来源做相同翻译。
// 见 userIds.ts 的模块注释。

// ─── 输入 / 输出契约 ────────────────────────────────────────────────────────

export interface InboundEvent {
  /** Binding 表 lookup 得来的 commercial uid(stringified)— **不**信任客户端输入。 */
  bindingUserId: string
  /** Optional iLink bot account id; broker uses it for audit/dedupe before dispatch. */
  accountId?: string
  /** WeChat openid 衍生(base64url),用于容器侧 peer.meta.senderId。 */
  senderId: string
  /** 入站文字(已 trim / unescape;sanitize markdown 在 outbound 渲染处做)。 */
  text: string
  /** Optional raw iLink message id; empty string is normalized to NULL by audit. */
  messageId?: string
  /** Optional comma-separated raw iLink item kinds for audit. */
  itemTypes?: string
  /** Optional full raw iLink payload for audit/debug. */
  rawPayload?: unknown
  /** Extracted iLink image attachments; broker may enrich text before dispatch. */
  imageAttachments?: WechatImageAttachment[]
  /** Extracted iLink media attachments; broker may enrich text before dispatch. */
  mediaAttachments?: WechatMediaAttachment[]
  /** = wechatMessageId;容器内 dispatchInbound 用作 idempotency key,重投递安全。 */
  idempotencyKey: string
  /** P1 默认 'main';P3 多 agent / commands 时由 broker 路由确定。 */
  agentId?: string
  /** broker 接到 inbound 那刻(epoch ms);容器侧 wechatTs 透传。 */
  receivedAt: number
  /** 可选追溯;不在则 dispatcher 自分一个 requestId 走 log。 */
  traceId?: string
}

/**
 * Dispatch 单次结果。所有 kind 都是 "终态" — 调用方按 kind 决定后续动作。
 *
 * **P1.6 (slice 4c) broker.ts 实际处理**:
 *   command_echo / cold_start  → broker 把 reply 文本 fire-and-forget 直接 sendText
 *                                 (不入 outbox,见模块头注释),**不**重试 evt
 *   dispatched                 → 成功,broker 透传 outcome 给上游 caller(无 pending 内存表)
 *   container_rejected         → broker **透传**(retryable 字段为 P1.7+ pending-inbound
 *                                 状态机预留;P1.6 不消化、不重试、不入 outbox)
 *   transport_failed           → broker **透传**(同上,P1.6 无 outbox inbound retry)
 *   step2_failed               → 已 best-effort 补偿;reconcile 30s 兜底清孤儿
 *   tunnel_unsupported         → P1 占位;slice 4c 注入 tunnel transport 后该 outcome 消失
 */
export type DispatchOutcome =
  | { kind: "command_echo"; reply: string }
  | { kind: "dispatched"; sessionId: WechatSessionId; newSession: boolean; started?: boolean }
  | {
      kind: "cold_start"
      reason: string
      retryAfterSec: number
      coldStartReply: string
    }
  | {
      kind: "container_rejected"
      status: number
      retryable: boolean
      errMessage: string
    }
  | {
      kind: "transport_failed"
      phase: "step1"
      retryable: true
      errMessage: string
    }
  | {
      kind: "step2_failed"
      phase: "master_sqlite" | "pg_pointer"
      compensation: "ok" | "failed" | "skipped_reuse"
      errMessage: string
    }
  | { kind: "tunnel_unsupported"; errMessage: string }

export type StopOutcome = { kind: "command_echo"; reply: string; interrupted: boolean }

/**
 * 容器 endpoint transport 抽象。
 *
 * - self-host 默认实装:直拨 `${host}:${port}${path}` 走 node:http keep-alive Agent
 * - remote-host:slice 4c 注入 tunnel-aware impl,反向经 node-agent;dispatcher 不关心
 *   具体走法,只看 `supportsTunnel` 能力位
 *
 * Codex r2 WARN:返回值带 `headers` 让 dispatcher 解析 `retry-after` 头(容器侧 202
 * cold-start 用 header 通知重试节奏);body 优先,header fallback。
 */
export interface ContainerTransport {
  post(
    endpoint: { host: string; port: number; tunnel?: unknown },
    path: string,
    headers: Record<string, string>,
    bodyJson: string,
    timeoutMs: number,
  ): Promise<{ status: number; bodyText: string; headers?: Record<string, string> }>
  /** true → 接受 endpoint.tunnel;false / undefined → 默认 self-host only。 */
  supportsTunnel?: boolean
}

export interface WechatCodexRouteFrame {
  baseUrl: string
  modelProvider: string
  providerName: string | null
  wireApi: "responses" | "chat"
  preferredAuthMethod: "apikey" | "chatgpt"
  disableResponseStorage: boolean
}

export type PrepareWechatCodexTurnResult =
  | {
      kind: "ready"
      /** 32-hex master-owned request id used for Codex billing correlation. */
      requestId: string
      /** Private master-owned api-relay route; WeChat deliberately does not support official_oauth here. */
      routeFrame: WechatCodexRouteFrame
    }
  | { kind: "unavailable"; reply?: string }

export interface InboundDispatcherDeps {
  pgPool: PgConn
  resolveContainerEndpoint: ResolveContainerEndpoint
  /** master 的 bridge HMAC root secret(载于 `/var/lib/openclaude/.v3-bridge-secret`)。 */
  bridgeSecret: string
  /**
   * master sqlite 写 `client_sessions` 一行(originChannel='wechat')。
   * slice 4c 注入(用 @openclaude/storage 的 helper)— 4b 测试可直接 mock。
   *
   * 失败需 throw — dispatcher 把 throw 翻译成 step2_failed outcome。
   */
  upsertMasterClientSession: (params: {
    sessionId: WechatSessionId
    userId: string
    agentId: string
    originChannel: "wechat"
    title: string
    createdAt: number
    lastAt: number
  }) => Promise<void>
  /**
   * Step 2b 失败时,撤销 Step 2a 写入(仅 newSession 路径需要)。
   * 失败 throw → dispatcher log.error 但不影响 outcome(已经在失败链路上)。
   */
  softDeleteMasterSession: (sessionId: WechatSessionId, userId: string) => Promise<void>
  /** wsess id 生成器 — 默认 newWechatSessionId,测试注入固定值便于断言。 */
  newSessionId?: () => WechatSessionId
  /** HTTP transport(self-host 默认 + tunnel slice 4c 注入)。 */
  transport: ContainerTransport
  /**
   * Resolve the model id that WeChat should use for this binding.
   *
   * Commercial wiring keeps this aligned with the user's web default model and
   * model grants. `null`/`undefined` means "use the container's current agent
   * default" for backward compatibility. Throws are logged and ignored so a
   * transient preferences/authz lookup failure does not drop the inbound text.
   */
  resolveModel?: (bindingUserId: string) => Promise<string | null | undefined>
  /**
   * Prepare a WeChat Codex turn before dispatching to the container.
   *
   * Commercial wiring creates an api-relay route, performs billing precheck,
   * registers the pending finalizer, and returns the private route + requestId
   * to inject into the container frame. `unavailable` means reply locally and do
   * not POST to the container. Undefined preserves non-commercial/test fallback.
   */
  prepareCodexTurn?: (args: {
    containerId: number
    bindingUserId: string
    userId: bigint
    modelId: string
    agentId: string
    traceId: string
  }) => Promise<PrepareWechatCodexTurnResult>
  /**
   * Abort a prepared Codex turn when the container definitely did not dispatch
   * it (schema/auth/cold-start pre-dispatch responses). Ambiguous transport/5xx
   * failures intentionally do not call this; the pending timeout owns cleanup.
   */
  failCodexTurn?: (requestId: string, reason: string) => Promise<void>
  /** 单次 Step 1 timeout;默认 5000 ms。 */
  step1TimeoutMs?: number
  /** Step 1 失败后单次退避重试间隔;默认 250 ms。 */
  step1RetryBackoffMs?: number
  /** Compensation 单次 timeout;默认 3000 ms。 */
  compensateTimeoutMs?: number
  /** 注入便于测试。默认 Date.now。 */
  now?: () => number
  /** 注入便于测试。默认 crypto.randomUUID()。 */
  newRequestId?: () => string
  logger?: Logger
}

export interface InboundDispatcher {
  dispatch(evt: InboundEvent): Promise<DispatchOutcome>
  stop(evt: InboundEvent): Promise<StopOutcome>
}

// ─── 实现 ──────────────────────────────────────────────────────────────────

export function makeInboundDispatcher(deps: InboundDispatcherDeps): InboundDispatcher {
  const log = (deps.logger ?? rootLogger).child({ subsys: "wechatInboundDispatcher" })
  const now = deps.now ?? (() => Date.now())
  const newSessionId = deps.newSessionId ?? (() => newWechatSessionId())
  const newRequestId = deps.newRequestId ?? defaultRequestId
  const step1TimeoutMs = deps.step1TimeoutMs ?? DEFAULT_STEP1_TIMEOUT_MS
  const step1RetryBackoffMs = deps.step1RetryBackoffMs ?? DEFAULT_STEP1_RETRY_BACKOFF_MS
  const compensateTimeoutMs = deps.compensateTimeoutMs ?? DEFAULT_COMPENSATE_TIMEOUT_MS

  return {
    async dispatch(evt: InboundEvent): Promise<DispatchOutcome> {
      const requestId = newRequestId()
      const agentId = evt.agentId ?? "main"
      const reqLog = log.child({
        requestId,
        bindingUserId: evt.bindingUserId,
        idempotencyKey: evt.idempotencyKey,
        traceId: evt.traceId,
      })

      // ── 0) 命令短路 ────────────────────────────────────────────────────
      // **literal** "/" 开头:`text="/list"` 算命令,`text="  /list"` 因前导空格不算
      // ——保持 telegram/personal-wechat 既有语义,空格强制让用户走"输入文本"路径
      if (evt.text.startsWith("/")) {
        reqLog.info("command_echo", { firstChar: evt.text[0] })
        return { kind: "command_echo", reply: COMMAND_ECHO_REPLY }
      }

      // ── 1) endpoint 解析 + cold-start UX ──────────────────────────────
      let endpoint
      try {
        endpoint = await deps.resolveContainerEndpoint(BigInt(evt.bindingUserId))
      } catch (err) {
        if (isContainerUnreadyError(err)) {
          reqLog.info("cold_start", { reason: err.reason, retryAfterSec: err.retryAfterSec })
          return {
            kind: "cold_start",
            reason: err.reason,
            retryAfterSec: err.retryAfterSec,
            coldStartReply: COLD_START_REPLY,
          }
        }
        reqLog.error("resolve_endpoint_failed", {
          errMessage: (err as Error)?.message ?? String(err),
        })
        return {
          kind: "transport_failed",
          phase: "step1",
          retryable: true,
          errMessage: `resolveContainerEndpoint failed: ${(err as Error)?.message ?? String(err)}`,
        }
      }

      if (endpoint.containerId === undefined) {
        reqLog.error("container_id_missing_from_resolver", {})
        return {
          kind: "container_rejected",
          status: 0,
          retryable: false,
          errMessage: "container_id_missing_from_resolver",
        }
      }

      if (endpoint.tunnel !== undefined && !deps.transport.supportsTunnel) {
        reqLog.warn("tunnel_unsupported_in_p1", { containerId: endpoint.containerId })
        return {
          kind: "tunnel_unsupported",
          errMessage: "P1 transport does not support remote-host tunnel; P1.7+ pending-inbound state machine may retry once tunnel transport is wired",
        }
      }

      // ── 2) pointer lookup or allocate ─────────────────────────────────
      let current: WechatSessionId | null
      try {
        current = await getCurrentSessionId(deps.pgPool, evt.bindingUserId)
      } catch (err) {
        reqLog.error("pointer_read_failed", {
          errMessage: (err as Error)?.message ?? String(err),
        })
        return {
          kind: "transport_failed",
          phase: "step1",
          retryable: true,
          errMessage: `pointer read failed: ${(err as Error)?.message ?? String(err)}`,
        }
      }

      let sessionId: WechatSessionId = current ?? newSessionId()
      const newSession = current === null
      let shouldUpsertMasterSession = newSession
      let shouldSetCurrentPointer = true
      let routedAgentId = agentId

      // **稳定时间戳**:Step 2a 的 createdAt / lastAt 用同一 now() pin 住,避免一次 dispatch
      // 内 createdAt / lastAt 错开 1 ms(测试 `createdAt === lastAt` 断言依赖)。
      const dispatchNow = now()
      const nonce = computeInboundNonce(deps.bridgeSecret, endpoint.containerId)
      const sessionTitle = deriveSessionTitle(evt.text)
      const model = await resolveModelForDispatch(evt.bindingUserId, deps.resolveModel, reqLog)
      let preparedCodexTurn: Extract<PrepareWechatCodexTurnResult, { kind: "ready" }> | null = null
      if (model?.startsWith("gpt-") && deps.prepareCodexTurn) {
        try {
          const prepared = await deps.prepareCodexTurn({
            containerId: endpoint.containerId,
            bindingUserId: evt.bindingUserId,
            userId: BigInt(evt.bindingUserId),
            modelId: model,
            agentId,
            traceId: requestId,
          })
          if (prepared.kind === "unavailable") {
            reqLog.warn("codex_turn_unavailable", { model })
            return {
              kind: "command_echo",
              reply: prepared.reply ?? CODEX_TEMP_UNAVAILABLE_REPLY,
            }
          }
          preparedCodexTurn = prepared
        } catch (err) {
          reqLog.error("prepare_codex_turn_failed", {
            model,
            errMessage: (err as Error)?.message ?? String(err),
          })
          return { kind: "command_echo", reply: CODEX_TEMP_UNAVAILABLE_REPLY }
        }
      }

      const failPreparedCodexTurn = async (reason: string): Promise<void> => {
        if (!preparedCodexTurn || !deps.failCodexTurn) return
        try {
          await deps.failCodexTurn(preparedCodexTurn.requestId, reason)
        } catch (err) {
          reqLog.warn("fail_prepared_codex_turn_failed", {
            reason,
            requestId: preparedCodexTurn.requestId,
            errMessage: (err as Error)?.message ?? String(err),
          })
        }
      }

      // ── 3) Step 1: POST 容器 /internal/v3/wechat-inbound ──────────────
      //
      // **wire schema** 与 packages/gateway/src/server.ts:`handleWechatInbound` 严格对齐:
      //   userId           = `c:` + bindingUserId  (与容器 owner id 字节级一致)
      //   peer.kind        = 'dm'                  (P1 仅 DM,group 留给 future phase)
      //   peer.id          = sessionId             (broker 保证 1:1 wsess→peer.id;sessionKey
      //                                             由容器 dispatchInbound 用 agentId+channel+
      //                                             peer.kind+peer.id 派生,broker 切 session
      //                                             = peer.id 变 = 容器看到新 session)
      //   peer.displayName = senderId              (P1.7 slice 7c senderId carrier — Peer
      //                                             协议已有的可选字段。WeChat 用户的 stable
      //                                             id 就是 openid 衍生 base64url,语义对齐。
      //                                             容器侧 dispatchInbound 把 displayName 透传
      //                                             到 OutboundMessage.peer.displayName,v3
      //                                             WechatOutbound channel adapter 在 send 时
      //                                             读它构造 peer.meta.senderId POST 给 master
      //                                             /internal/v3/wechat-outbound — schema 要求)
      //   idempotencyKey   = WeChat msgId          (dispatchInbound 用作幂等键,重投递安全)
      //   ts               = broker 收到 inbound 那刻 epoch ms
      //   content.text     = 入站文字              (P1 text-only)
      //   agentId          = evt.agentId 或 'main'
      //
      // 不传:sessionMeta(容器侧 client_sessions 由 sessionManager.handleResult 路径
      // 自己写;master 侧 client_sessions 是 dispatcher Step 2a 直接 upsertMasterClient
      // Session,不经 wire body),traceId(用 x-request-id header 关联)。
      const dispatchText = withWechatOutboundMediaHint(evt.text)
      const wireBody = {
        userId: MASTER_USER_PREFIX + evt.bindingUserId,
        peer: { kind: "dm" as const, id: sessionId, displayName: evt.senderId },
        idempotencyKey: evt.idempotencyKey,
        ts: evt.receivedAt,
        agentId,
        ...(model ? { model } : {}),
        ...(preparedCodexTurn
          ? {
              requestId: preparedCodexTurn.requestId,
              __oc_codex_route: preparedCodexTurn.routeFrame,
            }
          : {}),
        content: { text: dispatchText },
      }
      const wireHeaders: Record<string, string> = {
        "content-type": "application/json",
        "x-openclaude-container-id": String(endpoint.containerId),
        "x-openclaude-inbound-nonce": nonce,
        "x-request-id": requestId,
      }
      const wireJson = JSON.stringify(wireBody)

      const step1 = await postStep1WithRetry(
        deps.transport,
        endpoint,
        wireHeaders,
        wireJson,
        step1TimeoutMs,
        step1RetryBackoffMs,
        reqLog,
      )

      if (step1.kind === "transport_error") {
        reqLog.warn("step1_transport_failed_final", { errMessage: step1.errMessage })
        return {
          kind: "transport_failed",
          phase: "step1",
          retryable: true,
          errMessage: step1.errMessage,
        }
      }

      if (step1.response.status === 202) {
        // 容器侧主动告知 "我冷启中"。优先解析 body.retryAfterSec / retryAfterMs,
        // 否则 fallback 到默认 3s。
        const retryAfterSec = parseRetryAfterSec(step1.response)
        reqLog.info("container_cold_start", { retryAfterSec })
        await failPreparedCodexTurn("wechat_container_cold_start")
        return {
          kind: "cold_start",
          reason: "container_internal_cold",
          retryAfterSec,
          coldStartReply: COLD_START_REPLY,
        }
      }

      if (step1.response.status !== 200) {
        // retryable 字段为 P1.7+ pending-inbound 状态机预留;**P1.6 broker.ts 仅返 outcome,
        // 不消费 retryable**(透传给上游 caller,无自动重投递):
        //   401/403/404/410 = permanent(认证 / 路由错配 / 容器已废弃)
        //   4xx 其他(400/413/429 等)= permanent(配置 / 业务规则,无 retry 价值)
        //   5xx                       = transient(P1.7+ 会让 pending-inbound 状态机重试)
        const retryable = step1.response.status >= 500 && step1.response.status < 600
        const truncBody = step1.response.bodyText.slice(0, 256)
        reqLog.warn("step1_container_rejected", { status: step1.response.status, retryable })
        if (step1.response.status >= 400 && step1.response.status < 500) {
          await failPreparedCodexTurn(`wechat_container_rejected_${step1.response.status}`)
        }
        return {
          kind: "container_rejected",
          status: step1.response.status,
          retryable,
          errMessage: truncBody,
        }
      }
      const step1Accepted = parseStep1Accepted(step1.response.bodyText, requestId)
      if (step1Accepted.agentId) {
        routedAgentId = step1Accepted.agentId
      }
      if (step1Accepted.sessionId && step1Accepted.sessionId !== sessionId) {
        reqLog.warn("step1_adopted_original_session", {
          allocatedSessionId: sessionId,
          acceptedSessionId: step1Accepted.sessionId,
        })
        sessionId = step1Accepted.sessionId
        if (current !== null && current !== sessionId) {
          // A retry for an older WeChat message may arrive after the user has
          // already moved the binding pointer to a newer wsess.  Adopt the
          // original runner's wsess for master row / running-session tracking,
          // but never use the retry's later timestamp to move the current
          // pointer backwards.
          shouldSetCurrentPointer = false
          shouldUpsertMasterSession = true
        }
      }

      if (!step1Accepted.accepted) {
        reqLog.info("step1_terminal_before_runner_start", { sessionId })
        await failPreparedCodexTurn("wechat_container_terminal_before_start")
        return { kind: "dispatched", sessionId, newSession, started: false }
      }

      // ── 4) Step 2a: master sqlite client_sessions 写(仅 newSession) ──
      if (shouldUpsertMasterSession) {
        try {
          await deps.upsertMasterClientSession({
            sessionId,
            userId: MASTER_USER_PREFIX + evt.bindingUserId,
            agentId: routedAgentId,
            originChannel: "wechat",
            title: sessionTitle,
            createdAt: dispatchNow,
            lastAt: dispatchNow,
          })
        } catch (err) {
          const errMessage = (err as Error)?.message ?? String(err)
          reqLog.error("step2a_master_sqlite_failed", { sessionId, errMessage })
          const compensation = await tryCompensation(
            deps.transport,
            endpoint,
            sessionId,
            evt.bindingUserId,
            nonce,
            "step2a_failed",
            requestId,
            compensateTimeoutMs,
            reqLog,
          )
          return {
            kind: "step2_failed",
            phase: "master_sqlite",
            compensation,
            errMessage,
          }
        }
      }

      // ── 5) Step 2b: PG wechat_session_pointer 写 ──────────────────────
      if (shouldSetCurrentPointer) {
        try {
          const applied = await setCurrentSessionId(
            deps.pgPool,
            evt.bindingUserId,
            sessionId,
            dispatchNow,
            routedAgentId,
          )
          if (!applied) {
            // updated_at <= EXCLUDED guard 过滤(stale ts):P1 单进程不会真触发,
            // 但 setCurrentSessionId 已经声明 false 是合法应答 — log warn,outcome 算
            // dispatched(容器侧 Step 1 已经完成,pointer 没更新仅意味着指向更旧的活会话,
            // 不算 error)
            reqLog.warn("pointer_write_stale_skip", { sessionId })
          }
        } catch (err) {
          const errMessage = (err as Error)?.message ?? String(err)
          reqLog.error("step2b_pg_pointer_failed", { sessionId, errMessage })

          let compensation: "ok" | "failed" | "skipped_reuse"
          if (newSession) {
            // newSession 路径:容器侧那条 row 是本次 inbound 才建的,撤回安全
            compensation = await tryCompensation(
              deps.transport,
              endpoint,
              sessionId,
              evt.bindingUserId,
              nonce,
              "step2b_failed",
              requestId,
              compensateTimeoutMs,
              reqLog,
            )
            // 同时撤 master sqlite Step 2a 写
            try {
              await deps.softDeleteMasterSession(
                sessionId,
                MASTER_USER_PREFIX + evt.bindingUserId,
              )
            } catch (softErr) {
              reqLog.error("master_softdelete_after_pg_fail_also_failed", {
                sessionId,
                errMessage: (softErr as Error)?.message ?? String(softErr),
              })
              // 不影响 compensation 字段:dispatcher 已尽力,reconcile 兜底
            }
          } else {
            // reuseSession 路径:容器侧 row 是合法在用的活会话,撤回会破坏
            // 未来 dispatchInbound — 跳过 compensation,只 log;pointer 漂移
            // 由 reconcile 兜底修正
            reqLog.warn("step2b_compensation_skipped_reuse", { sessionId })
            compensation = "skipped_reuse"
          }

          return {
            kind: "step2_failed",
            phase: "pg_pointer",
            compensation,
            errMessage,
          }
        }
      } else {
        reqLog.info("pointer_write_skipped_dedup_old_session", {
          sessionId,
          currentSessionId: current,
        })
      }

      if (step1Accepted.started !== false) {
        try {
          await markRunningSession(
            deps.pgPool,
            evt.bindingUserId,
            sessionId,
            step1Accepted.runId,
            routedAgentId,
            dispatchNow,
          )
        } catch (err) {
          reqLog.error("mark_running_session_failed", {
            sessionId,
            runId: step1Accepted.runId,
            errMessage: (err as Error)?.message ?? String(err),
          })
        }
      }

      reqLog.info("dispatched", { sessionId, newSession, started: step1Accepted.started })
      return { kind: "dispatched", sessionId, newSession, started: step1Accepted.started }
    },

    async stop(evt: InboundEvent): Promise<StopOutcome> {
      const requestId = newRequestId()
      const agentId = evt.agentId ?? "main"
      const reqLog = log.child({
        requestId,
        bindingUserId: evt.bindingUserId,
        idempotencyKey: evt.idempotencyKey,
        traceId: evt.traceId,
      })

      let targets: Array<{ sessionId: WechatSessionId; runId: string; agentId?: string }> = []
      try {
        targets = await listRunningSessions(deps.pgPool, evt.bindingUserId)
      } catch (err) {
        reqLog.error("stop_running_sessions_read_failed", {
          errMessage: (err as Error)?.message ?? String(err),
        })
        // Keep /stop usable during migration or a transient read failure on
        // the new running-session table: fall back to the legacy current
        // pointer below and let the container scan live runners by wsess.
      }

      let pointer: Awaited<ReturnType<typeof getCurrentSessionPointer>> | null = null
      try {
        pointer = await getCurrentSessionPointer(deps.pgPool, evt.bindingUserId)
      } catch (err) {
        reqLog.error("stop_pointer_read_failed", {
          errMessage: (err as Error)?.message ?? String(err),
        })
        if (targets.length === 0) {
          return {
            kind: "command_echo",
            interrupted: false,
            reply: "暂时无法读取当前微信任务，请稍后重试；也可以打开实时过程链接在网页端停止。",
          }
        }
      }

      if (pointer) {
        const pointerAgentId = pointer.agentId
        const alreadyTargeted = targets.some(
          (target) =>
            target.sessionId === pointer!.sessionId &&
            (!pointerAgentId || !target.agentId || target.agentId === pointerAgentId),
        )
        if (!alreadyTargeted) {
          targets.push({
            sessionId: pointer.sessionId,
            runId: "pointer-fallback",
            ...(pointerAgentId ? { agentId: pointerAgentId } : {}),
          })
        }
      }

      if (targets.length === 0) {
        return {
          kind: "command_echo",
          interrupted: false,
          reply: "当前没有可中断的微信任务。",
        }
      }

      let endpoint
      try {
        endpoint = await deps.resolveContainerEndpoint(BigInt(evt.bindingUserId))
      } catch (err) {
        if (isContainerUnreadyError(err)) {
          return {
            kind: "command_echo",
            interrupted: false,
            reply: "容器正在唤醒中，暂时没有可中断的运行任务。",
          }
        }
        reqLog.error("stop_resolve_endpoint_failed", {
          errMessage: (err as Error)?.message ?? String(err),
        })
        return {
          kind: "command_echo",
          interrupted: false,
          reply: "中断指令暂时发送失败，请稍后重试；也可以打开实时过程链接在网页端停止。",
        }
      }
      if (endpoint.containerId === undefined) {
        reqLog.error("stop_container_id_missing_from_resolver", {})
        return {
          kind: "command_echo",
          interrupted: false,
          reply: "中断指令暂时发送失败：容器状态异常。",
        }
      }
      if (endpoint.tunnel !== undefined && !deps.transport.supportsTunnel) {
        reqLog.warn("stop_tunnel_unsupported", { containerId: endpoint.containerId })
        return {
          kind: "command_echo",
          interrupted: false,
          reply: "当前容器连接方式暂不支持微信内中断，请打开实时过程链接在网页端停止。",
        }
      }

      const nonce = computeInboundNonce(deps.bridgeSecret, endpoint.containerId)
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-openclaude-container-id": String(endpoint.containerId),
        "x-openclaude-inbound-nonce": nonce,
        "x-request-id": requestId,
      }

      let interruptedCount = 0
      let failureCount = 0
      for (const target of targets) {
        const targetAgentId =
          target.agentId ?? (target.runId === "pointer-fallback" ? undefined : agentId)
        const bodyJson = JSON.stringify({
          userId: MASTER_USER_PREFIX + evt.bindingUserId,
          peer: { kind: "dm" as const, id: target.sessionId },
          ...(targetAgentId ? { agentId: targetAgentId } : {}),
        })
        const stopRes = await postWithRetry(
          deps.transport,
          WECHAT_STOP_CONTAINER_PATH,
          endpoint,
          headers,
          bodyJson,
          step1TimeoutMs,
          step1RetryBackoffMs,
          reqLog,
        )
        if (stopRes.kind === "transport_error") {
          failureCount++
          reqLog.warn("stop_transport_failed_final", {
            sessionId: target.sessionId,
            errMessage: stopRes.errMessage,
          })
          continue
        }
        if (stopRes.response.status < 200 || stopRes.response.status >= 300) {
          failureCount++
          reqLog.warn("stop_container_rejected", {
            sessionId: target.sessionId,
            status: stopRes.response.status,
            bodyText: stopRes.response.bodyText.slice(0, 256),
          })
          continue
        }

        let interrupted = false
        try {
          const parsed = JSON.parse(stopRes.response.bodyText) as { interrupted?: unknown }
          interrupted = parsed.interrupted === true
        } catch {
          interrupted = false
        }
        if (interrupted) {
          interruptedCount++
          if (target.runId !== "pointer-fallback") {
            try {
              await clearRunningSession(deps.pgPool, evt.bindingUserId, target.sessionId, target.runId)
            } catch (err) {
              reqLog.warn("stop_clear_running_session_failed", {
                sessionId: target.sessionId,
                errMessage: (err as Error)?.message ?? String(err),
              })
            }
          }
        } else if (target.runId !== "pointer-fallback") {
          reqLog.info("stop_not_interrupted_keep_running_session", {
            sessionId: target.sessionId,
            runId: target.runId,
          })
        }
      }

      const interrupted = interruptedCount > 0
      const total = targets.length
      return {
        kind: "command_echo",
        interrupted,
        reply: interrupted
          ? total > 1
            ? `已发送中断指令（${interruptedCount}/${total} 个运行任务）。任务会尽快停止；如需查看状态，请打开实时过程链接。`
            : "已发送中断指令。正在运行的任务会尽快停止；如需查看状态，请打开实时过程链接。"
          : failureCount > 0
            ? "中断指令暂时发送失败，请稍后重试；也可以打开实时过程链接在网页端停止。"
            : "当前没有正在运行的任务，可能已经结束；如页面仍显示运行中，可在实时过程链接里再点停止。",
      }
    },
  }
}

// ─── 私有 helpers ──────────────────────────────────────────────────────────

type Step1Result =
  | { kind: "ok"; response: { status: number; bodyText: string; headers?: Record<string, string> } }
  | { kind: "transport_error"; errMessage: string }

async function resolveModelForDispatch(
  bindingUserId: string,
  resolveModel: InboundDispatcherDeps["resolveModel"],
  log: Logger,
): Promise<string | null> {
  if (!resolveModel) return null
  try {
    const model = await resolveModel(bindingUserId)
    if (typeof model !== "string") return null
    const trimmed = model.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (err) {
    log.warn("resolve_model_failed", {
      bindingUserId,
      errMessage: (err as Error)?.message ?? String(err),
    })
    return null
  }
}

async function postStep1WithRetry(
  transport: ContainerTransport,
  endpoint: { host: string; port: number; tunnel?: unknown },
  headers: Record<string, string>,
  bodyJson: string,
  timeoutMs: number,
  retryBackoffMs: number,
  log: Logger,
): Promise<{ kind: "transport_error"; errMessage: string } | { kind: "ok"; response: { status: number; bodyText: string; headers?: Record<string, string> } }> {
  return postWithRetry(
    transport,
    WECHAT_INBOUND_CONTAINER_PATH,
    endpoint,
    headers,
    bodyJson,
    timeoutMs,
    retryBackoffMs,
    log,
  )
}

async function postWithRetry(
  transport: ContainerTransport,
  path: string,
  endpoint: { host: string; port: number; tunnel?: unknown },
  headers: Record<string, string>,
  bodyJson: string,
  timeoutMs: number,
  retryBackoffMs: number,
  log: Logger,
): Promise<{ kind: "transport_error"; errMessage: string } | { kind: "ok"; response: { status: number; bodyText: string; headers?: Record<string, string> } }> {
  // 仅 transport 层错(connect refused / timeout / DNS / TLS)走 1 次退避重试;
  // HTTP 应答(任意 status code)即视为"网络已通",由上层按 status code 分流。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await transport.post(
        endpoint,
        path,
        headers,
        bodyJson,
        timeoutMs,
      )
      return { kind: "ok", response }
    } catch (err) {
      const errMessage = (err as Error)?.message ?? String(err)
      if (attempt === 0) {
        log.warn("step1_transport_retry", { errMessage, backoffMs: retryBackoffMs })
        await sleep(retryBackoffMs)
        continue
      }
      return { kind: "transport_error", errMessage }
    }
  }
  /* unreachable */
  return { kind: "transport_error", errMessage: "unreachable" }
}

async function tryCompensation(
  transport: ContainerTransport,
  endpoint: { host: string; port: number; tunnel?: unknown },
  sessionId: WechatSessionId,
  bindingUserId: string,
  nonce: string,
  reason: "step2a_failed" | "step2b_failed",
  requestId: string,
  timeoutMs: number,
  log: Logger,
): Promise<"ok" | "failed"> {
  // 容器侧 handler 必须 idempotent + always-200(per Codex r2 plan review)。
  // dispatcher 这边:transport 错 → "failed";200 body 含 `ok:false` → "failed"。
  const bodyJson = JSON.stringify({
    sessionId,
    bindingUserId,
    reason,
    traceId: requestId,
  })
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-openclaude-container-id": "", // caller 应该已 verify endpoint.containerId 非空;这里下方再覆盖
    "x-openclaude-inbound-nonce": nonce,
    "x-request-id": requestId,
  }
  // 上游已经 verify endpoint.containerId 非空(dispatcher Step 1 入口),
  // 这里再次 stringify 兜底取 endpoint 的 containerId
  // 注:transport.post 不读这个字段,但容器侧 checkInboundBypass 用它做匹配
  if ("containerId" in endpoint && (endpoint as { containerId?: number | string }).containerId !== undefined) {
    headers["x-openclaude-container-id"] = String((endpoint as { containerId?: number | string }).containerId)
  }

  try {
    const res = await transport.post(
      endpoint,
      WECHAT_INBOUND_COMPENSATE_PATH,
      headers,
      bodyJson,
      timeoutMs,
    )
    if (res.status !== 200) {
      log.error("compensation_non_200", { status: res.status, sessionId })
      return "failed"
    }
    // contract: 200 body 可能含 `{ ok: false, code }` 描述容器侧 issue。
    // 解析失败按 "ok" 处理 — 容器侧 200 已经说明请求被收到。
    try {
      const parsed = JSON.parse(res.bodyText) as { ok?: unknown }
      if (parsed.ok === false) {
        log.warn("compensation_body_not_ok", { sessionId, bodyText: res.bodyText.slice(0, 256) })
        return "failed"
      }
    } catch {
      log.warn("compensation_body_unparseable_treat_ok", {
        sessionId,
        bodyText: res.bodyText.slice(0, 256),
      })
    }
    log.info("compensation_ok", { sessionId, reason })
    return "ok"
  } catch (err) {
    const errMessage = (err as Error)?.message ?? String(err)
    log.error("compensation_transport_failed", { sessionId, errMessage })
    return "failed"
  }
}

function isContainerUnreadyError(err: unknown): err is ContainerUnreadyError {
  return (
    err instanceof Error &&
    err.name === "ContainerUnreadyError" &&
    typeof (err as { retryAfterSec?: unknown }).retryAfterSec === "number" &&
    typeof (err as { reason?: unknown }).reason === "string"
  )
}

/**
 * 容器 202 cold-start 时解析重试节奏。优先级:
 *   1. body JSON `{ retryAfterMs }` 或 `{ retryAfterSec }`
 *   2. header `retry-after`(秒整数,符合 HTTP/1.1 RFC 7231 §7.1.3)
 *   3. fallback DEFAULT_COLD_START_RETRY_AFTER_SEC
 *
 * 严格上界 60s — 容器冷启不该超过此值,防错配把 user 卡死。
 */
function parseRetryAfterSec(response: {
  status: number
  bodyText: string
  headers?: Record<string, string>
}): number {
  const MAX_RETRY_SEC = 60

  // 1) body 优先
  try {
    const parsed = JSON.parse(response.bodyText) as {
      retryAfterMs?: unknown
      retryAfterSec?: unknown
    }
    if (typeof parsed.retryAfterMs === "number" && parsed.retryAfterMs > 0) {
      return clamp(Math.ceil(parsed.retryAfterMs / 1000), 1, MAX_RETRY_SEC)
    }
    if (typeof parsed.retryAfterSec === "number" && parsed.retryAfterSec > 0) {
      return clamp(Math.ceil(parsed.retryAfterSec), 1, MAX_RETRY_SEC)
    }
  } catch {
    /* body 不是 JSON — 走 header */
  }

  // 2) header
  const hdr = response.headers?.["retry-after"] ?? response.headers?.["Retry-After"]
  if (hdr !== undefined) {
    const n = Number(hdr)
    if (Number.isFinite(n) && n > 0) {
      return clamp(Math.ceil(n), 1, MAX_RETRY_SEC)
    }
  }

  // 3) fallback
  return DEFAULT_COLD_START_RETRY_AFTER_SEC
}

function parseStep1Accepted(
  bodyText: string,
  fallbackRunId: string,
): { accepted: boolean; started: boolean; runId: string; sessionId?: WechatSessionId; agentId?: string } {
  try {
    const parsed = JSON.parse(bodyText) as {
      accepted?: unknown
      started?: unknown
      traceId?: unknown
      sessionId?: unknown
      peerId?: unknown
      sessionKey?: unknown
      agentId?: unknown
    }
    const traceId = typeof parsed.traceId === "string" && parsed.traceId.length > 0
      ? parsed.traceId
      : fallbackRunId
    const explicitSessionId = typeof parsed.sessionId === "string"
      ? parsed.sessionId
      : typeof parsed.peerId === "string"
        ? parsed.peerId
        : undefined
    let sessionId = explicitSessionId && isWechatSessionId(explicitSessionId)
      ? explicitSessionId
      : undefined
    const explicitAgentId = typeof parsed.agentId === "string" && isSafeAgentId(parsed.agentId)
      ? parsed.agentId
      : undefined
    let agentId = explicitAgentId
    if (typeof parsed.sessionKey === "string") {
      const match = /^agent:([^:]+):webchat:dm:(wsess-[0-9a-f]{16})$/.exec(parsed.sessionKey)
      if (match?.[1] && isSafeAgentId(match[1]) && !agentId) agentId = match[1]
      if (match?.[2] && isWechatSessionId(match[2]) && !sessionId) sessionId = match[2]
    }
    return {
      accepted: parsed.accepted !== false,
      started: parsed.started !== false,
      runId: traceId,
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
    }
  } catch {
    return { accepted: true, started: true, runId: fallbackRunId }
  }
}

function isSafeAgentId(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(s)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * 衍生 session title:取 text 第一个非空白 unicode "图形簇" 上界 30 个 code point。
 *
 * - `text="你好,帮我看一下今天 PR"` → `"你好,帮我看一下今天 PR"`
 * - `text="👨‍👩‍👧 emoji"` → `Array.from` 切 emoji 在 ZWJ 处,代价可接受(P3 真需要 grapheme cluster 再上 Intl.Segmenter)
 * - `text="   "` → `DEFAULT_SESSION_TITLE`("微信会话")
 * - `text=""` → `DEFAULT_SESSION_TITLE`
 *
 * 不用 `slice(0, 30)`(会在 UTF-16 surrogate pair 中间切断,出乱码)。
 */
function deriveSessionTitle(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return DEFAULT_SESSION_TITLE
  const codePoints = Array.from(trimmed)
  if (codePoints.length === 0) return DEFAULT_SESSION_TITLE
  return codePoints.slice(0, 30).join("")
}

function withWechatOutboundMediaHint(text: string): string {
  if (!shouldIncludeWechatOutboundMediaHint(text)) return text
  const hinted = `${text}${WECHAT_OUTBOUND_MEDIA_HINT}`
  if (hinted.length > WECHAT_INBOUND_TEXT_MAX_CHARS) return text
  return hinted
}

function shouldIncludeWechatOutboundMediaHint(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (/^https?:\/\//i.test(normalized)) return false
  const lower = normalized.toLowerCase()
  const action =
    "(?:发|发送|传|传给|给我发|发我|发给我|分享|导出|下载|保存|生成|做一份|给我一个|send|share|attach|attachment|export|download|deliver|generate)"
  const media =
    "(?:文件|附件|图片|照片|图像|视频|语音|音频|录音|文档|报告|表格|压缩包|pdf|txt|md|csv|json|docx|xlsx|pptx|zip|png|jpe?g|mp4|mp3)"
  return (
    new RegExp(`${action}[\\s\\S]{0,32}${media}`, "i").test(lower) ||
    new RegExp(`${media}[\\s\\S]{0,32}${action}`, "i").test(lower)
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultRequestId(): string {
  // 不强依赖 crypto.randomUUID 以保兼容性:base36 时间戳 + 短随机就够 log 串联
  const rand = Math.random().toString(36).slice(2, 10)
  return `wci-${Date.now().toString(36)}-${rand}`
}
