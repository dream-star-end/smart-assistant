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

/** Distinct sessions a single hello may scan for pending prompts.
 *  Hello carries every visible session (users have 250+); this cap keeps one
 *  hello from becoming an unbounded scan. Live catch-up stays at 8. */
export const HELLO_PENDING_PERMISSION_MAX_SESSIONS = 32

/** Default rows per session in the batched hello scan. */
const HELLO_PENDING_PERMISSION_DEFAULT_PER_SESSION = 8

/** Hard ceiling on the total row LIMIT of the batched hello scan. */
export const HELLO_PENDING_PERMISSION_MAX_TOTAL_ROWS = 64

/** Snapshot read depth for the session GET permission-prompt payload. */
export const PERMISSION_PROMPT_SNAPSHOT_LIMIT = 16

/** Exact PK lookups for cards that fell out of the recent snapshot window. */
export const PERMISSION_PROMPT_LOOKUP_MAX_IDS = 16

/** Cap stored input JSON echoed on the snapshot (bytes of UTF-8 JSON). */
export const PERMISSION_PROMPT_MAX_INPUT_BYTES = 8192

/** Statement timeout for snapshot/hello permission reads. */
export const PERMISSION_PROMPT_READ_TIMEOUT_MS = 250

type PermissionReadPool = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: object[]; rowCount: number | null }>
  connect?: () => Promise<PoolClient>
  release?: (err?: Error | boolean) => void
}

type PermissionReadKind = 'pool' | 'borrowed' | 'query'

/** Pool owns connect(); a borrowed PoolClient also has connect() but must not
 *  be reconnected, committed, or released by this helper. */
export function permissionReadKind(q: {
  connect?: unknown
  release?: unknown
}): PermissionReadKind {
  if (typeof q.release === 'function') return 'borrowed'
  if (typeof q.connect === 'function') return 'pool'
  return 'query'
}

function quoteShownStatementTimeout(value: string): string {
  const trimmed = value.trim()
  if (/^(0|\d+(\.\d+)?\s*(us|ms|s|min|h)?)$/i.test(trimmed)) return trimmed
  return '0'
}

async function restoreBorrowedStatementTimeout(
  client: Pick<PoolClient, 'query'>,
  previous: string,
): Promise<void> {
  await client.query(`SET LOCAL statement_timeout = '${previous}'`)
}

async function queryPermissionReadOnBorrowedClient<T extends object>(
  client: Pick<PoolClient, 'query'>,
  sql: string,
  params: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const shown = await client.query('SHOW statement_timeout') as {
    rows: Array<{ statement_timeout?: string }>
  }
  const previous = quoteShownStatementTimeout(String(shown.rows[0]?.statement_timeout ?? '0'))
  const sp = `oc_perm_r_${Math.floor(Math.random() * 1e9)}`
  await client.query(`SAVEPOINT ${sp}`)
  try {
    await client.query(`SET LOCAL statement_timeout = ${PERMISSION_PROMPT_READ_TIMEOUT_MS}`)
    const result = await client.query(sql, params)
    await client.query(`RELEASE SAVEPOINT ${sp}`)
    await restoreBorrowedStatementTimeout(client, previous)
    return result as { rows: T[]; rowCount: number | null }
  } catch (error) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`) } catch { /* ignore */ }
    try { await client.query(`RELEASE SAVEPOINT ${sp}`) } catch { /* ignore */ }
    try { await restoreBorrowedStatementTimeout(client, previous) } catch { /* ignore */ }
    throw error
  }
}

/** Bounded PG read. Own a Pool connection with BEGIN/COMMIT; on a borrowed
 *  transaction client use a savepoint so a 250ms timeout cannot abort the
 *  caller's timeline snapshot. Never connect/COMMIT/release a borrowed client. */
export async function queryPermissionRead<T extends object>(
  pool: PermissionReadPool | Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
  sql: string,
  params: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const q = pool as PermissionReadPool
  const kind = permissionReadKind(q)
  if (kind === 'query') {
    return q.query(sql, params) as Promise<{ rows: T[]; rowCount: number | null }>
  }
  if (kind === 'borrowed') {
    return queryPermissionReadOnBorrowedClient(q as Pick<PoolClient, 'query'>, sql, params)
  }
  const client = await q.connect!()
  let destroyed = false
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = ${PERMISSION_PROMPT_READ_TIMEOUT_MS}`)
    const result = await client.query(sql, params)
    await client.query('COMMIT')
    return result as { rows: T[]; rowCount: number | null }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      destroyed = true
      try {
        client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)))
      } catch { /* ignore */ }
    }
    throw error
  } finally {
    if (!destroyed) client.release()
  }
}

export type PermissionPromptCompleteness = 'complete' | 'truncated' | 'unavailable'

export type PermissionPromptSource = 'pg' | 'runtime'

export interface PendingPermissionPromptRow {
  requestId: string
  clientMessageId: string | null
  toolUseId: string | null
  toolName: string
  input: Record<string, unknown>
  inputTruncated: boolean
  inputPreview: string
  expiresAt: Date
}

export async function readPendingPermissionPrompts(
  pool: Pick<Pool, 'query'>,
  input: { userId: bigint; sessionId: string; limit?: number },
): Promise<PendingPermissionPromptRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? HELLO_PENDING_PERMISSION_MAX_ROWS, 64))
  const result = await queryPermissionRead<{
    request_id: string
    client_message_id: string | null
    tool_use_id: string | null
    tool_name: string
    input_json: unknown
    expires_at: Date | string
  }>(pool,
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
    const classified = classifyPermissionInput(inputJson as Record<string, unknown>)
    rows.push({
      requestId: row.request_id,
      clientMessageId: row.client_message_id,
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      input: classified.input,
      inputTruncated: classified.truncated,
      inputPreview: classified.preview,
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
    inputPreview: row.inputPreview || JSON.stringify(row.input).slice(0, 400),
    ...(row.inputTruncated
      ? { inputTruncated: true }
      : { inputJson: row.input }),
    expiresAt,
    ...(row.requestId.startsWith('ask-user:') ? { detachedAskUser: true } : {}),
    ts: nowMs,
  }
}

/** jsonb may arrive as text depending on pg type parsers; corrupt input is
 *  skipped rather than thrown (hello/session GET must never fail on one row). */
function parsePromptJsonObject(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return null }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function parsePromptDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function sliceUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text
  const buf = Buffer.from(text, 'utf8')
  let end = Math.min(maxBytes, buf.length)
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

export function classifyPermissionInput(input: Record<string, unknown>): {
  input: Record<string, unknown>
  truncated: boolean
  preview: string
} {
  let encoded = ''
  try { encoded = JSON.stringify(input) } catch {
    return { input: {}, truncated: true, preview: '' }
  }
  const preview = sliceUtf8(encoded, 400)
  if (utf8ByteLength(encoded) <= PERMISSION_PROMPT_MAX_INPUT_BYTES) {
    return { input, truncated: false, preview }
  }
  return { input: {}, truncated: true, preview }
}

const PENDING_PERMISSION_ZOMBIE_SQL = `
        AND (
          p.request_id LIKE 'ask-user:%'
          OR p.client_message_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM turn_control_requests c
             WHERE c.user_id=p.user_id AND c.session_id=p.session_id AND c.kind='stop'
               AND c.status<>'cancelled'
               AND (
                 c.root_client_message_id=p.client_message_id
                 OR (c.root_client_message_id IS NULL AND c.created_at>=p.created_at)
               )
          )
        )`

/** INC-20260907-PERMISSION-ROOTFIX — batched variant of readPendingPermissionPrompts.
 *  Hello used to call the single-session reader once per live-catch-up session
 *  (capped at 8 peers) while hello carries every visible session. One SQL with
 *  `session_id = ANY($2::text[])` covers the bounded candidate set in a single
 *  round trip; WHERE semantics stay byte-identical to the single-session reader. */
export type HelloPendingPermissionScan = {
  bySession: Map<string, PendingPermissionPromptRow[]>
  rowLimited: boolean
  uncoveredSessionIds: string[]
}

/** Production hello scan: Stop fence + per-session row number + global LIMIT.
 *  per-session cap is min(requested, floor(64/n)) so 32 sessions × 3 pending
 *  cannot silently drop 10 selected sessions. */
export const PERMISSION_PROMPT_HELLO_PRODUCTION_SQL =
  `SELECT session_id,request_id,client_message_id,tool_use_id,tool_name,input_json,expires_at FROM (
      SELECT p.session_id,p.request_id,p.client_message_id,p.tool_use_id,p.tool_name,p.input_json,p.expires_at,
             ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY p.created_at ASC) AS rn
        FROM turn_permission_requests p
       WHERE p.user_id=$1 AND p.session_id = ANY($2::text[]) AND p.status='pending' AND p.expires_at>NOW()
         AND (
           p.request_id LIKE 'ask-user:%'
           OR p.client_message_id IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM turn_control_requests c
              WHERE c.user_id=p.user_id AND c.session_id=p.session_id AND c.kind='stop'
                AND c.status<>'cancelled'
                AND (
                  c.root_client_message_id=p.client_message_id
                  OR (c.root_client_message_id IS NULL AND c.created_at>=p.created_at)
                )
           )
         )
    ) ranked
    WHERE rn <= $4
    ORDER BY session_id, expires_at ASC
    LIMIT $3`

export async function readPendingPermissionPromptsForSessions(
  pool: Pick<Pool, 'query'>,
  input: {
    userId: bigint
    sessionIds: string[]
    limitPerSession?: number
  },
): Promise<HelloPendingPermissionScan> {
  const seen = new Set<string>()
  const sessionIds: string[] = []
  for (const id of input.sessionIds) {
    if (sessionIds.length >= HELLO_PENDING_PERMISSION_MAX_SESSIONS) break
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    sessionIds.push(id)
  }
  const empty: HelloPendingPermissionScan = {
    bySession: new Map(),
    rowLimited: false,
    uncoveredSessionIds: [],
  }
  if (sessionIds.length === 0) return empty
  const fairShare = Math.max(1, Math.floor(HELLO_PENDING_PERMISSION_MAX_TOTAL_ROWS / sessionIds.length))
  const perSession = Math.max(1, Math.min(
    input.limitPerSession ?? HELLO_PENDING_PERMISSION_DEFAULT_PER_SESSION,
    64,
    fairShare,
  ))
  const totalLimit = Math.min(
    perSession * sessionIds.length, HELLO_PENDING_PERMISSION_MAX_TOTAL_ROWS,
  )
  let result: {
    rows: Array<{
      session_id: string
      request_id: string
      client_message_id: string | null
      tool_use_id: string | null
      tool_name: string
      input_json: unknown
      expires_at: Date | string
    }>
    rowCount: number | null
  }
  try {
    result = await queryPermissionRead(
      pool,
      PERMISSION_PROMPT_HELLO_PRODUCTION_SQL,
      [input.userId.toString(), sessionIds, totalLimit, perSession],
    )
  } catch {
    return { bySession: new Map(), rowLimited: true, uncoveredSessionIds: sessionIds }
  }
  const bySession = new Map<string, PendingPermissionPromptRow[]>()
  for (const row of result.rows) {
    const inputJson = parsePromptJsonObject(row.input_json)
    if (inputJson === null) continue
    const expiresAt = parsePromptDate(row.expires_at)
    if (expiresAt === null) continue
    const classified = classifyPermissionInput(inputJson)
    const entry: PendingPermissionPromptRow = {
      requestId: row.request_id,
      clientMessageId: row.client_message_id,
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      input: classified.input,
      inputTruncated: classified.truncated,
      inputPreview: classified.preview,
      expiresAt,
    }
    const list = bySession.get(row.session_id)
    if (list) list.push(entry)
    else bySession.set(row.session_id, [entry])
  }
  // ROW_NUMBER can truncate one session even when other sessions leave unused
  // slots in the global page. As with snapshot LIMIT, saturation means there
  // may be more: the active session must remain eligible for a GET refill.
  const rowLimited = result.rows.length >= totalLimit ||
    [...bySession.values()].some((rows) => rows.length >= perSession)
  const uncoveredSessionIds = rowLimited
    ? sessionIds.filter((id) => !bySession.has(id))
    : []
  return { bySession, rowLimited, uncoveredSessionIds }
}

/** One prompt of the session-GET snapshot. Unlike the pending-only readers,
 *  responded/cancelled rows are included so device B can converge cards that
 *  device A already answered. `responded` means the control was accepted, not
 *  that the tool actually executed. */
export interface PermissionPromptSnapshotEntry {
  requestId: string
  clientMessageId: string | null
  toolUseId: string | null
  toolName: string
  input: Record<string, unknown>
  inputTruncated: boolean
  status: 'pending' | 'responded' | 'cancelled' | 'expired'
  response: { behavior: 'allow' | 'deny' | null; reason: string | null; answers: Record<string, string> | null } | null
  expiresAt: number
  createdAt: number
  updatedAt: number
}

export interface PermissionPromptSnapshot {
  items: PermissionPromptSnapshotEntry[]
  completeness: PermissionPromptCompleteness
  source: PermissionPromptSource
}

/** response_json has three writers: settlePermissionPromptFromRuntime /
 *  cancelPendingPermissionPromptsForTurn store `{behavior, reason, ...}`;
 *  admitDurableControl stores the whole inbound.permission_response frame.
 *  `answers` may live under either key; keep only string→string entries. */
function summarizePermissionResponse(
  responseJson: unknown,
  status: PermissionPromptSnapshotEntry['status'],
): { behavior: 'allow' | 'deny' | null; reason: string | null; answers: Record<string, string> | null } | null {
  if (status === 'pending') return null
  const raw = parsePromptJsonObject(responseJson)
  if (raw === null) {
    return {
      behavior: status === 'cancelled' || status === 'expired' ? 'deny' : null,
      reason: null,
      answers: null,
    }
  }
  const behaviorRaw = raw.behavior
  const behavior: 'allow' | 'deny' | null =
    behaviorRaw === 'allow' || behaviorRaw === 'deny' ? behaviorRaw : null
  const reasonRaw = raw.reason
  const reason = typeof reasonRaw === 'string' ? reasonRaw : null
  let answers: Record<string, string> | null = null
  const answersRaw = raw.answers ?? parsePromptJsonObject(raw.updatedInput)?.answers
  if (answersRaw !== null && answersRaw !== undefined && typeof answersRaw === 'object' &&
    !Array.isArray(answersRaw)) {
    const kept: Record<string, string> = {}
    for (const [key, value] of Object.entries(answersRaw as Record<string, unknown>)) {
      if (typeof value === 'string') kept[key] = value
    }
    answers = Object.keys(kept).length > 0 ? kept : null
  }
  return { behavior, reason, answers }
}

function mapPermissionSnapshotRow(row: {
  request_id: string
  client_message_id: string | null
  tool_use_id: string | null
  tool_name: string
  input_json: unknown
  response_json: unknown
  status: string
  expires_at: Date | string
  created_at: Date | string
  updated_at: Date | string
  stopped?: boolean
}, nowMs: number, opts?: { includeFullInput?: boolean }): PermissionPromptSnapshotEntry | null {
  const parsedInput = parsePromptJsonObject(row.input_json)
  if (parsedInput === null) return null
  const expiresAt = parsePromptDate(row.expires_at)
  const createdAt = parsePromptDate(row.created_at)
  const updatedAt = parsePromptDate(row.updated_at)
  if (expiresAt === null || createdAt === null || updatedAt === null) return null
  let status: PermissionPromptSnapshotEntry['status']
  if (row.status === 'responded' || row.status === 'cancelled') status = row.status
  else if (row.status === 'pending' || row.status === 'expired') {
    status = row.status === 'pending' && expiresAt.getTime() > nowMs ? 'pending' : 'expired'
  } else return null
  const detached = row.request_id.startsWith('ask-user:')
  if (status === 'pending' && row.stopped === true && !detached) {
    status = 'cancelled'
  }
  const classified = opts?.includeFullInput
    ? { input: parsedInput, truncated: false, preview: sliceUtf8(JSON.stringify(parsedInput), 400) }
    : classifyPermissionInput(parsedInput)
  const response = status === 'cancelled' && row.stopped === true && !detached
    ? { behavior: 'deny' as const, reason: 'user_stop', answers: null }
    : summarizePermissionResponse(row.response_json, status)
  return {
    requestId: row.request_id,
    clientMessageId: row.client_message_id,
    toolUseId: row.tool_use_id,
    toolName: row.tool_name,
    input: classified.input,
    inputTruncated: classified.truncated,
    status,
    response,
    expiresAt: expiresAt.getTime(),
    createdAt: createdAt.getTime(),
    updatedAt: updatedAt.getTime(),
  }
}

const STOPPED_PROJECTION_SQL = `(
        p.request_id NOT LIKE 'ask-user:%'
        AND p.client_message_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM turn_control_requests c
           WHERE c.user_id=p.user_id AND c.session_id=p.session_id AND c.kind='stop'
             AND c.status<>'cancelled'
             AND (
               c.root_client_message_id=p.client_message_id
               OR (c.root_client_message_id IS NULL AND c.created_at>=p.created_at)
             )
        )
      ) AS stopped`

export const PERMISSION_PROMPT_SNAPSHOT_SQL =
  `SELECT p.request_id,p.client_message_id,p.tool_use_id,p.tool_name,p.input_json,p.response_json,p.status,p.expires_at,p.created_at,p.updated_at,
          ${STOPPED_PROJECTION_SQL}
     FROM turn_permission_requests p
    WHERE p.user_id=$1 AND p.session_id=$2
    ORDER BY p.created_at DESC
    LIMIT $3`

export const PERMISSION_PROMPT_LOOKUP_SQL =
  `SELECT p.request_id,p.client_message_id,p.tool_use_id,p.tool_name,p.input_json,p.response_json,p.status,p.expires_at,p.created_at,p.updated_at,
          ${STOPPED_PROJECTION_SQL}
     FROM turn_permission_requests p
    WHERE p.user_id=$1 AND p.request_id = ANY($2::text[]) AND p.session_id=$3`

export const PERMISSION_PROMPT_HELLO_BATCH_SQL = PERMISSION_PROMPT_HELLO_PRODUCTION_SQL

/** Recent prompts of one session regardless of status, newest first. Feeds the
 *  `permissionPrompts` payload on session GET. A `pending` row whose expires_at
 *  has passed is reported as 'expired' — nothing in PG moves it there.
 *  LIMIT bounds output; it is not a scan budget. Callers must pair this with
 *  EXPLAIN evidence on existing indexes; a new index is not assumed. */
export async function readPermissionPromptSnapshot(
  pool: Pick<Pool, 'query'>,
  input: { userId: bigint; sessionId: string; limit?: number },
): Promise<PermissionPromptSnapshot> {
  const limit = Math.max(1, Math.min(input.limit ?? PERMISSION_PROMPT_SNAPSHOT_LIMIT, 64))
  try {
    const result = await queryPermissionRead<{
      request_id: string
      client_message_id: string | null
      tool_use_id: string | null
      tool_name: string
      input_json: unknown
      response_json: unknown
      status: string
      expires_at: Date | string
      created_at: Date | string
      updated_at: Date | string
      stopped: boolean
    }>(pool, PERMISSION_PROMPT_SNAPSHOT_SQL, [input.userId.toString(), input.sessionId, limit])
    const nowMs = Date.now()
    const items: PermissionPromptSnapshotEntry[] = []
    for (const row of result.rows) {
      const entry = mapPermissionSnapshotRow(row, nowMs, { includeFullInput: false })
      if (entry) items.push(entry)
    }
    return {
      items,
      completeness: result.rows.length >= limit ? 'truncated' : 'complete',
      source: 'pg',
    }
  } catch {
    return { items: [], completeness: 'unavailable', source: 'pg' }
  }
}

/** Exact PK lookup `(user_id, request_id)` then session isolation. Used when a
 *  local card is older than the recent snapshot window. Existing primary key
 *  is the access path — no extra index. */
export async function readPermissionPromptsByRequestIds(
  pool: Pick<Pool, 'query'>,
  input: { userId: bigint; sessionId: string; requestIds: string[] },
): Promise<PermissionPromptSnapshotEntry[]> {
  const seen = new Set<string>()
  const requestIds: string[] = []
  for (const id of input.requestIds) {
    if (requestIds.length >= PERMISSION_PROMPT_LOOKUP_MAX_IDS) break
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    requestIds.push(id)
  }
  if (requestIds.length === 0) return []
  try {
    const result = await queryPermissionRead<{
      request_id: string
      client_message_id: string | null
      tool_use_id: string | null
      tool_name: string
      input_json: unknown
      response_json: unknown
      status: string
      expires_at: Date | string
      created_at: Date | string
      updated_at: Date | string
      stopped: boolean
    }>(
      pool,
      PERMISSION_PROMPT_LOOKUP_SQL,
      [input.userId.toString(), requestIds, input.sessionId],
    )
    const nowMs = Date.now()
    const items: PermissionPromptSnapshotEntry[] = []
    for (const row of result.rows) {
      const entry = mapPermissionSnapshotRow(row, nowMs, { includeFullInput: true })
      if (entry) items.push(entry)
    }
    return items
  } catch {
    return []
  }
}

export function serializePermissionPromptEntry(entry: PermissionPromptSnapshotEntry): {
  requestId: string
  clientMessageId: string | null
  toolUseId: string | null
  toolName: string
  inputJson: Record<string, unknown>
  inputTruncated: boolean
  status: PermissionPromptSnapshotEntry['status']
  behavior: 'allow' | 'deny' | null
  reason: string | null
  answers: Record<string, string> | null
  expiresAt: number
  createdAt: number
  updatedAt: number
} {
  return {
    requestId: entry.requestId,
    clientMessageId: entry.clientMessageId,
    toolUseId: entry.toolUseId,
    toolName: entry.toolName,
    inputJson: entry.input,
    inputTruncated: entry.inputTruncated,
    status: entry.status,
    behavior: entry.response?.behavior ?? null,
    reason: entry.response?.reason ?? null,
    answers: entry.response?.answers ?? null,
    expiresAt: entry.expiresAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export interface HelloPermissionPeer {
  peerId: string
  agentId?: string
  inFlight?: boolean
}

/** Pick the bounded hello permission scan set. In-flight / currently open
 *  sessions win; remaining visible peers fill the rest. Truncation is explicit
 *  so session 9 is never silently dropped — the client GETs that session. */
export function selectHelloPermissionSessions(
  peers: HelloPermissionPeer[],
  opts?: { maxSessions?: number },
): {
  sessions: Array<{ peerId: string; sessionKey: string }>
  truncated: boolean
  scanned: number
  omitted: number
} {
  const maxSessions = Math.max(1, Math.min(
    opts?.maxSessions ?? HELLO_PENDING_PERMISSION_MAX_SESSIONS,
    HELLO_PENDING_PERMISSION_MAX_SESSIONS,
  ))
  const seen = new Set<string>()
  const prioritized: HelloPermissionPeer[] = []
  const rest: HelloPermissionPeer[] = []
  for (const peer of peers) {
    if (typeof peer.peerId !== 'string' || peer.peerId === '' || seen.has(peer.peerId)) continue
    seen.add(peer.peerId)
    if (peer.inFlight === true) prioritized.push(peer)
    else rest.push(peer)
  }
  const ordered = [...prioritized, ...rest]
  const truncated = ordered.length > maxSessions
  const chosen = ordered.slice(0, maxSessions)
  const sessions = chosen.map((peer) => {
    const aid = typeof peer.agentId === 'string' && peer.agentId !== '' ? peer.agentId : 'main'
    const safeId = peer.peerId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return { peerId: peer.peerId, sessionKey: `agent:${aid}:webchat:dm:${safeId}` }
  })
  return {
    sessions,
    truncated,
    scanned: sessions.length,
    omitted: Math.max(0, ordered.length - sessions.length),
  }
}

export function parsePermissionLookupIds(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (id === '' || seen.has(id)) continue
    if (id.length > 200) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= PERMISSION_PROMPT_LOOKUP_MAX_IDS) break
  }
  return ids
}
