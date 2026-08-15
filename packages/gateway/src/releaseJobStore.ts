import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const RELEASE_JOB_ID_RE = /^rel-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/
export const RELEASE_JOB_MARKER = 'OC_RELEASE_JOB_V1'

export const RELEASE_JOB_PHASES = [
  'queued',
  'acquiring_lease',
  'deploying',
  'smoking',
  'completed',
  'failed',
  'rolled_back',
] as const

export type ReleaseJobPhase = (typeof RELEASE_JOB_PHASES)[number]

export const RELEASE_JOB_TRANSITIONS: Record<ReleaseJobPhase, readonly ReleaseJobPhase[]> = {
  queued: ['acquiring_lease', 'failed'],
  acquiring_lease: ['deploying', 'failed'],
  deploying: ['smoking', 'completed', 'failed', 'rolled_back'],
  smoking: ['completed', 'failed', 'rolled_back'],
  completed: [],
  failed: [],
  rolled_back: [],
}

export const RELEASE_PHASE_LABELS: Record<ReleaseJobPhase, string> = {
  queued: '排队中',
  acquiring_lease: '获取 lease',
  deploying: '部署中',
  smoking: '冒烟中',
  completed: '完成',
  failed: '失败',
  rolled_back: '已回滚',
}

export type ReleaseJobEntry = {
  at: string
  phase: string
  text: string
}

export type ReleaseProgressCard = {
  kind: 'release_progress'
  runId: string
  goal: string
  entries: Array<{ phase: string; text: string }>
  summary: string | null
  error: string | null
  startTime: string
  completedAt: string | null
  _completed: boolean
  _isError: boolean
  phase: ReleaseJobPhase
  nextStep: string | null
}

export type ReleaseJob = {
  version: 1
  id: string
  phase: ReleaseJobPhase
  createdAt: string
  updatedAt: string
  startedAt: string
  finishedAt: string | null
  owner: string
  queueId: string
  title: string
  deployArgs: string[]
  thenSmoke: boolean
  deployUnit: string | null
  smokeUnit: string | null
  supervisorPid: number | null
  exitCode: number | null
  error: string | null
  nextStep: string | null
  recallRequired: boolean
  entries: ReleaseJobEntry[]
  card: ReleaseProgressCard
}

export type PublicReleaseJob = {
  id: string
  phase: ReleaseJobPhase
  phaseLabel: string
  title: string
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  elapsedMs: number
  queueId: string
  deployUnit: string | null
  error: string | null
  nextStep: string | null
  recallRequired: boolean
  entries: ReleaseJobEntry[]
  card: ReleaseProgressCard
}

export function isReleaseJobPhase(value: unknown): value is ReleaseJobPhase {
  return typeof value === 'string' && (RELEASE_JOB_PHASES as readonly string[]).includes(value)
}

export function isReleaseJobId(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_JOB_ID_RE.test(value)
}

export function canTransition(from: ReleaseJobPhase, to: ReleaseJobPhase): boolean {
  return from === to || RELEASE_JOB_TRANSITIONS[from].includes(to)
}

export function isTerminalPhase(phase: ReleaseJobPhase): boolean {
  return RELEASE_JOB_TRANSITIONS[phase].length === 0
}

export function defaultReleaseJobDir(): string {
  return process.env.OC_V5_RELEASE_JOB_DIR || '/var/lib/openclaude-v5/release-jobs'
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asCard(raw: unknown, job: { id: string; phase: ReleaseJobPhase; title: string; createdAt: string; finishedAt: string | null; error: string | null; nextStep: string | null; entries: ReleaseJobEntry[] }): ReleaseProgressCard {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    kind: 'release_progress',
    runId: asString(rec.runId) ?? job.id,
    goal: asString(rec.goal) ?? job.title,
    entries: Array.isArray(rec.entries)
      ? rec.entries.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const row = entry as Record<string, unknown>
          return [{ phase: String(row.phase ?? ''), text: String(row.text ?? '') }]
        })
      : job.entries.map((entry) => ({ phase: entry.phase, text: entry.text })),
    summary: asString(rec.summary),
    error: asString(rec.error) ?? (job.phase === 'failed' ? job.error : null),
    startTime: asString(rec.startTime) ?? job.createdAt,
    completedAt: asString(rec.completedAt) ?? job.finishedAt,
    _completed: rec._completed === true || isTerminalPhase(job.phase),
    _isError: rec._isError === true || job.phase === 'failed',
    phase: isReleaseJobPhase(rec.phase) ? rec.phase : job.phase,
    nextStep: asString(rec.nextStep) ?? job.nextStep,
  }
}

export function parseReleaseJob(raw: unknown): ReleaseJob | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (rec.version !== 1 || !isReleaseJobId(rec.id) || !isReleaseJobPhase(rec.phase)) return null
  if (typeof rec.createdAt !== 'string' || typeof rec.title !== 'string') return null
  const entries = Array.isArray(rec.entries)
    ? rec.entries.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const row = entry as Record<string, unknown>
        if (typeof row.at !== 'string' || typeof row.phase !== 'string' || typeof row.text !== 'string') return []
        return [{ at: row.at, phase: row.phase, text: row.text }]
      })
    : []
  const finishedAt = typeof rec.finishedAt === 'string' ? rec.finishedAt : null
  const error = asString(rec.error)
  const nextStep = asString(rec.nextStep)
  const jobHead = {
    id: rec.id,
    phase: rec.phase,
    title: rec.title,
    createdAt: rec.createdAt,
    finishedAt,
    error,
    nextStep,
    entries,
  }
  return {
    version: 1,
    id: rec.id,
    phase: rec.phase,
    createdAt: rec.createdAt,
    updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : rec.createdAt,
    startedAt: typeof rec.startedAt === 'string' ? rec.startedAt : rec.createdAt,
    finishedAt,
    owner: typeof rec.owner === 'string' ? rec.owner : '',
    queueId: typeof rec.queueId === 'string' ? rec.queueId : '',
    title: rec.title,
    deployArgs: Array.isArray(rec.deployArgs) ? rec.deployArgs.map((item) => String(item)) : [],
    thenSmoke: rec.thenSmoke === true,
    deployUnit: asString(rec.deployUnit),
    smokeUnit: asString(rec.smokeUnit),
    supervisorPid: typeof rec.supervisorPid === 'number' ? rec.supervisorPid : null,
    exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : null,
    error,
    nextStep,
    recallRequired: rec.recallRequired === true || rec.phase === 'failed',
    entries,
    card: asCard(rec.card, jobHead),
  }
}

export function publicReleaseJob(job: ReleaseJob, nowMs = Date.now()): PublicReleaseJob {
  const start = Date.parse(job.startedAt || job.createdAt)
  const end = job.finishedAt ? Date.parse(job.finishedAt) : nowMs
  return {
    id: job.id,
    phase: job.phase,
    phaseLabel: RELEASE_PHASE_LABELS[job.phase],
    title: job.title,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    elapsedMs: Number.isFinite(start) ? Math.max(0, end - start) : 0,
    queueId: job.queueId,
    deployUnit: job.deployUnit,
    error: job.error,
    nextStep: job.nextStep,
    recallRequired: job.recallRequired,
    entries: job.entries,
    card: job.card,
  }
}

export function readReleaseJob(dir: string, id: string): ReleaseJob | null {
  if (!isReleaseJobId(id)) return null
  const file = join(dir, `${id}.json`)
  if (!existsSync(file)) return null
  try {
    return parseReleaseJob(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function listReleaseJobs(dir: string): ReleaseJob[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.recall.json'))
    .map((name) => readReleaseJob(dir, name.replace(/\.json$/, '')))
    .filter((job): job is ReleaseJob => job !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function parseReleaseJobOutput(text: string): ReleaseJob | null {
  const raw = String(text ?? '')
  const marker = raw.indexOf(RELEASE_JOB_MARKER)
  const body = marker >= 0 ? raw.slice(marker + RELEASE_JOB_MARKER.length).trim() : raw.trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return parseReleaseJob(JSON.parse(body.slice(start, end + 1)))
  } catch {
    return null
  }
}
