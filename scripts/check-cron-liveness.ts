#!/usr/bin/env node
/**
 * Cron Liveness Self-Check (OCV5-905 · Anti-Silent-Stall Watchdog).
 *
 * Reads `cron.yaml` + recent run timestamps (`cron/last-run.json` minuteKeys/timestamps and
 * optional `cron/outputs/<jobId>-*.md` artifacts) and verifies that EVERY `enabled: true`
 * recurring job has run within `2 * period` (default multiplier = 2).
 *
 * Prevents silent multi-week cron stalls (like the 9-week L4 deadlock stall):
 * - Exits `0` when all enabled recurring jobs are healthy or within their initial `createdAt`
 *   warmup window;
 * - Exits `1` and prints a `[CRON-LIVENESS] crit` alert summary when any enabled recurring job
 *   is overdue past `2 * period` or has an invalid cron expression;
 * - Exits `2` on missing/corrupt `cron.yaml` (fail-closed).
 *
 * Usage:
 *   npx tsx scripts/check-cron-liveness.ts [--cron-yaml <path>] [--last-run <path>]
 *     [--outputs-dir <dir>] [--now <iso-or-ms>] [--multiplier 2] [--tz-offset-minutes 480] [--json]
 */

import { access, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { asRecord, errMsg, isRecord } from '../packages/kernel/src/index.js'

export interface CronJobSpec {
  id: string
  schedule: string
  enabled: boolean
  oneshot?: boolean
  agent?: string
  createdAt?: number | string
  label?: string
}

export interface CronJobLivenessStatus {
  id: string
  schedule: string
  enabled: boolean
  status: 'ok' | 'crit' | 'disabled' | 'oneshot' | 'warmup'
  periodMinutes?: number
  thresholdMinutes?: number
  elapsedMinutes?: number | null
  lastRunAt?: string | null
  reason: string
}

export interface CronLivenessReport {
  ok: boolean
  level: 'ok' | 'crit'
  checkedAt: string
  multiplier: number
  totalJobs: number
  enabledRecurringJobs: number
  critCount: number
  jobs: CronJobLivenessStatus[]
  critSummaryLines: string[]
}

interface CronFieldSpec {
  label: string
  min: number
  max: number
}

const CRON_FIELDS: readonly CronFieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day-of-month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12 },
  { label: 'day-of-week', min: 0, max: 6 },
]

function validatePart(part: string, spec: CronFieldSpec): string | null {
  if (part === '') return `${spec.label} empty term`
  if (part === '*') return null
  const slash = part.indexOf('/')
  if (slash >= 0) {
    const base = part.slice(0, slash)
    const step = Number(part.slice(slash + 1))
    if (!Number.isInteger(step) || step < 1) return `${spec.label} invalid step in "${part}"`
    if (base === '*') return null
    const r = /^(\d+)-(\d+)$/.exec(base)
    if (!r) return `${spec.label} invalid step base in "${part}"`
    const a = Number(r[1])
    const b = Number(r[2])
    return a < spec.min || b > spec.max || a > b ? `${spec.label} range out of bounds` : null
  }
  const r = /^(\d+)-(\d+)$/.exec(part)
  if (r) {
    const a = Number(r[1])
    const b = Number(r[2])
    return a < spec.min || b > spec.max || a > b ? `${spec.label} range out of bounds` : null
  }
  if (/^\d+$/.test(part)) {
    const n = Number(part)
    return n < spec.min || n > spec.max ? `${spec.label} value ${n} out of range` : null
  }
  return `${spec.label} invalid term "${part}"`
}

export function validateCronExpr(expr: string): string | null {
  const fields = expr.trim().split(/\s+/).filter(Boolean)
  if (fields.length !== 5) return `expected 5 cron fields, got ${fields.length}`
  for (let i = 0; i < 5; i++) {
    for (const part of fields[i]!.split(',')) {
      const err = validatePart(part, CRON_FIELDS[i]!)
      if (err) return err
    }
  }
  return null
}

function matchPart(part: string, val: number): boolean {
  if (part === '*') return true
  const slash = part.indexOf('/')
  if (slash >= 0) {
    const base = part.slice(0, slash)
    const step = Number(part.slice(slash + 1))
    if (base === '*') return val % step === 0
    const [s, e] = base.split('-').map(Number)
    return s !== undefined && e !== undefined && val >= s && val <= e && (val - s) % step === 0
  }
  const dash = part.indexOf('-')
  if (dash >= 0) {
    const [s, e] = part.split('-').map(Number)
    return s !== undefined && e !== undefined && val >= s && val <= e
  }
  return Number(part) === val
}

function cronMatchesShiftedUtc(fields: string[], shiftedDate: Date): boolean {
  const vals = [
    shiftedDate.getUTCMinutes(),
    shiftedDate.getUTCHours(),
    shiftedDate.getUTCDate(),
    shiftedDate.getUTCMonth() + 1,
    shiftedDate.getUTCDay(),
  ]
  for (let i = 0; i < 5; i++) {
    const ok = fields[i]!.split(',').some((p) => matchPart(p, vals[i]!))
    if (!ok) return false
  }
  return true
}

/**
 * Computes the nominal cron period in minutes around `nowMs` by locating the two most recent
 * scheduled fire points `t1 <= nowMs` and `t2 < t1` (up to a 65-day lookback window).
 */
export function estimateCronPeriodMinutes(
  schedule: string,
  nowMs: number,
  tzOffsetMinutes = 480,
): number {
  const fields = schedule.trim().split(/\s+/)
  const nowMin = Math.floor(nowMs / 60_000)
  const hits: number[] = []
  const maxLookbackMinutes = 65 * 24 * 60
  for (let k = 0; k <= maxLookbackMinutes && hits.length < 2; k++) {
    const candMin = nowMin - k
    const shifted = new Date((candMin + tzOffsetMinutes) * 60_000)
    if (cronMatchesShiftedUtc(fields, shifted)) {
      hits.push(candMin)
    }
  }
  if (hits.length === 2) {
    return Math.max(1, hits[0]! - hits[1]!)
  }
  return 31 * 24 * 60
}

/**
 * Normalizes timestamps across OpenClaude's `last-run.json` (`minuteKey` ~ `29_928_247`),
 * Unix seconds, Unix milliseconds, ISO-8601 strings, or nested state objects.
 */
export function normalizeRunTimestampMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    if (raw < 1_000_000_000) return Math.round(raw * 60_000)
    if (raw < 100_000_000_000) return Math.round(raw * 1000)
    return Math.round(raw)
  }
  if (typeof raw === 'string' && raw.trim()) {
    const trimmed = raw.trim()
    if (/^\d+$/.test(trimmed)) return normalizeRunTimestampMs(Number(trimmed))
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  const rec = asRecord(raw)
  if (rec) {
    for (const k of ['lastRunAt', 'lastRun', 'updatedAt', 'timestamp', 'ts']) {
      const cand = normalizeRunTimestampMs(rec[k])
      if (cand !== null) return cand
    }
  }
  return null
}

export function parseCronJobsYaml(yamlText: string): CronJobSpec[] {
  const doc = parseYaml(yamlText) as unknown
  const obj = asRecord(doc)
  if (!obj || !Array.isArray(obj.jobs)) {
    throw new Error('cron.yaml must contain a top-level "jobs" array')
  }
  const out: CronJobSpec[] = []
  for (const item of obj.jobs) {
    const rec = asRecord(item)
    if (!rec || typeof rec.id !== 'string' || typeof rec.schedule !== 'string') {
      throw new Error(`cron.yaml contains job missing string id or schedule: ${JSON.stringify(item)}`)
    }
    out.push({
      id: rec.id,
      schedule: rec.schedule,
      enabled: rec.enabled !== false,
      oneshot: rec.oneshot === true,
      ...(typeof rec.agent === 'string' ? { agent: rec.agent } : {}),
      ...(typeof rec.createdAt === 'number' || typeof rec.createdAt === 'string'
        ? { createdAt: rec.createdAt }
        : {}),
      ...(typeof rec.label === 'string' ? { label: rec.label } : {}),
    })
  }
  return out
}

export function evaluateCronLiveness(args: {
  jobs: CronJobSpec[]
  lastRunByJob: Record<string, number | null>
  nowMs: number
  multiplier?: number
  tzOffsetMinutes?: number
}): CronLivenessReport {
  const multiplier = args.multiplier ?? 2
  const tzOffsetMinutes = args.tzOffsetMinutes ?? 480
  const statuses: CronJobLivenessStatus[] = []
  let enabledRecurringJobs = 0

  for (const job of args.jobs) {
    if (!job.enabled) {
      statuses.push({
        id: job.id,
        schedule: job.schedule,
        enabled: false,
        status: 'disabled',
        reason: 'job is disabled (enabled: false)',
      })
      continue
    }
    if (job.oneshot) {
      statuses.push({
        id: job.id,
        schedule: job.schedule,
        enabled: true,
        status: 'oneshot',
        reason: 'oneshot reminder excluded from recurring liveness check',
      })
      continue
    }

    enabledRecurringJobs++
    const schedErr = validateCronExpr(job.schedule)
    if (schedErr) {
      statuses.push({
        id: job.id,
        schedule: job.schedule,
        enabled: true,
        status: 'crit',
        reason: `invalid schedule "${job.schedule}": ${schedErr}`,
      })
      continue
    }

    const periodMinutes = estimateCronPeriodMinutes(job.schedule, args.nowMs, tzOffsetMinutes)
    const thresholdMinutes = Number((periodMinutes * multiplier).toFixed(2))
    const thresholdMs = thresholdMinutes * 60_000
    const lastRunMs = args.lastRunByJob[job.id] ?? null
    const createdAtMs = normalizeRunTimestampMs(job.createdAt)

    if (createdAtMs !== null && args.nowMs - createdAtMs <= thresholdMs && lastRunMs === null) {
      statuses.push({
        id: job.id,
        schedule: job.schedule,
        enabled: true,
        status: 'warmup',
        periodMinutes,
        thresholdMinutes,
        elapsedMinutes: null,
        lastRunAt: null,
        reason: `newly created within ${multiplier}x period warmup window`,
      })
      continue
    }

    if (lastRunMs === null) {
      statuses.push({
        id: job.id,
        schedule: job.schedule,
        enabled: true,
        status: 'crit',
        periodMinutes,
        thresholdMinutes,
        elapsedMinutes: null,
        lastRunAt: null,
        reason: `enabled recurring job has no recorded run (exceeds ${multiplier}x period = ${thresholdMinutes}m)`,
      })
      continue
    }

    const elapsedMs = Math.max(0, args.nowMs - lastRunMs)
    const elapsedMinutes = Number((elapsedMs / 60_000).toFixed(1))
    const lastRunAt = new Date(lastRunMs).toISOString()
    const overdue = elapsedMs > thresholdMs

    statuses.push({
      id: job.id,
      schedule: job.schedule,
      enabled: true,
      status: overdue ? 'crit' : 'ok',
      periodMinutes,
      thresholdMinutes,
      elapsedMinutes,
      lastRunAt,
      reason: overdue
        ? `stalled for ${elapsedMinutes}m > ${thresholdMinutes}m (${multiplier}x period of ${periodMinutes}m; lastRunAt=${lastRunAt})`
        : `healthy: ran ${elapsedMinutes}m ago <= ${thresholdMinutes}m (${multiplier}x period)`,
    })
  }

  const critJobs = statuses.filter((s) => s.status === 'crit')
  const critSummaryLines =
    critJobs.length > 0
      ? [
          `[CRON-LIVENESS] crit: ${critJobs.length}/${enabledRecurringJobs} enabled recurring cron job(s) stalled beyond ${multiplier}x period`,
          ...critJobs.map((j) => `  - ${j.id} (${j.schedule}): ${j.reason}`),
        ]
      : []

  return {
    ok: critJobs.length === 0,
    level: critJobs.length === 0 ? 'ok' : 'crit',
    checkedAt: new Date(args.nowMs).toISOString(),
    multiplier,
    totalJobs: args.jobs.length,
    enabledRecurringJobs,
    critCount: critJobs.length,
    jobs: statuses,
    critSummaryLines,
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch (err: unknown) {
    void err
    return false
  }
}

async function loadLastRunTimestamps(
  jobs: CronJobSpec[],
  lastRunPath: string,
  outputsDir?: string,
): Promise<Record<string, number | null>> {
  const result: Record<string, number | null> = {}
  for (const j of jobs) result[j.id] = null

  if (await pathExists(lastRunPath)) {
    const raw = JSON.parse(await readFile(lastRunPath, 'utf8')) as unknown
    const obj = asRecord(raw)
    const map = isRecord(obj?.jobs) ? obj.jobs : obj
    if (map) {
      for (const [id, v] of Object.entries(map)) {
        const ts = normalizeRunTimestampMs(v)
        if (ts !== null) result[id] = Math.max(result[id] ?? 0, ts)
      }
    }
  }

  if (outputsDir && (await pathExists(outputsDir))) {
    const files = await readdir(outputsDir)
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      for (const j of jobs) {
        if (!file.startsWith(`${j.id}-`)) continue
        const s = await stat(path.join(outputsDir, file))
        if (s.mtimeMs > 0) {
          result[j.id] = Math.max(result[j.id] ?? 0, Math.round(s.mtimeMs))
        }
      }
    }
  }
  return result
}

function readFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  return idx >= 0 ? argv[idx + 1] : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cronYamlPath = path.resolve(
    readFlag(argv, '--cron-yaml') ?? '/home/agent/.openclaude/cron.yaml',
  )
  const baseHome = path.dirname(cronYamlPath)
  const lastRunPath = path.resolve(
    readFlag(argv, '--last-run') ?? path.join(baseHome, 'cron', 'last-run.json'),
  )
  const outputsDir = readFlag(argv, '--outputs-dir') ?? path.join(baseHome, 'cron', 'outputs')
  const nowArg = readFlag(argv, '--now')
  const nowMs = nowArg ? (normalizeRunTimestampMs(nowArg) ?? Number.NaN) : Date.now()
  if (!Number.isFinite(nowMs)) throw new Error(`Invalid --now value: ${nowArg}`)

  const multArg = readFlag(argv, '--multiplier')
  const multiplier = multArg ? Number(multArg) : 2
  const tzArg = readFlag(argv, '--tz-offset-minutes')
  const tzOffsetMinutes = tzArg ? Number(tzArg) : 480

  const yamlText = await readFile(cronYamlPath, 'utf8')
  const jobs = parseCronJobsYaml(yamlText)
  const lastRunByJob = await loadLastRunTimestamps(jobs, lastRunPath, outputsDir)
  const report = evaluateCronLiveness({
    jobs,
    lastRunByJob,
    nowMs,
    multiplier,
    tzOffsetMinutes,
  })

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (report.ok) {
    console.log(
      `[CRON-LIVENESS] ok: ${report.enabledRecurringJobs}/${report.totalJobs} enabled recurring cron job(s) healthy (<= ${multiplier}x period)`,
    )
  } else {
    for (const line of report.critSummaryLines) {
      console.error(line)
    }
  }
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`[CRON-LIVENESS] fatal: ${errMsg(err)}`)
    process.exit(2)
  })
}
