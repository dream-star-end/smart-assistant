import { randomUUID } from 'node:crypto'
import type { GoalStateSnapshot, GoalStatus } from '@openclaude/protocol'
import type { Pool, PoolClient } from 'pg'

const STORAGE_USER_PREFIX = 'c:'

export class GoalStateError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'GoalStateError'
  }
}

type GoalRow = {
  session_id: string
  goal_id: string
  objective: string
  status: GoalStatus
  token_budget: string | null
  credit_budget: string | null
  state_revision: string
  snapshot_revision: string
  active_elapsed_ms: string
  active_started_at: Date | null
  status_changed_at: Date
  engine_status: string | null
  engine_tokens_used: string | null
  engine_time_used_seconds: string | null
  engine_updated_at: Date | null
  created_at: Date
  updated_at: Date
  tokens_used: string
  credits_used: string
  time_used_seconds: string
}

export interface GoalStateServiceDeps {
  pool: Pool
  broadcast?: (uid: bigint, snapshot: GoalStateSnapshot) => void | Promise<void>
  syncEngine?: (uid: bigint, snapshot: GoalStateSnapshot) => void | Promise<void>
}

export interface SetGoalInput {
  objective: string
  tokenBudget: number | null
  creditBudget: string | null
  /** Required compare-and-swap revision. A never-created goal uses 0. */
  expectedStateRevision: number
}

function storageUserId(uid: bigint): string {
  return `${STORAGE_USER_PREFIX}${uid.toString()}`
}

function positiveSafeInt(value: unknown, field: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GoalStateError('INVALID', `${field} must be a positive safe integer or null`)
  }
  return value
}

function positiveCredits(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new GoalStateError('INVALID', 'creditBudget must be a positive integer string or null')
  }
  return value
}

function safeDbNumber(value: string, field: string): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`session goal ${field} exceeds safe integer range`)
  return n
}

function toSnapshot(row: GoalRow): GoalStateSnapshot {
  return {
    sessionId: row.session_id,
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget === null ? null : safeDbNumber(row.token_budget, 'token_budget'),
    creditBudget: row.credit_budget,
    tokensUsed: safeDbNumber(row.tokens_used, 'tokens_used'),
    creditsUsed: row.credits_used,
    timeUsedSeconds: safeDbNumber(row.time_used_seconds, 'time_used_seconds'),
    stateRevision: safeDbNumber(row.state_revision, 'state_revision'),
    snapshotRevision: safeDbNumber(row.snapshot_revision, 'snapshot_revision'),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    statusChangedAt: row.status_changed_at.toISOString(),
    engineStatus: row.engine_status,
    engineTokensUsed:
      row.engine_tokens_used === null ? null : safeDbNumber(row.engine_tokens_used, 'engine_tokens_used'),
    engineTimeUsedSeconds:
      row.engine_time_used_seconds === null
        ? null
        : safeDbNumber(row.engine_time_used_seconds, 'engine_time_used_seconds'),
    engineUpdatedAt: row.engine_updated_at?.toISOString() ?? null,
  }
}

const SNAPSHOT_SELECT = `
  SELECT g.session_id, g.goal_id::text, g.objective, g.status,
         g.token_budget::text, g.credit_budget::text,
         g.state_revision::text, g.snapshot_revision::text,
         g.active_elapsed_ms::text, g.active_started_at, g.status_changed_at,
         g.engine_status, g.engine_tokens_used::text, g.engine_time_used_seconds::text,
         g.engine_updated_at, g.created_at, g.updated_at,
         COALESCE((
           SELECT SUM(per_tape.goal_tokens)
             FROM (
               SELECT t.tape_id,
                      GREATEST(
                        t.goal_tokens_used,
                        COALESCE(SUM(
                          ur.input_tokens + ur.output_tokens +
                          ur.cache_read_tokens + ur.cache_write_tokens
                        ),0)
                      ) AS goal_tokens
                 FROM client_session_turn_tapes t
                 LEFT JOIN LATERAL (
                   SELECT c.request_id,c.cost_credits
                     FROM turn_tape_cost_components c
                    WHERE c.session_id=t.session_id AND c.user_id=t.user_id AND c.tape_id=t.tape_id
                   UNION ALL
                   SELECT p.request_id,p.cost_credits::numeric
                     FROM pending_usage_patches p
                    WHERE p.user_id=t.user_id
                      AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
                      AND p.cost_credits ~ '^[0-9]+$'
                      AND NOT EXISTS (
                        SELECT 1 FROM turn_tape_cost_components c0
                         WHERE c0.request_id=p.request_id AND c0.user_id=p.user_id
                      )
                 ) a ON TRUE
                 LEFT JOIN usage_records ur
                   ON ur.user_id=$3 AND ur.request_id=a.request_id
                WHERE t.session_id=g.session_id AND t.user_id=$2
                  AND t.goal_id=g.goal_id AND t.finalized_at IS NOT NULL
                GROUP BY t.tape_id,t.goal_tokens_used
             ) per_tape
         ),0)::text AS tokens_used,
         COALESCE((
           SELECT SUM(a.cost_credits)
             FROM client_session_turn_tapes t
             JOIN LATERAL (
               SELECT c.request_id,c.cost_credits
                 FROM turn_tape_cost_components c
                WHERE c.session_id=t.session_id AND c.user_id=t.user_id AND c.tape_id=t.tape_id
               UNION ALL
               SELECT p.request_id,p.cost_credits::numeric
                 FROM pending_usage_patches p
                WHERE p.user_id=t.user_id
                  AND (p.turn_key=t.turn_key OR p.parent_turn_key=t.turn_key)
                  AND p.cost_credits ~ '^[0-9]+$'
                  AND NOT EXISTS (
                    SELECT 1 FROM turn_tape_cost_components c0
                     WHERE c0.request_id=p.request_id AND c0.user_id=p.user_id
                  )
             ) a ON TRUE
            WHERE t.session_id=g.session_id AND t.user_id=$2 AND t.goal_id=g.goal_id
         ),0)::text AS credits_used,
         FLOOR((g.active_elapsed_ms + CASE WHEN g.status='active'
           THEN EXTRACT(EPOCH FROM (clock_timestamp()-g.active_started_at))*1000 ELSE 0 END)/1000)::text
           AS time_used_seconds
    FROM session_goals g
   WHERE g.session_id=$1`

async function assertOwnedSession(
  client: PoolClient,
  uid: bigint,
  sessionId: string,
  lock: boolean,
): Promise<string> {
  const userId = storageUserId(uid)
  const r = await client.query(
    `SELECT id FROM client_sessions
      WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [sessionId, userId],
  )
  if (r.rowCount !== 1) throw new GoalStateError('NOT_FOUND', 'session not found')
  return userId
}

async function readSnapshot(
  client: PoolClient,
  uid: bigint,
  sessionId: string,
  userId: string,
): Promise<GoalStateSnapshot | null> {
  const r = await client.query<GoalRow>(SNAPSHOT_SELECT, [sessionId, userId, uid.toString()])
  return r.rows[0] ? toSnapshot(r.rows[0]) : null
}

async function readGoalForUpdate(client: PoolClient, sessionId: string): Promise<GoalRow | null> {
  const r = await client.query<GoalRow>(
    `SELECT session_id,goal_id::text,objective,status,token_budget::text,credit_budget::text,
            state_revision::text,snapshot_revision::text,active_elapsed_ms::text,active_started_at,
            status_changed_at,engine_status,engine_tokens_used::text,engine_time_used_seconds::text,
            engine_updated_at,created_at,updated_at,'0' AS tokens_used,'0' AS credits_used,
            '0' AS time_used_seconds
       FROM session_goals WHERE session_id=$1 FOR UPDATE`,
    [sessionId],
  )
  return r.rows[0] ?? null
}

function assertExpected(row: GoalRow | null, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new GoalStateError('INVALID', 'expectedStateRevision must be a non-negative safe integer')
  }
  const actual = row ? safeDbNumber(row.state_revision, 'state_revision') : 0
  if (actual !== expected) throw new GoalStateError('CONFLICT', `stale goal revision: expected ${expected}, got ${actual}`)
}

function settledElapsedSql(): string {
  return `active_elapsed_ms + CASE WHEN status='active'
    THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp()-active_started_at))*1000))::bigint
    ELSE 0 END`
}

export function resolveGoalTransition(
  status: GoalStatus,
  action: 'pause' | 'resume' | 'complete' | 'block',
): { target: GoalStatus; idempotent: boolean } {
  const target: GoalStatus =
    action === 'pause' ? 'paused' : action === 'resume' ? 'active' : action === 'complete' ? 'completed' : 'blocked'
  if (status === target) return { target, idempotent: true }
  const allowed =
    (action === 'pause' && status === 'active') ||
    (action === 'resume' && (status === 'paused' || status === 'blocked')) ||
    (action === 'complete' && ['active', 'paused', 'blocked'].includes(status)) ||
    (action === 'block' && (status === 'active' || status === 'paused'))
  if (!allowed) throw new GoalStateError('CONFLICT', `cannot ${action} goal from ${status}`)
  return { target, idempotent: false }
}

export class GoalStateService {
  private readonly pool: Pool
  private readonly broadcast?: GoalStateServiceDeps['broadcast']
  private readonly syncEngine?: GoalStateServiceDeps['syncEngine']

  constructor(deps: GoalStateServiceDeps) {
    this.pool = deps.pool
    this.broadcast = deps.broadcast
    this.syncEngine = deps.syncEngine
  }

  async get(uid: bigint, sessionId: string): Promise<GoalStateSnapshot | null> {
    const client = await this.pool.connect()
    try {
      const userId = await assertOwnedSession(client, uid, sessionId, false)
      return await readSnapshot(client, uid, sessionId, userId)
    } finally {
      client.release()
    }
  }

  async set(uid: bigint, sessionId: string, input: SetGoalInput): Promise<GoalStateSnapshot> {
    const objective = input.objective.trim()
    if (!objective || objective.length > 8000) {
      throw new GoalStateError('INVALID', 'objective must contain 1..8000 characters')
    }
    const tokenBudget = positiveSafeInt(input.tokenBudget, 'tokenBudget')
    const creditBudget = positiveCredits(input.creditBudget)
    const snapshot = await this.mutate(uid, sessionId, async (client, row) => {
      assertExpected(row, input.expectedStateRevision)
      if (!row || row.status === 'cleared' || row.status === 'completed') {
        await client.query(
          `INSERT INTO session_goals
             (session_id,goal_id,objective,status,token_budget,credit_budget,
              state_revision,snapshot_revision,active_elapsed_ms,active_started_at,
              status_changed_at,created_at,updated_at)
           VALUES ($1,$2,$3,'active',$4,$5,1,1,0,clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp())
           ON CONFLICT (session_id) DO UPDATE SET
             goal_id=EXCLUDED.goal_id,objective=EXCLUDED.objective,status='active',
             token_budget=EXCLUDED.token_budget,credit_budget=EXCLUDED.credit_budget,
             state_revision=session_goals.state_revision+1,
             snapshot_revision=session_goals.snapshot_revision+1,
             active_elapsed_ms=0,active_started_at=clock_timestamp(),
             status_changed_at=clock_timestamp(),engine_status=NULL,engine_tokens_used=NULL,
             engine_time_used_seconds=NULL,engine_updated_at=NULL,
             created_at=clock_timestamp(),updated_at=clock_timestamp()`,
          [sessionId, randomUUID(), objective, tokenBudget, creditBudget],
        )
        return true
      }
      const same =
        row.objective === objective &&
        row.token_budget === (tokenBudget === null ? null : String(tokenBudget)) &&
        row.credit_budget === creditBudget
      if (same) return false
      await client.query(
        `UPDATE session_goals SET objective=$2,token_budget=$3,credit_budget=$4,
            state_revision=state_revision+1,snapshot_revision=snapshot_revision+1,
            updated_at=clock_timestamp() WHERE session_id=$1`,
        [sessionId, objective, tokenBudget, creditBudget],
      )
      return true
    })
    if (!snapshot) throw new Error('goal row missing after set')
    await this.publish(uid, snapshot, true)
    return snapshot
  }

  async pause(uid: bigint, sessionId: string, expected: number): Promise<GoalStateSnapshot> {
    return this.transition(uid, sessionId, 'pause', expected)
  }

  async resume(uid: bigint, sessionId: string, expected: number): Promise<GoalStateSnapshot> {
    return this.transition(uid, sessionId, 'resume', expected)
  }

  async complete(uid: bigint, sessionId: string, expected: number): Promise<GoalStateSnapshot> {
    return this.transition(uid, sessionId, 'complete', expected)
  }

  async clear(uid: bigint, sessionId: string, expected: number): Promise<GoalStateSnapshot | null> {
    const snapshot = await this.mutate(uid, sessionId, async (client, row) => {
      assertExpected(row, expected)
      if (!row) return false
      if (row.status === 'cleared') return false
      await client.query(
        `UPDATE session_goals SET status='cleared',
            active_elapsed_ms=${settledElapsedSql()},active_started_at=NULL,
            state_revision=state_revision+1,snapshot_revision=snapshot_revision+1,
            status_changed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE session_id=$1`,
        [sessionId],
      )
      return true
    })
    if (snapshot) await this.publish(uid, snapshot, true)
    return snapshot
  }

  /** Trusted platform-only transition. Deliberately not exposed by browser HTTP. */
  async markBlocked(uid: bigint, sessionId: string, expected: number): Promise<GoalStateSnapshot> {
    return this.transition(uid, sessionId, 'block', expected)
  }

  async updateEngineMetrics(args: {
    uid: bigint
    sessionId: string
    goalId: string
    stateRevision: number
    engineStatus?: string
    tokensUsed?: number
    timeUsedSeconds?: number
    engineUpdatedAt?: string
  }): Promise<GoalStateSnapshot | null> {
    if (!Number.isSafeInteger(args.stateRevision) || args.stateRevision <= 0) {
      throw new GoalStateError('INVALID', 'engine stateRevision must be a positive safe integer')
    }
    for (const [field, value] of [
      ['tokensUsed', args.tokensUsed],
      ['timeUsedSeconds', args.timeUsedSeconds],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new GoalStateError('INVALID', `engine ${field} must be a non-negative safe integer`)
      }
    }
    const snapshot = await this.mutate(args.uid, args.sessionId, async (client, row) => {
      if (!row || row.goal_id !== args.goalId || safeDbNumber(row.state_revision, 'state_revision') !== args.stateRevision) {
        return false
      }
      const tokens = args.tokensUsed ?? null
      const seconds = args.timeUsedSeconds ?? null
      const priorTokens = row.engine_tokens_used === null
        ? 0
        : safeDbNumber(row.engine_tokens_used, 'engine_tokens_used')
      const priorSeconds = row.engine_time_used_seconds === null
        ? 0
        : safeDbNumber(row.engine_time_used_seconds, 'engine_time_used_seconds')
      const nextTokens = Math.max(tokens ?? 0, priorTokens)
      const nextSeconds = Math.max(seconds ?? 0, priorSeconds)
      const changed =
        (args.engineStatus !== undefined && args.engineStatus !== row.engine_status) ||
        (tokens !== null && nextTokens !== priorTokens) ||
        (seconds !== null && nextSeconds !== priorSeconds)
      if (!changed) return false
      await client.query(
        `UPDATE session_goals SET engine_status=COALESCE($2,engine_status),
            engine_tokens_used=GREATEST(COALESCE(engine_tokens_used,0),COALESCE($3,0)),
            engine_time_used_seconds=GREATEST(COALESCE(engine_time_used_seconds,0),COALESCE($4,0)),
            engine_updated_at=COALESCE($5::timestamptz,clock_timestamp()),
            snapshot_revision=snapshot_revision+1,updated_at=clock_timestamp()
          WHERE session_id=$1 AND goal_id=$6::uuid AND state_revision=$7`,
        [args.sessionId, args.engineStatus ?? null, tokens, seconds, args.engineUpdatedAt ?? null, args.goalId, args.stateRevision],
      )
      return true
    })
    if (snapshot) await this.publish(args.uid, snapshot, false)
    return snapshot
  }

  private async transition(
    uid: bigint,
    sessionId: string,
    action: 'pause' | 'resume' | 'complete' | 'block',
    expected: number,
  ): Promise<GoalStateSnapshot> {
    const snapshot = await this.mutate(uid, sessionId, async (client, row) => {
      assertExpected(row, expected)
      if (!row) throw new GoalStateError('CONFLICT', 'goal is not set')
      const { target, idempotent } = resolveGoalTransition(row.status, action)
      if (idempotent) return false
      await client.query(
        `UPDATE session_goals SET status=$2,
            active_elapsed_ms=${settledElapsedSql()},
            active_started_at=CASE WHEN $2='active' THEN clock_timestamp() ELSE NULL END,
            state_revision=state_revision+1,snapshot_revision=snapshot_revision+1,
            status_changed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE session_id=$1`,
        [sessionId, target],
      )
      return true
    })
    if (!snapshot) throw new GoalStateError('CONFLICT', 'goal is not set')
    await this.publish(uid, snapshot, true)
    return snapshot
  }

  private async mutate(
    uid: bigint,
    sessionId: string,
    fn: (client: PoolClient, row: GoalRow | null) => Promise<boolean>,
  ): Promise<GoalStateSnapshot | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const userId = await assertOwnedSession(client, uid, sessionId, true)
      const row = await readGoalForUpdate(client, sessionId)
      await fn(client, row)
      const snapshot = await readSnapshot(client, uid, sessionId, userId)
      await client.query('COMMIT')
      return snapshot
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* original error wins */ }
      throw err
    } finally {
      client.release()
    }
  }

  private async publish(uid: bigint, snapshot: GoalStateSnapshot, sync: boolean): Promise<void> {
    const pending: Array<Promise<unknown>> = []
    if (this.broadcast) pending.push(Promise.resolve(this.broadcast(uid, snapshot)))
    if (sync && this.syncEngine) pending.push(Promise.resolve(this.syncEngine(uid, snapshot)))
    await Promise.allSettled(pending)
  }

  /** Re-read platform-owned token/credit/runtime aggregates after a tape or
   * late billing transaction commits, then publish the exact PG snapshot. */
  async refreshUsage(uid: bigint, sessionId: string): Promise<GoalStateSnapshot | null> {
    const snapshot = await this.get(uid, sessionId)
    if (snapshot) await this.publish(uid, snapshot, false)
    return snapshot
  }
}

/** Called inside the tape/cost transaction. It never changes platform state
 * revision, so a matching engine notification remains valid. */
export async function bumpGoalUsageSnapshotForTape(
  client: PoolClient,
  sessionId: string,
  userId: string,
  tapeId: string,
): Promise<boolean> {
  const updated = await client.query(
    `UPDATE session_goals g SET snapshot_revision=snapshot_revision+1,updated_at=clock_timestamp()
      FROM client_session_turn_tapes t
     WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3
       AND t.goal_id IS NOT NULL AND g.session_id=t.session_id AND g.goal_id=t.goal_id`,
    [sessionId, userId, tapeId],
  )
  return (updated.rowCount ?? 0) > 0
}
