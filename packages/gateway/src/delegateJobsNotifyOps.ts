import {
  delegateNotifyId,
  type DelegateCallbackState,
  type DelegateJobState,
} from '@openclaude/protocol'
import type { DelegateDurableDb, DurableJobRecord } from './delegateDurable.js'

/**
 * Max callback_epoch (inclusive) allowed when master rejects a callback
 * clientMessageId as terminal `previously_failed` (OCV5-73). Epoch starts at 1,
 * so cap=5 allows up to 4 epoch bumps (epochs 1..5) with exponential backoff
 * before abandoning permanent failures.
 */
export const NOTIFY_MAX_CALLBACK_EPOCH = 5

export interface DelegateNotifyJobMut {
  id: string
  state: DelegateJobState
  claimToken?: string
  fencingEpoch: number
  callbackState: DelegateCallbackState
  callbackEpoch: number
  notifyId?: string
  notifyDeliveryToken?: string
  notifyClaimedUntil?: number | null
  notifyRetryAt?: number | null
  notifyAttempt?: number
  terminalCommittedAt?: number | null
  lastActivityAt: number
}

export interface DelegateNotifyOpsHost<TJob extends DelegateNotifyJobMut> {
  durable?: DelegateDurableDb | null
  now: () => number
  refreshJob: (jobId: string) => TJob | undefined
  ingestDurableRow: (row: DurableJobRecord) => void
  cloneEntry: (job: TJob) => TJob
  commit: (job: TJob, draft: TJob, includeTerminal: boolean) => boolean
  nextNotifyBackoffMs: (attempt: number) => number
  shouldAbandonPendingNotify: (
    job: { notifyAttempt?: number; terminalCommittedAt?: number | null },
    now: number,
  ) => boolean
  isLegalCallbackTransition: (from: DelegateCallbackState, to: DelegateCallbackState) => boolean
}

export function releaseNotifyClaimWithEpochBumpOp<TJob extends DelegateNotifyJobMut>(
  host: DelegateNotifyOpsHost<TJob>,
  jobId: string,
  deliveryToken: string,
  fence?: { claimToken: string; fencingEpoch: number },
  opts?: { maxCallbackEpoch?: number },
): 'bumped' | 'abandoned_at_epoch_cap' | 'stale' {
  const job = host.refreshJob(jobId)
  if (!job) return 'stale'
  if (job.claimToken) {
    if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
      return 'stale'
    }
  }
  if (job.callbackState !== 'injecting' || job.notifyDeliveryToken !== deliveryToken) {
    return 'stale'
  }
  const currentEpoch = job.callbackEpoch > 0 ? job.callbackEpoch : 1
  const maxEpoch = Math.max(1, Math.floor(opts?.maxCallbackEpoch ?? NOTIFY_MAX_CALLBACK_EPOCH))
  const now = host.now()
  if (currentEpoch >= maxEpoch) {
    if (host.durable) {
      const row = host.durable.casAbandonNotify({
        jobId,
        state: job.state,
        fencingEpoch: job.fencingEpoch,
        claimToken: job.claimToken ?? null,
        deliveryToken,
        now,
      })
      if (!row) {
        host.refreshJob(jobId)
        return 'stale'
      }
      host.ingestDurableRow(row)
      return 'abandoned_at_epoch_cap'
    }
    job.callbackState = 'abandoned'
    job.notifyDeliveryToken = undefined
    job.notifyClaimedUntil = null
    job.notifyRetryAt = null
    job.lastActivityAt = now
    return 'abandoned_at_epoch_cap'
  }
  const nextEpoch = currentEpoch + 1
  const nextNotifyId = delegateNotifyId(job.id, nextEpoch)
  const nextAttempt = (job.notifyAttempt ?? 0) + 1
  const retryAt = now + host.nextNotifyBackoffMs(job.notifyAttempt ?? 0)
  if (host.durable) {
    const row = host.durable.casReleaseNotify({
      jobId,
      state: job.state,
      fencingEpoch: job.fencingEpoch,
      claimToken: job.claimToken ?? null,
      deliveryToken,
      now,
      retryAt,
      notifyAttempt: nextAttempt,
      callbackEpoch: nextEpoch,
      notifyId: nextNotifyId,
    })
    if (!row) {
      host.refreshJob(jobId)
      return 'stale'
    }
    host.ingestDurableRow(row)
    return 'bumped'
  }
  job.callbackState = 'pending'
  job.callbackEpoch = nextEpoch
  job.notifyId = nextNotifyId
  job.notifyDeliveryToken = undefined
  job.notifyClaimedUntil = null
  job.notifyRetryAt = retryAt
  job.notifyAttempt = nextAttempt
  job.lastActivityAt = now
  return 'bumped'
}

export function shouldAbandonNotifyAfterAttemptOp<TJob extends DelegateNotifyJobMut>(
  host: DelegateNotifyOpsHost<TJob>,
  jobId: string,
): boolean {
  const job = host.refreshJob(jobId)
  if (!job) return false
  return host.shouldAbandonPendingNotify(
    {
      notifyAttempt: (job.notifyAttempt ?? 0) + 1,
      terminalCommittedAt: job.terminalCommittedAt,
    },
    host.now(),
  )
}

export function abandonNotifyClaimOp<TJob extends DelegateNotifyJobMut>(
  host: DelegateNotifyOpsHost<TJob>,
  jobId: string,
  deliveryToken: string,
  fence?: { claimToken: string; fencingEpoch: number },
): boolean {
  const job = host.refreshJob(jobId)
  if (!job) return false
  if (job.claimToken) {
    if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
      return false
    }
  }
  if (job.callbackState !== 'injecting' || job.notifyDeliveryToken !== deliveryToken) {
    return false
  }
  const now = host.now()
  if (host.durable) {
    const row = host.durable.casAbandonNotify({
      jobId,
      state: job.state,
      fencingEpoch: job.fencingEpoch,
      claimToken: job.claimToken ?? null,
      deliveryToken,
      now,
    })
    if (!row) {
      host.refreshJob(jobId)
      return false
    }
    host.ingestDurableRow(row)
    return true
  }
  job.callbackState = 'abandoned'
  job.notifyDeliveryToken = undefined
  job.notifyClaimedUntil = null
  job.notifyRetryAt = null
  job.lastActivityAt = now
  return true
}

export function abandonNotifyOp<TJob extends DelegateNotifyJobMut>(
  host: DelegateNotifyOpsHost<TJob>,
  jobId: string,
  fence?: { claimToken: string; fencingEpoch: number },
): boolean {
  const job = host.refreshJob(jobId)
  if (!job) return false
  if (job.claimToken) {
    if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
      return false
    }
  }
  if (job.callbackState === 'abandoned') return true
  if (!host.isLegalCallbackTransition(job.callbackState, 'abandoned')) return false
  const draft = host.cloneEntry(job)
  draft.callbackState = 'abandoned'
  draft.notifyDeliveryToken = undefined
  draft.notifyClaimedUntil = null
  draft.notifyRetryAt = null
  draft.lastActivityAt = host.now()
  return host.commit(job, draft, false)
}

export function deferPendingNotifyOp<TJob extends DelegateNotifyJobMut>(
  host: DelegateNotifyOpsHost<TJob>,
  jobId: string,
  fence?: { claimToken: string; fencingEpoch: number },
): boolean {
  const job = host.refreshJob(jobId)
  if (!job || job.callbackState !== 'pending') return false
  if (job.claimToken) {
    if (!fence || job.claimToken !== fence.claimToken || job.fencingEpoch !== fence.fencingEpoch) {
      return false
    }
  }
  const draft = host.cloneEntry(job)
  draft.notifyRetryAt = host.now() + host.nextNotifyBackoffMs(job.notifyAttempt ?? 0)
  draft.notifyAttempt = (job.notifyAttempt ?? 0) + 1
  draft.lastActivityAt = host.now()
  return host.commit(job, draft, false)
}
