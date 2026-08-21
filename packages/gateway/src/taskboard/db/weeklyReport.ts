// 周报:从已有 ticket / activity / run 现算,不另存快照。
// 覆盖周期内单据流转、各阶段执行耗时、成本/token(含缺单价)、阻塞与失败。

import { zonedDayRangeMs, zonedYmd } from '../notify.js'
import { zonedDateParts } from '../patrolWindow.js'
import { type CostTotals, queryCostStats } from './costStats.js'
import type { TaskboardDb } from './schema.js'

const TZ = 'Asia/Shanghai'

export interface WeeklyPeriod {
  week: string
  fromYmd: string
  toYmd: string
  fromMs: number
  toMs: number
  timeZone: string
}

export interface TicketFlow {
  created: number
  completed: number
  canceled: number
  waitingHuman: number
  blockedNow: number
  statusTransitions: { from: string; to: string; count: number }[]
}

export interface StageSpend {
  stageId: string
  stageName: string
  runCount: number
  succeeded: number
  failed: number
  timeout: number
  totalDurationMs: number
  avgDurationMs: number
}

export interface BlockedItem {
  identifier: string
  title: string
  blockedReason: string | null
}

export interface FailedRunItem {
  runId: string
  identifier: string
  stageName: string | null
  status: string
  error: string | null
  createdAt: number
}

export interface WeeklyReport {
  period: WeeklyPeriod
  projectId: string | null
  flow: TicketFlow
  stages: StageSpend[]
  cost: CostTotals
  blocked: BlockedItem[]
  failedRuns: FailedRunItem[]
}

export interface WeeklyReportQuery {
  fromMs: number
  toMs: number
  fromYmd: string
  toYmd: string
  week?: string
  projectId?: string
  timeZone?: string
}

function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const utc = Date.UTC(y, m - 1, d) + delta * 86_400_000
  const dt = new Date(utc)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** 上海日历周一 YYYY-MM-DD。 */
export function shanghaiMondayYmd(at: Date, timeZone = TZ): string {
  const ymd = zonedYmd(at, timeZone)
  const parts = zonedDateParts(at, timeZone)
  const daysFromMonday = parts.weekday === 0 ? 6 : parts.weekday - 1
  return addDaysYmd(ymd, -daysFromMonday)
}

/**
 * ISO 周:该周周四所在年 + 年内周序号。返回 `YYYY-Www`。
 */
export function isoWeekLabel(mondayYmd: string): string {
  const thursday = addDaysYmd(mondayYmd, 3)
  const [y, m, d] = thursday.split('-').map(Number)
  const jan1 = Date.UTC(y, 0, 1)
  const thu = Date.UTC(y, m - 1, d)
  const dayOfYear = Math.floor((thu - jan1) / 86_400_000) + 1
  const week = Math.floor((dayOfYear - 1) / 7) + 1
  return `${y}-W${String(week).padStart(2, '0')}`
}

export function periodFromMonday(mondayYmd: string, timeZone = TZ): WeeklyPeriod {
  const sundayYmd = addDaysYmd(mondayYmd, 6)
  const { start } = zonedDayRangeMs(mondayYmd, timeZone)
  const { end } = zonedDayRangeMs(sundayYmd, timeZone)
  return {
    week: isoWeekLabel(mondayYmd),
    fromYmd: mondayYmd,
    toYmd: sundayYmd,
    fromMs: start,
    toMs: end,
    timeZone,
  }
}

export function currentWeekPeriod(now = new Date(), timeZone = TZ): WeeklyPeriod {
  return periodFromMonday(shanghaiMondayYmd(now, timeZone), timeZone)
}

/** 解析 `2026-W34`(ISO 周,周一到周日,上海日历)。 */
export function periodFromIsoWeek(week: string, timeZone = TZ): WeeklyPeriod | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week.trim())
  if (!m) return null
  const year = Number(m[1])
  const weekNo = Number(m[2])
  if (weekNo < 1 || weekNo > 53) return null
  const jan4 = new Date(Date.UTC(year, 0, 4, 4, 0, 0))
  const mondayWeek1 = shanghaiMondayYmd(jan4, timeZone)
  const monday = addDaysYmd(mondayWeek1, (weekNo - 1) * 7)
  if (isoWeekLabel(monday) !== `${year}-W${String(weekNo).padStart(2, '0')}`) {
    const period = periodFromMonday(monday, timeZone)
    return period
  }
  return periodFromMonday(monday, timeZone)
}

export function buildWeeklyReport(db: TaskboardDb, query: WeeklyReportQuery): WeeklyReport {
  const timeZone = query.timeZone ?? TZ
  const period: WeeklyPeriod = {
    week: query.week ?? isoWeekLabel(query.fromYmd),
    fromYmd: query.fromYmd,
    toYmd: query.toYmd,
    fromMs: query.fromMs,
    toMs: query.toMs,
    timeZone,
  }
  const ticketScope = query.projectId ? 'AND project_id = @projectId' : ''
  const params: Record<string, unknown> = {
    fromMs: query.fromMs,
    toMs: query.toMs,
    projectId: query.projectId ?? null,
  }

  const created = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tb_ticket
          WHERE created_at >= @fromMs AND created_at < @toMs ${ticketScope}`,
      )
      .get(params) as { n: number }
  ).n
  const completed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tb_ticket
          WHERE status = 'done'
            AND COALESCE(closed_at, updated_at) >= @fromMs
            AND COALESCE(closed_at, updated_at) < @toMs ${ticketScope}`,
      )
      .get(params) as { n: number }
  ).n
  const canceled = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tb_ticket
          WHERE status = 'canceled'
            AND updated_at >= @fromMs AND updated_at < @toMs ${ticketScope}`,
      )
      .get(params) as { n: number }
  ).n
  const waitingHuman = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tb_ticket
          WHERE status = 'waiting_human' ${ticketScope}`,
      )
      .get(params) as { n: number }
  ).n
  const blockedNow = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tb_ticket
          WHERE status = 'blocked' ${ticketScope}`,
      )
      .get(params) as { n: number }
  ).n

  const transitionRows = db
    .prepare(
      `SELECT a.from_value AS from_value, a.to_value AS to_value, COUNT(*) AS n
         FROM tb_ticket_activity a
         JOIN tb_ticket t ON t.id = a.ticket_id
        WHERE a.action = 'status_changed'
          AND a.created_at >= @fromMs AND a.created_at < @toMs
          ${query.projectId ? 'AND t.project_id = @projectId' : ''}
        GROUP BY a.from_value, a.to_value
        ORDER BY n DESC`,
    )
    .all(params) as { from_value: string | null; to_value: string | null; n: number }[]

  const stageRows = db
    .prepare(
      `SELECT r.stage_id AS stage_id,
              COALESCE(s.name, r.stage_id) AS stage_name,
              COUNT(*) AS run_count,
              SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN r.status = 'timeout' THEN 1 ELSE 0 END) AS timeout,
              COALESCE(SUM(r.duration_ms), 0) AS total_duration_ms
         FROM tb_ticket_run r
         JOIN tb_ticket t ON t.id = r.ticket_id
         LEFT JOIN tb_pipeline_stage s ON s.id = r.stage_id
        WHERE r.status IN ('succeeded', 'failed', 'timeout')
          AND r.created_at >= @fromMs AND r.created_at < @toMs
          ${query.projectId ? 'AND t.project_id = @projectId' : ''}
        GROUP BY r.stage_id
        ORDER BY total_duration_ms DESC`,
    )
    .all(params) as {
    stage_id: string
    stage_name: string
    run_count: number
    succeeded: number
    failed: number
    timeout: number
    total_duration_ms: number
  }[]

  const blocked = db
    .prepare(
      `SELECT identifier, title, blocked_reason FROM tb_ticket
        WHERE status = 'blocked' ${ticketScope}
        ORDER BY updated_at DESC
        LIMIT 20`,
    )
    .all(params) as { identifier: string; title: string; blocked_reason: string | null }[]

  const failedRuns = db
    .prepare(
      `SELECT r.id AS run_id, t.identifier AS identifier, s.name AS stage_name,
              r.status AS status, r.error AS error, r.created_at AS created_at
         FROM tb_ticket_run r
         JOIN tb_ticket t ON t.id = r.ticket_id
         LEFT JOIN tb_pipeline_stage s ON s.id = r.stage_id
        WHERE r.status IN ('failed', 'timeout')
          AND r.created_at >= @fromMs AND r.created_at < @toMs
          ${query.projectId ? 'AND t.project_id = @projectId' : ''}
        ORDER BY r.created_at DESC
        LIMIT 20`,
    )
    .all(params) as {
    run_id: string
    identifier: string
    stage_name: string | null
    status: string
    error: string | null
    created_at: number
  }[]

  const cost = queryCostStats(db, {
    fromMs: query.fromMs,
    toMs: query.toMs,
    projectId: query.projectId,
    timeZone,
  }).totals

  return {
    period,
    projectId: query.projectId ?? null,
    flow: {
      created,
      completed,
      canceled,
      waitingHuman,
      blockedNow,
      statusTransitions: transitionRows.map((row) => ({
        from: row.from_value ?? '',
        to: row.to_value ?? '',
        count: row.n,
      })),
    },
    stages: stageRows.map((row) => ({
      stageId: row.stage_id,
      stageName: row.stage_name,
      runCount: row.run_count,
      succeeded: row.succeeded,
      failed: row.failed,
      timeout: row.timeout,
      totalDurationMs: row.total_duration_ms,
      avgDurationMs: row.run_count > 0 ? Math.round(row.total_duration_ms / row.run_count) : 0,
    })),
    cost,
    blocked: blocked.map((row) => ({
      identifier: row.identifier,
      title: row.title,
      blockedReason: row.blocked_reason,
    })),
    failedRuns: failedRuns.map((row) => ({
      runId: row.run_id,
      identifier: row.identifier,
      stageName: row.stage_name,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
    })),
  }
}
