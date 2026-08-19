/**
 * In-memory delegate job handles + long-poll wait.
 *
 * Every engine starts delegation with `async: true`: MCP calls only wait a
 * short fast-path window, while the gateway parks the child behind a jobId and
 * the caller long-polls `POST /api/delegate/wait`. Running jobs do not expire:
 * the delegate idle watchdog owns liveness. The TTL starts only after a result
 * is available, so a legitimate long run cannot lose its retrieval handle.
 */

import { randomBytes } from 'node:crypto'

export const DEFAULT_DELEGATE_JOB_TTL_MS = 2 * 60 * 60_000
export const MIN_DELEGATE_JOB_TTL_MS = 60_000
export const MAX_DELEGATE_JOB_TTL_MS = 2 * 60 * 60_000

export const DEFAULT_DELEGATE_WAIT_MS = 30_000
export const MIN_DELEGATE_WAIT_MS = 250
export const MAX_DELEGATE_WAIT_MS = 55_000

export const DEFAULT_MAX_DELEGATE_JOBS = 256

function normalizeMs(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Job result TTL. Default 2h; env `OPENCLAUDE_DELEGATE_JOB_TTL_MS` clamped to 1min..2h. */
export function resolveDelegateJobTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return normalizeMs(
    env.OPENCLAUDE_DELEGATE_JOB_TTL_MS,
    DEFAULT_DELEGATE_JOB_TTL_MS,
    MIN_DELEGATE_JOB_TTL_MS,
    MAX_DELEGATE_JOB_TTL_MS,
  )
}

/** Per-request long-poll wait. Default 30s; clamped to 250ms..55s. */
export function resolveDelegateWaitMs(
  raw: unknown,
  fallback = DEFAULT_DELEGATE_WAIT_MS,
): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_DELEGATE_WAIT_MS, Math.max(MIN_DELEGATE_WAIT_MS, Math.floor(n)))
}

export type DelegateJobHttpResult = {
  httpStatus: number
  body: Record<string, unknown>
}

export type DelegateJobWaitView =
  | { status: 'running'; jobId: string; sessionKey?: string }
  | { status: 'expired'; jobId: string }
  | {
      status: 'done'
      jobId: string
      httpStatus: number
      body: Record<string, unknown>
    }

type JobEntry = {
  id: string
  agentId: string
  createdAt: number
  expiresAt: number | null
  sessionKey?: string
  result: DelegateJobHttpResult | null
  waiters: Array<(view: DelegateJobWaitView) => void>
}

export type DelegateJobStoreOptions = {
  ttlMs?: number
  maxJobs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export class DelegateJobStore {
  private readonly jobs = new Map<string, JobEntry>()
  private readonly ttlMs: number
  private readonly maxJobs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: DelegateJobStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DELEGATE_JOB_TTL_MS
    this.maxJobs = opts.maxJobs ?? DEFAULT_MAX_DELEGATE_JOBS
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? defaultSleep
  }

  create(
    agentId: string,
    meta?: { sessionKey?: string },
  ): { jobId: string } | { error: 'capacity' } {
    this.sweep()
    if (this.jobs.size >= this.maxJobs) return { error: 'capacity' }
    const jobId = `dlgjob-${this.now().toString(36)}-${randomBytes(6).toString('hex')}`
    const createdAt = this.now()
    this.jobs.set(jobId, {
      id: jobId,
      agentId,
      createdAt,
      expiresAt: null,
      sessionKey: meta?.sessionKey,
      result: null,
      waiters: [],
    })
    return { jobId }
  }

  complete(jobId: string, result: DelegateJobHttpResult): void {
    const job = this.jobs.get(jobId)
    if (!job || job.result) return
    job.result = result
    job.expiresAt = this.now() + this.ttlMs
    const view: DelegateJobWaitView = {
      status: 'done',
      jobId,
      httpStatus: result.httpStatus,
      body: result.body,
    }
    const waiters = job.waiters.splice(0)
    for (const w of waiters) w(view)
  }

  get(jobId: string): DelegateJobWaitView {
    this.sweep()
    const job = this.jobs.get(jobId)
    if (!job) return { status: 'expired', jobId }
    if (job.result) {
      return {
        status: 'done',
        jobId,
        httpStatus: job.result.httpStatus,
        body: job.result.body,
      }
    }
    return this.runningView(job)
  }

  async wait(jobId: string, waitMs: number): Promise<DelegateJobWaitView> {
    this.sweep()
    const job = this.jobs.get(jobId)
    if (!job) return { status: 'expired', jobId }
    if (job.result) {
      return {
        status: 'done',
        jobId,
        httpStatus: job.result.httpStatus,
        body: job.result.body,
      }
    }
    const capped = resolveDelegateWaitMs(waitMs)
    return new Promise<DelegateJobWaitView>((resolve) => {
      let settled = false
      const finish = (view: DelegateJobWaitView) => {
        if (settled) return
        settled = true
        const idx = job.waiters.indexOf(finish)
        if (idx >= 0) job.waiters.splice(idx, 1)
        resolve(view)
      }
      job.waiters.push(finish)
      if (job.result) {
        finish({
          status: 'done',
          jobId,
          httpStatus: job.result.httpStatus,
          body: job.result.body,
        })
        return
      }
      void this.sleep(capped).then(() => {
        finish(this.get(jobId))
      })
    })
  }

  private runningView(job: JobEntry): DelegateJobWaitView {
    return job.sessionKey
      ? { status: 'running', jobId: job.id, sessionKey: job.sessionKey }
      : { status: 'running', jobId: job.id }
  }

  sweep(now = this.now()): number {
    let removed = 0
    for (const [id, job] of this.jobs) {
      if (!job.result || job.expiresAt === null || job.expiresAt > now) continue
      const waiters = job.waiters.splice(0)
      for (const w of waiters) w({ status: 'expired', jobId: id })
      this.jobs.delete(id)
      removed++
    }
    return removed
  }

  size(): number {
    return this.jobs.size
  }

  close(): void {
    for (const job of this.jobs.values()) {
      const waiters = job.waiters.splice(0)
      for (const w of waiters) w({ status: 'expired', jobId: job.id })
    }
    this.jobs.clear()
  }
}
