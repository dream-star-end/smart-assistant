import type { DelegateJobSnapshot } from './delegateJobs.js'
import { isEngineLocalTurnExempt } from './modelAuthority.js'

/** Same deployment discriminator used by the personal engine lane. */
export const personalCompactionEnabled = isEngineLocalTurnExempt

export interface CompactionActiveTask {
  kind: 'delegate' | 'subtask'
  id: string
  state: string
  sessionKey?: string
  agentId?: string
  idempotencyKey?: string
  traceId?: string
}

/** Project only job authority; never expose fencing/claim tokens to a model. */
export function compactionDelegateTasks(
  jobs: readonly DelegateJobSnapshot[],
  parentSessionKey: string,
): CompactionActiveTask[] {
  return jobs.filter(job => job.parentSessionKey === parentSessionKey &&
    ['queued', 'running', 'paused_for_cutover'].includes(job.state)).map(job => ({
    kind: 'delegate', id: job.id, state: job.state,
    sessionKey: job.sessionKey, agentId: job.agentId,
    idempotencyKey: job.idempotencyKey, traceId: job.traceId,
  }))
}
