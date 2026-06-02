/**
 * v3 commercial WeChat broker — outbox drain worker。
 *
 * 详见 docs/v3/wechat-broker-design.md §4.6。
 *
 * **职责**:周期 `pickOne` queued 行 → sendText (iLink) → markSent / markFailed。
 *
 * **dep injection**:
 *   - `sendText`(broker.ts P1.7 用 iLink 实装,本模块只看 SendResult)
 *   - `getBinding`(broker.ts P1.7 通过 @openclaude/storage 读 master sqlite wechat_bindings)
 *   - `log`(broker.ts 注入,P1 简单 console)
 *
 * **关键设计**:
 *   - Worker 不做 in-process retry backoff;失败行 release 回 'queued',下次 tick 自然 retry
 *     (避免 P1 阶段引入 timer table / delay queue 复杂度)
 *   - 每 tick 拉到 `maxPerTick` 条就 yield(防 event loop 长 block 影响 broker.reconcile / inbound)
 *   - 失败分类:`SendResult.permanent=true` → 立即 force-fail(attempts=maxAttempts,不复活);
 *     否则 attempts+1,< maxAttempts release 'queued',>= maxAttempts 转 'failed' 终态
 *   - "binding 失踪" / "no context_token" 视为 permanent(用户没绑定或未入站过,broker 重试无意义)
 */

import type { Pool } from 'pg'
import {
  DEFAULT_MAX_ATTEMPTS,
  dropAgedPending,
  markFailed,
  markSent,
  pickOne,
  purgeFailedAged,
  purgeSentTombstones,
  releaseStaleSending,
} from './outboxStore.js'
import type { IlinkMediaPart, IlinkPart, OutboxRow } from './types.js'
import type { ResolveOutboundMediaPartFn, ResolvedWechatOutboundMedia } from './outboundMedia.js'
import { MASTER_USER_PREFIX } from './userIds.js'

export const DEFAULT_INTER_PART_DELAY_MS = 1000

/** sendText 实装返回。permanent → broker 立即 force-fail 不复活;否则按 attempts cap 兜底。 */
export interface SendResult {
  ok: boolean
  errMessage?: string
  permanent?: boolean
}

/** 单条 IlinkPart 出站 — 实装(broker.ts)以 iLink HTTP 调用 + per-part client_id 实现。 */
export type SendTextFn = (params: {
  botToken: string
  toUserId: string
  contextToken: string
  text: string
}) => Promise<SendResult>

export type SendMediaFn = (params: {
  botToken: string
  toUserId: string
  contextToken: string
  media: ResolvedWechatOutboundMedia
}) => Promise<SendResult>

/** 读 master sqlite wechat_bindings 当前快照(broker.ts 注入)。 */
export type GetBindingFn = (bindingUserId: string) => Promise<{
  botToken: string
  contextTokens: Record<string, string>
} | null>

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void
export type DelayFn = (ms: number) => Promise<void>

export interface OutboxWorkerOptions {
  pool: Pool
  sendText: SendTextFn
  sendMedia?: SendMediaFn
  resolveMediaPart?: ResolveOutboundMediaPartFn
  getBinding: GetBindingFn
  log?: LogFn
  /** 每个 tick 最多 drain 条数,防 event loop 长 block。默认 20。 */
  maxPerTick?: number
  /** 周期 tick 间隔 ms。默认 1000。 */
  pollIntervalMs?: number
  /** 重试 cap。默认 DEFAULT_MAX_ATTEMPTS。 */
  maxAttempts?: number
  /** 同一 outbox row 内连续 iLink sendmessage 之间的 pacing。默认 1000ms。 */
  interPartDelayMs?: number
  /** 注入 delay 便于测试。默认 setTimeout。 */
  delay?: DelayFn
  /** 注入 now 便于测试。默认 Date.now。 */
  now?: () => number
}

/** 单条 outbox row 出站结果分类(测试 & 调用方观测用)。 */
export type DrainOutcome =
  | { kind: 'sent'; outboxId: number }
  | { kind: 'failed_permanent'; outboxId: number; reason: string }
  | { kind: 'failed_transient'; outboxId: number; attempts: number; errMessage: string }
  | { kind: 'failed_terminal'; outboxId: number; attempts: number; errMessage: string }
  /** markSent / markFailed 命中 0 row(状态机漂移,真正罕见);broker 只 log 不 throw。 */
  | { kind: 'noop'; outboxId: number; reason: string }

/**
 * 强制把一行翻成 'failed' 终态(attempts = maxAttempts,后续 enqueue 永走 already_failed)。
 *
 * 用于 permanent 错误(binding 失踪 / no context_token / sendText 标 permanent),
 * markFailed 自然路径走不到的兜底。
 */
async function forceFail(
  pool: Pool,
  id: number,
  errMessage: string,
  now: number,
  maxAttempts: number,
): Promise<boolean> {
  const truncErr = errMessage.length > 1000 ? errMessage.slice(0, 1000) : errMessage
  const res = await pool.query(
    `UPDATE wechat_outbox SET
       status     = 'failed',
       attempts   = GREATEST(attempts + 1, $1),
       last_error = $2,
       locked_at  = NULL,
       updated_at = $3
     WHERE id = $4 AND status = 'sending'`,
    [maxAttempts, truncErr, now, id],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * 出站一条 outbox row。该函数是纯单条处理 — 不递归、不循环、不调度。drain loop 由
 * `OutboxWorker.tick` 包裹。导出便于单测覆盖。
 */
export async function drainOne(
  row: OutboxRow,
  deps: {
    pool: Pool
    sendText: SendTextFn
    sendMedia?: SendMediaFn
    resolveMediaPart?: ResolveOutboundMediaPartFn
    getBinding: GetBindingFn
    now: () => number
    maxAttempts: number
    interPartDelayMs?: number
    delay?: DelayFn
  },
): Promise<DrainOutcome> {
  const { pool, sendText, sendMedia, resolveMediaPart, getBinding, now, maxAttempts } = deps
  const interPartDelayMs = deps.interPartDelayMs ?? 0
  const delay = deps.delay ?? defaultDelay

  // outbox.binding_user_id 沿 PG-side 命名(raw digit,见 userIds.ts);跨入 master sqlite
  // 读 wechat_bindings 时 prepend `c:` 前缀,与 inboundDispatcher 写 client_sessions 时
  // 的 `MASTER_USER_PREFIX + evt.bindingUserId` 模式对称。
  const binding = await getBinding(MASTER_USER_PREFIX + row.bindingUserId)
  if (!binding) {
    const ok = await forceFail(pool, row.id, 'binding_gone', now(), maxAttempts)
    return ok
      ? { kind: 'failed_permanent', outboxId: row.id, reason: 'binding_gone' }
      : { kind: 'noop', outboxId: row.id, reason: 'binding_gone_but_row_drifted' }
  }

  const contextToken = binding.contextTokens[row.senderId]
  if (!contextToken) {
    const ok = await forceFail(pool, row.id, 'no_context_token', now(), maxAttempts)
    return ok
      ? { kind: 'failed_permanent', outboxId: row.id, reason: 'no_context_token' }
      : { kind: 'noop', outboxId: row.id, reason: 'no_context_token_but_row_drifted' }
  }

  // 顺序发送 parts;任意一条失败 → 标失败整行(retry 时 user 看见 part 1 重复 — 接受)。
  // Codex slice 3 r1 WARN: payload 完整性 invariant — payload 是 JSONB,DB 层不强制类型;
  // 若整行没有任何可发送的 text part(空数组 / 全 unknown part / 全 text-but-empty),
  // 不能静默 markSent 丢消息,转 failed_permanent("invalid_payload")。
  let sentParts = 0
  for (let i = 0; i < row.payload.length; i++) {
    const part = row.payload[i]!
    let result: SendResult | null = null
    if (isTextPart(part)) {
      result = await sendText({
        botToken: binding.botToken,
        toUserId: row.senderId,
        contextToken,
        text: part.text,
      })
    } else if (isMediaPart(part) && sendMedia && resolveMediaPart) {
      try {
        const media = await resolveMediaPart({
          bindingUserId: row.bindingUserId,
          part,
        })
        result = await sendMedia({
          botToken: binding.botToken,
          toUserId: row.senderId,
          contextToken,
          media,
        })
      } catch (err) {
        result = {
          ok: false,
          errMessage: String((err as Error)?.message ?? err),
        }
      }
    }
    if (!result) continue
    if (!result.ok) {
      const errMsg = result.errMessage ?? 'send_unknown_error'
      if (result.permanent) {
        const ok = await forceFail(pool, row.id, errMsg, now(), maxAttempts)
        return ok
          ? { kind: 'failed_permanent', outboxId: row.id, reason: errMsg }
          : { kind: 'noop', outboxId: row.id, reason: 'permanent_fail_but_row_drifted' }
      }
      const r = await markFailed(pool, row.id, errMsg, now(), maxAttempts)
      if (!r) return { kind: 'noop', outboxId: row.id, reason: 'markFailed_drift' }
      return r.permanent
        ? { kind: 'failed_terminal', outboxId: row.id, attempts: r.attempts, errMessage: errMsg }
        : { kind: 'failed_transient', outboxId: row.id, attempts: r.attempts, errMessage: errMsg }
    }
    sentParts++
    if (interPartDelayMs > 0 && hasLaterSendablePart(row.payload, i, Boolean(sendMedia && resolveMediaPart))) {
      await delay(interPartDelayMs)
    }
  }

  if (sentParts === 0) {
    const ok = await forceFail(pool, row.id, 'invalid_payload', now(), maxAttempts)
    return ok
      ? { kind: 'failed_permanent', outboxId: row.id, reason: 'invalid_payload' }
      : { kind: 'noop', outboxId: row.id, reason: 'invalid_payload_but_row_drifted' }
  }

  const sentOk = await markSent(pool, row.id, now())
  return sentOk
    ? { kind: 'sent', outboxId: row.id }
    : { kind: 'noop', outboxId: row.id, reason: 'markSent_drift' }
}

function isTextPart(p: IlinkPart): p is { type: 'text'; text: string } {
  return p.type === 'text' && typeof p.text === 'string'
}

function isMediaPart(p: IlinkPart): p is IlinkMediaPart {
  return (
    (p.type === 'image' || p.type === 'video' || p.type === 'voice' || p.type === 'file') &&
    typeof p.containerPath === 'string' &&
    typeof p.filename === 'string'
  )
}

function isSendablePart(
  p: IlinkPart,
  mediaEnabled: boolean,
): boolean {
  if (isTextPart(p)) return true
  return mediaEnabled && isMediaPart(p)
}

function hasLaterSendablePart(
  payload: readonly IlinkPart[],
  currentIndex: number,
  mediaEnabled: boolean,
): boolean {
  for (let i = currentIndex + 1; i < payload.length; i++) {
    if (isSendablePart(payload[i]!, mediaEnabled)) return true
  }
  return false
}

/**
 * Drain loop 控制器。`start()` 启动周期 tick;`stop()` 平滑停。
 *
 * 不在构造时启动 — broker.ts 显式 start,便于测试构造后断言初始状态。
 */
export class OutboxWorker {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopFlag = false
  private inFlight: Promise<void> | null = null
  private readonly opts: Omit<Required<OutboxWorkerOptions>, 'sendMedia' | 'resolveMediaPart' | 'log'> & {
    sendMedia?: SendMediaFn
    resolveMediaPart?: ResolveOutboundMediaPartFn
    log: LogFn
  }

  constructor(options: OutboxWorkerOptions) {
    this.opts = {
      pool: options.pool,
      sendText: options.sendText,
      sendMedia: options.sendMedia,
      resolveMediaPart: options.resolveMediaPart,
      getBinding: options.getBinding,
      log: options.log ?? defaultLog,
      maxPerTick: options.maxPerTick ?? 20,
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      interPartDelayMs: options.interPartDelayMs ?? DEFAULT_INTER_PART_DELAY_MS,
      delay: options.delay ?? defaultDelay,
      now: options.now ?? Date.now,
    }
  }

  start(): void {
    if (this.timer || this.inFlight) return
    this.stopFlag = false
    this.scheduleNext(0)
  }

  async stop(): Promise<void> {
    this.stopFlag = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // wait for any in-flight tick
    if (this.inFlight) {
      try {
        await this.inFlight
      } catch {
        /* swallowed; tick 内部已 log */
      }
    }
  }

  /** 单次 tick 暴露给测试 — 不依赖 setTimeout 调度。 */
  async tick(): Promise<void> {
    if (this.stopFlag) return
    let consumed = 0
    while (!this.stopFlag && consumed < this.opts.maxPerTick) {
      const row = await pickOne(this.opts.pool, this.opts.now())
      if (!row) break
      consumed++
      try {
        await drainOne(row, this.opts)
      } catch (err) {
        // pickOne 已标 'sending'(locked_at 已 stamp);留它给 releaseStaleSending 回收。
        this.opts.log(
          'error',
          `outboxWorker.drainOne crashed: id=${row.id} err=${String((err as Error)?.message ?? err)}`,
        )
      }
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopFlag) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.inFlight = this.tick()
        .catch((err) => {
          this.opts.log(
            'error',
            `outboxWorker.tick crashed: ${String((err as Error)?.message ?? err)}`,
          )
        })
        .finally(() => {
          this.inFlight = null
          if (!this.stopFlag) this.scheduleNext(this.opts.pollIntervalMs)
        })
    }, delayMs)
  }
}

/**
 * 周期 housekeeping(daemon 角色):dropAgedPending + releaseStaleSending + purge 两路 tombstone。
 * broker.ts 单独 schedule(默认 5min 一次),不和 drain loop 混进同一 timer 减少抢锁。
 */
export async function runHousekeeping(
  pool: Pool,
  now: number,
  opts: { maxAttempts?: number } = {},
): Promise<{
  staleReleased: number
  aged: number
  purgedSent: number
  purgedFailed: number
}> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  // 顺序:先 release stale sending(可能让 drop/queued 抓到老 row),再 drop aged,最后 purge tombstones。
  const staleReleased = await releaseStaleSending(pool, now)
  const aged = await dropAgedPending(pool, now, undefined, maxAttempts)
  const purgedSent = await purgeSentTombstones(pool, now)
  const purgedFailed = await purgeFailedAged(pool, now)
  return { staleReleased, aged, purgedSent, purgedFailed }
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  out(`[outboxWorker] ${message}`)
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
