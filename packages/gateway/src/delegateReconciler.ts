/**
 * OCV5-22 stage 1 startup reconciler.
 *
 * Scans non-terminal durable jobs and runs AdoptOrKill. Conservative:
 *   - this process + live lease → leave running
 *   - queued → adopt (lease transfer, stay queued)
 *   - running + stale/other + checkpoint none → killed_by_cutover
 *     unless lease is still valid AND we cannot prove the child is dead
 *     (wait for lease; do not invent a kill)
 *   - isChildAlive() === false (orphan proved) → kill even if lease remains
 *   - queued past QUEUE_WAIT_MS wall clock → failed{capacity_timeout}
 *
 * Must finish before spawn. Does not start real grok processes.
 */
import { isDelegateTerminalState, type DelegateJobState } from '@openclaude/protocol'
import type { DelegateJobSnapshot, DelegateJobStore } from './delegateJobs.js'
import type { DelegateResumeRegistry } from './delegateResume.js'

export type DelegateReconcileHooks = {
  isChildAlive?: (job: DelegateJobSnapshot) => boolean | undefined
  now?: () => number
  /** Wall-clock budget used after restart (hrtime does not survive). */
  queueWaitMs?: number
}

export type DelegateReconcileSummary = {
  scanned: number
  adopted: number
  killed: number
  deferred: number
  capacityTimedOut: number
}

const DEFAULT_QUEUE_WAIT_MS = 90_000

export function reconcileDelegateJobsOnBoot(
  store: DelegateJobStore,
  hooks: DelegateReconcileHooks = {},
): DelegateReconcileSummary {
  const now = hooks.now ?? Date.now
  const queueWaitMs = hooks.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS
  const summary: DelegateReconcileSummary = {
    scanned: 0,
    adopted: 0,
    killed: 0,
    deferred: 0,
    capacityTimedOut: 0,
  }
  for (const job of store.listNonTerminal()) {
    summary.scanned += 1
    if (job.state === 'queued') {
      const createdAt = job.createdAt ?? 0
      if (createdAt > 0 && now() - createdAt >= queueWaitMs) {
        const ok = store.fail(job.id, {
          failureClass: 'capacity_timeout',
          detail: 'capacity_timeout after restart: queued past wait budget',
          httpStatus: 429,
        })
        if (ok) summary.capacityTimedOut += 1
      }
      continue
    }
    const next = store.decideAdoptNextState(job)
    if (shouldDeferKill(store, job, next, now, hooks.isChildAlive)) {
      summary.deferred += 1
      continue
    }
    const adopted = store.adoptOrKill(job.id, job.fencingEpoch, next)
    if (!adopted) continue
    if (adopted.state === 'killed_by_cutover' || isDelegateTerminalState(adopted.state)) {
      summary.killed += 1
    } else {
      summary.adopted += 1
    }
  }
  return summary
}

/** Earliest wall-clock instant a deferred/queued row needs another scan. */
export function nextDelegateReconcileAt(
  store: DelegateJobStore,
  hooks: DelegateReconcileHooks = {},
): number | undefined {
  const now = hooks.now ?? Date.now
  const queueWaitMs = hooks.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS
  let next: number | undefined
  for (const job of store.listNonTerminal()) {
    let due: number
    if (job.state === 'queued') {
      due = (job.createdAt ?? now()) + queueWaitMs
    } else if (job.ownerLeaseUntil != null) {
      due = job.ownerLeaseUntil
    } else {
      due = now()
    }
    next = next == null ? due : Math.min(next, due)
  }
  return next
}

function shouldDeferKill(
  store: DelegateJobStore,
  job: DelegateJobSnapshot,
  next: DelegateJobState,
  now: () => number,
  isChildAlive?: (job: DelegateJobSnapshot) => boolean | undefined,
): boolean {
  if (job.state !== 'running' || next !== 'killed_by_cutover') return false
  const alive = isChildAlive?.(job)
  if (alive === false) return false
  const leaseValid = job.ownerLeaseUntil != null && job.ownerLeaseUntil >= now()
  if (alive === true) return true
  // Unknown liveness: only kill once the lease has elapsed.
  if (job.ownerInstanceId === store.ownerInstanceId && leaseValid) return true
  return leaseValid
}

/**
 * Rebuild occupancy + attempt→jobId from durable non-terminal rows so resume
 * idempotency survives a gateway restart.
 */
export function restoreResumeOccupancyFromJobs(
  registry: DelegateResumeRegistry,
  store: DelegateJobStore,
): number {
  let n = 0
  for (const job of store.listNonTerminal()) {
    if (!job.sessionKey) continue
    if (job.kind === 'cron' || job.kind === 'taskboard' || job.kind === 'ccb_local') continue
    registry.restoreInFlight({
      sessionKey: job.sessionKey,
      parentSessionKey: job.parentSessionKey ?? '',
      targetAgentId: parseTargetAgent(job.sessionKey) ?? job.agentId,
      sourceAgent: parseSourceAgent(job.sessionKey) ?? 'restored',
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
    })
    n += 1
  }
  return n
}

function parseTargetAgent(sessionKey: string): string | undefined {
  const m = /^agent:([^:]+):delegate:/.exec(sessionKey)
  return m?.[1]
}

function parseSourceAgent(sessionKey: string): string | undefined {
  const m = /^agent:[^:]+:delegate:([^:]+):/.exec(sessionKey)
  return m?.[1]
}
