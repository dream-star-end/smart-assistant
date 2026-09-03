import type { Pool, PoolClient } from 'pg'

import { isClientMessageId } from '@openclaude/protocol'

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

/** Legacy CCB/Codex permission window when the frame omits expiresAt. */
export const DEFAULT_PERMISSION_TTL_MS = 30 * 60_000
/** Cap so a bogus/future-skewed frame cannot keep a prompt pending forever. */
export const MAX_PERMISSION_TTL_MS = 24 * 60 * 60_000

/** Prefer the frame-carried expiry (detached ask_user: 24h). Fall back to
 *  the historical 30-minute window for old gateways that omit expiresAt. */
export function resolvePermissionExpiresAt(
  frameExpiresAt: unknown,
  nowMs: number = Date.now(),
): Date {
  if (typeof frameExpiresAt === 'number' && Number.isFinite(frameExpiresAt)) {
    const capped = Math.min(frameExpiresAt, nowMs + MAX_PERMISSION_TTL_MS)
    if (capped > nowMs) return new Date(capped)
  }
  return new Date(nowMs + DEFAULT_PERMISSION_TTL_MS)
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
      // INC-20260903-PENDING-PERMISSION-ZOMBIE — a user Stop makes every
      // still-open prompt of that turn unanswerable (the runtime aborts the
      // tool). Close the durable authority in the same transaction so the
      // hello-time replay can never re-materialise a card the runtime already
      // gave up on. Detached ask_user prompts outlive their turn and are
      // deliberately left alone.
      await cancelPendingPermissionPromptsForTurn(client, {
        userId: input.userId,
        sessionId: input.sessionId,
        clientMessageId: effectiveRootClientMessageId,
        reason: 'user_stop',
        controlId: input.controlId,
      })
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

// ---------------------------------------------------------------------------
// INC-20260903-PENDING-PERMISSION-ZOMBIE — durable settlement of prompts.
//
// Before this, only the user's own inbound.permission_response ever moved a
// turn_permission_requests row out of `pending`. Every container-side
// settlement (Stop → runtime abort, disconnect/timeout/crash auto-deny,
// another tab answering first) left the Master row `pending` until expires_at,
// and the hello-time replay from INC-…-LOST then re-sent a prompt whose
// runtime waiter was long gone: a fresh "等待回答" card on every reconnect.
// "DB pending" must mean "still answerable". These helpers close the row from
// every settlement authority Master can observe.
// ---------------------------------------------------------------------------

export type PermissionPromptCancelReason =
  | 'user_stop'
  | 'turn_finalized'
  | 'runtime_settled'

/** Detached ask_user prompts (`ask-user:` requestIds) are not bound to a turn:
 * they stay answerable for 24h after Stop / turn end / session eviction and
 * must never be closed by turn-scoped settlement. */
const NOT_DETACHED_ASK_USER_SQL = `request_id NOT LIKE 'ask-user:%'`

/** Close every still-pending prompt that belongs to a turn lineage. With a
 * null clientMessageId (legacy peer-wide Stop) every non-detached prompt of the
 * session is closed — the runtime interrupts the whole peer in that case.
 * Matches the root itself and recovery children whose request carried the
 * root as `clientMessageId`, mirroring settleStopControlsForTurn. */
export async function cancelPendingPermissionPromptsForTurn(
  q: Pick<Pool | PoolClient, 'query'>,
  input: {
    userId: bigint
    sessionId: string
    clientMessageId: string | null
    reason: PermissionPromptCancelReason
    controlId?: string | null
  },
): Promise<number> {
  const result = await q.query(
    `UPDATE turn_permission_requests p
        SET status='cancelled',
            response_control_id=COALESCE(p.response_control_id,$4),
            response_json=COALESCE(p.response_json,$5::jsonb),
            updated_at=NOW()
      WHERE p.user_id=$1 AND p.session_id=$2 AND p.status='pending'
        AND ${NOT_DETACHED_ASK_USER_SQL}
        AND (
          $3::text IS NULL
          OR p.client_message_id=$3
          OR EXISTS (
            SELECT 1 FROM turn_recovery_jobs j
             WHERE j.user_id=p.user_id AND j.session_id=p.session_id
               AND j.root_client_message_id=$3
               AND j.request_json->>'clientMessageId'=p.client_message_id
          )
          OR EXISTS (
            SELECT 1 FROM turn_recovery_jobs j
             WHERE j.user_id=p.user_id AND j.session_id=p.session_id
               AND j.root_client_message_id=p.client_message_id
               AND j.request_json->>'clientMessageId'=$3
          )
        )`,
    [
      input.userId.toString(), input.sessionId, input.clientMessageId,
      input.controlId ?? null,
      JSON.stringify({ behavior: 'deny', settledBy: 'master', reason: input.reason }),
    ],
  )
  return result.rowCount ?? 0
}

export interface RuntimePermissionSettlementInput {
  userId: bigint
  sessionId: string
  requestId: string
  behavior: 'allow' | 'deny'
  reason: string
  answers?: Record<string, string> | null
}

/** Record a container-emitted `outbound.permission_settled` frame. The runtime
 * is the only authority on whether a prompt is still answerable; whatever it
 * reports (remote answer from another tab, disconnect/timeout/crash deny,
 * duplicate already_settled) means the row must leave `pending`. A row that
 * the user's own durable response already moved to `responded` is untouched. */
export async function settlePermissionPromptFromRuntime(
  q: Pick<Pool | PoolClient, 'query'>,
  input: RuntimePermissionSettlementInput,
): Promise<boolean> {
  const status = input.behavior === 'allow' ? 'responded' : 'cancelled'
  const result = await q.query(
    `UPDATE turn_permission_requests
        SET status=$4,
            response_json=COALESCE(response_json,$5::jsonb),
            updated_at=NOW()
      WHERE user_id=$1 AND request_id=$2 AND session_id=$3 AND status='pending'`,
    [
      input.userId.toString(), input.requestId, input.sessionId, status,
      JSON.stringify({
        behavior: input.behavior,
        settledBy: 'runtime',
        reason: input.reason,
        ...(input.answers ? { answers: input.answers } : {}),
      }),
    ],
  )
  return result.rowCount === 1
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

// ---------------------------------------------------------------------------
// INC-20260903-PENDING-PERMISSION-LOST — hello-time replay of durable prompts.
//
// persistPermissionAuthority makes the prompt durable *before* the browser
// sees it, but nothing ever re-read that authority for a browser that attached
// after the frame was emitted (bridge/container reconnect window). The engine
// then waits in waitingForUserInput with the watchdog suppressed and the user
// has no card to answer. The bridge hello handler now re-materialises still
// answerable rows through these pure helpers.
// ---------------------------------------------------------------------------

/** Bound per hello peer; a session realistically has 0-1 open prompts. */
export const HELLO_PENDING_PERMISSION_MAX_ROWS = 8

export interface PendingPermissionPromptRow {
  requestId: string
  clientMessageId: string | null
  toolUseId: string | null
  toolName: string
  input: Record<string, unknown>
  expiresAt: Date
}

export async function readPendingPermissionPrompts(
  pool: Pick<Pool, 'query'>,
  input: { userId: bigint; sessionId: string; limit?: number },
): Promise<PendingPermissionPromptRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? HELLO_PENDING_PERMISSION_MAX_ROWS, 64))
  const result = await pool.query<{
    request_id: string
    client_message_id: string | null
    tool_use_id: string | null
    tool_name: string
    input_json: unknown
    expires_at: Date | string
  }>(
    // Defence in depth for rows persisted before durable settlement existed
    // (INC-…-ZOMBIE): a turn the user durably stopped is never answerable
    // again, even if its row is still `pending`. Detached ask_user survives
    // Stop by design and is exempt.
    `SELECT p.request_id,p.client_message_id,p.tool_use_id,p.tool_name,p.input_json,p.expires_at
       FROM turn_permission_requests p
      WHERE p.user_id=$1 AND p.session_id=$2 AND p.status='pending' AND p.expires_at>NOW()
        AND (
          p.request_id LIKE 'ask-user:%'
          OR p.client_message_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM turn_control_requests c
             WHERE c.user_id=p.user_id AND c.session_id=p.session_id AND c.kind='stop'
               AND c.status<>'cancelled'
               AND (
                 c.root_client_message_id=p.client_message_id
                 -- legacy peer-wide Stop: only one admitted after the prompt
                 OR (c.root_client_message_id IS NULL AND c.created_at>=p.created_at)
               )
          )
        )
      ORDER BY p.created_at ASC
      LIMIT $3`,
    [input.userId.toString(), input.sessionId, limit],
  )
  const rows: PendingPermissionPromptRow[] = []
  for (const row of result.rows) {
    let inputJson: unknown = row.input_json
    if (typeof inputJson === 'string') {
      try { inputJson = JSON.parse(inputJson) } catch { continue }
    }
    if (typeof inputJson !== 'object' || inputJson === null || Array.isArray(inputJson)) continue
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
    if (Number.isNaN(expiresAt.getTime())) continue
    rows.push({
      requestId: row.request_id,
      clientMessageId: row.client_message_id,
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      input: inputJson as Record<string, unknown>,
      expiresAt,
    })
  }
  return rows
}

/** Rebuild the wire frame the container originally emitted. No frameSeq: the
 * browser reducer is idempotent by requestId and ignores unstamped frames for
 * cursor purposes, so a catch-up copy can never move the ring cursor. */
export function pendingPermissionPromptToFrame(
  row: PendingPermissionPromptRow,
  target: { sessionKey: string; peerId: string },
  nowMs: number = Date.now(),
): Record<string, unknown> | null {
  const expiresAt = row.expiresAt.getTime()
  if (!(expiresAt > nowMs)) return null
  const clientMessageId = isClientMessageId(row.clientMessageId) ? row.clientMessageId : null
  return {
    type: 'outbound.permission_request',
    sessionKey: target.sessionKey,
    channel: 'webchat',
    peer: { id: target.peerId, kind: 'dm' },
    requestId: row.requestId,
    toolName: row.toolName,
    ...(row.toolUseId ? { toolUseId: row.toolUseId } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    inputPreview: JSON.stringify(row.input).slice(0, 400),
    inputJson: row.input,
    expiresAt,
    ...(row.requestId.startsWith('ask-user:') ? { detachedAskUser: true } : {}),
    ts: nowMs,
  }
}
