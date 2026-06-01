/**
 * v3 commercial WeChat broker — 顶层 singleton。
 *
 * 详见 docs/v3/wechat-broker-design.md §3 / §4.7 / §4.8 / §4.9。
 *
 * **职责**:把 slice 2-4b 各自独立的零件(inboundDispatcher / outboundReceiver /
 * outboxWorker / sessionPointer)组装成一个生命周期受控、feature-flag 化的 broker。
 *
 *   1) `onInbound(evt)` — manager.onInbound 接到 inbound text 后唯一入口;
 *      gate(brokerEnabled?)→ dispatch → 命令短路 / cold-start 的反射文案以 **fire-and-forget**
 *      方式直接走 sendText(不入 outbox,避免 outbox session_id NOT NULL 限制带来语义污染)
 *
 *   2) `outboundHandler` — 容器 → master 出站 HTTP handler(挂在 18443 / 18791)。
 *      broker 包一层 enable-gate;disabled 时直接 403 不触 inner receiver。
 *
 *   3) `start()` — 启动 outboxWorker + reconcile timer(默认 30s)+ housekeeping
 *      timer(默认 5min)。三个 timer 各自走 self-scheduling setTimeout + inFlight
 *      guard,避免 setInterval 跨 tick async overlap。
 *
 *   4) `stop()` — 平滑停:先置 stopFlag、清 timer、等所有 inFlight 走完、最后停
 *      outboxWorker。
 *
 * **never throw 契约**:`onInbound` 在 brokerEnabled() 抛 / dispatcher 抛 / sendReflection
 * 抛(同步或异步)的情况下都不允许冒泡;caller(manager.onInbound)的 inbound HTTP path
 * 不应因 broker 内部异常而 500。所有内部 error 翻译成 BrokerInboundOutcome 的 broker_failed /
 * broker_disabled kind 或 log + 静默吞掉。
 *
 * **不做的事**:
 *   - 不读 wechat_bindings(由 getBinding dep 抽象 — P1.7 注入真实 master sqlite 读)
 *   - 不实装 sendText 网络层(由 dep 抽象 — P1.7 注入 iLink HTTP)
 *   - 不发 audit 行 / 不做 inbound rate-limit(P1 占位;P3 加在本文件)
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Pool } from "pg"

import { rootLogger, type Logger } from "../logging/logger.js"
import {
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
} from "./../http/util.js"
import { type InboundDispatcher, type DispatchOutcome, type InboundEvent } from "./inboundDispatcher.js"
import {
  type OutboundReceiverCtx,
  type OutboundReceiverHandler,
} from "./outboundReceiver.js"
import {
  OutboxWorker,
  runHousekeeping,
  type GetBindingFn,
  type SendTextFn,
} from "./outboxWorker.js"
import { DEFAULT_MAX_ATTEMPTS } from "./outboxStore.js"
import {
  RECONCILE_GRACE_MS_DEFAULT,
  activeWsessIdsFromPg,
  listOrphanWechatSessions,
  type PgConn,
} from "./sessionPointer.js"
import type { WechatSessionId } from "./types.js"

/** Reconcile 周期默认值。RFC §4.8。 */
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000

/** Housekeeping 周期默认值。RFC §4.6 + outboxWorker.runHousekeeping。 */
const DEFAULT_HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1000

/**
 * v3 commercial canonical user id 接受形式:`c:<digit>` 或裸 `<digit>`。
 * - `c:<digit>`     — 生产路径(wechat_bindings.user_id / JWT identity / master sqlite
 *                    client_sessions.user_id 全是这个形式)
 * - `<digit>`       — 测试 fixture / 历史 personal-OC 路径 / 已归一化的输入(幂等)
 *
 * 任何其他形式视为非法。`c:abc` 会在这里被 reject,而不是被推迟到 dispatcher
 * `BigInt()` 抛出 — broker 层 log 直接看到原值,可观测性更好(Codex r-pass 建议)。
 */
const COMMERCIAL_BINDING_USER_ID_RE = /^(c:)?[1-9][0-9]{0,18}$/

/**
 * 把 commercial canonical user id 归一为 dispatcher 契约要求的 raw digit。
 *
 * **为什么 broker 层做归一**:
 * - channels-wechat 是 generic 包,personal-OC 也复用,不能感知 `c:` 这种
 *   commercial-only 约定 → 不在 manager 侧剥
 * - dispatcher / gateway wechat-inbound-compensate handler 的 wire 契约都是
 *   raw digit(`COMPENSATE_BINDING_USER_ID_RE = /^[1-9][0-9]{0,18}$/`、
 *   `BigInt(evt.bindingUserId)`、`MASTER_USER_PREFIX + evt.bindingUserId`)
 *   → 不在 dispatcher 改契约,因为那要连测试 + gateway compensate handler 一起改
 * - broker 是 commercial-specific 层,在这里翻译"外部 canonical → 内部 raw"
 *   是最清晰的层级边界
 *
 * **不归一的路径**:reflection 经 `deps.getBinding(evt.bindingUserId)` 查
 * master sqlite `wechat_bindings.user_id`(主键存的是 `c:<digit>` canonical 形式)
 * — 反射继续用原始 evt,**只有 dispatch 路径**用归一后的 raw digit。
 */
function normalizeDispatcherBindingUserId(input: string): string {
  if (!COMMERCIAL_BINDING_USER_ID_RE.test(input)) {
    throw new Error(
      `invalid bindingUserId: ${JSON.stringify(input)}; expected "c:<digit>" or raw digit`,
    )
  }
  return input.startsWith("c:") ? input.slice(2) : input
}

// ─── 公开类型 ──────────────────────────────────────────────────────────────

/**
 * `onInbound` 返回的全部分类。
 *
 * dispatch 成功 → 回 dispatcher 原始 DispatchOutcome 透明转;
 * dispatcher 抛 → `broker_failed`(理论不该发生,但 broker never-throw 兜底);
 * brokerEnabled() false 或抛 → `broker_disabled`(caller HTTP 路径据此返 503 / 静默,
 *   不影响其他 inbound 流量)。
 *
 * **不污染 DispatchOutcome 类型**:broker 自己的失败语义不并入 dispatcher 的 union,
 * dispatcher 模块仍可独立测试 / 复用。
 */
export type BrokerInboundOutcome =
  | DispatchOutcome
  | { kind: "duplicate_audit"; reason: string }
  | { kind: "broker_disabled"; reason: string }
  | { kind: "broker_failed"; errMessage: string }

export interface WechatBroker {
  /**
   * 出站 HTTP handler。挂在 master:18443 + self-host:18791 的
   * `/internal/v3/wechat-outbound` 路径。
   *
   * 内部包一层 enable-gate:flag 关闭时直接 403 + 标准安全头,不触底层 receiver。
   */
  outboundHandler: OutboundReceiverHandler
  /**
   * 入站事件入口。manager.onInbound 接到 iLink inbound text 解码完成后调用本函数。
   * 永不 throw — caller 不需要 try/catch。
   */
  onInbound(evt: InboundEvent): Promise<BrokerInboundOutcome>
  /**
   * Best-effort cleanup when a master SQLite binding is unbound.
   *
   * Does not delete outbox rows: queued/sending rows are terminal-failed so
   * outbound_id idempotency tombstones remain intact.
   */
  cleanupBinding(bindingUserId: string): Promise<{ pointerDeleted: boolean; outboxFailed: number }>
  /** 启动 outboxWorker + reconcile + housekeeping 三条 timer。幂等(已 start 再 start 是 no-op)。 */
  start(): void
  /** 平滑停。await 所有 inFlight tick + outboxWorker.stop()。 */
  stop(): Promise<void>
}

export interface BrokerDeps {
  pgPool: Pool
  /** dispatcher 由 caller 注入(slice 4b 测试同款工厂构造好后传进来)。 */
  dispatcher: InboundDispatcher
  /** outbound HTTP handler 由 caller 注入(slice 4a 工厂产出)。 */
  outboundReceiver: OutboundReceiverHandler
  /**
   * Master SQLite 全部 wsess 行(含 userId / createdAt)。
   *
   * P1.7 用 @openclaude/storage 实装,P1.6 测试以 mock 注入。
   * Reconcile tick 一次性 snapshot,避免 listOrphan + softDelete 各跑一遍。
   */
  allMasterWsessRows: () => Promise<Array<{
    id: WechatSessionId
    userId: string
    createdAt: number
  }>>
  /** Reconcile 发现孤儿 → 调本函数 soft-delete master sqlite row。 */
  softDeleteMasterSession: (sessionId: WechatSessionId, userId: string) => Promise<void>
  /** 出站(发给用户的 iLink HTTP)— P1.7 实装,P1.6 测试 mock。 */
  sendText: SendTextFn
  /** 读 master sqlite wechat_bindings(per binding 的 botToken + contextTokens)。 */
  getBinding: GetBindingFn
  /**
   * **runtime 可变** 的开关回调。返 true → broker 接 inbound + 处理出站;false → 关。
   *
   * 用回调而非 boolean 字段:支持 P1.7 接 ConfigService / 环境变量热重载。
   * 抽签时若 callback 抛,broker 视为 disabled(防御性兜底)。
   */
  brokerEnabled: () => boolean

  // ─ 调优 / 测试 ─
  /** Reconcile 周期。默认 30s。 */
  reconcileIntervalMs?: number
  /** Housekeeping 周期。默认 5min。 */
  housekeepingIntervalMs?: number
  /** Reconcile grace 期。默认 RECONCILE_GRACE_MS_DEFAULT(10min)。 */
  reconcileGraceMs?: number
  /** outboxWorker 内部参数透传。 */
  outboxWorker?: {
    maxPerTick?: number
    pollIntervalMs?: number
    maxAttempts?: number
  }
  /** 注入便于测试。默认 Date.now。 */
  now?: () => number
  logger?: Logger
}

// ─── 实现 ──────────────────────────────────────────────────────────────────

export function makeWechatBroker(deps: BrokerDeps): WechatBroker {
  const log = (deps.logger ?? rootLogger).child({ subsys: "wechatBroker" })
  const now = deps.now ?? (() => Date.now())
  const reconcileIntervalMs = deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
  const housekeepingIntervalMs =
    deps.housekeepingIntervalMs ?? DEFAULT_HOUSEKEEPING_INTERVAL_MS
  const reconcileGraceMs = deps.reconcileGraceMs ?? RECONCILE_GRACE_MS_DEFAULT

  const outboxWorker = new OutboxWorker({
    pool: deps.pgPool,
    sendText: deps.sendText,
    getBinding: deps.getBinding,
    log: (level, message) => {
      // outboxWorker 内部已经会 console.* fallback;broker 这里把它桥接到结构化 logger。
      if (level === "error") log.error(`outboxWorker: ${message}`)
      else if (level === "warn") log.warn(`outboxWorker: ${message}`)
      else log.info(`outboxWorker: ${message}`)
    },
    maxPerTick: deps.outboxWorker?.maxPerTick,
    pollIntervalMs: deps.outboxWorker?.pollIntervalMs,
    maxAttempts: deps.outboxWorker?.maxAttempts,
    now,
  })

  let stopFlag = false
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null
  let housekeepingTimer: ReturnType<typeof setTimeout> | null = null
  let reconcileInFlight: Promise<void> | null = null
  let housekeepingInFlight: Promise<void> | null = null
  /**
   * stop() 正在进行时持有的 Promise。null = 没在 stop 中。
   *
   * 用于消除 start/stop 竞态(Codex r5 IMPORTANT#1):若 caller 在 stop() 还
   * 没 await 完成时调 start(),原先的 idempotency 检查会看到 inFlight Promise
   * 仍存在就早退,等 stop 跑完后 stopFlag 留在 true、timer 都已清空 — 重启
   * 请求被静默吞掉。
   *
   * 改用 stoppingPromise + restartRequested 双 flag 显式建模:
   *   - stop() 期间 start() 设 restartRequested=true 就 return
   *   - stop()(IIFE 自带)finally 里看 restartRequested 决定是否 doStart
   */
  let stoppingPromise: Promise<void> | null = null
  let restartRequested = false

  /**
   * 包一层 brokerEnabled() 防御性 catch。callback 抛 → 视为 disabled,
   * caller(onInbound / outboundHandler)按 disabled 路径走。
   */
  function isEnabled(): boolean {
    try {
      return deps.brokerEnabled()
    } catch (err) {
      log.error("brokerEnabled_callback_threw", {
        errMessage: (err as Error)?.message ?? String(err),
      })
      return false
    }
  }

  // ─── outbound handler:disabled 时短路 403,enabled 时透传到 inner receiver ─────
  const outboundHandler: OutboundReceiverHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: OutboundReceiverCtx,
  ): Promise<void> => {
    if (!isEnabled()) {
      // 设置与底层 receiver 一致的安全头 / requestId,sink 行为对齐(防 header 差异
      // 导致 metrics / monitor 误判)。
      setSecurityHeaders(res)
      const requestId = ensureRequestId(req)
      res.setHeader(REQUEST_ID_HEADER, requestId)
      const body = JSON.stringify({
        error: { code: "WECHAT_BROKER_DISABLED", message: "wechat broker is disabled" },
        request_id: requestId,
      })
      res.writeHead(403, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(body, "utf-8")),
        [REQUEST_ID_HEADER]: requestId,
      })
      res.end(body)
      return
    }
    await deps.outboundReceiver(req, res, ctx)
  }

  // ─── onInbound:never-throw + 反射 fire-and-forget ─────────────────────────
  async function onInbound(evt: InboundEvent): Promise<BrokerInboundOutcome> {
    if (!isEnabled()) {
      return { kind: "broker_disabled", reason: "feature_flag_off" }
    }
    // 归一 bindingUserId → dispatcher 契约的 raw digit。
    // 见模块上方 normalizeDispatcherBindingUserId 的注释:reflection 路径继续用
    // 原始 evt(canonical `c:<digit>` 形式,匹配 sqlite getBinding 主键),只有
    // dispatch 路径走归一形式。
    let dispatchBindingUserId: string
    try {
      dispatchBindingUserId = normalizeDispatcherBindingUserId(evt.bindingUserId)
    } catch (err) {
      const errMessage = (err as Error)?.message ?? String(err)
      log.error("invalid_binding_user_id", {
        bindingUserId: evt.bindingUserId,
        idempotencyKey: evt.idempotencyKey,
        errMessage,
      })
      return { kind: "broker_failed", errMessage }
    }
    const dispatchEvt: InboundEvent =
      dispatchBindingUserId === evt.bindingUserId
        ? evt
        : { ...evt, bindingUserId: dispatchBindingUserId }

    const duplicate = await hasCommittedAuditDuplicate(evt)
    if (duplicate === true) {
      log.info("audit_duplicate_inbound_dropped", {
        bindingUserId: evt.bindingUserId,
        accountId: evt.accountId,
        messageId: evt.messageId,
        idempotencyKey: evt.idempotencyKey,
      })
      return { kind: "duplicate_audit", reason: "duplicate_message_id" }
    }

    let outcome: DispatchOutcome
    try {
      outcome = await deps.dispatcher.dispatch(dispatchEvt)
    } catch (err) {
      const errMessage = (err as Error)?.message ?? String(err)
      log.error("dispatcher_threw", {
        bindingUserId: evt.bindingUserId,
        idempotencyKey: evt.idempotencyKey,
        errMessage,
      })
      return { kind: "broker_failed", errMessage }
    }

    if (shouldCommitAudit(outcome)) {
      await insertCommittedAudit(evt, dispatchBindingUserId)
    }

    // 反射文案直接走 sendText fire-and-forget,**不入 outbox**:
    //   - outbox.session_id NOT NULL,反射没有 wsess(短路在 sessionId allocate 之前)
    //   - 反射性质 = 立刻给用户一个"已收到"信号,不接受 enqueue → drain 的二段延迟
    //   - 失败也无需重试(用户重发即可,user 层幂等)
    if (outcome.kind === "command_echo") {
      fireAndForgetReflection(evt, outcome.reply, "command_echo")
    } else if (outcome.kind === "cold_start") {
      fireAndForgetReflection(evt, outcome.coldStartReply, "cold_start")
    }
    return outcome
  }

  async function hasCommittedAuditDuplicate(evt: InboundEvent): Promise<boolean | "skipped" | "failed"> {
    const accountId = typeof evt.accountId === "string" ? evt.accountId.trim() : ""
    if (!accountId) return "skipped"
    const rawMessageId = typeof evt.messageId === "string" ? evt.messageId.trim() : ""
    const messageId = rawMessageId ? rawMessageId : null
    if (!messageId) return "skipped"
    try {
      const r = await deps.pgPool.query(
        "SELECT 1 FROM wechat_audit WHERE account_id = $1 AND message_id = $2 LIMIT 1",
        [accountId.slice(0, 128), messageId.slice(0, 128)],
      )
      return (r.rowCount ?? 0) > 0
    } catch (err) {
      log.error("audit_duplicate_check_failed", {
        bindingUserId: evt.bindingUserId,
        accountId,
        messageId,
        idempotencyKey: evt.idempotencyKey,
        errMessage: (err as Error)?.message ?? String(err),
      })
      return "failed"
    }
  }

  function shouldCommitAudit(outcome: DispatchOutcome): boolean {
    return outcome.kind === "dispatched" || outcome.kind === "command_echo"
  }

  async function insertCommittedAudit(evt: InboundEvent, dispatchBindingUserId: string): Promise<void> {
    const accountId = typeof evt.accountId === "string" ? evt.accountId.trim() : ""
    if (!accountId) return
    const rawMessageId = typeof evt.messageId === "string" ? evt.messageId.trim() : ""
    const messageId = rawMessageId ? rawMessageId : null
    const itemTypes = normalizeAuditItemTypes(evt.itemTypes)
    const rawPayload =
      evt.rawPayload !== undefined
        ? evt.rawPayload
        : {
            text: evt.text,
            idempotencyKey: evt.idempotencyKey,
          }
    try {
      await deps.pgPool.query(
        `INSERT INTO wechat_audit
           (binding_user_id, account_id, sender_id, message_id, item_types, raw_payload, received_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (account_id, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
        [
          dispatchBindingUserId,
          accountId.slice(0, 128),
          evt.senderId ? evt.senderId.slice(0, 256) : null,
          messageId ? messageId.slice(0, 128) : null,
          itemTypes,
          JSON.stringify(rawPayload),
          evt.receivedAt || now(),
        ],
      )
    } catch (err) {
      log.error("audit_insert_failed", {
        bindingUserId: evt.bindingUserId,
        accountId,
        messageId,
        idempotencyKey: evt.idempotencyKey,
        errMessage: (err as Error)?.message ?? String(err),
      })
    }
  }

  function normalizeAuditItemTypes(input: unknown): string {
    const s = typeof input === "string" ? input.trim() : ""
    return (s || "unknown").slice(0, 256)
  }

  async function cleanupBinding(
    bindingUserIdInput: string,
  ): Promise<{ pointerDeleted: boolean; outboxFailed: number }> {
    const bindingUserId = normalizeDispatcherBindingUserId(bindingUserIdInput)
    const pointer = await deps.pgPool.query(
      "DELETE FROM wechat_session_pointer WHERE binding_user_id = $1",
      [bindingUserId],
    )
    const outbox = await deps.pgPool.query(
      `UPDATE wechat_outbox
          SET status = 'failed',
              attempts = GREATEST(attempts, $2),
              last_error = $3,
              locked_at = NULL,
              updated_at = $4
        WHERE binding_user_id = $1
          AND status IN ('queued', 'sending')`,
      [
        bindingUserId,
        deps.outboxWorker?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        "binding unbound",
        now(),
      ],
    )
    return {
      pointerDeleted: (pointer.rowCount ?? 0) > 0,
      outboxFailed: outbox.rowCount ?? 0,
    }
  }

  /**
   * 反射文案 fire-and-forget 发送。
   *
   * 用 `void Promise.resolve().then(...)` 而非裸 `void sendReflection()`:
   * 后者若 sendReflection **在返回 Promise 前**同步 throw(eg getBinding 取不到 binding
   * 时本函数若不小心写成同步 throw)依然会冒泡;`Promise.resolve().then` 把同步 throw
   * 转成 rejected promise 在统一 catch 处兜底,onInbound never-throw 契约不破。
   */
  function fireAndForgetReflection(
    evt: InboundEvent,
    text: string,
    reason: "command_echo" | "cold_start",
  ): void {
    void Promise.resolve()
      .then(() => sendReflection(evt, text, reason))
      .catch((err) => {
        log.error("reflection_send_threw_unexpected", {
          bindingUserId: evt.bindingUserId,
          reason,
          errMessage: (err as Error)?.message ?? String(err),
        })
      })
  }

  async function sendReflection(
    evt: InboundEvent,
    text: string,
    reason: "command_echo" | "cold_start",
  ): Promise<void> {
    let binding
    try {
      binding = await deps.getBinding(evt.bindingUserId)
    } catch (err) {
      log.error("reflection_getBinding_failed", {
        bindingUserId: evt.bindingUserId,
        reason,
        errMessage: (err as Error)?.message ?? String(err),
      })
      return
    }
    if (!binding) {
      log.warn("reflection_binding_gone", { bindingUserId: evt.bindingUserId, reason })
      return
    }
    const contextToken = binding.contextTokens[evt.senderId]
    if (!contextToken) {
      log.warn("reflection_no_context_token", {
        bindingUserId: evt.bindingUserId,
        senderId: evt.senderId,
        reason,
      })
      return
    }
    let result
    try {
      result = await deps.sendText({
        botToken: binding.botToken,
        toUserId: evt.senderId,
        contextToken,
        text,
      })
    } catch (err) {
      log.error("reflection_sendText_threw", {
        bindingUserId: evt.bindingUserId,
        reason,
        errMessage: (err as Error)?.message ?? String(err),
      })
      return
    }
    if (!result.ok) {
      log.warn("reflection_sendText_not_ok", {
        bindingUserId: evt.bindingUserId,
        reason,
        permanent: result.permanent ?? false,
        errMessage: result.errMessage ?? "unknown",
      })
    }
  }

  // ─── reconcile tick:单次 snapshot 内 diff + softDelete ─────────────────────
  async function tickReconcile(): Promise<void> {
    if (stopFlag || !isEnabled()) return
    let rows: Array<{ id: WechatSessionId; userId: string; createdAt: number }>
    try {
      rows = await deps.allMasterWsessRows()
    } catch (err) {
      log.error("reconcile_allMasterWsessRows_failed", {
        errMessage: (err as Error)?.message ?? String(err),
      })
      return
    }
    let active: Set<WechatSessionId>
    try {
      active = await activeWsessIdsFromPg(deps.pgPool as unknown as PgConn)
    } catch (err) {
      log.error("reconcile_activeWsess_failed", {
        errMessage: (err as Error)?.message ?? String(err),
      })
      return
    }
    // 同一 snapshot 喂给 listOrphan + byId Map,避免重复 query。
    const byId = new Map<WechatSessionId, { userId: string; createdAt: number }>()
    for (const r of rows) byId.set(r.id, { userId: r.userId, createdAt: r.createdAt })

    const orphans = await listOrphanWechatSessions({
      allWsess: () => Promise.resolve(rows.map((r) => ({ id: r.id, createdAt: r.createdAt }))),
      activeFromPg: () => Promise.resolve(active),
      now,
      graceMs: reconcileGraceMs,
    })

    let softDeleted = 0
    let softDeleteErrors = 0
    for (const id of orphans) {
      if (stopFlag) break
      const meta = byId.get(id)
      if (!meta) continue // 防御:不应发生(orphan 由 rows 派生)
      try {
        await deps.softDeleteMasterSession(id, meta.userId)
        softDeleted++
      } catch (err) {
        softDeleteErrors++
        log.error("reconcile_softDelete_failed", {
          sessionId: id,
          userId: meta.userId,
          errMessage: (err as Error)?.message ?? String(err),
        })
      }
    }

    if (orphans.length > 0 || softDeleteErrors > 0) {
      log.info("reconcile_tick", {
        masterRows: rows.length,
        activeBindings: active.size,
        orphansDetected: orphans.length,
        softDeleted,
        softDeleteErrors,
      })
    }
  }

  async function tickHousekeeping(): Promise<void> {
    if (stopFlag || !isEnabled()) return
    try {
      const counts = await runHousekeeping(deps.pgPool, now(), {
        maxAttempts: deps.outboxWorker?.maxAttempts,
      })
      if (
        counts.staleReleased > 0 ||
        counts.aged > 0 ||
        counts.purgedSent > 0 ||
        counts.purgedFailed > 0
      ) {
        log.info("housekeeping_tick", counts)
      }
    } catch (err) {
      log.error("housekeeping_failed", {
        errMessage: (err as Error)?.message ?? String(err),
      })
    }
  }

  function scheduleReconcile(delayMs: number): void {
    if (stopFlag) return
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      reconcileInFlight = tickReconcile()
        .catch((err) => {
          // tickReconcile 自身已 try/catch — 这里捕获不应发生的同步 throw 兜底
          log.error("reconcile_tick_unexpected", {
            errMessage: (err as Error)?.message ?? String(err),
          })
        })
        .finally(() => {
          reconcileInFlight = null
          if (!stopFlag) scheduleReconcile(reconcileIntervalMs)
        })
    }, delayMs)
  }

  function scheduleHousekeeping(delayMs: number): void {
    if (stopFlag) return
    housekeepingTimer = setTimeout(() => {
      housekeepingTimer = null
      housekeepingInFlight = tickHousekeeping()
        .catch((err) => {
          log.error("housekeeping_tick_unexpected", {
            errMessage: (err as Error)?.message ?? String(err),
          })
        })
        .finally(() => {
          housekeepingInFlight = null
          if (!stopFlag) scheduleHousekeeping(housekeepingIntervalMs)
        })
    }, delayMs)
  }

  // ─── start / stop ─────────────────────────────────────────────────────────

  /** 真正的"启动副作用"块。`start()` 和 stop() finally 的重启路径共用。 */
  function doStart(): void {
    if (reconcileTimer || housekeepingTimer || reconcileInFlight || housekeepingInFlight) {
      // 已启动 — 幂等(同 timer / inFlight 检查保留)。
      return
    }
    // **显式重置 stopFlag**:支持 start → stop → start 重启场景。
    stopFlag = false
    outboxWorker.start()
    // 立即跑一次,然后按周期 schedule。delay=0 第一次也走 setTimeout(),避免
    // start() 同步阻塞调用方。
    scheduleReconcile(0)
    scheduleHousekeeping(0)
    log.info("broker_started", {
      reconcileIntervalMs,
      housekeepingIntervalMs,
      reconcileGraceMs,
    })
  }

  function start(): void {
    if (stoppingPromise) {
      // 在 stop() 等 inFlight 期间被调到 — 记下意图,stop 自己的 finally 会
      // 在所有清理完后调一次 doStart()。Caller 后续 await stoppingPromise 即可
      // 等到重启完成(Codex r5 IMPORTANT#1)。
      restartRequested = true
      return
    }
    doStart()
  }

  async function stop(): Promise<void> {
    if (stoppingPromise) {
      // 已经在停 — 多个 caller 共享同一 stoppingPromise,避免重复跑 stop 逻辑
      // 也避免乱七八糟的 inFlight 信号重置。**取消任何 pending restart**:
      // 用户在 stop() 进行中再次调 stop() 表达"不管 start 是否插入过我都要它停",
      // 否则 start→stop→start→stop 序列会以 RUNNING 收尾(违反"最后动作 = stop")。
      restartRequested = false
      await stoppingPromise
      return
    }
    // 新一轮 stop:清掉旧 restartRequested(若上一轮 stop 已 doStart 复活,
    // restartRequested 已被消费;这里防御性 reset)。
    restartRequested = false
    stoppingPromise = (async () => {
      stopFlag = true
      if (reconcileTimer) {
        clearTimeout(reconcileTimer)
        reconcileTimer = null
      }
      if (housekeepingTimer) {
        clearTimeout(housekeepingTimer)
        housekeepingTimer = null
      }
      // 等所有 inFlight tick 走完(它们 finally 不会再 schedule 因为 stopFlag=true)。
      await Promise.allSettled([reconcileInFlight, housekeepingInFlight])
      // 最后停 outboxWorker — 它内部自己有 stopFlag + inFlight guard。
      await outboxWorker.stop()
      log.info("broker_stopped", {})
    })()
    try {
      await stoppingPromise
    } finally {
      stoppingPromise = null
      // 若 stop 期间有 start() 调过 → 在这里完成重启(同步 doStart,新 stop()
      // 调用看到的就是 running 状态)。
      if (restartRequested) {
        restartRequested = false
        doStart()
      }
    }
  }

  return { outboundHandler, onInbound, cleanupBinding, start, stop }
}
