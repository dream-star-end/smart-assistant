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
