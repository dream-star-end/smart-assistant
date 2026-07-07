// Cron — periodic self-reflection jobs for the learning loop.
//
// Jobs are defined in ~/.openclaude/cron.yaml:
//
//   jobs:
//     - id: daily-reflection
//       schedule: "0 3 * * *"          # crontab syntax
//       agent: main                    # which agent runs it
//       prompt: |
//         回顾最近 24 小时所有对话...
//       deliver: local                 # local | webchat | telegram
//       deliverTarget: {}              # optional { channel, peerId } for non-local
//
// The scheduler runs every 60 seconds. If the current minute matches a cron
// expression AND the job hasn't run in that minute, it fires.
//
// Bounded catch-up (OC_CRON_CATCHUP_MIN, default 15, 0=off): when the current
// minute does not match but the container was asleep/evicted across a scheduled
// minute, the tick scans backwards up to N minutes for the MOST RECENT missed
// match M and fires it once (only that one — multiple missed fires collapse to
// one, same semantics as Claude Code). Guarded by lastRun (cross-restart
// idempotent, last-run.json rides the volume) and job.createdAt (never re-fire
// a schedule point that predates the job's creation). This is what lets a
// master-woken container actually run a "9am daily" job it slept through, while
// staying bounded so a long sleep never replays a full backlog.
//
// Last-run times are persisted to ~/.openclaude/cron/last-run.json.
//
// Job output: run_id + timestamp written to ~/.openclaude/cron/outputs/<id>-<ts>.md.
// If the agent's final text starts with [SILENT], output is archived but not delivered.

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type AgentDef, type OpenClaudeConfig, paths, readAgentsConfig } from '@openclaude/storage'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { createLogger } from './logger.js'
import type { SessionManager } from './sessionManager.js'
import { isHiddenSystemAgentId } from './agentVisibility.js'
// 合成首帧执行模型解析(codex 计费旁路封堵的对偶面):cron 无 per-user 计费主体,
// 落 codex 会被 CODEX_BILLING_GUARD fail-closed 拒 —— 解析为 codex 时改用显式非 codex
// 兜底模型。与 sessionManager.getOrCreate 的 engine 判定同点收口(单一权威)。
// 注:server.ts ↔ cron.ts 已存在被容忍的模块循环(server import CronScheduler;
// sessionManager 亦 `import { resolveExecutionModel } from './server.js'`),本函数只在
// runJob 运行期调用,非模块初始化期,live-binding 安全,沿用既有模式。
import { resolveSyntheticTurnModel } from './server.js'
import {
  postCronIndex,
  readV3CronIndexConfig,
  type CronIndexPayload,
} from './v3CronIndexPush.js'
import type { V3WechatOutboundConfig } from './v3WechatOutbound.js'

const logger = createLogger({ module: 'cron' })

const LAST_RUN_FILE = join(paths.home, 'cron', 'last-run.json')

export interface CronJob {
  id: string
  schedule: string
  agent: string
  prompt: string
  deliver?: 'local' | 'webchat' | 'telegram'
  deliverTarget?: { channel?: string; peerId?: string }
  enabled?: boolean
  oneshot?: boolean // fire once then auto-disable
  label?: string // human-readable label (for reminders)
  // Marks the job as a proactive "heartbeat check" — purely a UI/delivery
  // hint (frontend uses it to style the push and skip the "system cron"
  // badge). Execution uses an isolated session just like any other cron job.
  heartbeat?: boolean
  // Epoch ms when the job was created (stamped by every creation entry point:
  // POST /api/cron + the CCB CronCreate bridge). Optional so legacy jobs and
  // personal DEFAULT_JOBS (no field on disk) still load. Used by bounded
  // catch-up to refuse re-firing a scheduled minute that predates creation —
  // otherwise a job created at 09:03 whose schedule is "0 9 * * *" would be
  // falsely "caught up" for the 09:00 tick it never missed. Legacy jobs
  // without createdAt are only bounded by the catch-up window itself.
  createdAt?: number
}

/**
 * 用户发起的提醒/定时任务 vs 系统自省 job 的判定。
 *
 * 用户 cron 入口(都该可推送到微信):
 *   - `POST /api/cron`  → `remind-<ts>-<rand>`(server.ts)
 *   - CronCreate tool_use bridge → `ccb-<ts>-<rand>`(sessionManager)
 * 系统自省 job(personal DEFAULT_JOBS;commercial OC_SEED_DEFAULT_CRON=0 不 seed,绝不外发到微信):
 *   - heartbeat(job.heartbeat=true)
 *   - daily-reflection / weekly-curation / skill-check 及任何含 reflection/skill 的变体
 *
 * 采用「反向排除系统」而非「白名单用户前缀」:任何新增的用户 cron 入口都自动获得微信投递,
 * 不会像 startsWith('ccb-') 那样漏掉 remind-(本类 bug 的根因)。系统 job 是封闭已知集。
 */
export function isUserInitiatedCronJob(job: Pick<CronJob, 'id' | 'heartbeat'>): boolean {
  if (job.heartbeat) return false
  const id = job.id
  if (id === 'daily-reflection' || id === 'weekly-curation' || id === 'skill-check') return false
  if (id.includes('reflection') || id.includes('skill')) return false
  return true
}

export interface CronFile {
  jobs: CronJob[]
}

const DEFAULT_JOBS: CronJob[] = [
  {
    id: 'daily-reflection',
    schedule: '17 3 * * *', // 3:17 AM user local time (Asia/Shanghai by default)
    agent: 'main',
    enabled: true,
    deliver: 'local',
    prompt: `You are doing a DAILY REFLECTION pass. It is currently early morning.

1. Run \`oc-memory session-search "<query>"\` in the shell with query terms that cover yesterday's activity (e.g. the current date, common topics).
2. Review the last 5-10 turns you find.
3. Extract durable facts, user preferences, and patterns that should persist across sessions.
4. Run \`oc-memory memory --action add --target <memory|user> --content "..."\` to add new entries — "memory" (your observations) or "user" (what you know about the user). Be selective — only things that will actually help next time.
5. If you notice a pattern of tasks that could be reused, use \`skill_save\` to distill it into a reusable skill.
6. IMPORTANT: 重点检查今天是否有超过 3 次工具调用的复杂任务。如果有且没有对应 skill,立即用 skill_save 创建。
7. 如果 MEMORY.md 中有冗长条目,考虑用 \`oc-memory archival-add "..."\` 迁移到归档记忆,然后 \`oc-memory memory --action remove --target memory --needle "..."\` 从 Core 删除。
8. Write a SHORT summary of what you learned today (max 200 words).
9. If you learned nothing significant, reply with exactly "[SILENT]" and nothing else.`,
  },
  {
    id: 'weekly-curation',
    schedule: '31 4 * * 0',
    agent: 'main',
    enabled: true,
    deliver: 'local',
    prompt: `You are doing a WEEKLY CURATION pass.

1. Run \`oc-memory memory --action read --target memory\` and \`oc-memory memory --action read --target user\` to see everything currently stored.
2. Call \`skill_list()\` to see accumulated skills.
3. Run \`oc-memory archival-search "*"\` to review archival memory entries.
4. Look for:
   - Duplicate or contradictory entries → use \`oc-memory memory --action replace --target <t> --needle "old" --content "new"\` to consolidate.
   - Obsolete facts (outdated preferences, stale technical details) → use \`oc-memory memory --action remove --target <t> --needle "..."\`.
   - Skills that are too narrow/specific → consider deleting with \`skill_delete\`.
   - Skills with updated_at 超过 30 天 → 检查是否需要刷新或删除。
   - Archival 中过时的知识 → \`oc-memory archival-delete <id>\`。
5. Write a SHORT summary of curation actions taken (max 200 words).
6. If no curation was needed, reply with exactly "[SILENT]".`,
  },
  {
    id: 'skill-check',
    schedule: '47 */6 * * *',
    agent: 'main',
    enabled: true,
    deliver: 'local',
    prompt: `Quick skill extraction pass (every 6 hours). Use the current local time to search.

1. \`oc-memory session-search "<query>"\` with today's date or recent keywords to find conversations from the last 6 hours.
2. If no results, try broader search terms (e.g. common topics the user discusses).
3. For any multi-step task found (3+ tool calls), check \`skill_list()\` for existing coverage.
4. If a useful new skill pattern is found, \`skill_save\` immediately with concrete steps and commands.
5. Also \`oc-memory memory --action read --target memory\` — if any entry is stale or incorrect, update it.
6. If genuinely nothing new to extract or update, reply with exactly "[SILENT]".`,
  },
  {
    id: 'heartbeat',
    schedule: '13 */4 * * *',
    agent: 'main',
    enabled: true,
    deliver: 'webchat',
    heartbeat: true, // UI hint only — execution is isolated like other cron jobs
    prompt: `Periodic heartbeat check (every 4 hours). You are proactively checking on the user's standing items.

1. \`oc-memory memory --action read --target memory\` — scan for any time-sensitive items, deadlines, or follow-ups.
2. \`oc-memory archival-search "pending OR reminder OR TODO OR deadline"\` — check for stored reminders/tasks.
3. \`oc-memory session-search "<query>"\` with the current date or recent keywords — look for conversations where the user said "later", "tomorrow", or "remind me".
4. If you find something actionable (missed deadline, pending follow-up, stale reminder), compose a SHORT proactive update for the user.
5. If everything is normal and nothing to report, reply with exactly "HEARTBEAT_OK".
6. DO NOT report that you checked and found nothing — that's what HEARTBEAT_OK is for.`,
  },
]

export async function ensureCronFile(): Promise<CronFile> {
  const path = paths.cronYaml
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true })
    // Controls only the first-time bootstrap when cron.yaml is missing.
    // Existing cron.yaml files and user-created jobs are left untouched.
    // Set OC_SEED_DEFAULT_CRON=0 in v3 commercial containers to skip seeding
    // the personal-version self-reflection jobs (they would burn user credits).
    const seedDefaults = process.env.OC_SEED_DEFAULT_CRON !== '0'
    const initialJobs = seedDefaults ? DEFAULT_JOBS : []
    await atomicWriteYaml(path, { jobs: initialJobs })
    return { jobs: initialJobs }
  }
  try {
    const raw = await readFile(path, 'utf-8')
    return parseYaml(raw) as CronFile
  } catch {
    return { jobs: [] }
  }
}

async function loadLastRun(): Promise<Record<string, number>> {
  if (!existsSync(LAST_RUN_FILE)) return {}
  try {
    return JSON.parse(await readFile(LAST_RUN_FILE, 'utf-8'))
  } catch {
    return {}
  }
}
let _writeCounter = 0
async function saveLastRun(map: Record<string, number>): Promise<void> {
  await mkdir(dirname(LAST_RUN_FILE), { recursive: true })
  const tmp = LAST_RUN_FILE + `.${process.pid}.${++_writeCounter}.tmp`
  await writeFile(tmp, JSON.stringify(map, null, 2))
  await rename(tmp, LAST_RUN_FILE)
}

/** Atomically write a YAML file by writing to a unique .tmp then renaming. */
async function atomicWriteYaml(filePath: string, data: unknown): Promise<void> {
  const tmp = filePath + `.${process.pid}.${++_writeCounter}.tmp`
  await writeFile(tmp, stringifyYaml(data))
  await rename(tmp, filePath)
}

// Minimal crontab matcher: 5 fields, supports *, */N, N, N,M, N-M
// Uses user's timezone (TZ env var or default Asia/Shanghai) instead of UTC
function getLocalDate(): Date {
  const tz = process.env.TZ || 'Asia/Shanghai'
  try {
    const str = new Date().toLocaleString('en-US', { timeZone: tz })
    return new Date(str)
  } catch {
    return new Date() // fallback to server local time
  }
}

export function cronMatches(expr: string, d?: Date): boolean {
  const local = d ?? getLocalDate()
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const vals = [
    local.getMinutes(),
    local.getHours(),
    local.getDate(),
    local.getMonth() + 1,
    local.getDay(),
  ]
  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(fields[i], vals[i])) return false
  }
  return true
}

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

/** 单字段的取值边界(matcher 语义:dow 用 getDay() 取 0-6,7 永不命中)。 */
interface CronFieldSpec {
  label: string
  min: number
  max: number
  /** dow=7 是"周日应写 0"的常见笔误,越界时追加提示。 */
  sundayHint?: boolean
}

const CRON_FIELDS: readonly CronFieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day-of-month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12 },
  { label: 'day-of-week', min: 0, max: 6, sundayHint: true },
]

function cronValueError(n: number, raw: string, spec: CronFieldSpec): string | null {
  if (n < spec.min || n > spec.max) {
    const hint = spec.sundayHint && n === 7 ? ' (use 0 for Sunday)' : ''
    return `${spec.label} field "${raw}" out of range ${spec.min}-${spec.max}${hint}`
  }
  return null
}

function cronRangeError(startStr: string, endStr: string, raw: string, spec: CronFieldSpec): string | null {
  return (
    cronValueError(Number(startStr), startStr, spec) ??
    cronValueError(Number(endStr), endStr, spec) ??
    (Number(startStr) > Number(endStr)
      ? `${spec.label} field "${raw}" has an inverted range (${startStr} > ${endStr})`
      : null)
  )
}

function cronPartError(part: string, spec: CronFieldSpec): string | null {
  const { label } = spec
  // 空 part:matcher 里 Number('')===0 会误匹配 0(尾逗号 / 连续逗号)——显式拒绝。
  if (part === '') return `${label} field has an empty part (stray or trailing comma)`
  if (part === '*') return null
  // step 形态 base/S:matcher 只认 base ∈ {*, N-M} 且 S 为正整数;数字底的 step
  // (如 5/2)matcher 恒 false,*/0 因 val%0===NaN 永不命中——都拒绝。
  const slash = part.indexOf('/')
  if (slash !== -1) {
    const base = part.slice(0, slash)
    const step = part.slice(slash + 1)
    if (!/^\d+$/.test(step) || Number(step) < 1) {
      return `${label} field "${part}" has invalid step "${step}" (step must be an integer >= 1)`
    }
    if (base === '*') return null
    const range = base.match(/^(\d+)-(\d+)$/)
    if (!range) {
      return `${label} field "${part}" has invalid step base "${base}" (only * or N-M can take a step)`
    }
    return cronRangeError(range[1], range[2], part, spec)
  }
  const range = part.match(/^(\d+)-(\d+)$/)
  if (range) return cronRangeError(range[1], range[2], part, spec)
  if (/^\d+$/.test(part)) return cronValueError(Number(part), part, spec)
  return `${label} field "${part}" is not a valid cron term`
}

/**
 * 校验 crontab 表达式的字段数与每字段的数值范围/形态。返回 null=合法,否则返回具体
 * 错误信息(英文,指明字段与非法值,如 `minute field "60" out of range 0-59`)。
 *
 * 与 matcher(cronMatches/matchPart)严格对齐——只接受 matcher 真正能命中的形态:
 * 星号、N、N-M(N<=M)、星号/S(S>=1)、N-M/S(S>=1)、以及以上的逗号列表。
 * (形态描述用"星号"是因为字面星号斜杠会终止本块注释。)
 * 纯字符正则(旧实现)拦不住越界与静默失效写法:AI 走 create_reminder 幻觉出的
 * `60 25 * * *` 能过旧校验却让 cronMatches 永不命中(落库即失效)。
 */
export function validateCronSchedule(expr: string): string | null {
  const trimmed = expr.trim()
  const fields = trimmed === '' ? [] : trimmed.split(/\s+/)
  if (fields.length !== 5) {
    return `expected 5 fields (minute hour dom month dow), got ${fields.length}`
  }
  for (let i = 0; i < 5; i++) {
    const spec = CRON_FIELDS[i]
    for (const part of fields[i].split(',')) {
      const err = cronPartError(part, spec)
      if (err) return err
    }
  }
  return null
}

// ── Bounded catch-up (see file header) ──────────────────────────────────────

/** Parse OC_CRON_CATCHUP_MIN. Default 15; "0" disables catch-up; invalid/negative
 *  → default (fail-safe: a garbage env never silently turns catch-up off). */
export function getCatchupMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_CRON_CATCHUP_MIN
  if (raw === undefined || raw.trim() === '') return 15
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 15
  return Math.trunc(n)
}

/**
 * Decide, for a single job, which minute (if any) should fire on this tick, and
 * return the minuteKey to record into lastRun — or null if nothing is due.
 *
 * Pure & side-effect-free so it can be unit-tested without a live scheduler /
 * sessions. tick() layers agent-existence + hidden-agent checks on top and only
 * writes lastRun with the returned key.
 *
 * Two clocks, deliberately separated:
 *   - real epoch ms (nowEpoch, minute boundaries) → minuteKey / createdAt compare.
 *     Cross-restart idempotency lives here; must not drift with the TZ view.
 *   - wall-clock view (localNow, already TZ-shifted by getLocalDate) → cronMatches.
 *     Shifting it back k minutes with getTime()-k*60000 keeps the same TZ offset,
 *     so matching a past minute uses the same calendar fields the live tick would.
 *
 * Current minute wins over any catch-up. Catch-up scans k=1..catchupMin looking
 * for the MOST RECENT missed match and fires only that one; older misses are
 * intentionally dropped (collapse a long sleep to a single run). The most-recent
 * miss's guards (lastRun strictly behind it; its fire boundary >= createdAt)
 * subsume all older misses, so breaking at the first match loses nothing.
 */
export function resolveDueMinute(
  job: Pick<CronJob, 'id' | 'schedule' | 'createdAt'>,
  lastRun: Record<string, number>,
  nowEpoch: number,
  localNow: Date,
  catchupMin: number,
): number | null {
  const nowMinuteKey = Math.floor(nowEpoch / 60_000)
  const last = lastRun[job.id]
  // Current minute: exact same rule as the pre-catch-up scheduler.
  if (cronMatches(job.schedule, localNow) && last !== nowMinuteKey) {
    return nowMinuteKey
  }
  if (catchupMin <= 0) return null
  for (let k = 1; k <= catchupMin; k++) {
    // Subtracting exact 60000-ms multiples preserves the sub-minute remainder,
    // so this minuteKey equals nowMinuteKey - k regardless of nowEpoch's offset.
    const missedMinuteKey = nowMinuteKey - k
    const localCandidate = new Date(localNow.getTime() - k * 60_000)
    if (!cronMatches(job.schedule, localCandidate)) continue
    // Most recent missed match. Fire once iff we have not already run at/after
    // this minute AND the schedule point is not older than the job's creation.
    // createdAt compared against the minute's fire boundary (missedMinuteKey*60000):
    // a cron nominally fires at the minute start, so a job created strictly after
    // that boundary never actually missed this fire — refuse it (false catch-up).
    const notYetRun = last === undefined || last < missedMinuteKey
    const afterCreation =
      job.createdAt === undefined || missedMinuteKey * 60_000 >= job.createdAt
    if (notYetRun && afterCreation) return missedMinuteKey
    // Most recent miss is stale (already run) or predates creation; all older
    // misses are even more so → stop, do not catch up further.
    return null
  }
  return null
}

// ── Runtime quotas (container API create/update paths only) ──────────────────

/** OC_CRON_MAX_JOBS: cap total jobs in cron.yaml. Default 50, "0"/invalid → 50.
 *  Only enforced on addJob (API/tool create), never on personal seed. */
export function getMaxJobs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_CRON_MAX_JOBS
  if (raw === undefined || raw.trim() === '') return 50
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.trunc(n)
}

/** OC_CRON_MAX_PER_HOUR: cap how many minutes in an hour a schedule may hit.
 *  Default 12 (=every 5 minutes). "0"/invalid → 12. */
export function getMaxPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_CRON_MAX_PER_HOUR
  if (raw === undefined || raw.trim() === '') return 12
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 12
  return Math.trunc(n)
}

/**
 * Count how many of minutes 0-59 the schedule's minute field matches — i.e. the
 * per-hour firing frequency for schedules whose other fields let the hour run.
 * Uses the same matcher (fieldMatches) as execution so the quota can never
 * disagree with what actually fires. Returns 0 for an invalid expression
 * (validateCronSchedule already rejects those upstream).
 */
export function countMinuteHitsPerHour(schedule: string): number {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return 0
  const minuteField = fields[0]
  let hits = 0
  for (let m = 0; m <= 59; m++) {
    if (fieldMatches(minuteField, m)) hits++
  }
  return hits
}

/**
 * Return an English rejection message (透传给模型) when a schedule fires more
 * often than OC_CRON_MAX_PER_HOUR per hour, else null. Prefixed with
 * `Invalid cron schedule` so tool callers surface it consistently with the
 * range/shape validator; the message tells the model how to fix it (5-min floor).
 * (字面星号斜杠会终止本块注释,故文中用 "N-minute" 而非符号写法。)
 */
export function frequencyQuotaError(
  schedule: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const max = getMaxPerHour(env)
  const hits = countMinuteHitsPerHour(schedule)
  if (hits > max) {
    return (
      `Invalid cron schedule "${schedule}": fires ${hits} times per hour, ` +
      `exceeding the limit of ${max}. Use a coarser minute field ` +
      `(recommended minimum interval is 5 minutes) or raise OC_CRON_MAX_PER_HOUR.`
    )
  }
  return null
}

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null
  private bootTickTimer: NodeJS.Timeout | null = null
  private stopped = false
  private running = false
  /** Reference to last-active-channel map for heartbeat session routing.
   *  Shape must stay in sync with Gateway's `lastActiveChannel` — the
   *  `userId` field was added so gateway can route heartbeats per-user. */
  public lastActiveChannel?: Map<
    string,
    {
      channel: string
      peerId: string
      sessionKey: string
      userId: string
      at: number
    }
  >
  /** Master wake-index push config; null on personal/dev (no master env) → every
   *  maybePushCronIndex is a cheap no-op. Read once in start() (env is fixed for
   *  the process lifetime), so a personal container never even computes the index. */
  private cronIndexCfg: V3WechatOutboundConfig | null = null
  /** Last (nextFireAt, enabledCount) actually reported to master. Push only when
   *  the value changes — avoids a POST every tick. Updated optimistically (before
   *  the fire-and-forget send resolves): a dropped push is recovered by master's
   *  periodic rescan, so we trade at-least-once for far fewer POSTs. */
  private lastCronIndex: CronIndexPayload | null = null

  constructor(
    private config: OpenClaudeConfig,
    private sessions: SessionManager,
    private onDeliver: (text: string, job: CronJob) => void | Promise<void>,
  ) {}

  /**
   * Push the derived wake-index payload to master when it changed since the last
   * report. Fire-and-forget; no-op entirely when master env absent.
   */
  private maybePushCronIndex(file: CronFile): void {
    if (!this.cronIndexCfg) return
    const payload = deriveCronIndexPayload(file, new Date())
    if (
      this.lastCronIndex &&
      this.lastCronIndex.nextFireAt === payload.nextFireAt &&
      this.lastCronIndex.enabledCount === payload.enabledCount
    ) {
      return
    }
    this.lastCronIndex = payload
    void postCronIndex(payload, { config: this.cronIndexCfg }).catch(() => {})
  }

  async start(): Promise<void> {
    // Read wake-index config once (env fixed for process lifetime).
    this.cronIndexCfg = readV3CronIndexConfig()
    const initialFile = await ensureCronFile()
    // Seed master with the current index right after boot so a just-restarted
    // container advertises its next fire even before the first tick.
    this.maybePushCronIndex(initialFile)
    // Tick once per minute
    this.timer = setInterval(() => {
      if (this.stopped) return
      if (!this.running) this.tick().catch((err) => logger.error('tick failed', {}, err))
    }, 60_000)
    // Fire an initial tick 10s after boot (not immediate, to avoid startup race).
    // Track the handle so stop() can cancel it during shutdown.
    this.bootTickTimer = setTimeout(() => {
      this.bootTickTimer = null
      if (this.stopped) return
      this.tick().catch(() => {})
    }, 10_000)
    logger.info('scheduler started')
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.bootTickTimer) clearTimeout(this.bootTickTimer)
    this.bootTickTimer = null
  }

  private async tick(): Promise<void> {
    this.running = true
    try {
      const file = await ensureCronFile()
      // Load lastRun once at the start of the tick — all updates accumulate in
      // memory and are flushed in a single write at the end, eliminating the
      // concurrent read-modify-write race condition.
      const lastRun = await loadLastRun()
      const now = new Date()
      const localNow = getLocalDate()
      const agentsConfig = await readAgentsConfig()

      // Cleanup: remove completed oneshot jobs from yaml
      const before = file.jobs.length
      file.jobs = file.jobs.filter((j) => !(j.oneshot && j.enabled === false))
      if (file.jobs.length < before) {
        await atomicWriteYaml(paths.cronYaml, file)
      }

      // Cleanup: delete output files older than 7 days
      this._cleanupOldOutputs().catch(() => {})

      const catchupMin = getCatchupMinutes()
      let lastRunDirty = false
      try {
        for (const job of file.jobs ?? []) {
          if (job.enabled === false) continue
          // Current-minute match OR most-recent bounded catch-up (see header).
          // Returns the minuteKey to record; null = nothing due for this job.
          const dueMinuteKey = resolveDueMinute(job, lastRun, now.getTime(), localNow, catchupMin)
          if (dueMinuteKey === null) continue
          if (isHiddenSystemAgentId(job.agent)) {
            logger.warn(`job ${job.id}: hidden system agent rejected`, {
              jobId: job.id,
              agent: job.agent,
            })
            continue
          }
          const agent = agentsConfig.agents.find((a) => a.id === job.agent)
          if (!agent) {
            logger.warn(`job ${job.id}: agent ${job.agent} not found`, {
              jobId: job.id,
              agent: job.agent,
            })
            continue
          }
          await this.runJob(job, agent)
          // Record the minute that actually fired (catch-up records the missed
          // minute M, not "now") so it stays idempotent across restarts.
          lastRun[job.id] = dueMinuteKey
          lastRunDirty = true
        }
      } finally {
        // Always flush completed job timestamps so a later failure doesn't replay
        // already-run jobs on the next tick.
        if (lastRunDirty) {
          await saveLastRun(lastRun)
        }
      }
      // Refresh master's wake index if the derived (nextFireAt, enabledCount)
      // changed this tick (jobs may have been disabled by oneshot cleanup/run).
      // Fire-and-forget; personal version (no master env) no-ops.
      this.maybePushCronIndex(file)
    } finally {
      this.running = false
    }
  }

  private async runJob(job: CronJob, agent: AgentDef): Promise<void> {
    logger.info(`running job ${job.id}`, { jobId: job.id, heartbeat: !!job.heartbeat })

    // Isolated session per execution for ALL jobs (heartbeat included).
    // Sharing the user's main session polluted conversation history and, when
    // the heartbeat turn crashed mid-execution, left a broken trailing turn
    // that caused the user's follow-up messages to return "本轮响应为空".
    // Delivery still targets the user's last-active channel via server.ts
    // (see onDeliver), which reads lastActiveChannel independently.
    const sessionKey = `agent:${agent.id}:cron:dm:${job.id}:${Date.now()}`

    // 合成首帧路由字段补齐:cron 是进程内直接派发的会话首帧,完全绕过 master bridge
    // 的 codex 计费编排(preCheck / server-owned requestId / inflight journal)。host
    // 平台 agent(如 `main`)的 cron 又无 per-user 计费主体,因此**不能落 codex engine**
    // (会被 CODEX_BILLING_GUARD 100% fail-closed 拒)。这里显式解析出非 codex 执行模型,
    // 与 agent 交互态默认(可能是 gpt-5.5=codex)解耦;非 codex agent 返回 undefined,
    // 沿用原默认(行为不变)。同点传入 getOrCreate(决定 runner engine)+ submit(路由字段)。
    const cronRoute = resolveSyntheticTurnModel(agent, this.config.defaults.model)
    const cronModel = cronRoute?.model
    // MAJOR-2 透明化:cron 是 host 平台维护 turn(无用户面),降级记 runLog/日志即可,不需用户可见。
    if (cronRoute?.downgraded) {
      logger.info(`job ${job.id} synthetic model downgraded off codex`, {
        jobId: job.id,
        from: cronRoute.originalModel,
        to: cronRoute.model,
      })
    }

    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent,
      ...(cronModel ? { model: cronModel } : {}),
      channel: 'cron',
      peerId: job.id,
      title: job.heartbeat ? '[heartbeat]' : `[cron] ${job.id}`,
      // Tag this run as a cron workload so CCB stamps
      // `cc_workload=cron;` into the attribution billing-header.
      // Lets Anthropic serve scheduled jobs at lower QoS and keeps
      // automation traffic from competing with interactive turns for
      // the user's rate-limit headroom — directly mitigates the
      // "automation abuse" ban trigger documented in the Feishu doc.
      workload: 'cron',
    })
    let output = ''
    try {
      await this.sessions.submit(
        session,
        job.prompt,
        (e) => {
          if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
        },
        // effortLevel: 不指定(cron 用模型默认档位)
        undefined,
        // model: 与 getOrCreate 同源;非 codex agent 为 undefined(不覆盖)。
        cronModel,
      )
    } finally {
      // All jobs use isolated sessions — always destroy, even if submit()
      // threw, otherwise the subprocess + resume-map entry would leak until
      // the eviction loop catches it on the next sweep.
      await this.sessions
        .destroySession(sessionKey)
        .catch((err) =>
          logger.warn(`destroySession failed for ${job.id}`, { jobId: job.id }, err as Error),
        )
    }
    // Persist output
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = join(paths.cronOutputsDir, `${job.id}-${ts}.md`)
    try {
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, output)
    } catch {}
    // One-shot jobs: disable after first run, regardless of delivery outcome
    if (job.oneshot) {
      logger.info(`job ${job.id} is one-shot, disabling`, { jobId: job.id })
      job.enabled = false
      await saveCronFile(await ensureCronFile(), job)
    }

    // Skip delivery for silence markers AND genuinely empty output. The empty
    // case covers subprocess crashes / API failures mid-turn: without this
    // guard, the user sees an orphan "💓 heartbeat" card with no content.
    const trimmed = output.trim()
    if (!trimmed || trimmed.startsWith('[SILENT]') || trimmed === 'HEARTBEAT_OK') {
      logger.info(`job ${job.id} silent/empty, not delivering`, {
        jobId: job.id,
        reason: !trimmed ? 'empty' : trimmed.startsWith('[SILENT]') ? 'silent' : 'heartbeat_ok',
      })
      return
    }
    logger.info(`job ${job.id} completed`, {
      jobId: job.id,
      chars: trimmed.length,
      deliver: job.deliver ?? 'local',
    })
    if ((job.deliver ?? 'local') === 'local') {
      // local = just log, don't push to any channel
    } else {
      logger.info(`delivering job ${job.id} to ${job.deliver}`, {
        jobId: job.id,
        deliver: job.deliver,
      })
      await this.onDeliver(trimmed, job)
    }
  }

  /**
   * 平台内部通知直投:复用 cron 的送达管线(webchat 推送 + 微信主动投递联动),
   * 但不经过 LLM 执行 —— 给确定性的系统通知(如技能自动回归失败提醒)用。
   */
  async deliverNotice(text: string, job: CronJob): Promise<void> {
    await this.onDeliver(text, job)
  }

  // ── Runtime job management (called by /api/cron) ──

  async addJob(job: CronJob): Promise<void> {
    // 字段数 + 数值范围/形态校验(纯字符正则拦不住 60 分 / 25 时 / dow 7 这类静默失效)。
    const schedErr = validateCronSchedule(job.schedule)
    if (schedErr) {
      throw new Error(`Invalid cron schedule "${job.schedule}": ${schedErr}`)
    }
    // 频率闸:分钟字段每小时命中次数超上限即拒(默认 12 = 星号/5,最短建议 5 分钟间隔)。
    // 错误信息经工具透传给模型,给出可执行的整改方向而非只报错。
    const freqErr = frequencyQuotaError(job.schedule)
    if (freqErr) throw new Error(freqErr)
    const file = await ensureCronFile()
    // Replace if same ID exists — filter first so the count check treats a
    // replace as size-neutral (only genuinely new IDs grow the file).
    const filtered = file.jobs.filter((j) => j.id !== job.id)
    const maxJobs = getMaxJobs()
    if (filtered.length >= maxJobs) {
      // 数量闸:仅 addJob 计数(个人版 seed 走 ensureCronFile 不经此路,不受限)。
      throw new Error(
        `Invalid cron schedule: reminder limit reached (${filtered.length}/${maxJobs} jobs). ` +
          `Delete an existing reminder before creating a new one, or raise OC_CRON_MAX_JOBS.`,
      )
    }
    filtered.push(job)
    file.jobs = filtered
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`added job ${job.id}`, { jobId: job.id, schedule: job.schedule })
    // 增删后刷新 master 唤醒索引(handler 不用重复调,scheduler 收口)。
    this.maybePushCronIndex(file)
  }

  async removeJob(id: string): Promise<boolean> {
    const file = await ensureCronFile()
    const before = file.jobs.length
    file.jobs = file.jobs.filter((j) => j.id !== id)
    if (file.jobs.length === before) return false
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`removed job ${id}`, { jobId: id })
    this.maybePushCronIndex(file)
    return true
  }

  async updateJob(
    id: string,
    updates: Partial<
      Pick<CronJob, 'enabled' | 'schedule' | 'prompt' | 'label' | 'deliver' | 'oneshot'>
    >,
  ): Promise<boolean> {
    const file = await ensureCronFile()
    const job = file.jobs.find((j) => j.id === id)
    if (!job) return false
    if (updates.enabled !== undefined) job.enabled = updates.enabled
    if (updates.schedule) {
      const schedErr = validateCronSchedule(updates.schedule)
      if (schedErr) {
        throw new Error(`Invalid cron schedule "${updates.schedule}": ${schedErr}`)
      }
      // 改 schedule 同样过频率闸(否则可绕过 addJob 闸把任务改成每分钟)。
      const freqErr = frequencyQuotaError(updates.schedule)
      if (freqErr) throw new Error(freqErr)
      job.schedule = updates.schedule
    }
    if (updates.prompt) job.prompt = updates.prompt
    // label 显式携带即生效:空串 = 清空(回退到 prompt 显示),与 create 的可选语义对称。
    if (updates.label !== undefined) job.label = updates.label || undefined
    if (updates.deliver !== undefined) {
      if (!['local', 'webchat', 'telegram'].includes(updates.deliver as string)) {
        throw new Error(`Invalid deliver "${updates.deliver}": must be local | webchat | telegram`)
      }
      job.deliver = updates.deliver
    }
    // oneshot 可改:重复→一次性(下次触发后自动停用)或反向。改为重复时若任务曾因
    // oneshot 触发被自动停用,调用方应同时传 enabled=true 重新启用(UI 已这么做)。
    if (updates.oneshot !== undefined) job.oneshot = !!updates.oneshot
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`updated job ${id}`, { jobId: id })
    this.maybePushCronIndex(file)
    return true
  }

  async listJobs(): Promise<CronJob[]> {
    const file = await ensureCronFile()
    return file.jobs ?? []
  }

  /** List jobs with computed next-run time for UI display */
  async listJobsWithMeta(): Promise<Array<CronJob & { nextRunAt?: string; lastRunAt?: string }>> {
    const file = await ensureCronFile()
    const lastRun = await loadLastRun()
    const now = new Date()
    return (file.jobs ?? []).map((job) => {
      const lastMinKey = lastRun[job.id]
      const lastRunAt = lastMinKey ? new Date(lastMinKey * 60_000).toISOString() : undefined
      const nextRunAt = job.enabled !== false ? computeNextRun(job.schedule, now) : undefined
      return { ...job, nextRunAt, lastRunAt }
    })
  }

  // Delete output files older than 7 days
  private async _cleanupOldOutputs(): Promise<void> {
    const dir = paths.cronOutputsDir
    if (!existsSync(dir)) return
    const cutoff = Date.now() - 7 * 24 * 3600_000
    try {
      const files = await readdir(dir)
      for (const f of files) {
        const fp = join(dir, f)
        const s = await stat(fp)
        if (s.mtimeMs < cutoff) {
          await unlink(fp)
        }
      }
    } catch {}
  }
}

// Helper to update a single job in the cron file (used by oneshot disable)
async function saveCronFile(file: CronFile, updatedJob: CronJob): Promise<void> {
  const idx = file.jobs.findIndex((j) => j.id === updatedJob.id)
  if (idx >= 0) file.jobs[idx] = updatedJob
  await atomicWriteYaml(paths.cronYaml, file)
}

/** Brute-force scan the next 1440 minutes (24h) to find the next matching time.
 *  Exported so the wake-index push (maybePushCronIndex) uses the exact same cron
 *  parser as execution — the master index must never diverge from what fires. */
export function computeNextRun(schedule: string, from: Date): string | undefined {
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1) // start from next minute
  for (let i = 0; i < 1440; i++) {
    if (cronMatches(schedule, d)) return d.toISOString()
    d.setMinutes(d.getMinutes() + 1)
  }
  return undefined
}

/**
 * 从 cron 文件派生上报给 master 的唤醒索引载荷(纯函数,供单测锁定过滤语义)。
 *
 * 只统计**用户发起的**任务(isUserInitiatedCronJob):系统自省 seed(daily-reflection/
 * skill-check/heartbeat 等,v3 迁移卷有存量遗留)不值得为其唤醒容器烧用户积分——
 * 它们仅在容器因其他原因活着时机会性运行(与无唤醒机制时的旧行为一致)。
 * master 侧 rescan(cronWake computeMinNextFire)用同一判定,两侧语义必须对齐。
 */
export function deriveCronIndexPayload(file: CronFile, now: Date): CronIndexPayload {
  let minTs: number | null = null
  let enabledCount = 0
  for (const job of file.jobs ?? []) {
    if (job.enabled === false) continue
    if (!isUserInitiatedCronJob(job)) continue
    enabledCount++
    const next = computeNextRun(job.schedule, now)
    if (next) {
      const ts = Date.parse(next)
      if (!Number.isNaN(ts) && (minTs === null || ts < minTs)) minTs = ts
    }
  }
  return {
    nextFireAt: minTs === null ? null : new Date(minTs).toISOString(),
    enabledCount,
  }
}
