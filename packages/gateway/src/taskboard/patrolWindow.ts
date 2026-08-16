// Taskboard 巡检时间窗 —— cron 匹配 / 静默时段 / 空转降频(纯逻辑,无 I/O)。
//
// 设计意图:
//   巡检引擎每 60s tick 一次,对每个 patrol_enabled 的 stage 问「这一轮该不该巡」。
//   本模块只回答到点判断,不查库、不认领、不跑 agent。当前时间一律由调用方传入,
//   才能被单测钉死,也能被 HTTP「立刻巡检一次」与 tick 同时复用。
//
// 坑:
//   1. 不能 import packages/gateway/src/cron.ts 的 cronMatches。那个函数用
//      Date#getMinutes 读「已经按 TZ 偏移过的 Date」,自己还读 process.env.TZ
//      和 Date.now();一 import 会把 fs/yaml/sessionManager 整棵树拖进来,破坏
//      纯函数约束。字段匹配算法与 cron.ts:730-760 对齐(见下方 fieldMatches),
//      时区改走 Intl.DateTimeFormat,与 web-react/src/lib/cron.ts 的 shanghaiParts
//      同一套路。
//   2. 不要用 UTC 偏移硬算(getTime()+8h)。DST 时区(America/New_York)会错。
//   3. hourCycle:'h23' 必须开:部分引擎在午夜会给出 hour=24,直接拿去比 cron 必歪。
//   4. lastPatrolAt 是上次 **实际巡检**(shouldPatrol 返回 patrol:true)的时间,
//      不是上次 tick。调用方若把跳过的 tick 也写进去,空转降频会失效。
//   5. 静默/降频默认值读 GUARDRAIL_DEFAULTS;stage.quietHours* 为 null 时回落默认。
//      PipelineStage 还没有 idleBackoff 字段,故允许调用方在入参上覆盖。
//   6. RUN_SKIP_REASONS 没有 patrol_disabled / idle_backoff。关闭巡检不填
//      skipReason;cron 未到点 / 静默 / 降频都用 outside_window(最接近的枚举)。

import { GUARDRAIL_DEFAULTS, type PipelineStage, type RunSkipReason } from './domain.js'

// ── 时区分量 ────────────────────────────────────────────────────────────────

export interface ZonedDateParts {
  minute: number
  hour: number
  day: number
  month: number
  /** 0=周日 … 6=周六,与 Date#getDay / crontab dow 一致。 */
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/** 用 IANA 时区取本地分/时/日/月/周。非法 timeZone 让 Intl 抛 RangeError。 */
export function zonedDateParts(at: Date, timezone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at)
  const grab = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  let hour = Number(grab('hour'))
  if (hour === 24) hour = 0
  const weekday = WEEKDAY_INDEX[grab('weekday')]
  if (weekday === undefined) {
    throw new RangeError(`无法解析时区 ${timezone} 的星期字段`)
  }
  return {
    minute: Number(grab('minute')),
    hour,
    day: Number(grab('day')),
    month: Number(grab('month')),
    weekday,
  }
}

// ── cron 字段匹配(与 gateway/src/cron.ts:730-760 对齐) ─────────────────────

function fieldMatches(field: string, val: number): boolean {
  for (const part of field.split(',')) {
    if (matchPart(part, val)) return true
  }
  return false
}

function matchPart(part: string, val: number): boolean {
  if (part === '*') return true
  const stepMatch = part.match(/^(.+)\/(\d+)$/)
  if (stepMatch) {
    const base = stepMatch[1]
    const step = Number(stepMatch[2])
    if (base === '*') return val % step === 0
    const range = base.split('-')
    if (range.length === 2) {
      const start = Number(range[0])
      const end = Number(range[1])
      return val >= start && val <= end && (val - start) % step === 0
    }
    return false
  }
  const rangeMatch = part.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const start = Number(rangeMatch[1])
    const end = Number(rangeMatch[2])
    return val >= start && val <= end
  }
  const n = Number(part)
  if (!Number.isNaN(n)) return n === val
  return false
}

/**
 * 5 字段 crontab(分 时 日 月 周)是否命中 `at` 在 `timezone` 下的本地分量。
 * 支持星号、星号/n、a-b、a,b,c、a-b/n(字面星号斜杠会终止本块注释,故用「星号」)。
 * 字段数不对或非法字段 → false。
 */
export function cronMatches(expr: string, at: Date, timezone: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const local = zonedDateParts(at, timezone)
  const vals = [local.minute, local.hour, local.day, local.month, local.weekday]
  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(fields[i], vals[i])) return false
  }
  return true
}

// ── 静默时段 ────────────────────────────────────────────────────────────────

/**
 * 是否落在静默小时区间。[startHour, endHour) 半开。
 * start > end 视为跨午夜(如 23→8: 23,24,…,7 为静默,8 点整已出静默)。
 * start === end 视为未配置静默(永不静默)。
 */
export function isInQuietHours(
  at: Date,
  timezone: string,
  startHour: number,
  endHour: number,
): boolean {
  if (startHour === endHour) return false
  const { hour } = zonedDateParts(at, timezone)
  if (startHour < endHour) return hour >= startHour && hour < endHour
  return hour >= startHour || hour < endHour
}

// ── 综合到点判断 ────────────────────────────────────────────────────────────

export type PatrolStageView = Pick<
  PipelineStage,
  'patrolEnabled' | 'patrolCron' | 'patrolTimezone' | 'quietHoursStart' | 'quietHoursEnd'
> & {
  /** 覆盖 GUARDRAIL_DEFAULTS;domain 尚无此字段。 */
  idleBackoffAfterTicks?: number | null
  idleBackoffIntervalMs?: number | null
}

export type PatrolVerdict =
  | { patrol: true }
  | { patrol: false; skipReason?: RunSkipReason; detail: string }

export function shouldPatrol(
  stage: PatrolStageView,
  at: Date,
  lastPatrolAt?: Date | null,
  idleTicks?: number,
): PatrolVerdict {
  if (!stage.patrolEnabled) {
    return { patrol: false, detail: '本阶段已关闭巡检(patrolEnabled=false)。' }
  }
  if (!stage.patrolCron) {
    return { patrol: false, detail: '本阶段未配置巡检 cron,不参与调度。' }
  }
  if (!cronMatches(stage.patrolCron, at, stage.patrolTimezone)) {
    return {
      patrol: false,
      skipReason: 'outside_window',
      detail: `当前时间未命中巡检 cron「${stage.patrolCron}」(时区 ${stage.patrolTimezone})。`,
    }
  }

  const quietStart = stage.quietHoursStart ?? GUARDRAIL_DEFAULTS.quietHoursStart
  const quietEnd = stage.quietHoursEnd ?? GUARDRAIL_DEFAULTS.quietHoursEnd
  if (isInQuietHours(at, stage.patrolTimezone, quietStart, quietEnd)) {
    return {
      patrol: false,
      skipReason: 'outside_window',
      detail: `落在静默时段 ${quietStart}:00–${quietEnd}:00(${stage.patrolTimezone})。`,
    }
  }

  const afterTicks = stage.idleBackoffAfterTicks ?? GUARDRAIL_DEFAULTS.idleBackoffAfterTicks
  const intervalMs = stage.idleBackoffIntervalMs ?? GUARDRAIL_DEFAULTS.idleBackoffIntervalMs
  const ticks = idleTicks ?? 0
  if (ticks >= afterTicks && lastPatrolAt) {
    const elapsed = at.getTime() - lastPatrolAt.getTime()
    if (elapsed < intervalMs) {
      return {
        patrol: false,
        skipReason: 'outside_window',
        detail: `已连续 ${ticks} 轮无候选,降频中(间隔 ${intervalMs}ms,距上次实际巡检 ${elapsed}ms)。`,
      }
    }
  }

  return { patrol: true }
}
