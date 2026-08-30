/**
 * OCV5-22 B3: cron fire Enqueue-then-project. Unique idempotency key is the
 * occurrence execution right; retries return the original dlgjob id.
 */
import { cronDelegateIdempotencyKey, isDelegateTerminalState, type DelegateJobState } from '@openclaude/protocol'
import type { DelegateJobStore } from './delegateJobs.js'

export function enqueueCronOccurrenceJob(
  store: DelegateJobStore,
  args: {
    cronJobId: string
    dueMinuteKey: number
    agentId: string
    sessionKey?: string
    parentSessionKey?: string
    callbackOriginSessionKey?: string
    callbackOriginUserId?: string
    parentEngine?: string
  },
): { jobId: string; reused: boolean } | { error: 'capacity' } {
  const idempotencyKey = cronDelegateIdempotencyKey(args.cronJobId, args.dueMinuteKey)
  const existing = store.findByIdempotencyKey(idempotencyKey)
  if (existing) return { jobId: existing.id, reused: true }
  const created = store.create(args.agentId, {
    sessionKey: args.sessionKey,
    parentSessionKey: args.parentSessionKey,
    callbackOriginSessionKey: args.callbackOriginSessionKey,
    callbackOriginUserId: args.callbackOriginUserId,
    parentEngine: args.parentEngine,
    queued: true,
    kind: 'cron',
    callback: 'cron-origin-inject',
    idempotencyKey,
  })
  if ('error' in created) return created
  return { jobId: created.jobId, reused: false }
}

export type CronDelegateFence = { claimToken: string; fencingEpoch: number }

export class CronDelegateClaimDeniedError extends Error {
  readonly code = 'DELEGATE_CLAIM_DENIED'
  constructor(
    readonly reason: 'terminal' | 'not_claimable',
    readonly state?: DelegateJobState,
  ) {
    super(`cron delegate claim denied: ${reason}${state ? ` (${state})` : ''}`)
    this.name = 'CronDelegateClaimDeniedError'
  }
}

export function isCronDelegateClaimDenied(err: unknown): err is CronDelegateClaimDeniedError {
  return (
    err instanceof CronDelegateClaimDeniedError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'DELEGATE_CLAIM_DENIED')
  )
}

/**
 * Durable job row is the execution right. A failed claim must not fall back to
 * an occurrence-captured fence or continue without a fence.
 */
export function claimCronDelegateExecution(
  store: DelegateJobStore,
  jobId: string,
): CronDelegateFence {
  const claimed = store.claimQueued(jobId)
  if (claimed.ok) return { claimToken: claimed.claimToken, fencingEpoch: claimed.fencingEpoch }
  const snap = store.snapshotOf(jobId)
  if (!snap || isDelegateTerminalState(snap.state)) {
    throw new CronDelegateClaimDeniedError('terminal', snap?.state)
  }
  throw new CronDelegateClaimDeniedError('not_claimable', snap.state)
}

/**
 * Terminal-write a cron occurrence job using the fence captured at claim time.
 * Missing or mismatched tokens return false. Never reads the live snapshot token.
 * HEARTBEAT_OK `skipped_silent` is the same SQLite CAS as `completed`.
 */
export function settleCronDelegateJob(
  store: DelegateJobStore,
  jobId: string,
  outcome: 'completed' | 'failed' | 'skipped_silent',
  fence: CronDelegateFence | undefined,
  detail?: string,
  extraBody?: Record<string, unknown>,
): boolean {
  if (!fence?.claimToken || !Number.isFinite(fence.fencingEpoch)) return false
  if (outcome === 'failed') {
    return store.fail(jobId, {
      failureClass: 'child_error',
      detail: detail ?? 'cron failed',
      httpStatus: 500,
      body: extraBody,
      claimToken: fence.claimToken,
      fencingEpoch: fence.fencingEpoch,
    })
  }
  return store.complete(
    jobId,
    {
      httpStatus: 200,
      body: {
        ok: true,
        failure_class: outcome === 'skipped_silent' ? 'cancelled' : undefined,
        ...(extraBody ?? {}),
      },
    },
    fence,
    outcome === 'skipped_silent' ? { callbackState: 'skipped_silent' } : undefined,
  )
}
