// Self-heal cancel contract (block C / design §A2, §C4).
//
// Canonical remote entry: POST /api/webhooks/v5-selfheal-cancel, verified by
// the SAME trust chain as dispatch (loopback + size + ts + HMAC + nonce) in
// server.ts, which then calls {@link executeSelfhealCancel}. The legacy
// /internal/selfheal/cancel route is deleted.
//
// terminated semantics (§A2 table) — `terminated === true` IFF the repair can
// hold NO further execution and NO future deploy (decidable across crashes; a
// teardown that was never CONFIRMED must not release the v5 singleflight slot):
//
//   ① unknown repair            → atomic tombstone insert         → true
//   ② no live session           → CAS active→cancelled            → true
//   ③ already cancelled          → idempotent                      → true
//   ④ live session               → CAS →'cancelling' (durable),
//                                  teardown, CONFIRM, →'cancelled' → true
//      teardown unconfirmed      → stays 'cancelling'              → false
//                                  (a retried cancel resumes here)
//   ⑤ terminal succeeded/failed  → best-effort residual-session
//                                  teardown + DURABLE release
//                                  revocation + outbox abandon     → true
//
// Case ⑤ (HIGH3): a terminal job is NOT resurrected — its business result
// (succeeded/failed) is unchanged — but the cancel must still fully release the
// v5 singleflight slot: any residual session is torn down, the durable
// `release_revoked` fuse blocks a parked pending_release cutover from ever
// being released, and the repair's still-queued master callbacks are abandoned.
//
// The whole decision runs under the per-repair keyed mutex (withRepairLock), so
// it serializes against the jobWorker's CAS→submit critical section.

import {
  abandonQueuedCallbacks,
  getJob,
  insertCancelTombstone,
  setJobReleaseRevoked,
  setJobStatus,
} from '@openclaude/storage'
import { createLogger } from '../logger.js'
import { selfhealSessionKey, withRepairLock } from './executionLedger.js'

const log = createLogger({ module: 'selfheal-cancel' })

/** The minimal session surface cancel needs (SessionManager satisfies it). */
export interface CancelSessionOps {
  getByKey(sessionKey: string): unknown | undefined
  interrupt(sessionKey: string): boolean
  destroySession(sessionKey: string): Promise<void>
}

export interface CancelOutcome {
  repairId: string
  /** True IFF the repair can hold no further execution and no future deploy:
   *  durable status 'cancelled', OR terminal (succeeded/failed) with its
   *  residual session gone + release durably revoked (case ⑤). */
  terminated: boolean
  /** True when the cancel is in effect (tombstoned / cancelled / cancelling /
   *  terminal-with-revoked-release). */
  accepted: boolean
  /** The job's durable status after this call (for observability). A terminal
   *  job keeps its business result — cancel never rewrites succeeded/failed. */
  status: string
}

/**
 * Execute one cancel request (post-verification). Idempotent and safe to retry:
 * a repair stuck in 'cancelling' resumes its teardown on the next call.
 */
export async function executeSelfhealCancel(
  input: { repairId: string; incidentId: string },
  sessions: CancelSessionOps,
): Promise<CancelOutcome> {
  return withRepairLock(input.repairId, () => cancelLocked(input, sessions))
}

async function cancelLocked(
  input: { repairId: string; incidentId: string },
  sessions: CancelSessionOps,
): Promise<CancelOutcome> {
  const { repairId, incidentId } = input

  let job = await getJob(repairId)
  if (!job) {
    // ① Unknown repair → atomic tombstone. A concurrent dispatch losing this
    // race sees the tombstone's payload_hash and 409s (never executes).
    const inserted = await insertCancelTombstone({ repairId, incidentId })
    if (inserted) {
      log.info('cancel tombstoned unknown repair', { repairId, incidentId })
      return { repairId, terminated: true, accepted: true, status: 'cancelled' }
    }
    job = await getJob(repairId)
    if (!job) {
      // Tombstone lost AND row still absent — only reachable if the row was
      // deleted concurrently (never happens; rows are immortal). Fail closed.
      return { repairId, terminated: false, accepted: false, status: 'unknown' }
    }
  }

  // ③ Idempotent replay.
  if (job.status === 'cancelled') {
    return { repairId, terminated: true, accepted: true, status: 'cancelled' }
  }
  // ⑤ Terminal success/failure is never resurrected (business result stands),
  // but the cancel must still fully release the v5 slot (HIGH3): tear down any
  // residual session (best-effort), durably revoke a held release so a parked
  // pending_release cutover can never ship, and abandon the repair's queued
  // master callbacks so the pump stops arming a gate that will never fire.
  if (job.status === 'succeeded' || job.status === 'failed') {
    const terminalSessionKey = job.sessionKey ?? selfhealSessionKey(repairId)
    if (sessions.getByKey(terminalSessionKey)) {
      try {
        sessions.interrupt(terminalSessionKey)
        await sessions.destroySession(terminalSessionKey)
      } catch (err) {
        log.warn(
          'terminal-cancel residual session teardown failed (best-effort)',
          { repairId, sessionKey: terminalSessionKey },
          err,
        )
      }
    }
    await setJobReleaseRevoked(repairId)
    const abandoned = await abandonQueuedCallbacks(repairId)
    log.info('terminal-cancel: release revoked, outbox abandoned', {
      repairId,
      status: job.status,
      abandoned,
    })
    return { repairId, terminated: true, accepted: true, status: job.status }
  }

  const sessionKey = job.sessionKey ?? selfhealSessionKey(repairId)
  const live = sessions.getByKey(sessionKey)

  if (!live) {
    // ② No live session (received/starting, or a crashed running/cancelling
    // whose process died) → direct CAS to cancelled.
    const cas = await setJobStatus(repairId, 'cancelled', [
      'received',
      'starting',
      'running',
      'cancelling',
    ])
    if (cas) {
      log.info('cancel applied (no live session)', { repairId, from: job.status })
      return { repairId, terminated: true, accepted: true, status: 'cancelled' }
    }
    // Lost a race (e.g. turn just finished) — re-read and report honestly.
    const now = await getJob(repairId)
    const status = now?.status ?? 'unknown'
    return {
      repairId,
      terminated: status === 'cancelled',
      accepted: status === 'cancelled' || status === 'cancelling',
      status,
    }
  }

  // ④ Live session: durable 'cancelling' FIRST (so a crash mid-teardown is
  // resumable and never mis-reported as terminated), then teardown, then
  // confirm, and only then CAS cancelling→cancelled.
  await setJobStatus(repairId, 'cancelling', ['received', 'starting', 'running'])
  let torndown = false
  try {
    sessions.interrupt(sessionKey)
    await sessions.destroySession(sessionKey)
    torndown = !sessions.getByKey(sessionKey)
  } catch (err) {
    log.warn('cancel teardown failed — staying in cancelling', { repairId, sessionKey }, err)
    torndown = false
  }
  if (!torndown) {
    return { repairId, terminated: false, accepted: true, status: 'cancelling' }
  }
  const done = await setJobStatus(repairId, 'cancelled', ['cancelling'])
  if (!done) {
    const now = await getJob(repairId)
    const status = now?.status ?? 'cancelling'
    return { repairId, terminated: status === 'cancelled', accepted: true, status }
  }
  log.info('cancel confirmed (live session torn down)', { repairId, sessionKey })
  return { repairId, terminated: true, accepted: true, status: 'cancelled' }
}
