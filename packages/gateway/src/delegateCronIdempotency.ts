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

export function settleCronDelegateJob(
  store: DelegateJobStore,
  jobId: string,
  outcome: 'completed' | 'failed' | 'skipped_silent',
  detail?: string,
): boolean {
  const snap = store.snapshotOf(jobId)
  if (!snap) return false
  if (snap.state === 'queued') {
    const claimed = store.claimQueued(jobId)
    if (!claimed.ok) return false
    if (outcome === 'completed' || outcome === 'skipped_silent') {
      store.complete(
        jobId,
        {
          httpStatus: 200,
          body: { ok: true, failure_class: outcome === 'skipped_silent' ? 'cancelled' : undefined },
        },
        { claimToken: claimed.claimToken, fencingEpoch: claimed.fencingEpoch },
      )
      if (outcome === 'skipped_silent') store.patchCallbackState(jobId, 'skipped_silent')
      return true
    }
    return store.fail(jobId, {
      failureClass: 'child_error',
      detail: detail ?? 'cron failed',
      httpStatus: 500,
      claimToken: claimed.claimToken,
      fencingEpoch: claimed.fencingEpoch,
    })
  }
  if (snap.claimToken) {
    const fence = { claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch }
    if (outcome === 'failed') {
      return store.fail(jobId, {
        failureClass: 'child_error',
        detail: detail ?? 'cron failed',
        httpStatus: 500,
        claimToken: fence.claimToken,
        fencingEpoch: fence.fencingEpoch,
      })
    }
    store.complete(jobId, { httpStatus: 200, body: { ok: true } }, fence)
    if (outcome === 'skipped_silent') store.patchCallbackState(jobId, 'skipped_silent')
    return true
  }
  return store.fail(jobId, {
    failureClass: 'child_error',
    detail: detail ?? 'cron failed',
    httpStatus: 500,
  })
}
