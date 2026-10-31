/**
 * OCV5-683: a container replace can land after master admission and before the
 * frame reaches the container. The same turn_dispatches row is released and
 * replayed once. No usage row is written here; billing stays on the normal
 * execution path and reuses the original billing_request_id.
 *
 * The recovery-job row is only the durable queue. Its root id is synthetic so
 * it does not consume the user message's automatic-recovery attempt budget.
 */
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

import { stripDispatchAuthorityField } from '@openclaude/protocol'

export const RECYCLE_READMIT_WINDOW_MS = 60_000
export const RECYCLE_READMIT_NOTICE_TEXT = '执行环境已更新，本轮已继续'
export const RECYCLE_READMIT_FAILURE_TEXT = '执行环境刚刚更新，这条消息还没开始处理，未扣费。'
export const RECYCLE_READMIT_FAILURE_CODE = 'bridge_closed_during_admission'

export type PreReceiptScheduleResult =
  | 'scheduled'
  | 'pending'
  | 'exhausted'
  | 'not_pre_receipt'
  | 'declined'

export interface SchedulePreReceiptInput {
  userId: bigint
  sessionId: string
  clientMessageId: string
  dispatchId: string
  leaseEpoch: number
  failureCode: string
  frame: Record<string, unknown>
  nowMs?: number
}

const DISPATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function preReceiptRecycleRoot(clientMessageId: string): string {
  return `pre-receipt:${clientMessageId}`
}

/** Container send dies before cleanup flips the death flag, so that code is
 * enough on its own. The default admission-close code also covers user-close
 * drain timeout, which must not replay. */
export function isPreReceiptRecycleReplayCode(
  failureCode: string,
  containerDeath: boolean,
): boolean {
  if (failureCode === 'container_forward_rejected') return true
  if (!containerDeath) return false
  return (
    failureCode === RECYCLE_READMIT_FAILURE_CODE ||
    failureCode === 'bridge_cleaned_before_physical_forward'
  )
}

export function recycleReplayDecision(input: {
  nowMs: number
  deadlineAt: number | null
  linkOpen: boolean
}): 'release' | 'expire' | 'replay' {
  if (!input.linkOpen) return 'release'
  if (
    input.deadlineAt == null ||
    !Number.isFinite(input.deadlineAt) ||
    input.nowMs > input.deadlineAt
  ) {
    return 'expire'
  }
  return 'replay'
}

export function recycleReadmitGreyLineVisible(input: {
  sameDispatch: boolean
  jobStatus: string
  acceptedAt: Date | string | null
  dispatchStatus: string
  outcome: string | null
}): boolean {
  if (!input.sameDispatch) return false
  if (
    input.jobStatus !== 'sent' &&
    input.jobStatus !== 'forwarded' &&
    input.jobStatus !== 'completed'
  ) {
    return false
  }
  if (input.acceptedAt == null) return false
  if (input.dispatchStatus === 'accepted') return true
  return input.dispatchStatus === 'terminal' && input.outcome === 'completed'
}

export const RECYCLE_READMIT_NOTICE_SQL = `
SELECT d.client_message_id,
       d.accepted_at,
       d.status AS dispatch_status,
       d.outcome,
       j.status AS job_status,
       (j.request_json->>'_recycleSameDispatch') AS same_dispatch
  FROM turn_recovery_jobs j
  JOIN turn_dispatches d
    ON d.user_id = j.user_id
   AND d.session_id = j.session_id
   AND d.dispatch_id::text = j.request_json->>'_recycleDispatchId'
 WHERE j.user_id = $1
   AND j.session_id = $2
   AND j.request_json->>'_recycleSameDispatch' = 'true'
   AND j.status IN ('sent', 'forwarded', 'completed')`

export function recycleReplayFrame(
  frame: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let cloned: Record<string, unknown>
  try {
    cloned = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return undefined
  stripDispatchAuthorityField(cloned)
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(cloned)) {
    if (
      key === '_recycleSameDispatch' ||
      key === '_recycleDeadlineAt' ||
      key === '_recycleDispatchId' ||
      key === '_recycleLeaseEpoch'
    ) {
      continue
    }
    rest[key] = value
  }
  return rest
}

export function recycleReplayFrameFromJob(
  request: Record<string, unknown>,
): Record<string, unknown> | null {
  const frame = request.frame
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
  return recycleReplayFrame(frame as Record<string, unknown>) ?? null
}

export function recycleReplayDispatchRef(
  request: Record<string, unknown>,
): { dispatchId: string; leaseEpoch: number } | null {
  const dispatchId = request._recycleDispatchId
  const leaseEpoch = request._recycleLeaseEpoch
  if (typeof dispatchId !== 'string' || !DISPATCH_ID_RE.test(dispatchId)) return null
  if (typeof leaseEpoch !== 'number' || !Number.isSafeInteger(leaseEpoch)) return null
  return { dispatchId, leaseEpoch }
}

export function recycleReplayDeadlineAt(request: Record<string, unknown>): number | null {
  const deadline = request._recycleDeadlineAt
  return typeof deadline === 'number' && Number.isFinite(deadline) ? deadline : null
}

type QueryResult = { rowCount?: number | null; rows: Array<Record<string, unknown>> }

async function rollbackQuiet(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => {})
}

export async function schedulePreReceiptRecycleReplay(
  pool: Pool,
  input: SchedulePreReceiptInput,
): Promise<PreReceiptScheduleResult> {
  if (!DISPATCH_ID_RE.test(input.dispatchId)) return 'declined'
  if (input.clientMessageId.length === 0 || input.sessionId.length === 0) return 'declined'
  if (!Number.isSafeInteger(input.leaseEpoch)) return 'declined'
  const frame = recycleReplayFrame(input.frame)
  if (!frame) return 'declined'
  const nowMs = input.nowMs ?? Date.now()
  const root = preReceiptRecycleRoot(input.clientMessageId)
  const userId = input.userId.toString()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const dispatch = await client.query<Record<string, unknown>>(
      `SELECT status, accepted_at, lease_epoch::text AS lease_epoch
         FROM turn_dispatches
        WHERE dispatch_id = $1
          AND user_id = $2
          AND session_id = $3
          AND client_message_id = $4
        FOR UPDATE`,
      [input.dispatchId, userId, input.sessionId, input.clientMessageId],
    )
    const row = dispatch.rows[0]
    if (
      !row ||
      row.status !== 'admitted' ||
      row.accepted_at != null ||
      Number(row.lease_epoch) !== input.leaseEpoch
    ) {
      await client.query('COMMIT')
      return 'not_pre_receipt'
    }
    const existing = await client.query<Record<string, unknown>>(
      `SELECT status
         FROM turn_recovery_jobs
        WHERE user_id = $1
          AND session_id = $2
          AND root_client_message_id = $3
          AND semantic_recovery_attempt = 1
        FOR UPDATE`,
      [userId, input.sessionId, root],
    )
    const jobStatus = existing.rows[0]?.status
    if (jobStatus === 'queued' || jobStatus === 'leased') {
      await client.query('COMMIT')
      return 'pending'
    }
    if (typeof jobStatus === 'string') {
      await client.query('COMMIT')
      return 'exhausted'
    }
    const stopped = await client.query(
      `SELECT 1
         FROM turn_control_requests
        WHERE user_id = $1
          AND session_id = $2
          AND kind = 'stop'
          AND root_client_message_id = $3
        LIMIT 1`,
      [userId, input.sessionId, input.clientMessageId],
    )
    if ((stopped.rowCount ?? 0) > 0) {
      await client.query('COMMIT')
      return 'declined'
    }
    const released = await client.query(
      `UPDATE turn_dispatches
          SET owner_id = NULL,
              lease_until = clock_timestamp() - interval '1 second',
              last_attempt_at = clock_timestamp()
        WHERE dispatch_id = $1
          AND status = 'admitted'
          AND accepted_at IS NULL
          AND lease_epoch = $2`,
      [input.dispatchId, input.leaseEpoch],
    )
    if ((released.rowCount ?? 0) !== 1) {
      await client.query('COMMIT')
      return 'not_pre_receipt'
    }
    const request = {
      _recycleSameDispatch: true,
      _recycleDeadlineAt: nowMs + RECYCLE_READMIT_WINDOW_MS,
      _recycleDispatchId: input.dispatchId,
      _recycleLeaseEpoch: input.leaseEpoch,
      frame,
    }
    const tapeSha256 = createHash('sha256')
      .update(`pre-receipt:${input.dispatchId}`, 'utf8')
      .digest('hex')
    const inserted = await client.query(
      `INSERT INTO turn_recovery_jobs (
         user_id, session_id, root_client_message_id, source_client_message_id,
         source_turn_key, error_code, recovery_mode, semantic_recovery_attempt,
         request_json, tape_sha256
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'replay', 1, $7::jsonb, $8)
       ON CONFLICT (user_id, session_id, root_client_message_id, semantic_recovery_attempt)
       DO NOTHING`,
      [
        userId,
        input.sessionId,
        root,
        input.clientMessageId,
        `pre-receipt:${input.dispatchId}`,
        input.failureCode,
        JSON.stringify(request),
        tapeSha256,
      ],
    )
    if ((inserted.rowCount ?? 0) !== 1) {
      await rollbackQuiet(client)
      return 'pending'
    }
    await client.query('COMMIT')
    return 'scheduled'
  } catch (error) {
    await rollbackQuiet(client)
    throw error
  } finally {
    client.release()
  }
}

export async function markPreReceiptRecycleReplaySent(
  pool: Pool,
  job: { jobId: string; leaseOwner: string; leaseEpoch: number },
): Promise<boolean> {
  const result: QueryResult = await pool.query(
    `UPDATE turn_recovery_jobs
        SET status = 'sent', lease_owner = NULL, lease_until = NULL, updated_at = NOW()
      WHERE job_id = $1
        AND status = 'leased'
        AND lease_owner = $2
        AND lease_epoch = $3
        AND dispatch_id IS NULL`,
    [job.jobId, job.leaseOwner, job.leaseEpoch],
  )
  return (result.rowCount ?? 0) === 1
}

export async function pausePreReceiptRecycleReplay(
  pool: Pool,
  job: { jobId: string; leaseOwner: string; leaseEpoch: number },
  reason: string,
): Promise<boolean> {
  const pauseReason = reason.replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 96)
  const result: QueryResult = await pool.query(
    `UPDATE turn_recovery_jobs
        SET status = 'paused',
            pause_reason = $4,
            terminal_outcome = 'interrupted',
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = NOW()
      WHERE job_id = $1
        AND status = 'leased'
        AND lease_owner = $2
        AND lease_epoch = $3
        AND dispatch_id IS NULL`,
    [job.jobId, job.leaseOwner, job.leaseEpoch, pauseReason],
  )
  return (result.rowCount ?? 0) === 1
}
