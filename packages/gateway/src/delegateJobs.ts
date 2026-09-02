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
} from '@openclaude/protocol'
import type { DelegateDurableDb, DurableJobRecord } from './delegateDurable.js'

export const DEFAULT_DELEGATE_JOB_TTL_MS = 2 * 60 * 60_000
export const MIN_DELEGATE_JOB_TTL_MS = 60_000
export const MAX_DELEGATE_JOB_TTL_MS = 2 * 60 * 60_000

export const DEFAULT_DELEGATE_WAIT_MS = 30_000
export const MIN_DELEGATE_WAIT_MS = 250
export const MAX_DELEGATE_WAIT_MS = 55_000

export const DEFAULT_MAX_DELEGATE_JOBS = 256

/** B1 lease heartbeat. 480 * 15s = 2h hard cap. */
export const DELEGATE_LEASE_HEARTBEAT_MS = 15_000
export const DELEGATE_LEASE_HEARTBEAT_MAX_BEATS = 480

/** Exclusive notify claim lease. Stale injecting is reclaimable after this. */
export const NOTIFY_CLAIM_LEASE_MS = 30_000
export const NOTIFY_RETRY_INITIAL_MS = 1_000
export const NOTIFY_RETRY_MAX_MS = 30_000
/**
 * ResumeInject retry budget. Both floors must trip: attempt count stops a
 * fast-fail storm, and the 24h terminal age stops a still-reachable origin
 * from being abandoned during a long BUSY window. Dispatch warns and
 * callback_state='abandoned'; listDueNotify already excludes that state.
 */
export const NOTIFY_ABANDON_MIN_ATTEMPTS = 48
export const NOTIFY_ABANDON_AFTER_TERMINAL_MS = 24 * 60 * 60_000

export function nextNotifyBackoffMs(attempt: number): number {
  const exp = Math.min(16, Math.max(0, Math.floor(attempt)))
  return Math.min(NOTIFY_RETRY_MAX_MS, NOTIFY_RETRY_INITIAL_MS * 2 ** exp)
}

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
  parentSessionKey?: string
  queued?: boolean
  kind?: DelegateJobKind
  callback?: DelegateCallback
  idempotencyKey?: string
  ownerInstanceId?: string
  claimToken?: string
  generation?: number
  parentEngine?: string
  callbackOriginSessionKey?: string
  callbackOriginUserId?: string
}

export type DelegateJobSnapshot = {
  id: string
  agentId: string
  state: DelegateJobState
  sessionKey?: string
  parentSessionKey?: string
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
  result?: DelegateJobHttpResult | null
  expiresAt?: number | null
  createdAt?: number
  lastActivityAt?: number
  parentEngine?: string
  notifyLane?: string
  notifyId?: string
  callbackOriginSessionKey?: string
  callbackOriginUserId?: string
  notifyRetryAt?: number | null
  notifyAttempt?: number
  notifyDeliveryToken?: string
  notifyClaimedUntil?: number | null
  terminalCommittedAt?: number
  notifyAAttemptedAt?: number | null
}

type JobEntry = {
  id: string
  agentId: string
  createdAt: number
  lastActivityAt: number
  expiresAt: number | null
  sessionKey?: string
  parentSessionKey?: string
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
  parentEngine?: string
  notifyLane?: string
  notifyId?: string
  callbackOriginSessionKey?: string
  callbackOriginUserId?: string
  notifyRetryAt?: number | null
  notifyAttempt: number
  notifyDeliveryToken?: string
  notifyClaimedUntil?: number | null
  terminalCommittedAt?: number | null
  notifyAAttemptedAt?: number | null
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
  /** Stage 1: WAL SQLite write-through. Absent = memory-only. */
  durable?: DelegateDurableDb | null
  /** Default true when durable is set. Tests may disable to inject rows first. */
  hydrate?: boolean
  /** Fired after a successful terminal persist so resume occupancy can release. */
  onTerminal?: (job: DelegateJobSnapshot) => void
  /** Fired after a queue-full / unclaimed row is deleted so projections can drop. */
  onDrop?: (job: DelegateJobSnapshot) => void
}

export function mintDelegateClaimToken(): string {
  return randomBytes(32).toString('hex')
}

const LEGAL_CALLBACK_TRANSITIONS = new Set<string>([
  'none->pending',
  'none->skipped_silent',
  'none->delivered',
  'pending->injecting',
  'pending->delivered',
  'pending->skipped_silent',
  'pending->abandoned',
  'injecting->delivered',
  'injecting->pending',
  'injecting->abandoned',
])

function isLegalCallbackTransition(from: DelegateCallbackState, to: DelegateCallbackState): boolean {
  return LEGAL_CALLBACK_TRANSITIONS.has(`${from}->${to}`)
}

/** Completer/Notifier owned ResumeInject callbacks. */
export function isResumeInjectCallback(callback: string | undefined): boolean {
  return callback === 'origin-inject' || callback === 'cron-origin-inject'
}

export function shouldAbandonPendingNotify(
  job: { notifyAttempt?: number | null; terminalCommittedAt?: number | null },
  now: number,
): boolean {
  const attempts = job.notifyAttempt ?? 0
  if (attempts < NOTIFY_ABANDON_MIN_ATTEMPTS) return false
  const terminalAt = job.terminalCommittedAt
  if (typeof terminalAt !== 'number' || terminalAt <= 0) return false
  return now - terminalAt >= NOTIFY_ABANDON_AFTER_TERMINAL_MS
}

function initTerminalCallback(draft: {
  callback: DelegateCallback
  callbackState: DelegateCallbackState
  callbackEpoch: number
}): void {
  if (isResumeInjectCallback(draft.callback)) {
    if (draft.callbackState === 'none') {
      draft.callbackState = 'pending'
      if (draft.callbackEpoch === 0) draft.callbackEpoch = 1
    }
    return
  }
  if (draft.callback === 'none' && draft.callbackState === 'none') {
    draft.callbackState = 'skipped_silent'
  }
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
  private readonly durable: DelegateDurableDb | null
  private readonly onTerminal?: (job: DelegateJobSnapshot) => void
  private readonly onDrop?: (job: DelegateJobSnapshot) => void
  /**
   * Phase F: stop new claimQueued/spawn. Queued rows stay queued.
   * Holders are generation-owned (`cutover:<n>`, `drain:<n>`) so one origin
   * cannot thaw another. Frozen iff the map is non-empty after expiry sweep.
   * Value is absolute expiry ms, or `null` for cutover/legacy (no TTL).
   */
  private readonly freezeHolders = new Map<string, number | null>()
  /**
   * In-process runner lifecycle keyed by jobId. Not durable: a hydrated row
   * has no attached writer until this process claims it. `runner_quiesced`
   * requires an ACK from the attached `(claimToken, fencingEpoch)`.
   */
  private readonly runners = new Map<
    string,
    { claimToken: string; fencingEpoch: number; phase: 'attached' | 'quiesce_acked' }
  >()

  constructor(opts: DelegateJobStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DELEGATE_JOB_TTL_MS
    this.maxJobs = opts.maxJobs ?? DEFAULT_MAX_DELEGATE_JOBS
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? defaultSleep
    this.sm = opts.sm === true
    this.bootId = opts.bootId ?? `gw:${randomBytes(8).toString('hex')}`
    this.leaseMs = opts.leaseMs ?? 45_000
    this.durable = opts.durable ?? null
    this.onTerminal = opts.onTerminal
    this.onDrop = opts.onDrop
    if (this.durable && opts.hydrate !== false) this.hydrateFromDurable()
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
  ): { jobId: string; reused?: boolean } | { error: 'capacity' } {
    this.sweep()
    const idempotencyKey =
      this.sm && typeof meta?.idempotencyKey === 'string' && meta.idempotencyKey.trim()
        ? meta.idempotencyKey.trim()
        : undefined
    if (idempotencyKey) {
      const existingId = this.byIdempotency.get(idempotencyKey)
      if (existingId && this.jobs.has(existingId)) return { jobId: existingId, reused: true }
    }
    const jobId = `dlgjob-${this.now().toString(36)}-${randomBytes(6).toString('hex')}`
    const createdAt = this.now()
    const queued = this.sm && meta?.queued === true
    const claimToken = meta?.claimToken ?? (queued ? undefined : mintDelegateClaimToken())
    const entry: JobEntry = {
      id: jobId,
      agentId,
      createdAt,
      lastActivityAt: createdAt,
      expiresAt: null,
      sessionKey: meta?.sessionKey,
      parentSessionKey: meta?.parentSessionKey,
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
      parentEngine: meta?.parentEngine,
      callbackOriginSessionKey: meta?.callbackOriginSessionKey,
      callbackOriginUserId: meta?.callbackOriginUserId,
      notifyRetryAt: null,
      notifyAttempt: 0,
      notifyDeliveryToken: undefined,
      notifyClaimedUntil: null,
      terminalCommittedAt: null,
    }
    if (this.durable) {
      const outcome = this.durable.insertCreate(this.toDurable(entry), this.maxJobs)
      if ('error' in outcome) return { error: 'capacity' }
      if ('reused' in outcome) {
        this.ingestDurableRow(outcome.reused)
        return { jobId: outcome.reused.id, reused: true }
      }
    } else if (this.nonTerminalCount() >= this.maxJobs) {
      return { error: 'capacity' }
    }
    this.jobs.set(jobId, entry)
    if (idempotencyKey) this.byIdempotency.set(idempotencyKey, jobId)
    if (!queued && entry.claimToken) {
      this.attachRunner(jobId, entry.claimToken, entry.fencingEpoch)
    }
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
    if (id) {
      const job = this.refreshJob(id)
      return job ? this.snapshot(job) : undefined
    }
    const durableHit = this.durable?.findByIdempotencyKey(key)
    if (!durableHit) return undefined
    return this.snapshot(this.ingestDurableRow(durableHit))
  }

  snapshotOf(jobId: string): DelegateJobSnapshot | undefined {
    const job = this.refreshJob(jobId)
    return job ? this.snapshot(job) : undefined
  }

  complete(
    jobId: string,
    result: DelegateJobHttpResult,
    fence?: { claimToken: string; fencingEpoch: number },
    opts?: { callbackState?: DelegateCallbackState },
  ): boolean {
    const job = this.refreshJob(jobId)
    if (!job || job.result) return false
    if (this.sm && job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
        if (fence) this.detachRunner(jobId, fence.claimToken, fence.fencingEpoch)
        return false
      }
    }
    const draft = this.cloneEntry(job)
    if (this.sm) {
      const next: DelegateJobState = result.httpStatus >= 200 && result.httpStatus < 300 ? 'completed' : 'failed'
      const gate = assertDelegateTransition(draft.state, next)
      if (!gate.ok && draft.state !== next) return false
      draft.state = next
      if (next === 'failed' && !draft.failureClass) {
        draft.failureClass = 'child_error'
        draft.failureDetail = String(result.body.error ?? 'delegate failed').slice(0, 512)
      }
      if (opts?.callbackState) {
        if (draft.callbackState !== opts.callbackState) {
          if (!isLegalCallbackTransition(draft.callbackState, opts.callbackState)) return false
          draft.callbackState = opts.callbackState
          if (draft.callbackEpoch === 0) draft.callbackEpoch = 1
        }
      } else {
        initTerminalCallback(draft)
      }
      draft.ownerLeaseUntil = null
      if (
        draft.state === 'completed' &&
        result.body &&
        result.body.ok === false
      ) {
        if (!draft.failureClass) draft.failureClass = 'child_error'
        const err = result.body.error
        if (typeof err === 'string' && err.trim() && !draft.failureDetail) {
          draft.failureDetail = err.slice(0, 512)
        }
      }
    }
    draft.result = result
    draft.expiresAt = this.now() + this.ttlMs
    draft.lastActivityAt = this.now()
    draft.terminalCommittedAt = draft.lastActivityAt
    return this.commit(job, draft, true)
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
    const job = this.refreshJob(jobId)
    if (!job || isDelegateTerminalState(job.state)) return false
    if (job.claimToken) {
      if (!args.claimToken || args.claimToken !== job.claimToken) {
        if (args.claimToken && args.fencingEpoch !== undefined) {
          this.detachRunner(jobId, args.claimToken, args.fencingEpoch)
        }
        return false
      }
      if (args.fencingEpoch === undefined || args.fencingEpoch !== job.fencingEpoch) {
        if (args.claimToken && args.fencingEpoch !== undefined) {
          this.detachRunner(jobId, args.claimToken, args.fencingEpoch)
        }
        return false
      }
    }
    const next = args.nextState ?? 'failed'
    const gate = assertDelegateTransition(job.state, next)
    if (!gate.ok) return false
    const draft = this.cloneEntry(job)
    draft.state = next
    draft.failureClass = args.failureClass
    draft.failureDetail = args.detail.slice(0, 512)
    if (isResumeInjectCallback(draft.callback)) {
      draft.callbackState = 'pending'
      draft.callbackEpoch = 1
    } else {
      draft.callbackState = 'skipped_silent'
    }
    draft.ownerLeaseUntil = null
    draft.result = {
      httpStatus: args.httpStatus,
      body: {
        error: args.detail,
        failure_class: args.failureClass,
        ...(args.body ?? {}),
      },
    }
    draft.expiresAt = this.now() + this.ttlMs
    draft.lastActivityAt = this.now()
    draft.terminalCommittedAt = draft.lastActivityAt
    return this.commit(job, draft, true)
  }

  freezeDispatch(holder: string, expiresAt?: number): void {
    const prev = this.freezeHolders.get(holder)
    this.freezeHolders.set(holder, expiresAt !== undefined ? expiresAt : (prev ?? null))
  }

  thawDispatch(holder: string): boolean {
    return this.freezeHolders.delete(holder)
  }

  setDispatchFrozen(frozen: boolean): void {
    if (frozen) this.freezeDispatch('legacy')
    else this.thawDispatch('legacy')
  }

  isDispatchFrozen(): boolean {
    this.purgeExpiredFreezeHolders()
    return this.freezeHolders.size > 0
  }

  /**
   * Runtime cutover/drain window. Feature flag OC_DELEGATE_CUTOVER being on
   * is not a window — only a live `cutover:<generation>` or `drain:<n>` freeze
   * holder disables InlinePush.
   */
  hasActiveCutoverWindow(): boolean {
    this.purgeExpiredFreezeHolders()
    for (const holder of this.freezeHolders.keys()) {
      if (holder.startsWith('cutover:') || holder.startsWith('drain:')) return true
    }
    return false
  }

  attachRunner(jobId: string, claimToken: string, fencingEpoch: number): void {
    this.runners.set(jobId, { claimToken, fencingEpoch, phase: 'attached' })
  }

  detachRunner(jobId: string, claimToken: string, fencingEpoch: number): void {
    const cur = this.runners.get(jobId)
    if (!cur) return
    if (cur.claimToken !== claimToken || cur.fencingEpoch !== fencingEpoch) return
    this.runners.delete(jobId)
  }

  /**
   * Runner stopped feeding turns and will not write terminal for this fence.
   * Only the currently attached fence can ACK; BeginCutover may then write
   * `runner_quiesced`.
   */
  ackRunnerQuiesced(jobId: string, claimToken: string, fencingEpoch: number): boolean {
    const cur = this.runners.get(jobId)
    if (!cur || cur.phase !== 'attached') return false
    if (cur.claimToken !== claimToken || cur.fencingEpoch !== fencingEpoch) return false
    cur.phase = 'quiesce_acked'
    return true
  }

  /**
   * True only when the currently attached `(claimToken, fencingEpoch)` has
   * ACK'd quiesce. Missing runner, fence mismatch, or no ACK is not a
   * positive idle proof — BeginCutover must then use `checkpoint=none`
   * rather than `runner_quiesced`.
   */
  isRunnerIdle(job: DelegateJobSnapshot): boolean {
    if (job.state !== 'running') return true
    const cur = this.runners.get(job.id)
    if (!cur) return false
    if (cur.claimToken !== job.claimToken || cur.fencingEpoch !== job.fencingEpoch) return false
    return cur.phase === 'quiesce_acked'
  }

  /** queued → running with a new claim_token (slot acquired). */
  claimQueued(
    jobId: string,
  ): { ok: true; claimToken: string; fencingEpoch: number } | { ok: false; reason?: 'cutover_frozen' } {
    this.purgeExpiredFreezeHolders()
    if (this.freezeHolders.size > 0) return { ok: false, reason: 'cutover_frozen' }
    const job = this.refreshJob(jobId)
    if (!job || job.state !== 'queued') return { ok: false }
    const gate = assertDelegateTransition('queued', 'running')
    if (!gate.ok) return { ok: false }
    const draft = this.cloneEntry(job)
    draft.state = 'running'
    draft.claimToken = mintDelegateClaimToken()
    draft.fencingEpoch += 1
    draft.attemptNo += 1
    draft.ownerInstanceId = this.bootId
    draft.ownerLeaseUntil = this.now() + this.leaseMs
    draft.checkpointKind = 'none'
    draft.lastActivityAt = this.now()
    if (!this.commit(job, draft, false)) return { ok: false }
    this.attachRunner(jobId, job.claimToken!, job.fencingEpoch)
    return { ok: true, claimToken: job.claimToken!, fencingEpoch: job.fencingEpoch }
  }

  casHeartbeat(jobId: string, claimToken: string, fencingEpoch: number): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    if (job.claimToken !== claimToken || job.fencingEpoch !== fencingEpoch) return false
    if (job.state !== 'running' && job.state !== 'paused_for_cutover') return false
    const draft = this.cloneEntry(job)
    draft.ownerLeaseUntil = this.now() + this.leaseMs
    draft.lastActivityAt = this.now()
    return this.commit(job, draft, false)
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
    const job = this.refreshJob(jobId)
    if (!job) return undefined
    if (!['queued', 'running', 'paused_for_cutover'].includes(job.state)) return undefined
    if (job.fencingEpoch !== expectedEpoch) return undefined
    if (nextState === 'queued' && job.state === 'queued') {
      // Keep queued unclaimed until a real runner/cron claims. Timeout uses
      // fail() without a fence; a minted token here would block that path.
      return this.snapshot(job)
    }
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
    const draft = this.cloneEntry(job)
    draft.ownerInstanceId = this.bootId
    draft.ownerLeaseUntil = now + this.leaseMs
    draft.claimToken = mintDelegateClaimToken()
    draft.attemptNo += 1
    draft.fencingEpoch += 1
    draft.state = nextState
    draft.lastActivityAt = now
    if (nextState !== 'paused_for_cutover') draft.checkpointKind = 'none'
    const terminal = isDelegateTerminalState(nextState)
    if (terminal) {
      draft.ownerLeaseUntil = null
      draft.failureClass = draft.failureClass ?? (nextState === 'killed_by_cutover' ? 'cutover' : draft.failureClass)
      draft.failureDetail = draft.failureDetail ?? 'adopt-or-kill'
      draft.result = {
        httpStatus: 409,
        body: { error: draft.failureDetail, failure_class: draft.failureClass },
      }
      draft.expiresAt = now + this.ttlMs
      draft.terminalCommittedAt = now
      initTerminalCallback(draft)
    }
    if (!this.commit(job, draft, terminal)) return undefined
    return this.snapshot(job)
  }

  decideAdoptNextState(
    job: DelegateJobSnapshot,
    opts?: { resumeQuiesced?: boolean },
  ): DelegateJobState {
    if (job.state === 'queued') return 'queued'
    if (job.state === 'paused_for_cutover') {
      if (opts?.resumeQuiesced === true && job.checkpointKind === 'runner_quiesced') {
        return 'paused_for_cutover'
      }
      return 'killed_by_cutover'
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

  /**
   * Phase F CAS: running → paused_for_cutover, rotate claim_token/fencing_epoch.
   * `runner_quiesced` only when the caller proved the runner stopped feeding turns.
   * Timeout path uses checkpoint `none` and still does not fail/kill the row.
   */
  pauseForCutover(
    jobId: string,
    args: {
      claimToken: string
      fencingEpoch: number
      generation: number
      checkpointKind: DelegateCheckpointKind
    },
  ): DelegateJobSnapshot | undefined {
    const job = this.refreshJob(jobId)
    if (!job || job.state !== 'running') return undefined
    if (job.claimToken !== args.claimToken || job.fencingEpoch !== args.fencingEpoch) return undefined
    const gate = assertDelegateTransition('running', 'paused_for_cutover')
    if (!gate.ok) return undefined
    const now = this.now()
    const draft = this.cloneEntry(job)
    draft.state = 'paused_for_cutover'
    draft.checkpointKind = args.checkpointKind
    draft.generation = args.generation
    draft.claimToken = mintDelegateClaimToken()
    draft.fencingEpoch += 1
    draft.ownerInstanceId = this.bootId
    draft.ownerLeaseUntil = now + this.leaseMs
    draft.lastActivityAt = now
    if (!this.commit(job, draft, false)) return undefined
    this.runners.delete(jobId)
    return this.snapshot(job)
  }

  /**
   * Same-process cancel/flag-off closeout. Owner does not need to be stale:
   * we are the process that paused the row. Writes killed_by_cutover + pending
   * in one commit so the row cannot occupy capacity or resume registry.
   */
  killOwnedPaused(jobId: string): DelegateJobSnapshot | undefined {
    const job = this.refreshJob(jobId)
    if (!job || job.state !== 'paused_for_cutover') return undefined
    if (job.ownerInstanceId && job.ownerInstanceId !== this.bootId) return undefined
    const gate = assertDelegateTransition('paused_for_cutover', 'killed_by_cutover')
    if (!gate.ok) return undefined
    const now = this.now()
    const draft = this.cloneEntry(job)
    draft.state = 'killed_by_cutover'
    draft.failureClass = draft.failureClass ?? 'cutover'
    draft.failureDetail = draft.failureDetail ?? 'cutover-cancelled'
    draft.ownerLeaseUntil = null
    draft.result = {
      httpStatus: 409,
      body: { error: draft.failureDetail, failure_class: draft.failureClass },
    }
    draft.expiresAt = now + this.ttlMs
    draft.terminalCommittedAt = now
    draft.lastActivityAt = now
    initTerminalCallback(draft)
    if (!this.commit(job, draft, true)) return undefined
    this.runners.delete(jobId)
    return this.snapshot(job)
  }

  /**
   * Phase M ClaimPaused: paused_for_cutover + runner_quiesced → running.
   * Does not spawn an engine; the caller may attach a resume hook.
   */
  claimPaused(
    jobId: string,
  ): { ok: true; claimToken: string; fencingEpoch: number } | { ok: false } {
    const job = this.refreshJob(jobId)
    if (!job || job.state !== 'paused_for_cutover') return { ok: false }
    if (job.checkpointKind !== 'runner_quiesced') return { ok: false }
    const gate = assertDelegateTransition('paused_for_cutover', 'running')
    if (!gate.ok) return { ok: false }
    const now = this.now()
    const draft = this.cloneEntry(job)
    draft.state = 'running'
    draft.checkpointKind = 'none'
    draft.claimToken = mintDelegateClaimToken()
    draft.fencingEpoch += 1
    draft.attemptNo += 1
    draft.ownerInstanceId = this.bootId
    draft.ownerLeaseUntil = now + this.leaseMs
    draft.lastActivityAt = now
    if (!this.commit(job, draft, false)) return { ok: false }
    this.attachRunner(jobId, job.claimToken!, job.fencingEpoch)
    return { ok: true, claimToken: job.claimToken!, fencingEpoch: job.fencingEpoch }
  }

  listRunning(): DelegateJobSnapshot[] {
    return this.listNonTerminal().filter((job) => job.state === 'running')
  }

  countRunning(): number {
    return this.listRunning().length
  }

  listNonTerminal(): DelegateJobSnapshot[] {
    if (this.durable) {
      for (const row of this.durable.loadNonTerminal()) this.ingestDurableRow(row)
    }
    const out: DelegateJobSnapshot[] = []
    for (const job of this.jobs.values()) {
      if (!isDelegateTerminalState(job.state)) out.push(this.snapshot(job))
    }
    return out
  }

  get(jobId: string): DelegateJobWaitView {
    this.sweep()
    const job = this.refreshJob(jobId)
    if (!job) {
      return this.sm
        ? { status: 'expired', jobId, failure_class: 'unknown_job' }
        : { status: 'expired', jobId }
    }
    return this.viewOf(job)
  }

  async wait(jobId: string, waitMs: number): Promise<DelegateJobWaitView> {
    this.sweep()
    const job = this.refreshJob(jobId)
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
      result: job.result,
      expiresAt: job.expiresAt,
      createdAt: job.createdAt,
      lastActivityAt: job.lastActivityAt,
      parentSessionKey: job.parentSessionKey,
      parentEngine: job.parentEngine,
      notifyLane: job.notifyLane,
      notifyId: job.notifyId,
      callbackOriginSessionKey: job.callbackOriginSessionKey,
      callbackOriginUserId: job.callbackOriginUserId,
      notifyRetryAt: job.notifyRetryAt,
      notifyAttempt: job.notifyAttempt,
      notifyDeliveryToken: job.notifyDeliveryToken,
      notifyClaimedUntil: job.notifyClaimedUntil,
      terminalCommittedAt: job.terminalCommittedAt ?? undefined,
      notifyAAttemptedAt: job.notifyAAttemptedAt ?? undefined,
    }
  }

  /**
   * Baseline (`5ea1f77d7`) JSON DTO. Durable-only fields stay off this object
   * so OC_DELEGATE_DURABLE=0 snapshots remain byte-equivalent.
   */
  private snapshotForJsonPersist(job: JobEntry): DelegateJobSnapshot {
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
      if (job.callbackState === 'pending' || job.callbackState === 'injecting') continue
      if (!this.persistDelete(job)) continue
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

  nonTerminalCount(): number {
    if (this.durable) return this.durable.countNonTerminal()
    let n = 0
    for (const job of this.jobs.values()) {
      if (!isDelegateTerminalState(job.state)) n++
    }
    return n
  }

  /**
   * Undo a provisional Enqueue that lost the waiter race (queue_full).
   * Only unclaimed queued rows; never a running owner.
   */
  dropIfUnclaimed(jobId: string): boolean {
    const job = this.refreshJob(jobId)
    if (!job || job.state !== 'queued' || job.result || job.claimToken) return false
    const snap = this.snapshot(job)
    if (!this.persistDelete(job)) return false
    const waiters = job.waiters.splice(0)
    for (const w of waiters) w({ status: 'expired', jobId, ...(this.sm ? { failure_class: 'capacity_queue_full' as const } : {}) })
    if (job.idempotencyKey) this.byIdempotency.delete(job.idempotencyKey)
    this.jobs.delete(jobId)
    try {
      this.onDrop?.(snap)
    } catch {
      /* projection must not revert an authoritative drop */
    }
    return true
  }

  /**
   * Capacity-reject an unclaimed queued job. Mutually exclusive with
   * {@link claimQueued}: a claimed running owner is left untouched so the
   * caller can choose "already dispatched" over reporting failure.
   *
   * `drop: true` (queue_full) deletes the row. Timeout/abort mark explicit
   * `failed` so Wait surfaces `failure_class` and a later claim cannot execute.
   */
  settleCapacityReject(
    jobId: string,
    args: {
      failureClass: DelegateFailureClass
      detail: string
      httpStatus: number
      drop: boolean
      nextState?: Extract<DelegateJobState, 'failed' | 'killed_by_cutover' | 'cancelled'>
    },
  ): 'dropped' | 'failed' | 'claimed' | 'missing' {
    const job = this.refreshJob(jobId)
    if (!job) return 'missing'
    if (isDelegateTerminalState(job.state) || job.result) return 'missing'
    if (job.state !== 'queued' || job.claimToken) return 'claimed'
    if (args.drop) return this.dropIfUnclaimed(jobId) ? 'dropped' : 'claimed'
    return this.fail(jobId, {
      failureClass: args.failureClass,
      detail: args.detail,
      httpStatus: args.httpStatus,
      nextState: args.nextState,
    })
      ? 'failed'
      : 'claimed'
  }

  snapshotsForPersist(): DelegateJobSnapshot[] {
    const out: DelegateJobSnapshot[] = []
    for (const job of this.jobs.values()) {
      if (!isDelegateTerminalState(job.state) || job.callbackState === 'pending' || job.callbackState === 'injecting') {
        out.push(this.snapshotForJsonPersist(job))
      }
    }
    return out
  }

  patchCallbackState(
    jobId: string,
    next: DelegateCallbackState,
    fence?: { claimToken: string; fencingEpoch: number },
  ): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    if (job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) return false
    }
    if (job.callbackState === next) return true
    if (!isLegalCallbackTransition(job.callbackState, next)) return false
    const draft = this.cloneEntry(job)
    draft.callbackState = next
    draft.lastActivityAt = this.now()
    return this.commit(job, draft, false)
  }

  /**
   * Persist notify_lane / notify_id / parent_engine. Never changes job
   * state — notify is a side channel. Fence CAS still applies when the
   * row has a claim token.
   */
  patchNotifyIntent(
    jobId: string,
    patch: { parentEngine?: string; notifyLane?: string; notifyId?: string },
    fence?: { claimToken: string; fencingEpoch: number },
  ): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    if (job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
        return false
      }
    }
    if (
      (patch.parentEngine === undefined || job.parentEngine === patch.parentEngine) &&
      (patch.notifyLane === undefined || job.notifyLane === patch.notifyLane) &&
      (patch.notifyId === undefined || job.notifyId === patch.notifyId)
    ) {
      return true
    }
    const draft = this.cloneEntry(job)
    if (patch.parentEngine !== undefined) draft.parentEngine = patch.parentEngine
    if (patch.notifyLane !== undefined) draft.notifyLane = patch.notifyLane
    if (patch.notifyId !== undefined) draft.notifyId = patch.notifyId
    draft.lastActivityAt = this.now()
    return this.commit(job, draft, false)
  }

  /** Terminal jobs whose Completer callback is still pending/injecting. */
  listPendingNotify(): DelegateJobSnapshot[] {
    const out: DelegateJobSnapshot[] = []
    if (this.durable) {
      for (const row of this.durable.loadAll()) this.ingestDurableRow(row)
    }
    for (const job of this.jobs.values()) {
      if (!isDelegateTerminalState(job.state)) continue
      if (job.callbackState === 'pending' || job.callbackState === 'injecting') {
        out.push(this.snapshot(job))
      }
    }
    return out
  }

  listDueNotify(now = this.now()): DelegateJobSnapshot[] {
    return this.listPendingNotify().filter((job) => this.isNotifyDue(job, now))
  }

  private isNotifyDue(job: DelegateJobSnapshot, now: number): boolean {
    if (job.callbackState === 'injecting') {
      return job.notifyClaimedUntil == null || job.notifyClaimedUntil <= now
    }
    return job.notifyRetryAt == null || job.notifyRetryAt <= now
  }

  claimNotifyDelivery(
    jobId: string,
    fence?: { claimToken: string; fencingEpoch: number },
  ): { ok: true; token: string; snapshot: DelegateJobSnapshot } | { ok: false } {
    const job = this.refreshJob(jobId)
    if (!job) return { ok: false }
    if (job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
        return { ok: false }
      }
    }
    if (!isDelegateTerminalState(job.state)) return { ok: false }
    if (!isResumeInjectCallback(job.callback)) return { ok: false }
    const now = this.now()
    const staleInjecting =
      job.callbackState === 'injecting' &&
      (job.notifyClaimedUntil == null || job.notifyClaimedUntil <= now)
    if (job.callbackState !== 'pending' && !staleInjecting) return { ok: false }
    const token = mintDelegateClaimToken()
    const claimedUntil = now + NOTIFY_CLAIM_LEASE_MS
    if (this.durable) {
      const row = this.durable.casClaimNotify({
        jobId,
        state: job.state,
        fencingEpoch: job.fencingEpoch,
        claimToken: job.claimToken ?? null,
        deliveryToken: token,
        now,
        claimedUntil,
      })
      if (!row) {
        this.refreshJob(jobId)
        return { ok: false }
      }
      const next = this.ingestDurableRow(row)
      return { ok: true, token, snapshot: this.snapshot(next) }
    }
    job.callbackState = 'injecting'
    job.notifyDeliveryToken = token
    job.notifyClaimedUntil = claimedUntil
    job.lastActivityAt = now
    return { ok: true, token, snapshot: this.snapshot(job) }
  }

  completeNotifyDelivery(
    jobId: string,
    deliveryToken: string,
    fence?: { claimToken: string; fencingEpoch: number },
  ): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    if (job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
        return false
      }
    }
    if (job.callbackState === 'delivered') return true
    if (job.callbackState !== 'injecting' || job.notifyDeliveryToken !== deliveryToken) return false
    const now = this.now()
    if (this.durable) {
      const row = this.durable.casCompleteNotify({
        jobId,
        state: job.state,
        fencingEpoch: job.fencingEpoch,
        claimToken: job.claimToken ?? null,
        deliveryToken,
        now,
      })
      if (!row) {
        this.refreshJob(jobId)
        return false
      }
      this.ingestDurableRow(row)
      return true
    }
    job.callbackState = 'delivered'
    job.notifyDeliveryToken = undefined
    job.notifyClaimedUntil = null
    job.notifyRetryAt = null
    job.lastActivityAt = now
    return true
  }

  /**
   * Slow-A fence: the claimed delivery token is still the exclusive owner.
   * Reads durable so a second store on the same SQLite can invalidate the
   * first writer after reclaim. Delivered or expired claims are not live.
   */
  isNotifyClaimLive(jobId: string, deliveryToken: string): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    if (job.callbackState === 'delivered' || job.callbackState === 'abandoned') return false
    if (job.callbackState !== 'injecting') return false
    if (job.notifyDeliveryToken !== deliveryToken) return false
    const now = this.now()
    if (job.notifyClaimedUntil != null && job.notifyClaimedUntil <= now) return false
    return true
  }

  hasNotifyAAttempted(jobId: string): boolean {
    const job = this.refreshJob(jobId)
    return job != null && job.notifyAAttemptedAt != null && job.notifyAAttemptedAt > 0
  }

  /**
   * Durable a_attempted stamp. Must run before the external A write so a
   * crash/reclaim can skip a second stdin push and consult parent tape.
   */
  markNotifyAAttempted(
    jobId: string,
    deliveryToken: string,
    fence?: { claimToken: string; fencingEpoch: number },
  ): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    if (job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
        return false
      }
    }
    if (job.callbackState !== 'injecting' || job.notifyDeliveryToken !== deliveryToken) return false
    if (job.notifyAAttemptedAt != null && job.notifyAAttemptedAt > 0) return true
    const now = this.now()
    if (this.durable) {
      const row = this.durable.casMarkAAttempted({
        jobId,
        state: job.state,
        fencingEpoch: job.fencingEpoch,
        claimToken: job.claimToken ?? null,
        deliveryToken,
        now,
      })
      if (!row) {
        this.refreshJob(jobId)
        return this.hasNotifyAAttempted(jobId)
      }
      this.ingestDurableRow(row)
      return true
    }
    job.notifyAAttemptedAt = now
    job.lastActivityAt = now
    return true
  }

  releaseNotifyClaim(
    jobId: string,
    deliveryToken: string,
    fence?: { claimToken: string; fencingEpoch: number },
  ): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    if (job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
        return false
      }
    }
    if (job.callbackState !== 'injecting' || job.notifyDeliveryToken !== deliveryToken) return false
    const now = this.now()
    const nextAttempt = (job.notifyAttempt ?? 0) + 1
    const retryAt = now + nextNotifyBackoffMs(job.notifyAttempt ?? 0)
    if (this.durable) {
      const row = this.durable.casReleaseNotify({
        jobId,
        state: job.state,
        fencingEpoch: job.fencingEpoch,
        claimToken: job.claimToken ?? null,
        deliveryToken,
        now,
        retryAt,
        notifyAttempt: nextAttempt,
      })
      if (!row) {
        this.refreshJob(jobId)
        return false
      }
      this.ingestDurableRow(row)
      return true
    }
    job.callbackState = 'pending'
    job.notifyDeliveryToken = undefined
    job.notifyClaimedUntil = null
    job.notifyRetryAt = retryAt
    job.notifyAttempt = nextAttempt
    job.lastActivityAt = now
    return true
  }

  shouldAbandonNotify(jobId: string): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    return shouldAbandonPendingNotify(job, this.now())
  }

  /**
   * Terminal notify budget exhausted. Clears the claim/retry so the
   * scheduler never picks the row again. pending|injecting → abandoned.
   */
  abandonNotify(
    jobId: string,
    fence?: { claimToken: string; fencingEpoch: number },
  ): boolean {
    const job = this.refreshJob(jobId)
    if (!job) return false
    if (job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
        return false
      }
    }
    if (job.callbackState === 'abandoned') return true
    if (!isLegalCallbackTransition(job.callbackState, 'abandoned')) return false
    const draft = this.cloneEntry(job)
    draft.callbackState = 'abandoned'
    draft.notifyDeliveryToken = undefined
    draft.notifyClaimedUntil = null
    draft.notifyRetryAt = null
    draft.lastActivityAt = this.now()
    return this.commit(job, draft, false)
  }

  deferPendingNotify(
    jobId: string,
    fence?: { claimToken: string; fencingEpoch: number },
  ): boolean {
    const job = this.refreshJob(jobId)
    if (!job || job.callbackState !== 'pending') return false
    if (job.claimToken) {
      if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
        return false
      }
    }
    const draft = this.cloneEntry(job)
    draft.notifyRetryAt = this.now() + nextNotifyBackoffMs(job.notifyAttempt ?? 0)
    draft.notifyAttempt = (job.notifyAttempt ?? 0) + 1
    draft.lastActivityAt = this.now()
    return this.commit(job, draft, false)
  }

  restoreSnapshot(snap: DelegateJobSnapshot, agentId = 'restored'): void {
    if (this.jobs.has(snap.id)) return
    const createdAt = snap.createdAt ?? this.now()
    const reconstructed = isDelegateTerminalState(snap.state)
      ? {
          httpStatus: snap.state === 'completed' ? 200 : 409,
          body: { failure_class: snap.failureClass, error: snap.failureDetail },
        }
      : null
    this.jobs.set(snap.id, {
      id: snap.id,
      agentId,
      createdAt,
      lastActivityAt: snap.lastActivityAt ?? createdAt,
      expiresAt: snap.expiresAt ?? null,
      sessionKey: snap.sessionKey,
      parentSessionKey: snap.parentSessionKey,
      result: snap.result ?? reconstructed,
      waiters: [],
      state: snap.state,
      failureClass: snap.failureClass,
      failureDetail: snap.failureDetail,
      generation: snap.generation,
      ownerInstanceId: snap.ownerInstanceId,
      ownerLeaseUntil: snap.ownerLeaseUntil ?? null,
      claimToken: snap.claimToken,
      attemptNo: snap.attemptNo,
      fencingEpoch: snap.fencingEpoch,
      checkpointKind: snap.checkpointKind,
      callback: snap.callback,
      callbackState: snap.callbackState,
      callbackEpoch: snap.callbackEpoch,
      idempotencyKey: snap.idempotencyKey,
      kind: snap.kind,
      parentEngine: snap.parentEngine,
      notifyLane: snap.notifyLane,
      notifyId: snap.notifyId,
      callbackOriginSessionKey: snap.callbackOriginSessionKey,
      callbackOriginUserId: snap.callbackOriginUserId,
      notifyRetryAt: snap.notifyRetryAt ?? null,
      notifyAttempt: snap.notifyAttempt ?? 0,
      notifyDeliveryToken: snap.notifyDeliveryToken,
      notifyClaimedUntil: snap.notifyClaimedUntil ?? null,
      terminalCommittedAt: snap.terminalCommittedAt ?? null,
      notifyAAttemptedAt: snap.notifyAAttemptedAt ?? null,
    })
    if (snap.idempotencyKey) this.byIdempotency.set(snap.idempotencyKey, snap.id)
  }

  /** Test hook: next durable upsert/delete throws, memory must stay unchanged. */
  injectDurableWriteFailure(): void {
    if (this.durable) this.durable.failNextWrite = true
  }

  hydrateFromDurable(): number {
    if (!this.durable) return 0
    let n = 0
    for (const row of this.durable.loadAll()) {
      if (this.jobs.has(row.id)) continue
      this.ingestDurableRow(row)
      n += 1
    }
    return n
  }

  snapshotFromDurable(row: DurableJobRecord): DelegateJobSnapshot {
    return {
      id: row.id,
      agentId: row.agentId,
      state: row.state,
      sessionKey: row.sessionKey,
      parentSessionKey: row.parentSessionKey,
      failureClass: row.failureClass,
      failureDetail: row.failureDetail,
      claimToken: row.claimToken,
      fencingEpoch: row.fencingEpoch,
      attemptNo: row.attemptNo,
      ownerInstanceId: row.ownerInstanceId,
      ownerLeaseUntil: row.ownerLeaseUntil ?? undefined,
      checkpointKind: row.checkpointKind,
      callback: row.callback,
      callbackState: row.callbackState,
      callbackEpoch: row.callbackEpoch,
      idempotencyKey: row.idempotencyKey,
      kind: row.kind,
      generation: row.generation,
      result: row.result ?? null,
      expiresAt: row.expiresAt ?? null,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      parentEngine: row.parentEngine,
      notifyLane: row.notifyLane,
      notifyId: row.notifyId,
      callbackOriginSessionKey: row.callbackOriginSessionKey,
      callbackOriginUserId: row.callbackOriginUserId,
      notifyRetryAt: row.notifyRetryAt,
      notifyAttempt: row.notifyAttempt ?? 0,
      notifyDeliveryToken: row.notifyDeliveryToken,
      notifyClaimedUntil: row.notifyClaimedUntil,
      terminalCommittedAt: row.terminalCommittedAt,
      notifyAAttemptedAt: row.notifyAAttemptedAt ?? undefined,
    }
  }

  private purgeExpiredFreezeHolders(): void {
    const now = this.now()
    for (const [holder, expiresAt] of this.freezeHolders) {
      if (expiresAt !== null && expiresAt <= now) this.freezeHolders.delete(holder)
    }
  }

  close(): void {
    for (const job of this.jobs.values()) {
      const waiters = job.waiters.splice(0)
      for (const w of waiters) w({ status: 'expired', jobId: job.id })
    }
    this.jobs.clear()
    this.byIdempotency.clear()
    this.freezeHolders.clear()
    this.runners.clear()
    // Durable rows stay on disk. Closing the handle is the caller's job so
    // tests can reopen the same file; production shutdown closes it below.
    this.durable?.close()
  }

  private cloneEntry(job: JobEntry): JobEntry {
    return {
      ...job,
      result: job.result ? { httpStatus: job.result.httpStatus, body: { ...job.result.body } } : null,
      waiters: [],
    }
  }

  private commit(live: JobEntry, draft: JobEntry, wake: boolean): boolean {
    const becomingTerminal =
      isDelegateTerminalState(draft.state) && !isDelegateTerminalState(live.state)
    if (!this.persistUpdate(live, draft)) {
      this.refreshJob(live.id)
      return false
    }
    const waiters = live.waiters
    Object.assign(live, draft)
    live.waiters = waiters
    if (wake) {
      const pending = waiters.splice(0)
      for (const w of pending) w(this.viewOf(live))
    }
    if (becomingTerminal) {
      this.runners.delete(live.id)
      this.onTerminal?.(this.snapshot(live))
    }
    return true
  }

  private persistUpdate(live: JobEntry, draft: JobEntry): boolean {
    if (!this.durable) return true
    return Boolean(
      this.durable.casUpdate(
        {
          jobId: live.id,
          state: live.state,
          fencingEpoch: live.fencingEpoch,
          claimToken: live.claimToken ?? null,
        },
        this.toDurable(draft),
      ),
    )
  }

  private persistDelete(job: JobEntry): boolean {
    if (!this.durable) return true
    return this.durable.casDelete({
      jobId: job.id,
      state: job.state,
      fencingEpoch: job.fencingEpoch,
      claimToken: job.claimToken ?? null,
    })
  }

  private refreshJob(jobId: string): JobEntry | undefined {
    if (this.durable) {
      const row = this.durable.get(jobId)
      if (row) return this.ingestDurableRow(row)
    }
    return this.jobs.get(jobId)
  }

  private ingestDurableRow(row: DurableJobRecord): JobEntry {
    const existing = this.jobs.get(row.id)
    const incoming = this.entryFromDurable(row)
    if (!existing) {
      this.jobs.set(row.id, incoming)
      if (row.idempotencyKey) this.byIdempotency.set(row.idempotencyKey, row.id)
      return incoming
    }
    const waiters = existing.waiters
    const hadResult = existing.result
    Object.assign(existing, incoming)
    existing.waiters = waiters
    if (!hadResult && existing.result) {
      const pending = waiters.splice(0)
      for (const w of pending) w(this.viewOf(existing))
    }
    if (row.idempotencyKey) this.byIdempotency.set(row.idempotencyKey, row.id)
    return existing
  }

  private entryFromDurable(row: DurableJobRecord): JobEntry {
    const snap = this.snapshotFromDurable(row)
    const reconstructed = isDelegateTerminalState(snap.state)
      ? {
          httpStatus: snap.state === 'completed' ? 200 : 409,
          body: { failure_class: snap.failureClass, error: snap.failureDetail },
        }
      : null
    return {
      id: snap.id,
      agentId: row.agentId,
      createdAt: snap.createdAt ?? this.now(),
      lastActivityAt: snap.lastActivityAt ?? snap.createdAt ?? this.now(),
      expiresAt: snap.expiresAt ?? null,
      sessionKey: snap.sessionKey,
      parentSessionKey: snap.parentSessionKey,
      result: snap.result ?? reconstructed,
      waiters: [],
      state: snap.state,
      failureClass: snap.failureClass,
      failureDetail: snap.failureDetail,
      generation: snap.generation,
      ownerInstanceId: snap.ownerInstanceId,
      ownerLeaseUntil: snap.ownerLeaseUntil ?? null,
      claimToken: snap.claimToken,
      attemptNo: snap.attemptNo,
      fencingEpoch: snap.fencingEpoch,
      checkpointKind: snap.checkpointKind,
      callback: snap.callback,
      callbackState: snap.callbackState,
      callbackEpoch: snap.callbackEpoch,
      idempotencyKey: snap.idempotencyKey,
      kind: snap.kind,
      parentEngine: snap.parentEngine,
      notifyLane: snap.notifyLane,
      notifyId: snap.notifyId,
      callbackOriginSessionKey: snap.callbackOriginSessionKey,
      callbackOriginUserId: snap.callbackOriginUserId,
      notifyRetryAt: snap.notifyRetryAt ?? null,
      notifyAttempt: snap.notifyAttempt ?? 0,
      notifyDeliveryToken: snap.notifyDeliveryToken,
      notifyClaimedUntil: snap.notifyClaimedUntil ?? null,
      terminalCommittedAt: snap.terminalCommittedAt ?? null,
      notifyAAttemptedAt: snap.notifyAAttemptedAt ?? null,
    }
  }

  private toDurable(job: JobEntry): DurableJobRecord {
    const ts = this.now()
    return {
      id: job.id,
      agentId: job.agentId,
      state: job.state,
      kind: job.kind,
      sessionKey: job.sessionKey,
      parentSessionKey: job.parentSessionKey,
      generation: job.generation,
      ownerInstanceId: job.ownerInstanceId,
      ownerLeaseUntil: job.ownerLeaseUntil,
      claimToken: job.claimToken,
      attemptNo: job.attemptNo,
      fencingEpoch: job.fencingEpoch,
      checkpointKind: job.checkpointKind,
      callback: job.callback,
      callbackState: job.callbackState,
      callbackEpoch: job.callbackEpoch,
      idempotencyKey: job.idempotencyKey,
      failureClass: job.failureClass,
      failureDetail: job.failureDetail,
      result: job.result,
      createdAt: job.createdAt,
      updatedAt: ts,
      lastActivityAt: job.lastActivityAt,
      expiresAt: job.expiresAt,
      parentEngine: job.parentEngine,
      notifyLane: job.notifyLane,
      notifyId: job.notifyId,
      callbackOriginSessionKey: job.callbackOriginSessionKey,
      callbackOriginUserId: job.callbackOriginUserId,
      notifyRetryAt: job.notifyRetryAt ?? null,
      notifyAttempt: job.notifyAttempt ?? 0,
      notifyDeliveryToken: job.notifyDeliveryToken,
      notifyClaimedUntil: job.notifyClaimedUntil ?? null,
      terminalCommittedAt: job.terminalCommittedAt ?? undefined,
      notifyAAttemptedAt: job.notifyAAttemptedAt ?? null,
    }
  }
}
