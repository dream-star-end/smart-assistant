import type { Pool, PoolClient } from 'pg'

import { canonicalDigestHex } from '../connectors/canonicalJson.js'

export type TurnControlKind = 'stop' | 'permission'
export type TurnControlStatus = 'pending' | 'leased' | 'applied' | 'terminal' | 'cancelled'

export interface PermissionAuthorityInput {
  userId: bigint
  requestId: string
  sessionId: string
  clientMessageId?: string | null
  toolUseId?: string | null
  toolName: string
  input: Record<string, unknown>
  askPayload?: Record<string, unknown> | null
  expiresAt: Date
}

export interface DurableControlInput {
  controlId: string
  userId: bigint
  sessionId: string
  rootClientMessageId?: string | null
  kind: TurnControlKind
  requestId?: string | null
  payload: Record<string, unknown>
}

export interface ClaimedTurnControl {
  controlId: string
  userId: bigint
  sessionId: string
  rootClientMessageId: string | null
  kind: TurnControlKind
  requestId: string | null
  payload: Record<string, unknown>
  leaseOwner: string
  leaseEpoch: number
  deliveryAttempt: number
}

export class TurnControlConflictError extends Error {
  constructor(readonly code: 'CONTROL_ID_CONFLICT' | 'PERMISSION_NOT_PENDING' | 'PERMISSION_CONFLICT') {
    super(code)
    this.name = 'TurnControlConflictError'
  }
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Persist the exact runtime-authored permission prompt before browser
 * delivery. A duplicate request may refresh expiry only when its immutable
 * tool/input authority is byte-for-byte equivalent. */
export async function persistPermissionAuthority(
  pool: Pool,
  input: PermissionAuthorityInput,
): Promise<'inserted' | 'existing'> {
  const digest = canonicalDigestHex(input.input)
  const result = await pool.query<{ inserted: boolean }>(
    `INSERT INTO turn_permission_requests (
       user_id,request_id,session_id,client_message_id,tool_use_id,tool_name,
       input_sha256,input_json,ask_payload_json,expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
     ON CONFLICT (user_id,request_id) DO UPDATE
       SET expires_at=GREATEST(turn_permission_requests.expires_at,EXCLUDED.expires_at),
           updated_at=NOW()
       WHERE turn_permission_requests.session_id=EXCLUDED.session_id
         AND turn_permission_requests.client_message_id IS NOT DISTINCT FROM EXCLUDED.client_message_id
         AND turn_permission_requests.tool_use_id IS NOT DISTINCT FROM EXCLUDED.tool_use_id
         AND turn_permission_requests.tool_name=EXCLUDED.tool_name
         AND turn_permission_requests.input_sha256=EXCLUDED.input_sha256
     RETURNING (xmax=0) AS inserted`,
    [
      input.userId.toString(), input.requestId, input.sessionId,
      input.clientMessageId ?? null, input.toolUseId ?? null, input.toolName,
      digest, JSON.stringify(input.input),
      input.askPayload == null ? null : JSON.stringify(input.askPayload),
      input.expiresAt,
    ],
  )
  if (result.rowCount === 0) throw new TurnControlConflictError('PERMISSION_CONFLICT')
  return result.rows[0]?.inserted ? 'inserted' : 'existing'
}

/** Commit a Stop/permission response before transport. Stop admission and
 * recovery cancellation share this transaction, so no scheduler owner can
 * create a younger semantic attempt after a persisted user cancellation. */
export async function admitDurableControl(
  pool: Pool,
  input: DurableControlInput,
): Promise<{ inserted: boolean; status: TurnControlStatus }> {
  return inTransaction(pool, async (client) => {
    let effectiveRootClientMessageId = input.rootClientMessageId ?? null
    if (input.kind === 'stop') {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(
           'oc_recovery_session:' || $1::text || ':' || $2, 0
         ))`,
        [input.userId.toString(), input.sessionId],
      )
      if (effectiveRootClientMessageId !== null) {
        const lineage = await client.query<{ root_client_message_id: string }>(
          `SELECT root_client_message_id FROM turn_recovery_jobs
            WHERE user_id=$1 AND session_id=$2
              AND (root_client_message_id=$3 OR request_json->>'clientMessageId'=$3)
            ORDER BY semantic_recovery_attempt DESC LIMIT 1`,
          [input.userId.toString(), input.sessionId, effectiveRootClientMessageId],
        )
        effectiveRootClientMessageId = lineage.rows[0]?.root_client_message_id ??
          effectiveRootClientMessageId
      }
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(
           'oc_recovery:' || $1::text || ':' || $2 || ':' || COALESCE($3,''), 0
         ))`,
        [input.userId.toString(), input.sessionId, effectiveRootClientMessageId],
      )
    }
    const inserted = await client.query<{ status: TurnControlStatus }>(
      `INSERT INTO turn_control_requests (
         control_id,user_id,session_id,root_client_message_id,kind,request_id,payload_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (control_id) DO NOTHING
       RETURNING status`,
      [
        input.controlId, input.userId.toString(), input.sessionId,
        effectiveRootClientMessageId, input.kind, input.requestId ?? null,
        JSON.stringify(input.payload),
      ],
    )
    if (inserted.rowCount === 0) {
      const prior = await client.query<{
        user_id: string
        session_id: string
        root_client_message_id: string | null
        kind: TurnControlKind
        request_id: string | null
        payload_json: Record<string, unknown>
        status: TurnControlStatus
      }>(
        `SELECT user_id::text,session_id,root_client_message_id,kind,request_id,payload_json,status
           FROM turn_control_requests WHERE control_id=$1 FOR UPDATE`,
        [input.controlId],
      )
      const row = prior.rows[0]
      if (
        !row || row.user_id !== input.userId.toString() || row.session_id !== input.sessionId ||
        row.root_client_message_id !== effectiveRootClientMessageId ||
        row.kind !== input.kind || row.request_id !== (input.requestId ?? null) ||
        canonicalDigestHex(row.payload_json) !== canonicalDigestHex(input.payload)
      ) {
        throw new TurnControlConflictError('CONTROL_ID_CONFLICT')
      }
      return { inserted: false, status: row.status }
    }

    if (input.kind === 'stop') {
      const cancellable = await client.query<{
        status: 'queued' | 'leased' | 'sent'
        dispatch_id: string | null
        dispatch_attempt_no: number | null
      }>(
        `SELECT status,dispatch_id,dispatch_attempt_no
           FROM turn_recovery_jobs
          WHERE user_id=$1 AND session_id=$2
            AND ($3::text IS NULL OR root_client_message_id=$3)
            AND status IN ('queued','leased','sent')
          FOR UPDATE`,
        [input.userId.toString(), input.sessionId, effectiveRootClientMessageId],
      )
      await client.query(
        `UPDATE turn_recovery_jobs
            SET status='cancelled',lease_owner=NULL,lease_until=NULL,
                pause_reason='user_stop',updated_at=NOW()
          WHERE user_id=$1 AND session_id=$2
            AND ($3::text IS NULL OR root_client_message_id=$3)
            AND status IN ('queued','leased','sent')`,
        [input.userId.toString(), input.sessionId, effectiveRootClientMessageId],
      )
      // queued/leased means the root-fenced physical enqueue has not won yet.
      // Close its admitted dispatch as not-accepted in the same transaction;
      // sent jobs may already be executing and are stopped only by the
      // ordered runtime control below.
      const preSendDispatches = cancellable.rows.filter(
        (row) => row.status !== 'sent' && row.dispatch_id !== null,
      )
      for (const row of preSendDispatches) {
        await client.query(
          `UPDATE turn_dispatches
              SET status='terminal',outcome='not_accepted',failure_code='USER_CANCELLED',
                  owner_id=NULL,lease_until=NULL,terminal_at=NOW(),last_attempt_at=NOW()
            WHERE dispatch_id=$1 AND attempt_no=$2 AND status='admitted'`,
          [row.dispatch_id, row.dispatch_attempt_no],
        )
      }
    } else {
      const permission = await client.query<{ status: string }>(
        `SELECT status FROM turn_permission_requests
          WHERE user_id=$1 AND request_id=$2 AND session_id=$3
            AND status='pending' AND expires_at>NOW()
          FOR UPDATE`,
        [input.userId.toString(), input.requestId, input.sessionId],
      )
      if (permission.rowCount !== 1) {
        throw new TurnControlConflictError('PERMISSION_NOT_PENDING')
      }
      await client.query(
        `UPDATE turn_permission_requests
            SET status='responded',response_control_id=$4,response_json=$5::jsonb,updated_at=NOW()
          WHERE user_id=$1 AND request_id=$2 AND session_id=$3`,
        [
          input.userId.toString(), input.requestId, input.sessionId,
          input.controlId, JSON.stringify(input.payload),
        ],
      )
    }
    return { inserted: true, status: 'pending' }
  })
}

/** Final tape is the durable terminal authority for an applied Stop. This
 * closes the control row even when its live final websocket frame was lost;
 * the browser's persisted replay then receives `terminal` from Master. */
export async function settleStopControlsForTurn(
  q: Pick<Pool | PoolClient, 'query'>,
  input: { userId: bigint; sessionId: string; clientMessageId: string },
): Promise<number> {
  const result = await q.query(
    `UPDATE turn_control_requests c
        SET status='terminal',lease_owner=NULL,lease_until=NULL,
            applied_at=COALESCE(applied_at,NOW()),
            terminal_at=COALESCE(terminal_at,NOW()),updated_at=NOW()
      WHERE c.user_id=$1 AND c.session_id=$2 AND c.kind='stop'
        AND c.status IN ('pending','leased','applied')
        AND (
          c.root_client_message_id=$3 OR EXISTS (
            SELECT 1 FROM turn_recovery_jobs j
             WHERE j.user_id=c.user_id AND j.session_id=c.session_id
               AND j.root_client_message_id=c.root_client_message_id
               AND j.request_json->>'clientMessageId'=$3
          )
        )`,
    [input.userId.toString(), input.sessionId, input.clientMessageId],
  )
  return result.rowCount ?? 0
}

/** Claim due controls with PostgreSQL row locks. A dead Master's lease expires
 * and another process resumes delivery; there is no browser-memory authority. */
export async function claimDueTurnControls(
  pool: Pool,
  input: { userId: bigint; ownerId: string; leaseMs: number; limit?: number },
): Promise<ClaimedTurnControl[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)))
  const result = await pool.query<{
    control_id: string
    user_id: string
    session_id: string
    root_client_message_id: string | null
    kind: TurnControlKind
    request_id: string | null
    payload_json: Record<string, unknown>
    lease_epoch: string
    delivery_attempt: number
  }>(
    `WITH due AS (
       SELECT control_id
         FROM turn_control_requests
        WHERE user_id=$1
          AND status IN ('pending','leased')
          AND next_attempt_at<=NOW()
          AND (status='pending' OR lease_until<NOW())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE turn_control_requests c
        SET status='leased',lease_owner=$2,lease_epoch=c.lease_epoch+1,
            lease_until=NOW()+($3::bigint * INTERVAL '1 millisecond'),
            delivery_attempt=c.delivery_attempt+1,updated_at=NOW()
       FROM due
      WHERE c.control_id=due.control_id
      RETURNING c.control_id,c.user_id::text,c.session_id,c.root_client_message_id,
                c.kind,c.request_id,c.payload_json,c.lease_epoch::text,c.delivery_attempt`,
    [input.userId.toString(), input.ownerId, Math.max(1000, Math.trunc(input.leaseMs)), limit],
  )
  return result.rows.map((row) => ({
    controlId: row.control_id,
    userId: BigInt(row.user_id),
    sessionId: row.session_id,
    rootClientMessageId: row.root_client_message_id,
    kind: row.kind,
    requestId: row.request_id,
    payload: row.payload_json,
    leaseOwner: input.ownerId,
    leaseEpoch: Number(row.lease_epoch),
    deliveryAttempt: row.delivery_attempt,
  }))
}

export function durableRetryDelayMs(deliveryAttempt: number, retryAfterMs = 0): number {
  const exponent = Math.max(0, Math.min(8, Math.trunc(deliveryAttempt) - 1))
  return Math.max(retryAfterMs, Math.min(300_000, 2_000 * (2 ** exponent)))
}

export async function releaseTurnControlForRetry(
  pool: Pool,
  control: Pick<ClaimedTurnControl, 'controlId' | 'leaseOwner' | 'leaseEpoch' | 'deliveryAttempt'>,
  retryAfterMs = 0,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE turn_control_requests
        SET status='pending',lease_owner=NULL,lease_until=NULL,
            next_attempt_at=NOW()+($4::bigint * INTERVAL '1 millisecond'),updated_at=NOW()
      WHERE control_id=$1 AND status='leased' AND lease_owner=$2 AND lease_epoch=$3`,
    [
      control.controlId, control.leaseOwner, control.leaseEpoch,
      durableRetryDelayMs(control.deliveryAttempt, retryAfterMs),
    ],
  )
  return result.rowCount === 1
}

export async function markTurnControlReceipt(
  pool: Pool,
  input: {
    userId: bigint
    controlId: string
    status: 'applied' | 'terminal'
    attempt?: number
    errorCode?: string | null
  },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE turn_control_requests
        SET status=CASE
              WHEN status='terminal' THEN 'terminal'
              WHEN $3='terminal' THEN 'terminal'
              ELSE 'applied'
            END,
            error_code=COALESCE($5,error_code),lease_owner=NULL,lease_until=NULL,
            applied_at=COALESCE(applied_at,NOW()),
            terminal_at=CASE WHEN $3='terminal' THEN COALESCE(terminal_at,NOW()) ELSE terminal_at END,
            updated_at=NOW()
      WHERE control_id=$1 AND user_id=$2
        AND status IN ('leased','applied','terminal')
        AND ($4::integer IS NULL OR delivery_attempt=$4)`,
    [input.controlId, input.userId.toString(), input.status, input.attempt ?? null, input.errorCode ?? null],
  )
  return result.rowCount === 1
}
