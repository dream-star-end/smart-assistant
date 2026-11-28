import type Database from 'better-sqlite3'
import { getSessionsDb } from './sqliteHandle.js'
import type {
  ExactTurnDispatchIdentity,
  TurnDispatchInboxOutcome,
  TurnDispatchInboxRow,
  TurnDispatchInboxState,
} from './types.js'

interface TurnDispatchInboxDbRow {
  user_id: string
  session_id: string
  client_message_id: string
  dispatch_id: string
  attempt_no: number
  payload_hash: string
  state: TurnDispatchInboxState
  outcome: TurnDispatchInboxOutcome | null
  agent_id: string | null
  turn_index: number | null
  turn_key: string | null
  request_id: string | null
  created_at: number
  accepted_at: number
  updated_at: number
  user_failure_code?: string | null
}

function mapTurnDispatchInboxRow(r: TurnDispatchInboxDbRow): TurnDispatchInboxRow {
  return {
    userId: r.user_id,
    sessionId: r.session_id,
    clientMessageId: r.client_message_id,
    dispatchId: r.dispatch_id,
    attemptNo: r.attempt_no,
    payloadHash: r.payload_hash,
    state: r.state,
    outcome: r.outcome,
    agentId: r.agent_id,
    turnIndex: r.turn_index,
    turnKey: r.turn_key,
    requestId: r.request_id,
    createdAt: r.created_at,
    acceptedAt: r.accepted_at,
    updatedAt: r.updated_at,
    ...(typeof r.user_failure_code === 'string' && r.user_failure_code.length > 0
      ? { userFailureCode: r.user_failure_code }
      : {}),
  }
}

function readTurnDispatchByLogicalKey(
  db: Database.Database,
  userId: string,
  sessionId: string,
  clientMessageId: string,
): TurnDispatchInboxRow | null {
  const row = db
    .prepare(
      'SELECT * FROM turn_dispatch_inbox WHERE user_id = ? AND session_id = ? AND client_message_id = ?',
    )
    .get(userId, sessionId, clientMessageId) as TurnDispatchInboxDbRow | undefined
  return row ? mapTurnDispatchInboxRow(row) : null
}

export async function insertQueuedTurnDispatch(input: {
  userId: string
  sessionId: string
  clientMessageId: string
  dispatchId: string
  attemptNo: number
  payloadHash: string
  now?: number
}): Promise<{ inserted: boolean; row: TurnDispatchInboxRow | null }> {
  const db = await getSessionsDb()
  const now = input.now ?? Date.now()
  const txn = db.transaction((): { inserted: boolean; row: TurnDispatchInboxRow | null } => {
    const res = db
      .prepare(
        `INSERT INTO turn_dispatch_inbox
           (user_id, session_id, client_message_id, dispatch_id, attempt_no, payload_hash,
            state, outcome, created_at, accepted_at, updated_at)
         VALUES (@userId, @sessionId, @clientMessageId, @dispatchId, @attemptNo, @payloadHash,
            'queued', NULL, @now, @now, @now)
         ON CONFLICT DO NOTHING`,
      )
      .run({
        userId: input.userId,
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        dispatchId: input.dispatchId,
        attemptNo: input.attemptNo,
        payloadHash: input.payloadHash,
        now,
      })
    const row = readTurnDispatchByLogicalKey(
      db,
      input.userId,
      input.sessionId,
      input.clientMessageId,
    )
    return { inserted: res.changes > 0, row }
  })
  return txn()
}

function hasExactDispatchConflict(
  input: ExactTurnDispatchIdentity,
  logical: TurnDispatchInboxRow | null,
  dispatch: TurnDispatchInboxDbRow | undefined,
): boolean {
  if (logical && (logical.dispatchId !== input.dispatchId || logical.attemptNo !== input.attemptNo)) {
    return true
  }
  if (!dispatch) return false
  return (
    dispatch.user_id !== input.userId ||
    dispatch.session_id !== input.sessionId ||
    dispatch.client_message_id !== input.clientMessageId
  )
}

export async function cancelQueuedTurnDispatchExact(
  input: ExactTurnDispatchIdentity & { now?: number },
): Promise<{
  applied: boolean
  found: boolean
  conflict: boolean
  state: TurnDispatchInboxState | 'absent' | null
  outcome: TurnDispatchInboxOutcome | null
}> {
  const db = await getSessionsDb()
  return db.transaction(() => {
    const logical = readTurnDispatchByLogicalKey(
      db,
      input.userId,
      input.sessionId,
      input.clientMessageId,
    )
    const dispatch = db
      .prepare('SELECT * FROM turn_dispatch_inbox WHERE dispatch_id = ? AND attempt_no = ?')
      .get(input.dispatchId, input.attemptNo) as TurnDispatchInboxDbRow | undefined
    if (hasExactDispatchConflict(input, logical, dispatch)) {
      return { applied: false, found: false, conflict: true, state: null, outcome: null }
    }
    if (!logical) {
      return {
        applied: false,
        found: false,
        conflict: false,
        state: 'absent' as const,
        outcome: null,
      }
    }
    const result = db
      .prepare(`
        UPDATE turn_dispatch_inbox SET state='rejected', outcome='not_accepted', updated_at=?
         WHERE user_id=? AND session_id=? AND client_message_id=?
           AND dispatch_id=? AND attempt_no=? AND state='queued'
      `)
      .run(
        input.now ?? Date.now(),
        input.userId,
        input.sessionId,
        input.clientMessageId,
        input.dispatchId,
        input.attemptNo,
      )
    const row = readTurnDispatchByLogicalKey(
      db,
      input.userId,
      input.sessionId,
      input.clientMessageId,
    )!
    return {
      applied: result.changes > 0,
      found: true,
      conflict: false,
      state: row.state,
      outcome: row.outcome,
    }
  })()
}

export async function casTurnDispatchState(input: {
  userId: string
  sessionId: string
  clientMessageId: string
  fromStates: readonly TurnDispatchInboxState[]
  toState: TurnDispatchInboxState
  outcome?: TurnDispatchInboxOutcome | null
  now?: number
  userFailureCode?: string
}): Promise<TurnDispatchInboxRow | null> {
  const db = await getSessionsDb()
  const now = input.now ?? Date.now()
  const placeholders = input.fromStates.map(() => '?').join(',')
  const setOutcome = input.outcome !== undefined
  const setCode = input.userFailureCode !== undefined
  const txn = db.transaction((): TurnDispatchInboxRow | null => {
    const res = db
      .prepare(
        `UPDATE turn_dispatch_inbox
            SET state = ?,
                ${setOutcome ? 'outcome = ?,' : ''}
                ${setCode ? 'user_failure_code = ?,' : ''}
                updated_at = ?
          WHERE user_id = ? AND session_id = ? AND client_message_id = ?
            AND state IN (${placeholders})`,
      )
      .run(
        input.toState,
        ...(setOutcome ? [input.outcome ?? null] : []),
        ...(setCode ? [input.userFailureCode ?? null] : []),
        now,
        input.userId,
        input.sessionId,
        input.clientMessageId,
        ...input.fromStates,
      )
    if (res.changes === 0) return null
    return readTurnDispatchByLogicalKey(db, input.userId, input.sessionId, input.clientMessageId)
  })
  return txn()
}

export async function recordTurnDispatchRunning(input: {
  userId: string
  sessionId: string
  clientMessageId: string
  agentId: string
  turnIndex: number
  turnKey: string
  requestId: string | null
  createdAt: number
  now?: number
}): Promise<TurnDispatchInboxRow | null> {
  const db = await getSessionsDb()
  const now = input.now ?? Date.now()
  const txn = db.transaction((): TurnDispatchInboxRow | null => {
    const res = db
      .prepare(
        `UPDATE turn_dispatch_inbox
            SET state = 'running',
                agent_id = @agentId,
                turn_index = @turnIndex,
                turn_key = @turnKey,
                request_id = @requestId,
                created_at = @createdAt,
                updated_at = @now
          WHERE user_id = @userId AND session_id = @sessionId
            AND client_message_id = @clientMessageId
            AND state = 'queued'`,
      )
      .run({
        userId: input.userId,
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        agentId: input.agentId,
        turnIndex: input.turnIndex,
        turnKey: input.turnKey,
        requestId: input.requestId,
        createdAt: input.createdAt,
        now,
      })
    if (res.changes === 0) return null
    return readTurnDispatchByLogicalKey(db, input.userId, input.sessionId, input.clientMessageId)
  })
  return txn()
}

export async function getTurnDispatchByLogicalKey(
  userId: string,
  sessionId: string,
  clientMessageId: string,
): Promise<TurnDispatchInboxRow | null> {
  const db = await getSessionsDb()
  return readTurnDispatchByLogicalKey(db, userId, sessionId, clientMessageId)
}

export async function getTurnDispatchByDispatchId(
  dispatchId: string,
  attemptNo: number,
): Promise<TurnDispatchInboxRow | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT * FROM turn_dispatch_inbox WHERE dispatch_id = ? AND attempt_no = ?')
    .get(dispatchId, attemptNo) as TurnDispatchInboxDbRow | undefined
  return row ? mapTurnDispatchInboxRow(row) : null
}

export async function insertRejectedTombstoneIfAbsent(input: {
  userId: string
  sessionId: string
  clientMessageId: string
  dispatchId: string
  attemptNo: number
  payloadHash: string
  now?: number
}): Promise<{ inserted: boolean; row: TurnDispatchInboxRow | null; conflict?: boolean }> {
  const db = await getSessionsDb()
  const now = input.now ?? Date.now()
  const txn = db.transaction(
    (): { inserted: boolean; row: TurnDispatchInboxRow | null; conflict?: boolean } => {
      const existing = readTurnDispatchByLogicalKey(
        db,
        input.userId,
        input.sessionId,
        input.clientMessageId,
      )
      if (existing) return { inserted: false, row: existing }
      const res = db
        .prepare(
          `INSERT INTO turn_dispatch_inbox
             (user_id, session_id, client_message_id, dispatch_id, attempt_no, payload_hash,
              state, outcome, created_at, accepted_at, updated_at)
           VALUES (@userId, @sessionId, @clientMessageId, @dispatchId, @attemptNo, @payloadHash,
              'rejected', 'not_accepted', @now, @now, @now)
           ON CONFLICT DO NOTHING`,
        )
        .run({
          userId: input.userId,
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          dispatchId: input.dispatchId,
          attemptNo: input.attemptNo,
          payloadHash: input.payloadHash,
          now,
        })
      if (res.changes === 0) return { inserted: false, row: null, conflict: true }
      return {
        inserted: true,
        row: readTurnDispatchByLogicalKey(db, input.userId, input.sessionId, input.clientMessageId),
      }
    },
  )
  return txn()
}

export async function scanOpenTurnDispatches(): Promise<TurnDispatchInboxRow[]> {
  const db = await getSessionsDb()
  const rows = db
    .prepare(
      `SELECT * FROM turn_dispatch_inbox
        WHERE state NOT IN ('terminal','rejected')
        ORDER BY accepted_at ASC`,
    )
    .all() as TurnDispatchInboxDbRow[]
  return rows.map(mapTurnDispatchInboxRow)
}

export async function turnDispatchInboxStats(): Promise<{ openJobs: number; bytes: number }> {
  const db = await getSessionsDb()
  const open = db
    .prepare(
      "SELECT COUNT(*) AS n FROM turn_dispatch_inbox WHERE state NOT IN ('terminal','rejected')",
    )
    .get() as { n: number }
  const bytesRow = db
    .prepare(
      `SELECT COALESCE(SUM(
          64
          + length(user_id) + length(session_id) + length(client_message_id)
          + length(dispatch_id) + length(payload_hash)
          + COALESCE(length(agent_id),0) + COALESCE(length(turn_key),0)
          + COALESCE(length(request_id),0)
        ), 0) AS b FROM turn_dispatch_inbox`,
    )
    .get() as { b: number }
  return { openJobs: Number(open.n) || 0, bytes: Number(bytesRow.b) || 0 }
}

export async function countRuntimeRecycleUnsafeTurnDispatches(): Promise<number> {
  const db = await getSessionsDb()
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM turn_dispatch_inbox WHERE state = 'running'")
    .get() as { n: number }
  return Number(row.n) || 0
}
