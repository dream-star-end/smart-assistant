/**
 * Single-job delegate cancellation for session background task control (OCV5-844).
 *
 * Cancels one delegate job owned by `sessionId` without stopping the parent turn:
 *   1. Validates `job.parentSessionKey` belongs to `sessionId` (404 on mismatch/missing).
 *   2. Idempotent when the job is already in a terminal state (`{ ok: true, cancelled: false, state }`).
 *   3. Interrupts the child session, queued capacity waiter, pre-spawn trace wait, and nested
 *      descendant delegations, marks the job `cancelled` in `DelegateJobStore`, and authoritatively
 *      projects `'cancelled'` into `DelegateInflightSurfaceStore`.
 */
import { isDelegateTerminalState, type DelegateJobState } from '@openclaude/protocol'
import {
  sessionIdFromParentKey,
  type DelegateInflightSurfaceStore,
} from './delegateInflightSurface.js'
import type { DelegateJobStore } from './delegateJobs.js'
import { cancelDelegateTraceWait } from './delegateTrace.js'
import type { SessionManager } from './sessionManager.js'

const SAFE_DELEGATE_JOB_ID_RE = /^[A-Za-z0-9._:-]{1,180}$/

export interface DelegateCancelHost {
  /** WeakMap key passed to `registerDelegateTraceWait` (Gateway instance in production). */
  traceHost?: object
  delegateJobs(): DelegateJobStore | undefined
  delegateInflightSurface?: () => DelegateInflightSurfaceStore | undefined
  sessions: Pick<SessionManager, 'getByKey' | 'interrupt'>
  _delegateQueueWaiters?: Map<string, () => void>
  _interruptDelegationsForParent(parentSessionKey: string): boolean
}

export type CancelSingleDelegateJobResult =
  | { ok: true; cancelled: boolean; state: DelegateJobState }
  | { ok: false; status: number; code: string; error: string }

function belongsToSession(parentSessionKey: string | undefined, sessionId: string): boolean {
  if (!parentSessionKey || !sessionId) return false
  return sessionIdFromParentKey(parentSessionKey) === sessionId
}

export function cancelSingleDelegateJob(
  host: DelegateCancelHost,
  sessionId: string,
  jobId: string,
): CancelSingleDelegateJobResult {
  const sid = sessionId.trim()
  const jid = jobId.trim()
  if (!sid) {
    return { ok: false, status: 400, code: 'INVALID_SESSION_ID', error: 'sessionId required' }
  }
  if (!jid || !SAFE_DELEGATE_JOB_ID_RE.test(jid)) {
    return { ok: false, status: 400, code: 'INVALID_JOB_ID', error: 'invalid delegate jobId' }
  }

  const jobs = host.delegateJobs()
  const surface = host.delegateInflightSurface?.()
  const job = jobs?.snapshotOf(jid)

  if (job) {
    if (!belongsToSession(job.parentSessionKey, sid)) {
      return { ok: false, status: 404, code: 'NOT_FOUND', error: 'delegate job not found' }
    }
    if (isDelegateTerminalState(job.state)) {
      return { ok: true, cancelled: false, state: job.state }
    }

    const childSessionKey = job.sessionKey
    if (childSessionKey) {
      cancelDelegateTraceWait(host.traceHost ?? host, childSessionKey)
      const wakeQueued = host._delegateQueueWaiters?.get(childSessionKey)
      if (wakeQueued) {
        host._delegateQueueWaiters?.delete(childSessionKey)
        try {
          wakeQueued()
        } catch {
          /* ignore */
        }
      }
      try {
        host._interruptDelegationsForParent(childSessionKey)
      } catch {
        /* ignore */
      }
      if (host.sessions.getByKey(childSessionKey)) {
        try {
          host.sessions.interrupt(childSessionKey, 'user')
        } catch {
          /* ignore */
        }
      }
    }

    const failed = jobs!.fail(jid, {
      failureClass: 'cancelled',
      detail: 'user-cancelled',
      httpStatus: 409,
      nextState: 'cancelled',
      body: { cancelled: true },
      ...(job.claimToken ? { claimToken: job.claimToken, fencingEpoch: job.fencingEpoch } : {}),
    })

    const after = jobs!.snapshotOf(jid)
    if (after && isDelegateTerminalState(after.state)) {
      try {
        surface?.projectJob(after)
      } catch {
        /* fail-open surface projection */
      }
      return {
        ok: true,
        cancelled: failed || after.state === 'cancelled',
        state: after.state,
      }
    }

    if (surface?.get(jid)) {
      try {
        surface.updateLive({
          jobId: jid,
          state: 'cancelled',
          liveHint: '',
          authoritative: true,
        })
      } catch {
        /* fail-open */
      }
    }
    return {
      ok: true,
      cancelled: failed,
      state: after?.state ?? 'cancelled',
    }
  }

  // Fallback for surface-only (e.g., sync delegate or expired job handle still visible in surface).
  const row = surface?.get(jid)
  if (!row || !belongsToSession(row.parentSessionKey, sid)) {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'delegate job not found' }
  }
  if (isDelegateTerminalState(row.state)) {
    return { ok: true, cancelled: false, state: row.state }
  }
  try {
    surface!.updateLive({
      jobId: jid,
      state: 'cancelled',
      liveHint: '',
      authoritative: true,
    })
  } catch {
    /* fail-open */
  }
  return { ok: true, cancelled: true, state: 'cancelled' }
}
