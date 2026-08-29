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
import {
  assertDelegateTransition,
  isDelegateTerminalState,
  type DelegateCallback,
  type DelegateCallbackState,
  type DelegateCheckpointKind,
  type DelegateFailureClass,
  type DelegateJobKind,
  type DelegateJobState,
} from '../../protocol/src/delegation.js'

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
  | { status: 'running'; jobId: string; sessionKey?: string; state?: DelegateJobState }
  | { status: 'queued'; jobId: string; sessionKey?: string; state: 'queued' }
  | { status: 'expired'; jobId: string; failure_class?: DelegateFailureClass }
  | {
      status: 'done'
      jobId: string
      httpStatus: number
      body: Record<string, unknown>
      state?: DelegateJobState
      failure_class?: DelegateFailureClass
    }
  | {
      status: 'failed'
      jobId: string
      httpStatus: number
      body: Record<string, unknown>
      state: 'failed' | 'killed_by_cutover' | 'cancelled'
      failure_class: DelegateFailureClass
      failure_detail: string
    }

export type DelegateCreateMeta = {
  sessionKey?: string
  queued?: boolean
  kind?: DelegateJobKind
  callback?: DelegateCallback
  idempotencyKey?: string
  ownerInstanceId?: string
  claimToken?: string
  generation?: number
}

export type DelegateJobSnapshot = {
  id: string
  agentId: string
  state: DelegateJobState
  sessionKey?: string
  failureClass?: DelegateFailureClass
  failureDetail?: string
  claimToken?: string
  fencingEpoch: number
  attemptNo: number
  ownerInstanceId?: string
  ownerLeaseUntil?: number
  checkpointKind: DelegateCheckpointKind
  callback: DelegateCallback
  callbackState: DelegateCallbackState
  callbackEpoch: number
  idempotencyKey?: string
  kind: DelegateJobKind
  generation: number
}

type JobEntry = {
  id: string
  agentId: string
  createdAt: number
  expiresAt: number | null
  sessionKey?: string
  result: DelegateJobHttpResult | null
  waiters: Array<(view: DelegateJobWaitView) => void>
  state: DelegateJobState
  failureClass?: DelegateFailureClass
  failureDetail?: string
  generation: number
  ownerInstanceId?: string
  ownerLeaseUntil?: number | null
  claimToken?: string
  attemptNo: number
  fencingEpoch: number
  checkpointKind: DelegateCheckpointKind
  callback: DelegateCallback
  callbackState: DelegateCallbackState
  callbackEpoch: number
  idempotencyKey?: string
  kind: DelegateJobKind
}

export type DelegateJobStoreOptions = {
  ttlMs?: number
  maxJobs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Phase 0 SM: queued view, failure_class, owner lease CAS. Default false. */
  sm?: boolean
  bootId?: string
  leaseMs?: number
}

export function mintDelegateClaimToken(): string {
  return randomBytes(32).toString('hex')
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export class DelegateJobStore {
  private readonly jobs = new Map<string, JobEntry>()
  private readonly byIdempotency = new Map<string, string>()
  private readonly ttlMs: number
  private readonly maxJobs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly sm: boolean
  private readonly bootId: string
  private readonly leaseMs: number

  constructor(opts: DelegateJobStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DELEGATE_JOB_TTL_MS
    this.maxJobs = opts.maxJobs ?? DEFAULT_MAX_DELEGATE_JOBS
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? defaultSleep
    this.sm = opts.sm === true
    this.bootId = opts.bootId ?? `gw:${randomBytes(8).toString('hex')}`
    this.leaseMs = opts.leaseMs ?? 45_000
  }

  get smEnabled(): boolean {
    return this.sm
  }

  get ownerInstanceId(): string {
    return this.bootId
  }

  create(
    agentId: string,
    meta?: DelegateCreateMeta,
  ): { jobId: string } | { error: 'capacity' } {
    this.sweep()
    const idempotencyKey =
      typeof meta?.idempotencyKey === 'string' && meta.idempotencyKey.trim()
        ? meta.idempotencyKey.trim()
        : undefined
    if (idempotencyKey) {
      const existingId = this.byIdempotency.get(idempotencyKey)
      if (existingId && this.jobs.has(existingId)) return { jobId: existingId }
    }
    if (this.jobs.size >= this.maxJobs) return { error: 'capacity' }
    const jobId = `dlgjob-${this.now().toString(36)}-${randomBytes(6).toString('hex')}`
    const createdAt = this.now()
    const queued = this.sm && meta?.queued === true
    const claimToken = meta?.claimToken ?? (queued ? undefined : mintDelegateClaimToken())
    this.jobs.set(jobId, {
      id: jobId,
      agentId,
      createdAt,
      expiresAt: null,
      sessionKey: meta?.sessionKey,
      result: null,
      waiters: [],
      state: queued ? 'queued' : 'running',
      generation: meta?.generation ?? 0,
      ownerInstanceId: queued ? undefined : (meta?.ownerInstanceId ?? this.bootId),
      ownerLeaseUntil: queued ? null : createdAt + this.leaseMs,
      claimToken,
      attemptNo: queued ? 0 : 1,
      fencingEpoch: queued ? 0 : 1,
      checkpointKind: 'none',
      callback: meta?.callback ?? 'none',
      callbackState: 'none',
      callbackEpoch: 0,
      idempotencyKey,
      kind: meta?.kind ?? 'delegate',
    })
    if (idempotencyKey) this.byIdempotency.set(idempotencyKey, jobId)
    return { jobId }
  }

  findBySessionKey(sessionKey: string): DelegateJobSnapshot | undefined {
    for (const job of this.jobs.values()) {
      if (job.sessionKey === sessionKey) return this.snapshot(job)
    }
    return undefined
  }

  findByIdempotencyKey(key: string): DelegateJobSnapshot | undefined {
    const id = this.byIdempotency.get(key)
    if (!id) return undefined
    const job = this.jobs.get(id)
    return job ? this.snapshot(job) : undefined
  }

  snapshotOf(jobId: string): DelegateJobSnapshot | undefined {
    const job = this.jobs.get(jobId)
    return job ? this.snapshot(job) : undefined
  }

  complete(jobId: string, result: DelegateJobHttpResult, fence?: { claimToken: string; fencingEpoch: number }): void {
    const job = this.jobs.get(jobId)
    if (!job || job.result) return
    if (this.sm && fence) {
      if (job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) return
    }
    if (this.sm) {
      const next: DelegateJobState = result.httpStatus >= 200 && result.httpStatus < 300 ? 'completed' : 'failed'
      const gate = assertDelegateTransition(job.state, next)
      if (!gate.ok && job.state !== next) return
      job.state = next
      if (next === 'failed' && !job.failureClass) {
        job.failureClass = 'child_error'
        job.failureDetail = String(result.body.error ?? 'delegate failed').slice(0, 512)
      }
      if (job.callback === 'origin-inject' || job.callback === 'cron-origin-inject') {
        if (job.callbackState === 'none') {
          job.callbackState = 'pending'
          job.callbackEpoch = 1
        }
      } else if (job.callback === 'none') {
        job.callbackState = 'skipped_silent'
      }
      job.ownerLeaseUntil = null
    }
    job.result = result
    job.expiresAt = this.now() + this.ttlMs
    const waiters = job.waiters.splice(0)
    for (const w of waiters) w(this.viewOf(job))
  }

  /**
   * Explicit SM fail. Must CAS claim_token when the job is owned.
   * Queued jobs (no claim yet) may fail without a token.
   */
  fail(
    jobId: string,
    args: {
      failureClass: DelegateFailureClass
      detail: string
      httpStatus: number
      body?: Record<string, unknown>
      claimToken?: string
      fencingEpoch?: number
      nextState?: Extract<DelegateJobState, 'failed' | 'killed_by_cutover' | 'cancelled'>
    },
  ): boolean {
    const job = this.jobs.get(jobId)
    if (!job || isDelegateTerminalState(job.state)) return false
    if (job.claimToken) {
      if (!args.claimToken || args.claimToken !== job.claimToken) return false
      if (args.fencingEpoch !== undefined && args.fencingEpoch !== job.fencingEpoch) return false
    }
    const next = args.nextState ?? 'failed'
    const gate = assertDelegateTransition(job.state, next)
    if (!gate.ok) return false
    job.state = next
    job.failureClass = args.failureClass
    job.failureDetail = args.detail.slice(0, 512)
    if (job.callback === 'origin-inject' || job.callback === 'cron-origin-inject') {
      job.callbackState = 'pending'
      job.callbackEpoch = 1
    } else {
      job.callbackState = 'skipped_silent'
    }
    job.ownerLeaseUntil = null
    job.result = {
      httpStatus: args.httpStatus,
      body: {
        error: args.detail,
        failure_class: args.failureClass,
        ...(args.body ?? {}),
      },
    }
    job.expiresAt = this.now() + this.ttlMs
    const waiters = job.waiters.splice(0)
    for (const w of waiters) w(this.viewOf(job))
    return true
  }

  /** queued → running with a new claim_token (slot acquired). */
  claimQueued(jobId: string): { ok: true; claimToken: string; fencingEpoch: number } | { ok: false } {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'queued') return { ok: false }
    const gate = assertDelegateTransition('queued', 'running')
    if (!gate.ok) return { ok: false }
    job.state = 'running'
    job.claimToken = mintDelegateClaimToken()
    job.fencingEpoch += 1
    job.attemptNo += 1
    job.ownerInstanceId = this.bootId
    job.ownerLeaseUntil = this.now() + this.leaseMs
    job.checkpointKind = 'none'
    return { ok: true, claimToken: job.claimToken, fencingEpoch: job.fencingEpoch }
  }

  casHeartbeat(jobId: string, claimToken: string, fencingEpoch: number): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (job.claimToken !== claimToken || job.fencingEpoch !== fencingEpoch) return false
    if (job.state !== 'running' && job.state !== 'paused_for_cutover') return false
    job.ownerLeaseUntil = this.now() + this.leaseMs
    return true
  }

  /**
   * Start-up / cutover reconciler. Returns the adopted snapshot or undefined
   * when this process lost the race / the row is terminal.
   */
  adoptOrKill(
    jobId: string,
    expectedEpoch: number,
    nextState: DelegateJobState,
  ): DelegateJobSnapshot | undefined {
    const job = this.jobs.get(jobId)
    if (!job) return undefined
    if (!['queued', 'running', 'paused_for_cutover'].includes(job.state)) return undefined
    if (job.fencingEpoch !== expectedEpoch) return undefined
    const now = this.now()
    const stale =
      !job.ownerInstanceId ||
      job.ownerInstanceId !== this.bootId ||
      job.ownerLeaseUntil == null ||
      job.ownerLeaseUntil < now
    if (!stale && job.ownerInstanceId === this.bootId && job.state === 'running') {
      return this.snapshot(job)
    }
    if (!stale) return undefined
    if (nextState !== job.state) {
      const gate = assertDelegateTransition(job.state, nextState)
      if (!gate.ok) return undefined
    }
    job.ownerInstanceId = this.bootId
    job.ownerLeaseUntil = now + this.leaseMs
    job.claimToken = mintDelegateClaimToken()
    job.attemptNo += 1
    job.fencingEpoch += 1
    job.state = nextState
    if (nextState !== 'paused_for_cutover') job.checkpointKind = 'none'
    if (isDelegateTerminalState(nextState)) {
      job.ownerLeaseUntil = null
      job.failureClass = job.failureClass ?? (nextState === 'killed_by_cutover' ? 'cutover' : job.failureClass)
      job.failureDetail = job.failureDetail ?? 'adopt-or-kill'
      job.result = {
        httpStatus: 409,
        body: { error: job.failureDetail, failure_class: job.failureClass },
      }
      job.expiresAt = now + this.ttlMs
      const waiters = job.waiters.splice(0)
      for (const w of waiters) w(this.viewOf(job))
    }
    return this.snapshot(job)
  }

  decideAdoptNextState(job: DelegateJobSnapshot): DelegateJobState {
    if (job.state === 'queued') return 'queued'
    if (job.state === 'paused_for_cutover') {
      return job.checkpointKind === 'runner_quiesced' ? 'paused_for_cutover' : 'killed_by_cutover'
    }
    if (job.state === 'running') {
      const now = this.now()
      const selfLive =
        job.ownerInstanceId === this.bootId &&
        job.ownerLeaseUntil != null &&
        job.ownerLeaseUntil >= now
      if (selfLive) return 'running'
      return job.checkpointKind === 'runner_quiesced' ? 'paused_for_cutover' : 'killed_by_cutover'
    }
    return job.state
  }

  listNonTerminal(): DelegateJobSnapshot[] {
    const out: DelegateJobSnapshot[] = []
    for (const job of this.jobs.values()) {
      if (!isDelegateTerminalState(job.state)) out.push(this.snapshot(job))
    }
    return out
  }

  get(jobId: string): DelegateJobWaitView {
    this.sweep()
    const job = this.jobs.get(jobId)
    if (!job) {
      return this.sm
        ? { status: 'expired', jobId, failure_class: 'unknown_job' }
        : { status: 'expired', jobId }
    }
    return this.viewOf(job)
  }

  async wait(jobId: string, waitMs: number): Promise<DelegateJobWaitView> {
    this.sweep()
    const job = this.jobs.get(jobId)
    if (!job) {
      return this.sm
        ? { status: 'expired', jobId, failure_class: 'unknown_job' }
        : { status: 'expired', jobId }
    }
    if (job.result) return this.viewOf(job)
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
        finish(this.viewOf(job))
        return
      }
      void this.sleep(capped).then(() => {
        finish(this.get(jobId))
      })
    })
  }

  private viewOf(job: JobEntry): DelegateJobWaitView {
    if (this.sm && job.state === 'queued' && !job.result) {
      return job.sessionKey
        ? { status: 'queued', jobId: job.id, sessionKey: job.sessionKey, state: 'queued' }
        : { status: 'queued', jobId: job.id, state: 'queued' }
    }
    if (this.sm && job.result && job.failureClass && isDelegateTerminalState(job.state) && job.state !== 'completed') {
      return {
        status: 'failed',
        jobId: job.id,
        httpStatus: job.result.httpStatus,
        body: job.result.body,
        state: job.state as 'failed' | 'killed_by_cutover' | 'cancelled',
        failure_class: job.failureClass,
        failure_detail: job.failureDetail ?? '',
      }
    }
    if (job.result) {
      return {
        status: 'done',
        jobId: job.id,
        httpStatus: job.result.httpStatus,
        body: job.result.body,
        ...(this.sm ? { state: job.state, failure_class: job.failureClass } : {}),
      }
    }
    return job.sessionKey
      ? { status: 'running', jobId: job.id, sessionKey: job.sessionKey, ...(this.sm ? { state: job.state } : {}) }
      : { status: 'running', jobId: job.id, ...(this.sm ? { state: job.state } : {}) }
  }

  private snapshot(job: JobEntry): DelegateJobSnapshot {
    return {
      id: job.id,
      agentId: job.agentId,
      state: job.state,
      sessionKey: job.sessionKey,
      failureClass: job.failureClass,
      failureDetail: job.failureDetail,
      claimToken: job.claimToken,
      fencingEpoch: job.fencingEpoch,
      attemptNo: job.attemptNo,
      ownerInstanceId: job.ownerInstanceId,
      ownerLeaseUntil: job.ownerLeaseUntil ?? undefined,
      checkpointKind: job.checkpointKind,
      callback: job.callback,
      callbackState: job.callbackState,
      callbackEpoch: job.callbackEpoch,
      idempotencyKey: job.idempotencyKey,
      kind: job.kind,
      generation: job.generation,
    }
  }

  sweep(now = this.now()): number {
    let removed = 0
    for (const [id, job] of this.jobs) {
      if (!job.result || job.expiresAt === null || job.expiresAt > now) continue
      const waiters = job.waiters.splice(0)
      for (const w of waiters) w({ status: 'expired', jobId: id, ...(this.sm ? { failure_class: 'job_ttl_elapsed' as const } : {}) })
      if (job.idempotencyKey) this.byIdempotency.delete(job.idempotencyKey)
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
    this.byIdempotency.clear()
  }
}
