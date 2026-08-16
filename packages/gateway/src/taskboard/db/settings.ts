// Taskboard 全局护栏 settings DAO。
//
// 设计意图:
//   单行表 tb_settings(id='global'),字段对齐 GUARDRAIL_DEFAULTS + patrolPaused。
//   HTTP GET/PATCH /api/board/settings 与巡检 tick 共用这一份,禁止再在 http.ts
//   旁路建表(T3 的 TASKBOARD_SETTINGS_DDL 已并进 schema.ts V1)。
//
// 坑:
//   - 库是新开的就走 migrate → DDL 已含此表;仍要 INSERT 默认行,CREATE TABLE
//     不会塞数据。
//   - usage 的「今日」按本地日历日切,与静默时段同一套本地时区语义。
//   - 成本 SUM 遇到全 NULL 要用 COALESCE,否则 JS 拿到 null 当 0 会 silently 漂。

import { GUARDRAIL_DEFAULTS } from '../domain.js'
import { type TaskboardDb, boolToInt, intToBool, nowMs } from './schema.js'

export interface TaskboardSettings {
  maxConcurrentRuns: number
  maxRunsPerDay: number
  maxCostPerDayUsd: number | null
  quietHoursStart: number
  quietHoursEnd: number
  circuitBreakerThreshold: number
  maxStageLoops: number
  maxRunsPerTick: number
  patrolPaused: boolean
}

export interface TaskboardUsage {
  runsToday: number
  costTodayUsd: number
  activeRuns: number
}

interface SettingsRow {
  max_concurrent_runs: number
  max_runs_per_day: number
  max_cost_per_day_usd: number | null
  quiet_hours_start: number
  quiet_hours_end: number
  circuit_breaker_threshold: number
  max_stage_loops: number
  max_runs_per_tick: number
  patrol_paused: number
}

export function defaultSettings(): TaskboardSettings {
  return {
    maxConcurrentRuns: GUARDRAIL_DEFAULTS.maxConcurrentRuns,
    maxRunsPerDay: GUARDRAIL_DEFAULTS.maxRunsPerDay,
    maxCostPerDayUsd: GUARDRAIL_DEFAULTS.maxCostPerDayUsd,
    quietHoursStart: GUARDRAIL_DEFAULTS.quietHoursStart,
    quietHoursEnd: GUARDRAIL_DEFAULTS.quietHoursEnd,
    circuitBreakerThreshold: GUARDRAIL_DEFAULTS.circuitBreakerThreshold,
    maxStageLoops: GUARDRAIL_DEFAULTS.maxStageLoops,
    maxRunsPerTick: GUARDRAIL_DEFAULTS.maxRunsPerTick,
    patrolPaused: false,
  }
}

function mapSettings(row: SettingsRow): TaskboardSettings {
  return {
    maxConcurrentRuns: row.max_concurrent_runs,
    maxRunsPerDay: row.max_runs_per_day,
    maxCostPerDayUsd: row.max_cost_per_day_usd,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    circuitBreakerThreshold: row.circuit_breaker_threshold,
    maxStageLoops: row.max_stage_loops,
    maxRunsPerTick: row.max_runs_per_tick,
    patrolPaused: intToBool(row.patrol_paused),
  }
}

/** 缺行时插入 GUARDRAIL_DEFAULTS。幂等,migrate 之后 / 每次读写前都可调。 */
export function ensureSettingsRow(db: TaskboardDb): void {
  const existing = db.prepare('SELECT id FROM tb_settings WHERE id = ?').get('global') as
    | { id: string }
    | undefined
  if (existing) return
  const d = defaultSettings()
  db.prepare(
    `INSERT INTO tb_settings (
       id, max_concurrent_runs, max_runs_per_day, max_cost_per_day_usd,
       quiet_hours_start, quiet_hours_end, circuit_breaker_threshold,
       max_stage_loops, max_runs_per_tick, patrol_paused, updated_at
     ) VALUES (
       'global', @maxConcurrentRuns, @maxRunsPerDay, @maxCostPerDayUsd,
       @quietHoursStart, @quietHoursEnd, @circuitBreakerThreshold,
       @maxStageLoops, @maxRunsPerTick, @patrolPaused, @now
     )`,
  ).run({
    ...d,
    patrolPaused: boolToInt(d.patrolPaused),
    now: nowMs(),
  })
}

export function getSettings(db: TaskboardDb): TaskboardSettings {
  ensureSettingsRow(db)
  const row = db.prepare('SELECT * FROM tb_settings WHERE id = ?').get('global') as SettingsRow
  return mapSettings(row)
}

export function updateSettings(
  db: TaskboardDb,
  patch: Partial<TaskboardSettings>,
): TaskboardSettings {
  const cur = getSettings(db)
  const next: TaskboardSettings = {
    maxConcurrentRuns: patch.maxConcurrentRuns ?? cur.maxConcurrentRuns,
    maxRunsPerDay: patch.maxRunsPerDay ?? cur.maxRunsPerDay,
    maxCostPerDayUsd:
      patch.maxCostPerDayUsd === undefined ? cur.maxCostPerDayUsd : patch.maxCostPerDayUsd,
    quietHoursStart: patch.quietHoursStart ?? cur.quietHoursStart,
    quietHoursEnd: patch.quietHoursEnd ?? cur.quietHoursEnd,
    circuitBreakerThreshold: patch.circuitBreakerThreshold ?? cur.circuitBreakerThreshold,
    maxStageLoops: patch.maxStageLoops ?? cur.maxStageLoops,
    maxRunsPerTick: patch.maxRunsPerTick ?? cur.maxRunsPerTick,
    patrolPaused: patch.patrolPaused ?? cur.patrolPaused,
  }
  db.prepare(
    `UPDATE tb_settings SET
       max_concurrent_runs = @maxConcurrentRuns,
       max_runs_per_day = @maxRunsPerDay,
       max_cost_per_day_usd = @maxCostPerDayUsd,
       quiet_hours_start = @quietHoursStart,
       quiet_hours_end = @quietHoursEnd,
       circuit_breaker_threshold = @circuitBreakerThreshold,
       max_stage_loops = @maxStageLoops,
       max_runs_per_tick = @maxRunsPerTick,
       patrol_paused = @patrolPaused,
       updated_at = @now
     WHERE id = 'global'`,
  ).run({
    ...next,
    patrolPaused: boolToInt(next.patrolPaused),
    now: nowMs(),
  })
  return next
}

export function startOfLocalDayMs(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function getUsage(db: TaskboardDb, now = Date.now()): TaskboardUsage {
  const start = startOfLocalDayMs(now)
  const today = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost
         FROM tb_ticket_run WHERE created_at >= ?`,
    )
    .get(start) as { n: number; cost: number }
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tb_ticket_run
        WHERE status IN ('queued', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?`,
    )
    .get(now) as { n: number }
  return {
    runsToday: today.n,
    costTodayUsd: today.cost,
    activeRuns: active.n,
  }
}

/** 今日该卡该 stage 的非 skipped run 数(日配额用;skipped 不占额度)。 */
export function countTicketStageRunsToday(
  db: TaskboardDb,
  ticketId: string,
  stageId: string,
  now = Date.now(),
): number {
  const start = startOfLocalDayMs(now)
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tb_ticket_run
        WHERE ticket_id = ? AND stage_id = ?
          AND created_at >= ?
          AND status != 'skipped'`,
    )
    .get(ticketId, stageId, start) as { n: number }
  return row.n
}

/**
 * 同一 ticket + stage + skipReason 在本地日历日是否已有 skipped run。
 * 巡检用它做落库去重,避免 60s tick 把时间线刷爆。
 */
export function hasSkippedRunToday(
  db: TaskboardDb,
  ticketId: string,
  stageId: string,
  skipReason: string,
  now = Date.now(),
): boolean {
  const start = startOfLocalDayMs(now)
  const row = db
    .prepare(
      `SELECT id FROM tb_ticket_run
        WHERE ticket_id = ? AND stage_id = ?
          AND status = 'skipped' AND skip_reason = ?
          AND created_at >= ?
        LIMIT 1`,
    )
    .get(ticketId, stageId, skipReason, start) as { id: string } | undefined
  return Boolean(row)
}

/** 该 stage 从最近一次成功往回数的连续失败/超时次数(熔断用)。 */
export function countConsecutiveStageFailures(db: TaskboardDb, stageId: string): number {
  const rows = db
    .prepare(
      `SELECT status FROM tb_ticket_run
        WHERE stage_id = ? AND status IN ('succeeded', 'failed', 'timeout')
        ORDER BY created_at DESC
        LIMIT 32`,
    )
    .all(stageId) as { status: string }[]
  let n = 0
  for (const row of rows) {
    if (row.status === 'succeeded') break
    n += 1
  }
  return n
}
