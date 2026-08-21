// 成本 / token 聚合。从 tb_ticket_run 现算,不加汇总表。
//
// 关键事实:本实例多条模型路由的 cost_usd 恒为 0 —— Cursor / Grok 适配器写死 0,
// 部分 codex 路由上游缺单价也记 0。token 却是真实的。因此不能把 cost_usd=0
// 静默当成「没花钱」:
//   priced   —— cost_usd > 0,或 cost_usd=0 且 token=0(真的没消耗)
//   unpriced —— token > 0 且 (cost_usd 为 null 或 0):有用量但没有单价数据
//   unknown  —— token=0 且 cost_usd 为 null:连用量都没记上
// skipped run 不进统计。美元合计只加 priced,unpriced 的 token 单独列出。

import { zonedDayRangeMs, zonedYmd } from '../notify.js'
import type { TaskboardDb } from './schema.js'

export const COST_GROUP_BY = ['day', 'project', 'ticket', 'stage'] as const
export type CostGroupBy = (typeof COST_GROUP_BY)[number]

export type CostCoverage = 'full' | 'partial' | 'unpriced_only' | 'none'

export interface CostSlice {
  runCount: number
  tokensIn: number
  tokensOut: number
  /** 只含 priced 的美元合计。unpriced 不掺进来当 0。 */
  costUsd: number
}

export interface CostTotals extends CostSlice {
  priced: CostSlice
  unpriced: CostSlice
  unknownRunCount: number
  /**
   * full          所有有用量的 run 都有单价
   * partial       有的有单价、有的没有
   * unpriced_only 有 token 但全部没有单价(面板绝不能显示「$0」)
   * none          区间内没有可统计的 run
   */
  coverage: CostCoverage
}

export interface CostBucket extends CostTotals {
  key: string
  label: string
  projectId?: string
  ticketId?: string
  stageId?: string
  identifier?: string
}

export interface CostStatsQuery {
  fromMs: number
  toMs: number
  projectId?: string
  ticketId?: string
  stageId?: string
  groupBy?: CostGroupBy
  timeZone?: string
}

export interface CostStatsResult {
  fromMs: number
  toMs: number
  timeZone: string
  totals: CostTotals
  buckets: CostBucket[]
}

interface RunCostRow {
  id: string
  ticket_id: string
  stage_id: string
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  created_at: number
  project_id: string
  identifier: string
  ticket_title: string
  project_key: string
  project_name: string
  stage_name: string | null
}

export type CostClass = 'priced' | 'unpriced' | 'unknown'

/**
 * 单条 run 的成本分类。token>0 且 cost 为 0/null → 缺单价,不是真的花了 0。
 */
export function classifyRunCost(
  tokensIn: number | null,
  tokensOut: number | null,
  costUsd: number | null,
): CostClass {
  const tin = tokensIn ?? 0
  const tout = tokensOut ?? 0
  const tokens = tin + tout
  if (tokens > 0 && (costUsd == null || costUsd === 0)) return 'unpriced'
  if (costUsd == null) return 'unknown'
  return 'priced'
}

function emptySlice(): CostSlice {
  return { runCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }
}

function coverageOf(priced: number, unpriced: number, unknown: number): CostCoverage {
  if (priced === 0 && unpriced === 0 && unknown === 0) return 'none'
  if (unpriced > 0 && priced === 0) return 'unpriced_only'
  if (unpriced > 0 && priced > 0) return 'partial'
  return 'full'
}

function addRun(slice: CostSlice, tokensIn: number, tokensOut: number, costUsd: number): void {
  slice.runCount += 1
  slice.tokensIn += tokensIn
  slice.tokensOut += tokensOut
  slice.costUsd += costUsd
}

function toTotals(priced: CostSlice, unpriced: CostSlice, unknownRunCount: number): CostTotals {
  return {
    runCount: priced.runCount + unpriced.runCount + unknownRunCount,
    tokensIn: priced.tokensIn + unpriced.tokensIn,
    tokensOut: priced.tokensOut + unpriced.tokensOut,
    costUsd: priced.costUsd,
    priced: { ...priced },
    unpriced: { ...unpriced },
    unknownRunCount,
    coverage: coverageOf(priced.runCount, unpriced.runCount, unknownRunCount),
  }
}

function loadRuns(db: TaskboardDb, query: CostStatsQuery): RunCostRow[] {
  const where = ["r.status != 'skipped'", 'r.created_at >= @fromMs', 'r.created_at < @toMs']
  const params: Record<string, unknown> = { fromMs: query.fromMs, toMs: query.toMs }
  if (query.projectId) {
    where.push('t.project_id = @projectId')
    params.projectId = query.projectId
  }
  if (query.ticketId) {
    where.push('t.id = @ticketId')
    params.ticketId = query.ticketId
  }
  if (query.stageId) {
    where.push('r.stage_id = @stageId')
    params.stageId = query.stageId
  }
  return db
    .prepare(
      `SELECT r.id, r.ticket_id, r.stage_id, r.tokens_in, r.tokens_out, r.cost_usd, r.created_at,
              t.project_id, t.identifier, t.title AS ticket_title,
              p.key AS project_key, p.name AS project_name,
              s.name AS stage_name
         FROM tb_ticket_run r
         JOIN tb_ticket t ON t.id = r.ticket_id
         JOIN tb_project p ON p.id = t.project_id
         LEFT JOIN tb_pipeline_stage s ON s.id = r.stage_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at ASC`,
    )
    .all(params) as RunCostRow[]
}

function bucketKey(
  row: RunCostRow,
  groupBy: CostGroupBy,
  timeZone: string,
): { key: string; label: string; extra: Partial<CostBucket> } {
  if (groupBy === 'day') {
    const day = zonedYmd(new Date(row.created_at), timeZone)
    return { key: day, label: day, extra: {} }
  }
  if (groupBy === 'project') {
    return {
      key: row.project_id,
      label: `${row.project_key} ${row.project_name}`.trim(),
      extra: { projectId: row.project_id },
    }
  }
  if (groupBy === 'ticket') {
    return {
      key: row.ticket_id,
      label: `${row.identifier} ${row.ticket_title}`.trim(),
      extra: { ticketId: row.ticket_id, identifier: row.identifier, projectId: row.project_id },
    }
  }
  return {
    key: row.stage_id,
    label: row.stage_name ?? row.stage_id,
    extra: { stageId: row.stage_id },
  }
}

function accumulate(rows: RunCostRow[]): {
  priced: CostSlice
  unpriced: CostSlice
  unknownRunCount: number
} {
  const priced = emptySlice()
  const unpriced = emptySlice()
  let unknownRunCount = 0
  for (const row of rows) {
    const tin = row.tokens_in ?? 0
    const tout = row.tokens_out ?? 0
    const klass = classifyRunCost(row.tokens_in, row.tokens_out, row.cost_usd)
    if (klass === 'unpriced') {
      addRun(unpriced, tin, tout, 0)
    } else if (klass === 'unknown') {
      unknownRunCount += 1
    } else {
      addRun(priced, tin, tout, row.cost_usd ?? 0)
    }
  }
  return { priced, unpriced, unknownRunCount }
}

export function queryCostStats(db: TaskboardDb, query: CostStatsQuery): CostStatsResult {
  const timeZone = query.timeZone ?? 'Asia/Shanghai'
  const rows = loadRuns(db, query)
  const totalsAcc = accumulate(rows)
  const totals = toTotals(totalsAcc.priced, totalsAcc.unpriced, totalsAcc.unknownRunCount)
  const buckets: CostBucket[] = []
  if (query.groupBy) {
    const groups = new Map<string, RunCostRow[]>()
    const meta = new Map<string, { label: string; extra: Partial<CostBucket> }>()
    for (const row of rows) {
      const { key, label, extra } = bucketKey(row, query.groupBy, timeZone)
      const list = groups.get(key)
      if (list) list.push(row)
      else groups.set(key, [row])
      if (!meta.has(key)) meta.set(key, { label, extra })
    }
    for (const [key, list] of groups) {
      const acc = accumulate(list)
      const info = meta.get(key)!
      buckets.push({
        key,
        label: info.label,
        ...info.extra,
        ...toTotals(acc.priced, acc.unpriced, acc.unknownRunCount),
      })
    }
  }
  return {
    fromMs: query.fromMs,
    toMs: query.toMs,
    timeZone,
    totals,
    buckets,
  }
}

/** 把 YYYY-MM-DD 闭区间转成 [start, nextDay) 毫秒。非法日期抛 validation 由调用方处理。 */
export function ymdRangeMs(
  fromYmd: string,
  toYmdInclusive: string,
  timeZone = 'Asia/Shanghai',
): { fromMs: number; toMs: number } {
  const from = zonedDayRangeMs(fromYmd, timeZone)
  const to = zonedDayRangeMs(toYmdInclusive, timeZone)
  return { fromMs: from.start, toMs: to.end }
}
