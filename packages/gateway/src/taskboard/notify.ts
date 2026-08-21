// Taskboard 通知打通 —— 复用 cron onDeliver 瀑布,不做微信+站内信双发。
//
// 铁律(CORRECTIONS §1.5 / v3InboxPost.ts:10-11):成功通道不再推站内信。
//   微信接管(queued / already_sent / pending) → return;
//   无绑定 / 无 context_token / 无 wsess → 回退站内信兜底;
//   传输/5xx 歧义失败 → 不跨通道回退(可能已经入队,回退会双推)。
//
// 三类稳定幂等键(换 id 会双推):
//   待确认  taskboard-await:<ticketId>:<runId>
//   熔断    taskboard-fuse:<stageId>:<YYYY-MM-DD>   (护栏已造,这里原样用)
//   简报    taskboard-digest:<YYYY-MM-DD>
//
// 告警级别:容器 inbox-post 只认 level=info。熔断/预算需要 warning,
// 必须走 master 进程内 createInboxMessage(本模块的 transport.createInboxMessage),
// 不能走 postInbox。inbox-post 的限频 + 6h 去重对 info 兜底仍然生效,不要绕过。
//
// 静默时段:
//   待确认 = 打扰类,静默内攒着,出静默再推(仍会进当日简报计数);
//   熔断 / 预算触顶 = 穿透(自动化已经停了,日键幂等不会刷屏);
//   简报 = 不穿透,挂在已有 60s tick 上按「当天是否已发过」判断,不新建 cron job。

import type { TaskboardDb } from './db/index.js'
import { getStage } from './db/pipelines.js'
import { type TaskboardSettings, getSettings } from './db/settings.js'
import { getTicket } from './db/tickets.js'
import type { PipelineStage, Ticket, TicketRun } from './domain.js'
import type { GuardrailAlert } from './guardrails.js'
import { isInQuietHours, zonedDateParts } from './patrolWindow.js'

/** 与种子流水线 / 静默时段同一套本地时区。 */
export const NOTIFY_TIMEZONE = 'Asia/Shanghai'

/** 简报最早发送的本地小时。默认静默是 23–08,20 点仍在工作时段。 */
export const DIGEST_LOCAL_HOUR = 20

export function awaitOutboundId(ticketId: string, runId: string): string {
  return `taskboard-await:${ticketId}:${runId}`
}

export function fuseOutboundId(stageId: string, ymd: string): string {
  return `taskboard-fuse:${stageId}:${ymd}`
}

export function digestOutboundId(ymd: string): string {
  return `taskboard-digest:${ymd}`
}

export function zonedYmd(at: Date, timeZone: string = NOTIFY_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const grab = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  return `${grab('year')}-${grab('month')}-${grab('day')}`
}

export type WechatDeliveryResult =
  | { kind: 'delivered' }
  | { kind: 'fallback'; marked: boolean }
  | { kind: 'failure'; retryable: boolean; code: string }

export interface InboxCreateArgs {
  title: string
  bodyMd: string
  level: 'warning' | 'info'
  deliveryKey: string
}

/**
 * 投递依赖。生产由 createProductionTaskboardNotifier 装配;
 * 测试注入 mock,用来钉死幂等键 / 通道选择 / 失败旁路。
 */
export interface NotifyTransport {
  /** 缺省或返回 fallback → 走站内信兜底。delivered → 不再推站内信。 */
  sendWechat?: (args: { text: string; outboundId: string }) => Promise<WechatDeliveryResult>
  /** info 级兜底。对应容器 inbox-post(限频 + 6h 去重)。 */
  postInbox: (args: { title: string; bodyMd: string; deliveryKey: string }) => Promise<void>
  /**
   * warning 级必须走这条(master createInboxMessage),不能复用 postInbox。
   * 熔断 / 预算触顶用。
   */
  createInboxMessage: (args: InboxCreateArgs) => Promise<void>
}

export interface TaskboardNotifyHooks {
  onWaitingHuman: (info: {
    ticket: Ticket
    run: TicketRun
    stage: PipelineStage
  }) => void | Promise<void>
  onDigestTick: (info: {
    db: TaskboardDb
    at: Date
    settings: TaskboardSettings
  }) => void | Promise<void>
}

export interface TaskboardNotifierOptions {
  getDb: () => TaskboardDb
  transport: NotifyTransport
  now?: () => number
  timezone?: string
  digestHour?: number
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

export interface DigestStats {
  date: string
  completed: number
  created: number
  waitingHuman: number
  blocked: { identifier: string; title: string }[]
  fusedStages: { id: string; name: string }[]
  runs: number
  /** null = 当日 run 全部没有成本字段,文案降级为「成本未统计」。 */
  costUsd: number | null
}

interface DeferredAwait {
  ticketId: string
  runId: string
  title: string
  bodyMd: string
}

export class TaskboardNotifier implements TaskboardNotifyHooks {
  private readonly getDb: () => TaskboardDb
  private readonly transport: NotifyTransport
  private readonly nowFn: () => number
  private readonly timezone: string
  private readonly digestHour: number
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void
  private readonly sent = new Set<string>()
  private readonly deferredAwaits = new Map<string, DeferredAwait>()

  constructor(opts: TaskboardNotifierOptions) {
    this.getDb = opts.getDb
    this.transport = opts.transport
    this.nowFn = opts.now ?? Date.now
    this.timezone = opts.timezone ?? NOTIFY_TIMEZONE
    this.digestHour = opts.digestHour ?? DIGEST_LOCAL_HOUR
    this.log = opts.log ?? (() => {})
  }

  /** 测试用:某 outboundId 是否已视为送达。 */
  hasSent(outboundId: string): boolean {
    return this.sent.has(outboundId)
  }

  async onWaitingHuman(info: {
    ticket: Ticket
    run: TicketRun
    stage: PipelineStage
  }): Promise<void> {
    try {
      const outboundId = awaitOutboundId(info.ticket.id, info.run.id)
      const copy = formatAwaitMessage(info.ticket, info.stage)
      const settings = safeSettings(this.getDb)
      const at = new Date(this.nowFn())
      if (settings && this.inQuiet(at, settings)) {
        this.deferredAwaits.set(outboundId, {
          ticketId: info.ticket.id,
          runId: info.run.id,
          title: copy.title,
          bodyMd: copy.bodyMd,
        })
        return
      }
      await this.deliver({
        outboundId,
        title: copy.title,
        bodyMd: copy.bodyMd,
        warning: false,
      })
    } catch (err) {
      this.log('taskboard await notify failed', {
        ticketId: info.ticket.id,
        runId: info.run.id,
        err: String(err),
      })
    }
  }

  async onGuardrailAlert(alert: GuardrailAlert): Promise<void> {
    try {
      if (alert.kind === 'circuit_open' || alert.kind === 'budget_exhausted') {
        await this.deliver({
          outboundId: alert.outboundId,
          title: alert.kind === 'circuit_open' ? '任务面板：巡检已熔断' : '任务面板：每日预算触顶',
          bodyMd: this.enrichAlertBody(alert),
          warning: true,
        })
        return
      }
      if (alert.kind === 'loop_guard') {
        const settings = safeSettings(this.getDb)
        const at = new Date(this.nowFn())
        if (settings && this.inQuiet(at, settings)) return
        await this.deliver({
          outboundId: alert.outboundId,
          title: '任务面板：单据循环受阻',
          bodyMd: alert.message,
          warning: false,
        })
      }
    } catch (err) {
      this.log('taskboard alert notify failed', {
        kind: alert.kind,
        outboundId: alert.outboundId,
        err: String(err),
      })
    }
  }

  async onDigestTick(info: {
    db: TaskboardDb
    at: Date
    settings: TaskboardSettings
  }): Promise<void> {
    try {
      if (!this.inQuiet(info.at, info.settings)) {
        await this.flushDeferred(info.db)
      }
      await this.maybeSendDigest(info.db, info.at, info.settings)
    } catch (err) {
      this.log('taskboard digest notify failed', { err: String(err) })
    }
  }

  private async flushDeferred(db: TaskboardDb): Promise<void> {
    for (const [outboundId, item] of [...this.deferredAwaits]) {
      const ticket = getTicket(db, item.ticketId)
      if (!ticket || ticket.status !== 'waiting_human') {
        this.deferredAwaits.delete(outboundId)
        continue
      }
      await this.deliver({
        outboundId,
        title: item.title,
        bodyMd: item.bodyMd,
        warning: false,
      })
      if (this.sent.has(outboundId)) this.deferredAwaits.delete(outboundId)
    }
  }

  private async maybeSendDigest(
    db: TaskboardDb,
    at: Date,
    settings: TaskboardSettings,
  ): Promise<void> {
    if (this.inQuiet(at, settings)) return
    const today = zonedYmd(at, this.timezone)
    const hour = zonedDateParts(at, this.timezone).hour
    if (hour >= this.digestHour) {
      await this.sendDigestForDate(db, today)
      return
    }
    // 出静默后、简报点之前:补发昨天的(进程夜间挂了也不会丢)。
    await this.sendDigestForDate(db, previousZonedYmd(today))
  }

  private async sendDigestForDate(db: TaskboardDb, date: string): Promise<void> {
    const outboundId = digestOutboundId(date)
    if (this.sent.has(outboundId)) return
    const stats = collectDigestStats(db, date, this.timezone)
    const copy = formatDigestMessage(stats)
    await this.deliver({
      outboundId,
      title: copy.title,
      bodyMd: copy.bodyMd,
      warning: false,
    })
  }

  private async deliver(args: {
    outboundId: string
    title: string
    bodyMd: string
    warning: boolean
  }): Promise<void> {
    if (this.sent.has(args.outboundId)) return
    try {
      if (this.transport.sendWechat) {
        const result = await this.transport.sendWechat({
          text: `${args.title}\n\n${args.bodyMd}`,
          outboundId: args.outboundId,
        })
        if (result.kind === 'delivered') {
          this.sent.add(args.outboundId)
          return
        }
        if (result.kind === 'failure') {
          // 与 onDeliver 一致:歧义失败不跨通道回退,避免微信已入队再推站内信。
          this.log('taskboard wechat notify failed', {
            outboundId: args.outboundId,
            code: result.code,
            retryable: result.retryable,
          })
          return
        }
        if (result.marked) {
          args = {
            ...args,
            bodyMd: `⚠️ 微信因会话过期/未激活未送达(发条微信即可恢复推送)\n\n${args.bodyMd}`,
          }
        }
      }

      if (args.warning) {
        await this.transport.createInboxMessage({
          title: args.title,
          bodyMd: args.bodyMd,
          level: 'warning',
          deliveryKey: args.outboundId,
        })
      } else {
        await this.transport.postInbox({
          title: args.title,
          bodyMd: args.bodyMd,
          deliveryKey: args.outboundId,
        })
      }
      this.sent.add(args.outboundId)
    } catch (err) {
      this.log('taskboard notify deliver failed', {
        outboundId: args.outboundId,
        err: String(err),
      })
    }
  }

  private inQuiet(at: Date, settings: TaskboardSettings): boolean {
    return isInQuietHours(at, this.timezone, settings.quietHoursStart, settings.quietHoursEnd)
  }

  private enrichAlertBody(alert: GuardrailAlert): string {
    if (!alert.stageId) return alert.message
    try {
      const stage = getStage(this.getDb(), alert.stageId)
      if (stage && !alert.message.includes(stage.name)) {
        return `${alert.message}\n阶段名称：${stage.name}。请到任务面板检查后重新开启巡检。`
      }
    } catch {
      /* 查库失败就用护栏原文 */
    }
    return `${alert.message}请到任务面板检查后重新开启巡检。`
  }
}

export function formatAwaitMessage(
  ticket: Pick<Ticket, 'identifier' | 'title'>,
  stage: Pick<PipelineStage, 'name'>,
): { title: string; bodyMd: string } {
  return {
    title: `任务面板：${ticket.identifier} 等你确认`,
    bodyMd: `「${ticket.identifier} ${ticket.title}」在「${stage.name}」做完了，现在等你确认。打开任务面板即可通过或打回。`,
  }
}

export function formatDigestMessage(stats: DigestStats): { title: string; bodyMd: string } {
  const [, month, day] = stats.date.split('-')
  const title = `任务面板每日简报（${Number(month)}月${Number(day)}日）`
  const blocked =
    stats.blocked.length === 0
      ? '无'
      : stats.blocked.map((t) => t.identifier).join('、') + (stats.blocked.length >= 8 ? ' 等' : '')
  const fused =
    stats.fusedStages.length === 0 ? '无' : stats.fusedStages.map((s) => s.name).join('、')
  const cost = stats.costUsd == null ? '成本未统计' : `成本 $${stats.costUsd.toFixed(4)}`
  const trouble = stats.blocked.length > 0 || stats.fusedStages.length > 0
  const closing = trouble ? '有站点出事，请打开任务面板处理。' : '没有受阻或熔断，自动化运转正常。'
  const bodyMd = [
    `当日完成 ${stats.completed} 张，新建 ${stats.created} 张，待我确认 ${stats.waitingHuman} 张。`,
    `受阻：${blocked}。熔断站点：${fused}。`,
    `当日 run ${stats.runs} 次，${cost}。`,
    closing,
  ].join('\n')
  return { title, bodyMd }
}

export function collectDigestStats(
  db: TaskboardDb,
  date: string,
  timeZone: string = NOTIFY_TIMEZONE,
): DigestStats {
  const { start, end } = zonedDayRangeMs(date, timeZone)
  const completed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tb_ticket
          WHERE status = 'done'
            AND COALESCE(closed_at, updated_at) >= ? AND COALESCE(closed_at, updated_at) < ?`,
      )
      .get(start, end) as { n: number }
  ).n
  const created = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tb_ticket
          WHERE created_at >= ? AND created_at < ?`,
      )
      .get(start, end) as { n: number }
  ).n
  const waitingHuman = (
    db.prepare(`SELECT COUNT(*) AS n FROM tb_ticket WHERE status = 'waiting_human'`).get() as {
      n: number
    }
  ).n
  const blocked = db
    .prepare(
      `SELECT identifier, title FROM tb_ticket
        WHERE status = 'blocked'
        ORDER BY updated_at DESC
        LIMIT 8`,
    )
    .all() as { identifier: string; title: string }[]
  const fusedStages = db
    .prepare(
      `SELECT id, name FROM tb_pipeline_stage
        WHERE patrol_enabled = 0
        ORDER BY name ASC
        LIMIT 12`,
    )
    .all() as { id: string; name: string }[]
  const usage = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              COUNT(cost_usd) AS cost_n,
              COALESCE(SUM(cost_usd), 0) AS cost_sum
         FROM tb_ticket_run
        WHERE created_at >= ? AND created_at < ?
          AND status != 'skipped'`,
    )
    .get(start, end) as { runs: number; cost_n: number; cost_sum: number }
  return {
    date,
    completed,
    created,
    waitingHuman,
    blocked,
    fusedStages,
    runs: usage.runs,
    costUsd: usage.cost_n > 0 ? usage.cost_sum : null,
  }
}

/** 上海无 DST:本地 00:00 = UTC 前一天 16:00。其它时区走 Intl 反查。 */
export function zonedDayRangeMs(
  ymd: string,
  timeZone: string = NOTIFY_TIMEZONE,
): { start: number; end: number } {
  const [y, m, d] = ymd.split('-').map(Number)
  if (timeZone === 'Asia/Shanghai') {
    const start = Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3600_000
    return { start, end: start + 24 * 3600_000 }
  }
  // 其它时区:从 UTC 正午附近扫到该本地日的 00:00。
  const probe = Date.UTC(y, m - 1, d, 12, 0, 0)
  const localHour = zonedDateParts(new Date(probe), timeZone).hour
  const start = probe - localHour * 3600_000
  return { start, end: start + 24 * 3600_000 }
}

export function previousZonedYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const utc = Date.UTC(y, m - 1, d) - 24 * 3600_000
  const dt = new Date(utc)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function safeSettings(getDb: () => TaskboardDb): TaskboardSettings | null {
  try {
    return getSettings(getDb())
  } catch {
    return null
  }
}

/** 给 patrol 用:通知抛错不能砸 tick / run。 */
export function fireNotify(
  fn: (() => void | Promise<void>) | undefined,
  log: (msg: string, extra?: Record<string, unknown>) => void,
  label: string,
  extra: Record<string, unknown> = {},
): void {
  if (!fn) return
  try {
    const ret = fn()
    if (ret && typeof ret.then === 'function') {
      void ret.catch((err) => log(label, { ...extra, err: String(err) }))
    }
  } catch (err) {
    log(label, { ...extra, err: String(err) })
  }
}
