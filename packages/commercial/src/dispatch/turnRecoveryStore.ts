import type { Pool, PoolClient } from 'pg'

import { AUTOMATIC_TURN_RETRY_MAX } from '@openclaude/protocol'

import { durableRetryDelayMs } from './turnControlStore.js'
import type { Queryable } from './turnDispatchStore.js'
import { PREPARATION_RETRY_MAX } from './preparationRecovery.js'

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
  sourceTurnKey: string | null
  jobOrigin?: 'finalized_tape' | 'pre_transfer_enrichment'
  preparationRetryCount?: number
  preparationSendIntentAt?: Date | null
  errorCode: string
  recoveryMode: 'replay' | 'checkpoint'
  semanticRecoveryAttempt: number
  transportWaitAttempt: number
  request: Record<string, unknown>
  leaseOwner: string
  leaseEpoch: number
}

/** S must be acquired before A whenever a transaction can touch session state. */
export async function lockRecoverySession(
  q: Queryable,
  input: { userId: bigint; sessionId: string },
): Promise<{ deleted: boolean; latestClientMessageId: string | null } | null> {
  const result = await q.query<{ messages: string; deleted_at: string | null }>(
    `SELECT messages,deleted_at FROM client_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`,
    [input.sessionId, `c:${input.userId.toString()}`],
  )
  const row = result.rows[0]
  if (!row) return null
  try {
    const messages = JSON.parse(row.messages)
    if (!Array.isArray(messages)) return null
    const latest = [...messages].reverse().find((message) => message?.role === 'user')
    return { deleted: row.deleted_at !== null, latestClientMessageId: typeof latest?.id === 'string' ? latest.id : null }
  } catch { return null }
}

export async function lockRecoverySessionAdvisory(q: Queryable, input: { userId: bigint; sessionId: string }): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtextextended(
    'oc_recovery_session:' || $1::text || ':' || $2, 0))`,
  [input.userId.toString(), input.sessionId])
}

export async function bumpPreparationVisibility(q: Queryable, input: { userId: bigint; sessionId: string }): Promise<void> {
  await q.query(`UPDATE client_sessions SET history_revision=history_revision+1,
    timeline_generation=timeline_generation+1,
    updated_at=GREATEST(updated_at+1,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint)
    WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [input.sessionId, `c:${input.userId.toString()}`])
}

/** Caller holds S then A. Cancellation never rewrites an intent-bearing child
 * as not executed, including a source that was superseded before first bind. */
export async function cancelPreparationJobUnderFence(q: Queryable,
  input: { jobId: string; userId: bigint; sessionId: string; leaseOwner: string; leaseEpoch: number },
): Promise<boolean> {
  const selected = await q.query<{ dispatch_id: string | null; source_dispatch_id: string; preparation_send_intent_at: Date | null }>(
    `UPDATE turn_recovery_jobs SET status='cancelled',pause_reason='preparation_fenced',lease_owner=NULL,lease_until=NULL,updated_at=NOW()
     WHERE job_id=$1 AND user_id=$2 AND session_id=$3 AND job_origin='pre_transfer_enrichment'
       AND status='leased' AND lease_owner=$4 AND lease_epoch=$5
     RETURNING dispatch_id,source_dispatch_id,preparation_send_intent_at`,
    [input.jobId,input.userId.toString(),input.sessionId,input.leaseOwner,input.leaseEpoch])
  const row = selected.rows[0]
  if (!row) return false
  if (row.preparation_send_intent_at === null) {
    await q.query(`UPDATE turn_dispatches SET status='terminal',outcome='not_accepted',failure_code='USER_CANCELLED',
      terminal_at=NOW(),owner_id=NULL,lease_until=NULL,last_attempt_at=NOW()
      WHERE dispatch_id=$1 AND accepted_at IS NULL AND (status='admitted' OR (status='terminal' AND outcome='not_accepted'))`,
    [row.dispatch_id ?? row.source_dispatch_id])
  }
  await bumpPreparationVisibility(q,input)
  return true
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
           AND (c.root_client_message_id=$3 OR (c.root_client_message_id IS NULL AND c.created_at >= (
              SELECT root.admitted_at FROM turn_dispatches root
               WHERE root.user_id=c.user_id AND root.session_id=c.session_id
                 AND root.client_message_id=$3 ORDER BY root.admitted_at LIMIT 1)))
      )
       AND NOT EXISTS (
         SELECT 1 FROM turn_recovery_jobs p
          WHERE p.user_id=$1 AND p.session_id=$2 AND p.root_client_message_id=$3
            AND p.status='paused' AND p.pause_reason='automatic_silent_no_progress'
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
    source_turn_key: string | null
    job_origin: 'finalized_tape' | 'pre_transfer_enrichment'
    preparation_retry_count: number
    preparation_send_intent_at: Date | null
    error_code: string
    recovery_mode: 'replay' | 'checkpoint'
    semantic_recovery_attempt: number
    transport_wait_attempt: number
    request_json: Record<string, unknown>
    lease_epoch: string
  }>(
    `WITH due AS (
       SELECT candidate.job_id
         FROM turn_recovery_jobs candidate
        WHERE candidate.user_id=$1 AND candidate.status IN ('queued','leased','sent')
          AND candidate.next_attempt_at<=NOW()
          AND (candidate.status='queued' OR candidate.lease_until<NOW())
          AND NOT EXISTS (
            SELECT 1 FROM turn_recovery_jobs paused
             WHERE paused.user_id=candidate.user_id
               AND paused.session_id=candidate.session_id
               AND paused.root_client_message_id=candidate.root_client_message_id
               AND paused.status='paused'
               AND paused.pause_reason='automatic_silent_no_progress'
          )
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
               j.lease_epoch::text,j.job_origin,j.preparation_retry_count,j.preparation_send_intent_at`,
    [input.userId.toString(), input.ownerId, Math.max(5_000, Math.trunc(input.leaseMs)), limit],
  )
  return result.rows.map((row) => ({
    jobId: row.job_id,
    userId: BigInt(row.user_id),
    sessionId: row.session_id,
    rootClientMessageId: row.root_client_message_id,
    sourceClientMessageId: row.source_client_message_id,
    sourceTurnKey: row.source_turn_key,
    jobOrigin: row.job_origin ?? 'finalized_tape',
    preparationRetryCount: row.preparation_retry_count ?? 0,
    preparationSendIntentAt: row.preparation_send_intent_at ?? null,
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
             AND (c.root_client_message_id=$4 OR (c.root_client_message_id IS NULL AND c.created_at >= (
              SELECT root.admitted_at FROM turn_dispatches root
               WHERE root.user_id=c.user_id AND root.session_id=c.session_id
                 AND root.client_message_id=$4 ORDER BY root.admitted_at LIMIT 1)))
        )
        AND NOT EXISTS (
          SELECT 1 FROM turn_recovery_jobs p
           WHERE p.user_id=$2 AND p.session_id=$3 AND p.root_client_message_id=$4
             AND p.status='paused' AND p.pause_reason='automatic_silent_no_progress'
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
  const located = await pool.query<{ user_id: string; session_id: string; root_client_message_id: string }>(
    `SELECT user_id::text,session_id,root_client_message_id FROM turn_recovery_jobs
      WHERE dispatch_id=$1 AND dispatch_attempt_no=$2`, [input.dispatchId, input.dispatchAttemptNo])
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = located.rows[0]
    if (row) await lockRecoveryRoot(client, { userId: BigInt(row.user_id), sessionId: row.session_id, rootClientMessageId: row.root_client_message_id })
    if (!row) {
      await client.query(`UPDATE turn_dispatches SET status='accepted',accepted_at=COALESCE(accepted_at,clock_timestamp()),
        last_attempt_at=clock_timestamp() WHERE dispatch_id=$1 AND attempt_no=$2 AND status='admitted' AND lease_epoch=$3`,
      [input.dispatchId,input.dispatchAttemptNo,input.expectedDispatchLeaseEpoch])
      await client.query('COMMIT')
      return false
    }
  const result = await client.query(
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
  await client.query('COMMIT')
  return result.rowCount === 1
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }

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
  if (input.job.jobOrigin === 'pre_transfer_enrichment' && !await commitPreparationSendIntent(pool, input)) return false
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    const session = await lockRecoverySession(client, input.job)
    if (!session || session.deleted || (input.job.jobOrigin === 'pre_transfer_enrichment' &&
      session.latestClientMessageId !== input.job.request.clientMessageId)) {
      await client.query('ROLLBACK')
      return false
    }
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
               AND c.kind='stop' AND (c.root_client_message_id=j.root_client_message_id OR (c.root_client_message_id IS NULL AND c.created_at >= (
              SELECT root.admitted_at FROM turn_dispatches root
               WHERE root.user_id=c.user_id AND root.session_id=c.session_id
                 AND root.client_message_id=j.root_client_message_id ORDER BY root.admitted_at LIMIT 1)))
          )
          AND NOT EXISTS (
            SELECT 1 FROM turn_recovery_jobs p
             WHERE p.user_id=j.user_id AND p.session_id=j.session_id
               AND p.root_client_message_id=j.root_client_message_id
               AND p.status='paused' AND p.pause_reason='automatic_silent_no_progress'
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

/** The intent commit cannot be rolled back by a subsequent websocket failure. */
async function commitPreparationSendIntent(
  pool: Pool,
  input: Parameters<typeof forwardRecoveryUnderRootFence>[1],
): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const session = await lockRecoverySession(client, input.job)
    if (!session || session.deleted || session.latestClientMessageId !== input.job.request.clientMessageId) {
      await client.query('ROLLBACK')
      return false
    }
    await lockRecoveryRoot(client, input.job)
    const result = await client.query(`UPDATE turn_recovery_jobs j
      SET preparation_send_intent_at=COALESCE(preparation_send_intent_at,clock_timestamp()),updated_at=NOW()
      FROM turn_dispatches d
      WHERE j.job_id=$1 AND j.user_id=$2 AND j.session_id=$3 AND j.root_client_message_id=$4
        AND j.job_origin='pre_transfer_enrichment' AND j.status='leased'
        AND j.lease_owner=$5 AND j.lease_epoch=$6 AND j.preparation_retry_count<$11
        AND j.dispatch_id=d.dispatch_id AND j.dispatch_attempt_no=d.attempt_no
        AND d.dispatch_id=$7 AND d.attempt_no=$8 AND d.owner_id=$9 AND d.lease_epoch=$10
        AND d.status='admitted' AND d.accepted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM turn_control_requests c
          WHERE c.user_id=j.user_id AND c.session_id=j.session_id AND c.kind='stop'
          AND (c.root_client_message_id=j.root_client_message_id OR (c.root_client_message_id IS NULL AND c.created_at >= (
              SELECT root.admitted_at FROM turn_dispatches root
               WHERE root.user_id=c.user_id AND root.session_id=c.session_id
                 AND root.client_message_id=j.root_client_message_id ORDER BY root.admitted_at LIMIT 1))))`,
    [input.job.jobId,input.job.userId.toString(),input.job.sessionId,input.job.rootClientMessageId,
      input.job.leaseOwner,input.job.leaseEpoch,input.dispatchId,input.dispatchAttemptNo,
      input.dispatchOwner,input.dispatchLeaseEpoch,PREPARATION_RETRY_MAX])
    await client.query('COMMIT')
    return result.rowCount === 1
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

export type PreparationReleaseResult = 'queued' | 'exhausted' | 'unknown' | 'fenced'

/** Same durable child, bounded preparation-only retries. Intent is never reset. */
export async function releasePreparationPreReceipt(
  pool: Pool,
  input: Parameters<typeof releaseRecoveryPreReceipt>[1] & { failureCode: string },
): Promise<PreparationReleaseResult> {
  const located = await pool.query<{ user_id: string; session_id: string; root_client_message_id: string }>(
    `SELECT user_id::text,session_id,root_client_message_id FROM turn_recovery_jobs WHERE job_id=$1`, [input.job.jobId])
  const identity = located.rows[0]
  if (!identity) return 'fenced'
  const root = { userId: BigInt(identity.user_id), sessionId: identity.session_id, rootClientMessageId: identity.root_client_message_id }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const session = await lockRecoverySession(client, root)
    await lockRecoveryRoot(client, root)
    const selected = await client.query<{
      preparation_retry_count: number; preparation_send_intent_at: Date | null;
      client_message_id: string; stopped: boolean;
    }>(`SELECT j.preparation_retry_count,j.preparation_send_intent_at,d.client_message_id,
      EXISTS (SELECT 1 FROM turn_control_requests c WHERE c.user_id=j.user_id AND c.session_id=j.session_id
        AND c.kind='stop' AND (c.root_client_message_id=j.root_client_message_id OR (c.root_client_message_id IS NULL AND c.created_at >= (
              SELECT root.admitted_at FROM turn_dispatches root
               WHERE root.user_id=c.user_id AND root.session_id=c.session_id
                 AND root.client_message_id=j.root_client_message_id ORDER BY root.admitted_at LIMIT 1)))) AS stopped
      FROM turn_recovery_jobs j JOIN turn_dispatches d ON d.dispatch_id=j.dispatch_id AND d.attempt_no=j.dispatch_attempt_no
      WHERE j.job_id=$1 AND j.job_origin='pre_transfer_enrichment' AND j.status IN ('leased','sent')
      AND j.lease_owner=$2 AND j.lease_epoch=$3 AND d.dispatch_id=$4 AND d.status='admitted'
      AND d.owner_id=$5 AND d.lease_epoch=$6 AND d.accepted_at IS NULL FOR UPDATE OF j,d`,
    [input.job.jobId,input.job.leaseOwner,input.job.leaseEpoch,input.dispatchId,input.dispatchOwner,input.dispatchLeaseEpoch])
    const row = selected.rows[0]
    if (!row) { await client.query('ROLLBACK'); return 'fenced' }
    const fenced = !session || session.deleted || session.latestClientMessageId !== row.client_message_id || row.stopped
    const pureTimeout = !row.preparation_send_intent_at && input.failureCode === 'dispatch_enrichment_timeout'
    const count = row.preparation_retry_count + (pureTimeout && !fenced ? 1 : 0)
    const exhausted = pureTimeout && count >= PREPARATION_RETRY_MAX
    const terminal = !row.preparation_send_intent_at && (fenced || exhausted)
    await client.query(`UPDATE turn_dispatches SET owner_id=NULL,lease_until=NULL,last_attempt_at=clock_timestamp(),
      status=CASE WHEN $2 THEN 'terminal' ELSE status END,
      outcome=CASE WHEN $2 THEN 'not_accepted' ELSE outcome END,
      failure_code=CASE WHEN $2 THEN $3 ELSE failure_code END,
      terminal_at=CASE WHEN $2 THEN NOW() ELSE terminal_at END
      WHERE dispatch_id=$1`, [input.dispatchId,terminal,fenced ? 'USER_CANCELLED' : 'dispatch_preparation_retry_exhausted'])
    await client.query(`UPDATE turn_recovery_jobs SET status=$2,preparation_retry_count=$3,
      pause_reason=$4,lease_owner=NULL,lease_until=NULL,
      transport_wait_attempt=transport_wait_attempt+CASE WHEN $5 THEN 0 ELSE 1 END,
      next_attempt_at=NOW()+($6::bigint * INTERVAL '1 millisecond'),updated_at=NOW() WHERE job_id=$1`,
    [input.job.jobId,fenced ? 'cancelled' : exhausted ? 'paused' : 'queued',count,
      fenced ? 'preparation_fenced' : exhausted ? 'preparation_retry_exhausted' : null,pureTimeout,
      pureTimeout ? 5000 : durableRetryDelayMs(input.job.transportWaitAttempt+1,input.retryAfterMs ?? 0)])
    await bumpPreparationVisibility(client, root)
    await client.query('COMMIT')
    return fenced ? 'fenced' : exhausted ? 'exhausted' : row.preparation_send_intent_at ? 'unknown' : 'queued'
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
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
  const located = await pool.query<{ user_id: string; session_id: string; root_client_message_id: string }>(
    `SELECT user_id::text,session_id,root_client_message_id FROM turn_recovery_jobs WHERE job_id=$1`, [input.job.jobId])
  const row = located.rows[0]
  if (!row) return false
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockRecoveryRoot(client, { userId: BigInt(row.user_id), sessionId: row.session_id, rootClientMessageId: row.root_client_message_id })
  const result = await client.query(
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
  await client.query('COMMIT')
  return result.rowCount === 1
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }

}

export type RecoveryJobTerminalRow = {
  rootClientMessageId: string
  errorCode: string
  semanticAttempt: number
  status: 'completed' | 'paused' | 'cancelled'
  pauseReason: string | null
}

function mapRecoveryJobTerminalRows(
  rows: Array<{
    root_client_message_id: string
    error_code: string | null
    semantic_recovery_attempt: number | string
    status: string
    pause_reason: string | null
  }>,
): RecoveryJobTerminalRow[] {
  const allowed = new Set<RecoveryJobTerminalRow['status']>(['completed', 'paused', 'cancelled'])
  const mapped: RecoveryJobTerminalRow[] = []
  for (const row of rows) {
    if (!allowed.has(row.status as RecoveryJobTerminalRow['status'])) continue
    mapped.push({
      rootClientMessageId: row.root_client_message_id,
      errorCode: row.error_code ?? '',
      semanticAttempt: Number(row.semantic_recovery_attempt),
      status: row.status as RecoveryJobTerminalRow['status'],
      pauseReason: row.pause_reason,
    })
  }
  return mapped
}

export async function settleRecoveryJobForTape(
  q: Queryable,
  input: { userId: bigint; sessionId: string; clientMessageId: string; outcome: 'completed' | 'interrupted' | 'crashed' },
): Promise<RecoveryJobTerminalRow[]> {
  const result = await q.query(
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
        AND status IN ('leased','sent','forwarded')
      RETURNING root_client_message_id, error_code, semantic_recovery_attempt, status, pause_reason`,
    [input.userId.toString(), input.sessionId, input.clientMessageId, input.outcome, AUTOMATIC_TURN_RETRY_MAX],
  )
  return mapRecoveryJobTerminalRows(result.rows as Array<{
    root_client_message_id: string
    error_code: string | null
    semantic_recovery_attempt: number | string
    status: string
    pause_reason: string | null
  }>)
}

/** Persist the no-progress circuit breaker on the exact recovery lineage.
 * The current semantic attempt becomes the durable paused receipt; any
 * descendant authored by an older concurrent master is cancelled under the
 * same root advisory lock. */
export async function pauseSilentRecoveryLineage(
  q: Queryable,
  input: {
    userId: bigint
    sessionId: string
    rootClientMessageId: string
    currentAttempt: number
    terminalOutcome: 'completed' | 'interrupted' | 'crashed'
  },
): Promise<RecoveryJobTerminalRow[]> {
  if (!Number.isSafeInteger(input.currentAttempt) || input.currentAttempt < 1) return []
  await lockRecoveryRoot(q, input)
  const result = await q.query(
    `UPDATE turn_recovery_jobs
        SET status=CASE
              WHEN semantic_recovery_attempt=$4 THEN 'paused'
              ELSE 'cancelled'
            END,
            pause_reason='automatic_silent_no_progress',
            terminal_outcome=CASE
              WHEN semantic_recovery_attempt=$4 THEN $5
              ELSE terminal_outcome
            END,
            lease_owner=NULL,lease_until=NULL,updated_at=NOW()
      WHERE user_id=$1 AND session_id=$2 AND root_client_message_id=$3
        AND semantic_recovery_attempt >= $4
        AND status <> 'cancelled'
      RETURNING root_client_message_id, error_code, semantic_recovery_attempt, status, pause_reason`,
    [
      input.userId.toString(), input.sessionId, input.rootClientMessageId,
      input.currentAttempt, input.terminalOutcome,
    ],
  )
  return mapRecoveryJobTerminalRows(result.rows as Array<{
    root_client_message_id: string
    error_code: string | null
    semantic_recovery_attempt: number | string
    status: string
    pause_reason: string | null
  }>)
}
