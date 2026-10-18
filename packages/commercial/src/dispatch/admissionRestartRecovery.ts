/** OCV5-511: ACKed intent survives a Master restart without guessing that an
 * unacknowledged container send never executed. Replay requires a durable
 * rejected tombstone for the exact old dispatch/attempt, and uses a new cmid. */
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  AUTOMATIC_TURN_RETRY_MAX, computeDispatchRequestHash, isClientMessageId,
  turnRecoveryAttemptIdentity, type DispatchRequestContent,
} from '@openclaude/protocol'
import type { MessageLike } from '@openclaude/storage'
import { getDispatch, getDispatchForUpdate, type TurnDispatchRow } from './turnDispatchStore.js'
import { abortNeverExecutedJournalForDispatch, assessDispatchBilling,
  type AbortedJournalRef } from './turnDispatchReconciler.js'
import { enqueueAutomaticRecoveryJob, lockRecoveryRoot } from './turnRecoveryStore.js'

export const ADMISSION_RESTART_UNEXECUTED = 'admission_restart_unexecuted'
const REQUEST_FIELDS = [
  'type', 'idempotencyKey', 'channel', 'peer', 'agentId', 'replyToId', 'effortLevel',
  'model', 'modelSwitchId', 'contextTier', 'serviceTier', 'teamMode', 'collabMode',
  'advisorModel', 'collabConfigVersion', 'conversationMode', 'clientMessageId', 'ts',
] as const
const CONTENT_FIELDS = ['text', 'displayText', 'media', 'replyTo', 'imageEdit'] as const
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export interface AdmissionRestartSnapshot {
  version: 1
  wireBase64: string
}

/** Only user input is saved: never persist/replay master authority, billing,
 * route tokens, trace ids or injected history. JSON cloning freezes nested
 * media/quotes before any later preparation mutation. */
export function snapshotAdmissionRequest(frame: Record<string, unknown>): AdmissionRestartSnapshot {
  const request: Record<string, unknown> = {}
  for (const key of REQUEST_FIELDS) if (frame[key] !== undefined) request[key] = frame[key]
  const content: Record<string, unknown> = {}
  if (typeof frame.content === 'string') content.text = frame.content
  else if (record(frame.content)) {
    for (const key of CONTENT_FIELDS) if (frame.content[key] !== undefined) content[key] = frame.content[key]
  }
  request.content = content
  return { version: 1, wireBase64: Buffer.from(JSON.stringify(request)).toString('base64') }
}

export interface AdmissionRestartRecoveryDeps {
  releaseReservation(ref: AbortedJournalRef): Promise<void>
}
export interface AdmissionRestartStorageDeps extends AdmissionRestartRecoveryDeps {
  loadLatestSource(q: Pool | PoolClient, row: TurnDispatchRow, lock: boolean): Promise<MessageLike | null>
  advanceTimeline(q: PoolClient, sessionId: string, userId: string): Promise<void>
}

function lineage(source: MessageLike): { root: string; attempt: number } | null {
  const root = isClientMessageId(source._automaticRecoveryRootClientMessageId)
    ? source._automaticRecoveryRootClientMessageId : source.id
  const previous = source._automaticRecovery === true
    ? source._automaticRecoveryAttempt : 0
  if (!isClientMessageId(root) || !Number.isSafeInteger(previous) ||
      typeof previous !== 'number' || previous < 0 || previous > AUTOMATIC_TURN_RETRY_MAX) return null
  return { root, attempt: previous + 1 }
}

function exactRequest(source: MessageLike, dispatch: TurnDispatchRow): Record<string, unknown> | null {
  const snapshot = source._admissionRestartRequest
  if (!record(snapshot) || snapshot.version !== 1 || typeof snapshot.wireBase64 !== 'string') return null
  let request: unknown
  try { request = JSON.parse(Buffer.from(snapshot.wireBase64, 'base64').toString('utf8')) } catch { return null }
  if (!record(request)) return null
  if (request.type !== 'inbound.message' || !record(request.peer) ||
      request.peer.id !== dispatch.sessionId || request.clientMessageId !== dispatch.clientMessageId ||
      (request.agentId || 'main') !== dispatch.agentId || (request.model || null) !== dispatch.model ||
      !record(request.content) ||
      computeDispatchRequestHash(request.content as DispatchRequestContent) !== dispatch.requestHash) return null
  // Re-apply the input allowlist even to a persisted snapshot; server-owned
  // requestId/authority/enrichment must be minted by normal admission again.
  return JSON.parse(Buffer.from(snapshotAdmissionRequest(request).wireBase64, 'base64').toString('utf8')) as Record<string, unknown>
}

const hasPersistedRejectedProof = (row: TurnDispatchRow): boolean =>
  row.outcome === 'not_accepted' && row.failureCode === 'DISPATCH_NOT_ACCEPTED'
const isSourceFailure = (row: TurnDispatchRow | null): row is TurnDispatchRow =>
  row !== null && row.status === 'terminal' && row.acceptedAt === null && row.agentContainerId !== null &&
  hasPersistedRejectedProof(row)

/** True means exact no-execution proof has a durable successor job. Unknown
 * execution remains open/rejecting in the ordinary inbox reconciler, which
 * keeps probing and lets accepted work finish under its original identity. */
export async function recoverAdmissionAfterRestart(pool: Pool, dispatchId: string,
  deps: AdmissionRestartStorageDeps): Promise<boolean> {
  const original = await getDispatch(pool, dispatchId)
  if (!isSourceFailure(original)) return false
  const initialSource = await deps.loadLatestSource(pool, original, false)
  if (!initialSource || !exactRequest(initialSource, original)) return false
  const initialLineage = lineage(initialSource)
  if (!initialLineage) return false
  // No network call is made under these locks. The tombstone has permanently
  // fenced delayed sends of the old identity before a new cmid can be minted.
  const client = await pool.connect()
  let committed = false
  let inserted = false
  let reservations: AbortedJournalRef[] = []
  try {
    await client.query('BEGIN')
    await lockRecoveryRoot(client, { userId: original.userId,
      sessionId: original.sessionId, rootClientMessageId: initialLineage.root })
    const source = await deps.loadLatestSource(client, original, true)
    const row = await getDispatchForUpdate(client, dispatchId)
    if (!source || !isSourceFailure(row) || row.attemptNo !== original.attemptNo ||
        row.userId !== original.userId || row.sessionId !== original.sessionId ||
        row.clientMessageId !== original.clientMessageId || row.agentContainerId !== original.agentContainerId) return false
    const request = exactRequest(source, row)
    const next = lineage(source)
    if (!request || !next || next.root !== initialLineage.root || next.attempt !== initialLineage.attempt) return false
    const tapes = await client.query(
      `SELECT 1 FROM client_session_turn_tapes WHERE session_id=$1 AND user_id=$2 AND client_message_id=$3 LIMIT 1`,
      [row.sessionId, `c:${row.userId}`, row.clientMessageId],
    )
    if (tapes.rowCount) return false
    reservations = await abortNeverExecutedJournalForDispatch(client, dispatchId)
    if (await assessDispatchBilling(client, dispatchId) !== 'not_billed') return false
    const oldJobs = await client.query<{ status: string; pause_reason: string | null }>(
      `SELECT status,pause_reason FROM turn_recovery_jobs
        WHERE dispatch_id=$1 AND dispatch_attempt_no=$2 AND user_id=$3 AND session_id=$4
          AND root_client_message_id=$5 AND semantic_recovery_attempt=$6 FOR UPDATE`,
      [dispatchId, row.attemptNo, row.userId.toString(), row.sessionId, next.root, next.attempt - 1],
    )
    if (oldJobs.rows.some(job => job.status === 'cancelled' ||
        (job.status === 'paused' && job.pause_reason !== 'dispatch_not_accepted'))) return false
    const stopped = await client.query(
      `SELECT 1 FROM turn_control_requests WHERE user_id=$1 AND session_id=$2 AND kind='stop'
        AND (root_client_message_id=$3 OR (root_client_message_id IS NULL AND created_at >= $4)) LIMIT 1`,
      [row.userId.toString(), row.sessionId, next.root, row.admittedAt],
    )
    if (!stopped.rowCount && next.attempt <= AUTOMATIC_TURN_RETRY_MAX) {
      const identity = turnRecoveryAttemptIdentity(row.sessionId, next.root, next.attempt)
      const content = request.content as Record<string, unknown>
      request.content = { ...content, recovery: {
        sourceClientMessageId: row.clientMessageId, mode: 'replay', automatic: true,
        rootClientMessageId: next.root, attempt: next.attempt, max: AUTOMATIC_TURN_RETRY_MAX,
      } }
      request.clientMessageId = identity.clientMessageId
      request.idempotencyKey = identity.idempotencyKey
      request.ts = Date.now()
      // A real exact dispatch rejection proof, not a fabricated turn tape.
      const proofDigest = createHash('sha256').update(JSON.stringify({
        dispatchId, attemptNo: row.attemptNo, requestHash: row.requestHash,
        snapshot: source._admissionRestartRequest, state: 'rejected',
        proofSource: 'reconciled_dispatch',
      })).digest('hex')
      inserted = await enqueueAutomaticRecoveryJob(client, {
        userId: row.userId, sessionId: row.sessionId, rootClientMessageId: next.root,
        sourceClientMessageId: row.clientMessageId,
        sourceTurnKey: `dispatch:${dispatchId}:${row.attemptNo}`,
        errorCode: ADMISSION_RESTART_UNEXECUTED, recoveryMode: 'replay',
        semanticRecoveryAttempt: next.attempt,
        request: { clientMessageId: request.clientMessageId, _admissionRestartWireVersion: 1,
          _admissionRestartWire: Buffer.from(JSON.stringify(request)).toString('base64') },
        tapeSha256: proofDigest,
      })
    }
    if (inserted || next.attempt > AUTOMATIC_TURN_RETRY_MAX) {
      // Retire only the exact proven rejected delivery. Root/Stop locks make
      // retirement and successor publication one atomic handoff. Completed /
      // interrupted is delivery settlement, not a claim the user's task ended.
      await client.query(
        `UPDATE turn_recovery_jobs SET status=$7,terminal_outcome='interrupted',
          pause_reason=$8,lease_owner=NULL,lease_until=NULL,updated_at=NOW()
          WHERE dispatch_id=$1 AND dispatch_attempt_no=$2 AND user_id=$3 AND session_id=$4
            AND root_client_message_id=$5 AND semantic_recovery_attempt=$6
            AND (status IN ('queued','leased','sent','forwarded')
              OR (status='paused' AND pause_reason='dispatch_not_accepted'))`,
        [dispatchId, row.attemptNo, row.userId.toString(), row.sessionId, next.root, next.attempt - 1,
          inserted ? 'completed' : 'paused', inserted ? null : 'automatic_retry_exhausted'],
      )
    }
    // Stop/paused lineage may veto enqueue. Still commit the exact no-execution
    // compensation; ordinary failure visibility then remains authoritative.
    await client.query(
      `UPDATE turn_dispatches SET outcome='not_accepted',failure_code=$2 WHERE dispatch_id=$1`,
      [dispatchId, inserted ? ADMISSION_RESTART_UNEXECUTED : 'DISPATCH_NOT_ACCEPTED'],
    )
    await deps.advanceTimeline(client, row.sessionId, `c:${row.userId}`)
    await client.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  if (committed) {
    // A pre-check can precede journal creation; its stable reservation must
    // also be released when the old request has no journal row at all.
    const refs = new Map(reservations.map(ref => [ref.requestId, ref]))
    refs.set(original.billingRequestId, { userId: original.userId.toString(), requestId: original.billingRequestId })
    for (const ref of refs.values()) await deps.releaseReservation(ref).catch(() => {})
  }
  return inserted
}

export async function reconcileAdmissionRestarts(pool: Pool, userId: bigint, limit: number,
  deps: AdmissionRestartStorageDeps): Promise<number> {
  const candidates = await pool.query<{ dispatch_id: string; attempt_no: number }>(
    `SELECT dispatch_id,attempt_no FROM turn_dispatches d
      WHERE user_id=$1 AND status='terminal' AND accepted_at IS NULL
        AND outcome='not_accepted' AND failure_code='DISPATCH_NOT_ACCEPTED'
        AND NOT EXISTS (SELECT 1 FROM turn_recovery_jobs j
          WHERE j.user_id=d.user_id AND j.session_id=d.session_id
            AND j.source_client_message_id=d.client_message_id)
      ORDER BY terminal_at DESC LIMIT $2`, [userId.toString(), limit],
  )
  let scheduled = 0
  for (const row of candidates.rows) {
    if (!await recoverAdmissionAfterRestart(pool, row.dispatch_id, deps)) continue
    const job = await pool.query(`SELECT 1 FROM turn_recovery_jobs WHERE source_turn_key=$1`,
      [`dispatch:${row.dispatch_id}:${row.attempt_no}`])
    if (job.rowCount) scheduled++
  }
  return scheduled
}
