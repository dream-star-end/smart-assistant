import type { Pool, PoolClient } from 'pg'

import { AUTOMATIC_TURN_RETRY_MAX } from '@openclaude/protocol'

import { durableRetryDelayMs } from './turnControlStore.js'
import type { Queryable } from './turnDispatchStore.js'

export interface AutomaticRecoveryJobInput {
  userId: bigint
  sessionId: string
  rootClientMessageId: string
  sourceClientMessageId: string
  sourceTurnKey: string
  errorCode: string
  recoveryMode: 'replay' | 'checkpoint'
  semanticRecoveryAttempt: number
  request: Record<string, unknown>
  tapeSha256: string
}

export interface ClaimedRecoveryJob {
  jobId: string
  userId: bigint
  sessionId: string
  rootClientMessageId: string
  sourceClientMessageId: string
  sourceTurnKey: string
  errorCode: string
  recoveryMode: 'replay' | 'checkpoint'
  semanticRecoveryAttempt: number
  transportWaitAttempt: number
  request: Record<string, unknown>
  leaseOwner: string
  leaseEpoch: number
}

export async function lockRecoveryRoot(
  q: Queryable,
  input: { userId: bigint; sessionId: string; rootClientMessageId: string },
): Promise<void> {
  await q.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       'oc_recovery_session:' || $1::text || ':' || $2, 0
     ))`,
    [input.userId.toString(), input.sessionId],
  )
  await q.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       'oc_recovery:' || $1::text || ':' || $2 || ':' || $3, 0
     ))`,
    [input.userId.toString(), input.sessionId, input.rootClientMessageId],
  )
}

/** Called from the lossless-tape finalize transaction. The immutable terminal
 * tape and its next recovery job therefore become visible atomically. */
export async function enqueueAutomaticRecoveryJob(
  q: Queryable,
  input: AutomaticRecoveryJobInput,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.semanticRecoveryAttempt) ||
    input.semanticRecoveryAttempt < 1 ||
    input.semanticRecoveryAttempt > AUTOMATIC_TURN_RETRY_MAX
  ) return false
  await lockRecoveryRoot(q, input)
  const result = await q.query(
    `INSERT INTO turn_recovery_jobs (
       user_id,session_id,root_client_message_id,source_client_message_id,
       source_turn_key,error_code,recovery_mode,semantic_recovery_attempt,
       request_json,tape_sha256
     )
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10
      WHERE NOT EXISTS (
        SELECT 1 FROM turn_control_requests c
         WHERE c.user_id=$1 AND c.session_id=$2 AND c.kind='stop'
           AND c.root_client_message_id=$3
      )
     ON CONFLICT (user_id,session_id,root_client_message_id,semantic_recovery_attempt)
       DO NOTHING`,
    [
      input.userId.toString(), input.sessionId, input.rootClientMessageId,
      input.sourceClientMessageId, input.sourceTurnKey, input.errorCode,
      input.recoveryMode, input.semanticRecoveryAttempt,
      JSON.stringify(input.request), input.tapeSha256,
    ],
  )
  return result.rowCount === 1
}

export async function claimDueRecoveryJobs(
  pool: Pool,
  input: { userId: bigint; ownerId: string; leaseMs: number; limit?: number },
): Promise<ClaimedRecoveryJob[]> {
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 4)))
  const result = await pool.query<{
    job_id: string
    user_id: string
    session_id: string
    root_client_message_id: string
    source_client_message_id: string
    source_turn_key: string
    error_code: string
    recovery_mode: 'replay' | 'checkpoint'
    semantic_recovery_attempt: number
    transport_wait_attempt: number
    request_json: Record<string, unknown>
    lease_epoch: string
  }>(
    `WITH due AS (
       SELECT job_id
         FROM turn_recovery_jobs
        WHERE user_id=$1 AND status IN ('queued','leased','sent')
          AND next_attempt_at<=NOW()
          AND (status='queued' OR lease_until<NOW())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE turn_recovery_jobs j
        SET status='leased',lease_owner=$2,lease_epoch=j.lease_epoch+1,
            lease_until=NOW()+($3::bigint * INTERVAL '1 millisecond'),updated_at=NOW()
       FROM due WHERE j.job_id=due.job_id
     RETURNING j.job_id,j.user_id::text,j.session_id,j.root_client_message_id,
               j.source_client_message_id,j.source_turn_key,j.error_code,j.recovery_mode,
               j.semantic_recovery_attempt,j.transport_wait_attempt,j.request_json,
               j.lease_epoch::text`,
    [input.userId.toString(), input.ownerId, Math.max(5_000, Math.trunc(input.leaseMs)), limit],
  )
  return result.rows.map((row) => ({
    jobId: row.job_id,
    userId: BigInt(row.user_id),
    sessionId: row.session_id,
    rootClientMessageId: row.root_client_message_id,
    sourceClientMessageId: row.source_client_message_id,
    sourceTurnKey: row.source_turn_key,
    errorCode: row.error_code,
    recoveryMode: row.recovery_mode,
    semanticRecoveryAttempt: row.semantic_recovery_attempt,
    transportWaitAttempt: row.transport_wait_attempt,
    request: row.request_json,
    leaseOwner: input.ownerId,
    leaseEpoch: Number(row.lease_epoch),
  }))
}

/** Admission transaction fence. A Stop that won the same root advisory lock
 * makes this fail before a new dispatch can be authored. */
export async function bindRecoveryJobDispatch(
  q: Queryable,
  input: {
    jobId: string
    userId: bigint
    sessionId: string
    rootClientMessageId: string
    semanticRecoveryAttempt: number
    leaseOwner: string
    leaseEpoch: number
    dispatchId: string
    dispatchAttemptNo: number
  },
): Promise<boolean> {
  await lockRecoveryRoot(q, input)
  const result = await q.query(
    `UPDATE turn_recovery_jobs
        SET dispatch_id=$8,dispatch_attempt_no=$9,updated_at=NOW()
      WHERE job_id=$1 AND user_id=$2 AND session_id=$3
        AND root_client_message_id=$4 AND semantic_recovery_attempt=$5
        AND status='leased' AND lease_owner=$6 AND lease_epoch=$7
        AND NOT EXISTS (
          SELECT 1 FROM turn_control_requests c
           WHERE c.user_id=$2 AND c.session_id=$3 AND c.kind='stop'
             AND c.root_client_message_id=$4
        )`,
    [
      input.jobId, input.userId.toString(), input.sessionId, input.rootClientMessageId,
      input.semanticRecoveryAttempt, input.leaseOwner, input.leaseEpoch,
      input.dispatchId, input.dispatchAttemptNo,
    ],
  )
  return result.rowCount === 1
}

/** The semantic attempt commits only here, after the embedded gateway has
 * durably admitted the dispatch. Pre-forward/transport waits never advance it. */
export async function markRecoveryContainerReceipt(
  pool: Pool,
  input: { dispatchId: string; dispatchAttemptNo: number; expectedDispatchLeaseEpoch: number },
): Promise<boolean> {
  const result = await pool.query(
    `WITH accepted AS (
       UPDATE turn_dispatches
          SET status='accepted',accepted_at=COALESCE(accepted_at,clock_timestamp()),
              last_attempt_at=clock_timestamp()
        WHERE dispatch_id=$1 AND attempt_no=$2 AND status='admitted' AND lease_epoch=$3
        RETURNING dispatch_id
     ), authoritative AS (
       SELECT dispatch_id FROM accepted
       UNION ALL
       SELECT dispatch_id FROM turn_dispatches
        WHERE dispatch_id=$1 AND attempt_no=$2 AND status='accepted' AND lease_epoch=$3
     )
     UPDATE turn_recovery_jobs
        SET status='forwarded',container_receipt_at=COALESCE(container_receipt_at,NOW()),
            lease_owner=NULL,lease_until=NULL,updated_at=NOW()
      WHERE dispatch_id=$1 AND dispatch_attempt_no=$2 AND status IN ('leased','sent')
        AND EXISTS (SELECT 1 FROM authoritative)`,
    [input.dispatchId, input.dispatchAttemptNo, input.expectedDispatchLeaseEpoch],
  )
  return result.rowCount === 1
}

/** Hold the exact recovery root and job row across the synchronous websocket
 * enqueue. A Stop that committed first makes the SELECT fail; a Stop that
 * arrives later observes status=sent and cancels runtime work without falsely
 * declaring the already-enqueued dispatch not accepted. */
export async function forwardRecoveryUnderRootFence(
  pool: Pool,
  input: {
    job: ClaimedRecoveryJob
    dispatchId: string
    dispatchAttemptNo: number
    dispatchOwner: string
    dispatchLeaseEpoch: number
  },
  forward: () => boolean,
): Promise<boolean> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockRecoveryRoot(client, input.job)
    const eligible = await client.query(
      `SELECT j.job_id
         FROM turn_recovery_jobs j
         JOIN turn_dispatches d
           ON d.dispatch_id=j.dispatch_id AND d.attempt_no=j.dispatch_attempt_no
        WHERE j.job_id=$1 AND j.user_id=$2 AND j.session_id=$3
          AND j.root_client_message_id=$4
          AND j.semantic_recovery_attempt=$5
          AND j.status='leased' AND j.lease_owner=$6 AND j.lease_epoch=$7
          AND d.dispatch_id=$8 AND d.attempt_no=$9
          AND d.status='admitted' AND d.owner_id=$10 AND d.lease_epoch=$11
          AND NOT EXISTS (
            SELECT 1 FROM turn_control_requests c
             WHERE c.user_id=j.user_id AND c.session_id=j.session_id
               AND c.kind='stop' AND c.root_client_message_id=j.root_client_message_id
          )
        FOR UPDATE OF j,d`,
      [
        input.job.jobId,
        input.job.userId.toString(),
        input.job.sessionId,
        input.job.rootClientMessageId,
        input.job.semanticRecoveryAttempt,
        input.job.leaseOwner,
        input.job.leaseEpoch,
        input.dispatchId,
        input.dispatchAttemptNo,
        input.dispatchOwner,
        input.dispatchLeaseEpoch,
      ],
    )
    if (eligible.rowCount !== 1 || !forward()) {
      await client.query('ROLLBACK')
      return false
    }
    const sent = await client.query(
      `UPDATE turn_recovery_jobs
          SET status='sent',updated_at=NOW()
        WHERE job_id=$1 AND status='leased' AND lease_owner=$2 AND lease_epoch=$3`,
      [input.job.jobId, input.job.leaseOwner, input.job.leaseEpoch],
    )
    if (sent.rowCount !== 1) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function releaseRecoveryForTransportWait(
  pool: Pool,
  job: Pick<ClaimedRecoveryJob, 'jobId' | 'leaseOwner' | 'leaseEpoch' | 'transportWaitAttempt'>,
  retryAfterMs = 0,
): Promise<boolean> {
  const waitAttempt = job.transportWaitAttempt + 1
  const result = await pool.query(
    `UPDATE turn_recovery_jobs
        SET status='queued',lease_owner=NULL,lease_until=NULL,
            transport_wait_attempt=transport_wait_attempt+1,
            next_attempt_at=NOW()+($4::bigint * INTERVAL '1 millisecond'),updated_at=NOW()
      WHERE job_id=$1 AND status='leased' AND lease_owner=$2 AND lease_epoch=$3
        AND dispatch_id IS NULL`,
    [job.jobId, job.leaseOwner, job.leaseEpoch, durableRetryDelayMs(waitAttempt, retryAfterMs)],
  )
  return result.rowCount === 1
}

/** Atomically unwind scheduler ownership after a send-unknown failure before
 * the container's durable receipt. The dispatch row/id/attempt/request hash
 * deliberately remain intact: takeover reuses that exact envelope, and the
 * Gateway durable inbox turns a duplicate physical send into a receipt rather
 * than a second execution. If the receipt already won (dispatch is no longer
 * `admitted`), both updates no-op and the semantic attempt remains committed. */
export async function releaseRecoveryPreReceipt(
  pool: Pool,
  input: {
    job: Pick<
      ClaimedRecoveryJob,
      'jobId' | 'leaseOwner' | 'leaseEpoch' | 'transportWaitAttempt'
    >
    dispatchId: string
    dispatchOwner: string
    dispatchLeaseEpoch: number
    retryAfterMs?: number
  },
): Promise<boolean> {
  const waitAttempt = input.job.transportWaitAttempt + 1
  const delayMs = durableRetryDelayMs(waitAttempt, input.retryAfterMs ?? 0)
  const result = await pool.query(
    `WITH released AS (
       UPDATE turn_dispatches
          SET owner_id=NULL,lease_until=NULL,last_attempt_at=clock_timestamp()
        WHERE dispatch_id=$1 AND status='admitted' AND owner_id=$2 AND lease_epoch=$3
        RETURNING dispatch_id
     )
     UPDATE turn_recovery_jobs j
        SET status='queued',lease_owner=NULL,lease_until=NULL,
            transport_wait_attempt=j.transport_wait_attempt+1,
            next_attempt_at=NOW()+($7::bigint * INTERVAL '1 millisecond'),updated_at=NOW()
      WHERE j.job_id=$4 AND j.status IN ('leased','sent') AND j.lease_owner=$5 AND j.lease_epoch=$6
        AND j.dispatch_id=$1 AND EXISTS (SELECT 1 FROM released)`,
    [
      input.dispatchId,
      input.dispatchOwner,
      input.dispatchLeaseEpoch,
      input.job.jobId,
      input.job.leaseOwner,
      input.job.leaseEpoch,
      delayMs,
    ],
  )
  return result.rowCount === 1
}

export async function settleRecoveryJobForTape(
  q: Queryable,
  input: { userId: bigint; sessionId: string; clientMessageId: string; outcome: 'completed' | 'interrupted' | 'crashed' },
): Promise<void> {
  await q.query(
    `UPDATE turn_recovery_jobs
        SET status=CASE
              WHEN $4='completed' THEN 'completed'
              WHEN semantic_recovery_attempt >= $5 THEN 'paused'
              ELSE 'completed'
            END,
            terminal_outcome=$4,
            pause_reason=CASE
              WHEN $4<>'completed' AND semantic_recovery_attempt >= $5
                THEN 'automatic_retry_exhausted'
              ELSE pause_reason
            END,
            updated_at=NOW()
      WHERE user_id=$1 AND session_id=$2
        AND request_json->>'clientMessageId'=$3
        AND status IN ('leased','sent','forwarded')`,
    [input.userId.toString(), input.sessionId, input.clientMessageId, input.outcome, AUTOMATIC_TURN_RETRY_MAX],
  )
}
