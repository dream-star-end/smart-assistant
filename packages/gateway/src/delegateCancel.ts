/**
 * Single-job delegate cancellation for session background task control (OCV5-844).
 *
 * Cancels one delegate job owned by `sessionId` without stopping the parent turn:
 *   1. Validates `job.parentSessionKey` belongs to `sessionId` (404 on mismatch/missing).
 *   2. Idempotent when already in a terminal state (`{ ok: true, cancelled: false, state }`).
 *   3. For durable/async jobs in `DelegateJobStore`: interrupts the child session, CAS-fails the
 *      job to `'cancelled'` (with 1 CAS retry on fresh token/epoch if still non-terminal), and
 *      ONLY projects to `DelegateInflightSurfaceStore` / returns 200 after the durable row is
 *      confirmed terminal; otherwise returns 409 `DELEGATE_CANCEL_CONFLICT` without fabricating
 *      a `'cancelled'` surface state.
 *   4. For surface-only (sync) rows: locates an unambiguous live handle in
 *      `_activeDelegationsByParent` / `sessions` and confirms real interruption; if none can be
 *      confirmed, NEVER fabricates `'cancelled'` and returns 409 `DELEGATE_CANCEL_UNCONFIRMED`.
 */
import { isDelegateTerminalState, type DelegateJobState } from '@openclaude/protocol'
import {
  sessionIdFromParentKey,
  type DelegateInflightSurfaceStore,
} from './delegateInflightSurface.js'
import type { DelegateJobSnapshot, DelegateJobStore } from './delegateJobs.js'
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
  _activeDelegationsByParent?: Map<string, Set<string>>
  _interruptDelegationsForParent(parentSessionKey: string): boolean
}

export type CancelSingleDelegateJobResult =
  | { ok: true; cancelled: boolean; state: DelegateJobState }
  | { ok: false; status: number; code: string; error: string }

function belongsToSession(parentSessionKey: string | undefined, sessionId: string): boolean {
  if (!parentSessionKey || !sessionId) return false
  return sessionIdFromParentKey(parentSessionKey) === sessionId
}

function interruptChildSession(host: DelegateCancelHost, childSessionKey: string): boolean {
  let confirmed = false
  if (cancelDelegateTraceWait(host.traceHost ?? host, childSessionKey)) {
    confirmed = true
  }
  const wakeQueued = host._delegateQueueWaiters?.get(childSessionKey)
  if (wakeQueued) {
    host._delegateQueueWaiters?.delete(childSessionKey)
    try {
      wakeQueued()
      confirmed = true
    } catch {
      /* ignore */
    }
  }
  try {
    if (host._interruptDelegationsForParent(childSessionKey)) {
      confirmed = true
    }
  } catch {
    /* ignore */
  }
  if (host.sessions.getByKey(childSessionKey)) {
    try {
      if (host.sessions.interrupt(childSessionKey, 'user')) {
        confirmed = true
      }
    } catch {
      /* ignore */
    }
  }
  return confirmed
}

function resolveUniqueSyncChildKey(
  host: DelegateCancelHost,
  parentSessionKey: string,
  _agentId: string,
  runId: string,
): string | null {
  const activeChildren = host._activeDelegationsByParent?.get(parentSessionKey)
  if (!activeChildren || activeChildren.size === 0) return null
  if (!runId) return null
  const all = [...activeChildren]

  // Require exact runId identity match (progressRunId is set by delegateRuntime on real child sessions).
  // Never guess by agentId alone: parallel delegations or stale surface rows could cancel an unrelated child.
  const byRunId = all.filter((childKey) => {
    if (childKey.includes(runId)) return true
    const sess = host.sessions.getByKey(childKey) as
      | { progressRunId?: string; delegateRunId?: string; runId?: string }
      | undefined
    return (
      sess?.progressRunId === runId ||
      sess?.delegateRunId === runId ||
      sess?.runId === runId
    )
  })
  return byRunId.length === 1 ? byRunId[0]! : null
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

    if (job.sessionKey) {
      interruptChildSession(host, job.sessionKey)
    }

    const attemptFail = (snap: DelegateJobSnapshot): boolean =>
      jobs!.fail(jid, {
        failureClass: 'cancelled',
        detail: 'user-cancelled',
        httpStatus: 409,
        nextState: 'cancelled',
        body: { cancelled: true },
        ...(snap.claimToken ? { claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch } : {}),
      })

    let failed = attemptFail(job)
    let after = jobs!.snapshotOf(jid)

    // Retry CAS once with fresh token/epoch if job is still non-terminal (e.g., queued -> running race).
    if (!failed && after && !isDelegateTerminalState(after.state)) {
      if (after.sessionKey && after.sessionKey !== job.sessionKey) {
        interruptChildSession(host, after.sessionKey)
      }
      failed = attemptFail(after)
      after = jobs!.snapshotOf(jid)
    }

    // Only project to surface and report 200 when the authoritative job row is confirmed terminal.
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

    return {
      ok: false,
      status: 409,
      code: 'DELEGATE_CANCEL_CONFLICT',
      error: 'delegate job could not be transitioned to cancelled',
    }
  }

  // Surface-only fallback (e.g., sync delegate): must confirm real handle interruption first.
  const row = surface?.get(jid)
  if (!row || !belongsToSession(row.parentSessionKey, sid)) {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'delegate job not found' }
  }
  if (isDelegateTerminalState(row.state)) {
    return { ok: true, cancelled: false, state: row.state }
  }

  const matchedChildKey = resolveUniqueSyncChildKey(
    host,
    row.parentSessionKey,
    row.agentId,
    row.runId,
  )
  const confirmed = matchedChildKey ? interruptChildSession(host, matchedChildKey) : false
  if (!confirmed) {
    return {
      ok: false,
      status: 409,
      code: 'DELEGATE_CANCEL_UNCONFIRMED',
      error: 'no live delegate handle confirmed for cancellation',
    }
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
