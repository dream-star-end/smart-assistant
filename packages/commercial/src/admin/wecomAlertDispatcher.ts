/**
 * 企业微信告警投递 scheduler(v5-owned)。偿「v5 告警只入库不推送」债(playbook 债表
 * af1b054f)。
 *
 * 与 iLink/Telegram 的架构差异:iLink/Telegram 投递寄生 shared 域 startAlertScheduler
 * (ilinkAlertWorker.doDispatch),v5 下 controlPlaneEnabled=false 把整个 shared scheduler
 * 关掉 → v5 告警只 enqueue 进 admin_alert_outbox 不推送。本 dispatcher **独立**、gate 在
 * runtimeChannel==='v5'(不加 controlPlaneEnabled 分支),直接把 outbox 里
 * channel_type='wecom_bot' 的行推到企微 webhook。
 *
 * 为什么 v5-only 而非 controlPlane 分支(消除双跑双发):
 *   - v3 跑旧代码,其 shared dispatcher 不认 'wecom_bot' → else 分支 markFailed,**从不发**
 *     wecom(无双发)。
 *   - 但 v3 旧 shared dispatcher 的 outbox claim 是**类型无关**的(claimReadyAlerts 无 type
 *     过滤),会误 claim wecom 行 markFailed。本 dispatcher 的 claim **对称地**只认领
 *     channel_type='wecom_bot'(claimReadyAlerts(limit, 'wecom_bot')),v5 侧绝不误碰
 *     ilink/telegram 行。v3 侧影响面(误 markFailed 竞争)详见交接报告。
 *
 * 限速:企微群机器人 20 条/分/机器人。这里 **per-channel 滑窗** 节流 ≤18/min(留余量),
 * 超限的行本 tick 跳过、留待下 tick(不动 next_attempt_at、不计失败 attempts)。
 *
 * 出口:sender 走 directEgressDispatcher() 直连(qyapi 国内域名,见 wecomAlertSender 头注)。
 */

import {
  claimReadyAlerts as realClaimReadyAlerts,
  markFailed as realMarkFailed,
  markSent as realMarkSent,
  type OutboxDispatchRow,
} from './alertOutbox.js'
import {
  loadChannelSecrets as realLoadChannelSecrets,
  markChannelError as realMarkChannelError,
  markChannelSendSuccess as realMarkChannelSendSuccess,
  type ChannelSecrets,
} from './alertChannels.js'
import { sendWecomAlert as realSendWecomAlert, WecomPermanentError } from './wecomAlertSender.js'

const WECOM_CHANNEL_TYPE = 'wecom_bot'
const RATE_WINDOW_MS = 60_000

// ─── 消息格式化 ───────────────────────────────────────────────────────

const SEV_BADGE: Record<string, { emoji: string; color: string; label: string }> = {
  critical: { emoji: '🔴', color: 'warning', label: 'CRITICAL' },
  warning: { emoji: '🟠', color: 'warning', label: 'WARNING' },
  info: { emoji: '🔵', color: 'info', label: 'INFO' },
}

/**
 * 把一条 outbox 渲染成企微 markdown。企微 markdown 支持 **bold** / `code` /
 * <font color="info|comment|warning"> / > 引用。风格贴 telegram 版(事件名 / severity
 * 徽标 / 时间 / 详情)。
 */
export function formatOutboxMarkdown(row: {
  event_type: string
  severity: string
  title: string
  body: string
}): string {
  const sev = SEV_BADGE[row.severity] ?? SEV_BADGE.info
  const time = new Date().toISOString().slice(0, 19).replace('T', ' ')
  return [
    `${sev.emoji} **${row.title}**`,
    `> 级别:<font color="${sev.color}">${sev.label}</font>`,
    `> 事件:\`${row.event_type}\``,
    `> 时间:${time} UTC`,
    '',
    row.body,
  ].join('\n')
}

// ─── dispatcher ───────────────────────────────────────────────────────

export interface WecomDispatcherDeps {
  // 显式签名(非 typeof):dispatcher 恒以 number limit 调用,避免 typeof 的
  // optional-limit 型变让注入的 mock 函数不可赋值。
  claimReadyAlerts: (limit: number, channelType?: string) => Promise<OutboxDispatchRow[]>
  loadChannelSecrets: (id: string | number | bigint) => Promise<ChannelSecrets | null>
  markSent: typeof realMarkSent
  markFailed: typeof realMarkFailed
  markChannelSendSuccess: typeof realMarkChannelSendSuccess
  markChannelError: typeof realMarkChannelError
  sendWecomAlert: typeof realSendWecomAlert
  now: () => number
}

export interface WecomDispatcherOptions {
  /** dispatcher 扫 outbox 的间隔。默认 5s,下限 500ms。 */
  dispatchIntervalMs?: number
  /** 每 tick 最多 claim 多少行。默认 20。 */
  claimLimit?: number
  /** per-channel 每分钟最多发多少条。默认 18(企微硬上限 20,留余量)。 */
  ratePerMinute?: number
  /** 错误回调;默认 console.warn。 */
  onError?: (scope: string, err: unknown) => void
  /** 依赖注入(测试用);缺省用真实实现。 */
  deps?: Partial<WecomDispatcherDeps>
}

export interface WecomAlertDispatcherHandle {
  stop(): Promise<void>
  /** 测试:强制跑一次 dispatch tick,返回本 tick 成功发送条数。 */
  dispatchNow(): Promise<number>
}

export function startWecomAlertDispatcher(
  opts: WecomDispatcherOptions = {},
): WecomAlertDispatcherHandle {
  const dispatchMs = Math.max(500, opts.dispatchIntervalMs ?? 5_000)
  const claimLimit = Math.max(1, opts.claimLimit ?? 20)
  const ratePerMinute = Math.max(1, opts.ratePerMinute ?? 18)
  const onError =
    opts.onError ??
    ((scope, err) => {
      // eslint-disable-next-line no-console
      console.warn(`[admin/wecomDispatcher] ${scope}:`, err)
    })

  const deps: WecomDispatcherDeps = {
    claimReadyAlerts: opts.deps?.claimReadyAlerts ?? realClaimReadyAlerts,
    loadChannelSecrets: opts.deps?.loadChannelSecrets ?? realLoadChannelSecrets,
    markSent: opts.deps?.markSent ?? realMarkSent,
    markFailed: opts.deps?.markFailed ?? realMarkFailed,
    markChannelSendSuccess: opts.deps?.markChannelSendSuccess ?? realMarkChannelSendSuccess,
    markChannelError: opts.deps?.markChannelError ?? realMarkChannelError,
    sendWecomAlert: opts.deps?.sendWecomAlert ?? realSendWecomAlert,
    now: opts.deps?.now ?? (() => Date.now()),
  }

  let stopped = false

  // per-channel 发送时间戳滑窗(限速);channel_id → 最近一分钟内的发送时刻。
  const sendWindows = new Map<string, number[]>()
  function pruneWindow(channelId: string): number[] {
    const now = deps.now()
    const w = sendWindows.get(channelId) ?? []
    const kept = w.filter((t) => now - t < RATE_WINDOW_MS)
    sendWindows.set(channelId, kept)
    return kept
  }
  function underRate(channelId: string): boolean {
    return pruneWindow(channelId).length < ratePerMinute
  }
  function recordSend(channelId: string): void {
    const w = pruneWindow(channelId)
    w.push(deps.now())
  }

  async function doDispatch(): Promise<number> {
    let sent = 0
    let ready: OutboxDispatchRow[]
    try {
      ready = await deps.claimReadyAlerts(claimLimit, WECOM_CHANNEL_TYPE)
    } catch (err) {
      onError('claimReady', err)
      return 0
    }
    if (ready.length === 0) return 0

    for (const row of ready) {
      if (stopped) break
      if (!row.channel_id || !row.channel) {
        await deps.markFailed(row.id, 'channel missing').catch(() => {})
        continue
      }
      // claim 已过滤 wecom_bot,这里双保险(防将来 claim 语义漂移误伤别的类型行)。
      if (row.channel.channel_type !== WECOM_CHANNEL_TYPE) {
        await deps
          .markFailed(row.id, `unexpected channel_type ${row.channel.channel_type}`)
          .catch(() => {})
        continue
      }
      if (!row.channel.enabled || row.channel.activation_status !== 'active') {
        await deps
          .markFailed(
            row.id,
            `channel not active (status=${row.channel.activation_status}, enabled=${row.channel.enabled})`,
          )
          .catch(() => {})
        continue
      }
      // 限速:超限本 tick 跳过,不动 next_attempt_at、不计失败,留待下 tick。
      if (!underRate(row.channel_id)) {
        continue
      }
      const secrets = await deps.loadChannelSecrets(row.channel_id).catch(() => null)
      if (!secrets || !secrets.botToken) {
        await deps.markFailed(row.id, 'channel secrets unavailable').catch(() => {})
        continue
      }
      const markdown = formatOutboxMarkdown(row)
      // 记在真正发之前:成功/失败都是一次真实请求,都占企微限速额度。
      recordSend(row.channel_id)
      try {
        await deps.sendWecomAlert({ webhookKey: secrets.botToken, markdown })
        await deps.markSent(row.id)
        await deps.markChannelSendSuccess(row.channel_id).catch(() => {})
        sent++
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err)
        await deps.markFailed(row.id, msg).catch(() => {})
        // permanent(errcode=93000 invalid key 等)→ 降级 activation_status=error,
        // 写 last_error,UI 显示红字。admin 需删重建(webhook 换新 key)。
        if (err instanceof WecomPermanentError) {
          await deps.markChannelError(row.channel_id, msg, 'permanent').catch(() => {})
        }
      }
    }
    return sent
  }

  let dispatchInflight: Promise<number> | null = null
  function dispatchTick(): Promise<number> {
    if (dispatchInflight) return dispatchInflight
    dispatchInflight = doDispatch().finally(() => {
      dispatchInflight = null
    })
    return dispatchInflight
  }

  const dispatchTimer = setInterval(() => {
    if (stopped) return
    void dispatchTick()
  }, dispatchMs)
  if (typeof dispatchTimer.unref === 'function') dispatchTimer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(dispatchTimer)
      if (dispatchInflight) {
        try {
          await dispatchInflight
        } catch {
          /* */
        }
      }
    },
    async dispatchNow() {
      return dispatchTick()
    },
  }
}
