/**
 * OCV5-22 B3: cron fire Enqueue-then-project. Unique idempotency key is the
 * occurrence execution right; retries return the original dlgjob id.
 */
import { cronDelegateIdempotencyKey } from '../../protocol/src/delegation.js'
import type { DelegateJobStore } from './delegateJobs.js'

export function enqueueCronOccurrenceJob(
  store: DelegateJobStore,
  args: { cronJobId: string; dueMinuteKey: number; agentId: string; sessionKey?: string },
): { jobId: string; reused: boolean } | { error: 'capacity' } {
  const idempotencyKey = cronDelegateIdempotencyKey(args.cronJobId, args.dueMinuteKey)
  const existing = store.findByIdempotencyKey(idempotencyKey)
  if (existing) return { jobId: existing.id, reused: true }
  const created = store.create(args.agentId, {
    sessionKey: args.sessionKey,
    queued: true,
    kind: 'cron',
    callback: 'cron-origin-inject',
    idempotencyKey,
  })
  if ('error' in created) return created
  return { jobId: created.jobId, reused: false }
}

export type CronDelegateFence = { claimToken: string; fencingEpoch: number }

/**
 * Terminal-write a cron occurrence job using the fence captured at claim time.
 * Missing or mismatched tokens return false. Never reads the live snapshot token.
 */
export function settleCronDelegateJob(
  store: DelegateJobStore,
  jobId: string,
  outcome: 'completed' | 'failed' | 'skipped_silent',
  fence: CronDelegateFence | undefined,
  detail?: string,
): boolean {
  if (!fence?.claimToken || !Number.isFinite(fence.fencingEpoch)) return false
  if (outcome === 'failed') {
    return store.fail(jobId, {
      failureClass: 'child_error',
      detail: detail ?? 'cron failed',
      httpStatus: 500,
      claimToken: fence.claimToken,
      fencingEpoch: fence.fencingEpoch,
    })
  }
  const won = store.complete(
    jobId,
    {
      httpStatus: 200,
      body: { ok: true, failure_class: outcome === 'skipped_silent' ? 'cancelled' : undefined },
    },
    fence,
  )
  if (!won) return false
  if (outcome === 'skipped_silent') store.patchCallbackState(jobId, 'skipped_silent', fence)
  return true
}
