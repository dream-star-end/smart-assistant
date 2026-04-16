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
// The scheduler runs every 60 seconds. If the current time matches a cron
// expression AND the job hasn't run in the current minute, it fires.
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
  heartbeat?: boolean // if true, runs in user's main session (shared context)
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

1. Call \`session_search\` with query terms that cover yesterday's activity (e.g. the current date, common topics).
2. Review the last 5-10 turns you find.
3. Extract durable facts, user preferences, and patterns that should persist across sessions.
4. Use the \`memory\` tool to \`add\` new entries to either "memory" (your observations) or "user" (what you know about the user). Be selective — only things that will actually help next time.
5. If you notice a pattern of tasks that could be reused, use \`skill_save\` to distill it into a reusable skill.
6. IMPORTANT: 重点检查今天是否有超过 3 次工具调用的复杂任务。如果有且没有对应 skill,立即用 skill_save 创建。
7. 如果 MEMORY.md 中有冗长条目,考虑用 archival_add 迁移到归档记忆,然后从 Core 中 remove。
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

1. Call \`memory(action=read, target=memory)\` and \`memory(action=read, target=user)\` to see everything currently stored.
2. Call \`skill_list()\` to see accumulated skills.
3. Call \`archival_search("*")\` to review archival memory entries.
4. Look for:
   - Duplicate or contradictory entries → use \`memory(replace, ...)\` to consolidate.
   - Obsolete facts (outdated preferences, stale technical details) → use \`memory(remove, ...)\`.
   - Skills that are too narrow/specific → consider deleting with \`skill_delete\`.
   - Skills with updated_at 超过 30 天 → 检查是否需要刷新或删除。
   - Archival 中过时的知识 → \`archival_delete\`。
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

1. \`session_search\` with today's date or recent keywords to find conversations from the last 6 hours.
2. If no results, try broader search terms (e.g. common topics the user discusses).
3. For any multi-step task found (3+ tool calls), check \`skill_list()\` for existing coverage.
4. If a useful new skill pattern is found, \`skill_save\` immediately with concrete steps and commands.
5. Also \`memory(action=read, target=memory)\` — if any entry is stale or incorrect, update it.
6. If genuinely nothing new to extract or update, reply with exactly "[SILENT]".`,
  },
  {
    id: 'heartbeat',
    schedule: '13 */4 * * *',
    agent: 'main',
    enabled: true,
    deliver: 'webchat',
    heartbeat: true, // runs in user's main session (shared context)
    prompt: `Periodic heartbeat check. You are running in the user's main session with full conversation context.

1. \`memory(action=read, target=memory)\` — scan for any time-sensitive items, deadlines, or follow-ups.
2. \`archival_search("pending OR reminder OR TODO OR deadline")\` — check for stored reminders/tasks.
3. Review recent conversation context — any unfinished tasks, pending follow-ups, or things the user said "later" about?
4. If you find something actionable, compose a SHORT proactive update.
5. If nothing needs attention, reply with exactly "HEARTBEAT_OK".
6. DO NOT report that you checked and found nothing — that's what HEARTBEAT_OK is for.`,
  },
]

export async function ensureCronFile(): Promise<CronFile> {
  const path = paths.cronYaml
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true })
    await atomicWriteYaml(path, { jobs: DEFAULT_JOBS })
    return { jobs: DEFAULT_JOBS }
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

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null
  private bootTickTimer: NodeJS.Timeout | null = null
  private stopped = false
  private running = false
  /** Reference to last-active-channel map for heartbeat session routing */
  public lastActiveChannel?: Map<
    string,
    { channel: string; peerId: string; sessionKey: string; at: number }
  >

  constructor(
    private config: OpenClaudeConfig,
    private sessions: SessionManager,
    private onDeliver: (text: string, job: CronJob) => void,
  ) {}

  async start(): Promise<void> {
    await ensureCronFile()
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

      const minuteKey = Math.floor(now.getTime() / 60_000)
      let lastRunDirty = false
      try {
        for (const job of file.jobs ?? []) {
          if (job.enabled === false) continue
          if (!cronMatches(job.schedule, localNow)) continue
          // Dedupe: don't run twice in the same minute
          if (lastRun[job.id] === minuteKey) continue
          const agent = agentsConfig.agents.find((a) => a.id === job.agent)
          if (!agent) {
            logger.warn(`job ${job.id}: agent ${job.agent} not found`, { jobId: job.id, agent: job.agent })
            continue
          }
          await this.runJob(job, agent)
          lastRun[job.id] = minuteKey
          lastRunDirty = true
        }
      } finally {
        // Always flush completed job timestamps so a later failure doesn't replay
        // already-run jobs on the next tick.
        if (lastRunDirty) {
          await saveLastRun(lastRun)
        }
      }
    } finally {
      this.running = false
    }
  }

  private async runJob(job: CronJob, agent: AgentDef): Promise<void> {
    logger.info(`running job ${job.id}`, { jobId: job.id, heartbeat: !!job.heartbeat })

    let sessionKey: string
    if (job.heartbeat) {
      // Heartbeat: run in user's main session (shared context)
      const lastActive = this.lastActiveChannel?.get(agent.id)
      sessionKey = lastActive?.sessionKey || `agent:${agent.id}:webchat:dm:__heartbeat__`
    } else {
      // Regular task: isolated session per execution (no history accumulation)
      sessionKey = `agent:${agent.id}:cron:dm:${job.id}:${Date.now()}`
    }

    const session = await this.sessions.getOrCreate({
      sessionKey,
      agent,
      channel: job.heartbeat ? 'webchat' : 'cron',
      peerId: job.heartbeat ? sessionKey.split(':')[4] || job.id : job.id,
      title: job.heartbeat ? '[heartbeat]' : `[cron] ${job.id}`,
    })
    let output = ''
    await this.sessions.submit(session, job.prompt, (e) => {
      if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
    })

    // Isolated sessions (non-heartbeat): destroy after execution to free resources
    if (!job.heartbeat) {
      await this.sessions.destroySession(sessionKey)
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

    // Deliver if not [SILENT] or HEARTBEAT_OK
    const trimmed = output.trim()
    if (trimmed.startsWith('[SILENT]') || trimmed === 'HEARTBEAT_OK') {
      logger.info(`job ${job.id} silent/ok, not delivering`, { jobId: job.id })
      return
    }
    logger.info(`job ${job.id} completed`, { jobId: job.id, chars: trimmed.length, deliver: job.deliver ?? 'local' })
    if ((job.deliver ?? 'local') === 'local') {
      // local = just log, don't push to any channel
    } else {
      logger.info(`delivering job ${job.id} to ${job.deliver}`, { jobId: job.id, deliver: job.deliver })
      this.onDeliver(trimmed, job)
    }
  }

  // ── Runtime job management (called by /api/cron) ──

  async addJob(job: CronJob): Promise<void> {
    // M6: Validate cron schedule before persisting
    const schedFields = job.schedule.trim().split(/\s+/)
    if (schedFields.length !== 5 || !schedFields.every((f) => /^[\d*/,\-]+$/.test(f))) {
      throw new Error(
        `Invalid cron schedule "${job.schedule}": must be a 5-field expression (minute hour dom month dow)`,
      )
    }
    const file = await ensureCronFile()
    // Replace if same ID exists
    file.jobs = file.jobs.filter((j) => j.id !== job.id)
    file.jobs.push(job)
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`added job ${job.id}`, { jobId: job.id, schedule: job.schedule })
  }

  async removeJob(id: string): Promise<boolean> {
    const file = await ensureCronFile()
    const before = file.jobs.length
    file.jobs = file.jobs.filter((j) => j.id !== id)
    if (file.jobs.length === before) return false
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`removed job ${id}`, { jobId: id })
    return true
  }

  async updateJob(
    id: string,
    updates: Partial<Pick<CronJob, 'enabled' | 'schedule' | 'prompt' | 'label'>>,
  ): Promise<boolean> {
    const file = await ensureCronFile()
    const job = file.jobs.find((j) => j.id === id)
    if (!job) return false
    if (updates.enabled !== undefined) job.enabled = updates.enabled
    if (updates.schedule) {
      // Validate new schedule before applying
      const schedFields = updates.schedule.trim().split(/\s+/)
      if (schedFields.length !== 5 || !schedFields.every((f) => /^[\d*/,\-]+$/.test(f))) {
        throw new Error(
          `Invalid cron schedule "${updates.schedule}": must be a 5-field expression (minute hour dom month dow)`,
        )
      }
      job.schedule = updates.schedule
    }
    if (updates.prompt) job.prompt = updates.prompt
    if (updates.label) job.label = updates.label
    await atomicWriteYaml(paths.cronYaml, file)
    logger.info(`updated job ${id}`, { jobId: id })
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

/** Brute-force scan the next 1440 minutes (24h) to find the next matching time */
function computeNextRun(schedule: string, from: Date): string | undefined {
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1) // start from next minute
  for (let i = 0; i < 1440; i++) {
    if (cronMatches(schedule, d)) return d.toISOString()
    d.setMinutes(d.getMinutes() + 1)
  }
  return undefined
}
