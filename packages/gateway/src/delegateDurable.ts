/**
 * OCV5-22 stage 1: volume SQLite for delegate jobs (WAL, single writer).
 *
 * Path sits next to sessions.db / taskboard.db under OPENCLAUDE_HOME
 * (`delegate-jobs.db`). Override: OPENCLAUDE_DELEGATE_JOBS_DB.
 * Schema version is PRAGMA user_version (gateway-local SQLite, not a
 * commercial PG migration). Flag OC_DELEGATE_DURABLE defaults off.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type {
  DelegateCallback,
  DelegateCallbackState,
  DelegateCheckpointKind,
  DelegateFailureClass,
  DelegateJobKind,
  DelegateJobState,
} from '@openclaude/protocol'

/** Structural twin of DelegateJobHttpResult; kept local to avoid a cycle. */
export type DurableJobResult = {
  httpStatus: number
  body: Record<string, unknown>
}

export const DELEGATE_DURABLE_SCHEMA_VERSION = 3

export type DurableJobRecord = {
  id: string
  agentId: string
  state: DelegateJobState
  kind: DelegateJobKind
  sessionKey?: string
  parentSessionKey?: string
  generation: number
  ownerInstanceId?: string
  ownerLeaseUntil?: number | null
  claimToken?: string
  attemptNo: number
  fencingEpoch: number
  checkpointKind: DelegateCheckpointKind
  callback: DelegateCallback
  callbackState: DelegateCallbackState
  callbackEpoch: number
  idempotencyKey?: string
  failureClass?: DelegateFailureClass
  failureDetail?: string
  result?: DurableJobResult | null
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  expiresAt?: number | null
  parentEngine?: string
  notifyLane?: string
  notifyId?: string
  callbackOriginSessionKey?: string
  callbackOriginUserId?: string
  notifyRetryAt?: number | null
  notifyAttempt?: number
  notifyDeliveryToken?: string
  notifyClaimedUntil?: number | null
  terminalCommittedAt?: number
  /** Unix ms when lane A attempted an external write for this notifyId. */
  notifyAAttemptedAt?: number | null
}

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS delegate_jobs (
  job_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_key TEXT,
  parent_session_key TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  owner_instance_id TEXT,
  owner_lease_until INTEGER,
  claim_token TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 0,
  fencing_epoch INTEGER NOT NULL DEFAULT 0,
  checkpoint_kind TEXT NOT NULL DEFAULT 'none',
  callback TEXT NOT NULL DEFAULT 'none',
  callback_state TEXT NOT NULL DEFAULT 'none',
  callback_epoch INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  failure_class TEXT,
  failure_detail TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER,
  parent_engine TEXT,
  notify_lane TEXT,
  notify_id TEXT,
  callback_origin_session_key TEXT,
  callback_origin_user_id TEXT,
  notify_retry_at INTEGER,
  notify_attempt INTEGER NOT NULL DEFAULT 0,
  notify_delivery_token TEXT,
  notify_claimed_until INTEGER,
  terminal_committed_at INTEGER,
  notify_a_attempted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegate_jobs_idempotency
  ON delegate_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delegate_jobs_active
  ON delegate_jobs(state, owner_lease_until)
  WHERE state IN ('queued','running','paused_for_cutover');
`

export function resolveDelegateJobsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAUDE_DELEGATE_JOBS_DB?.trim()
  if (override) return override
  const home = env.OPENCLAUDE_HOME?.trim() || join(homedir(), '.openclaude')
  return join(home, 'delegate-jobs.db')
}

type SqliteDb = InstanceType<typeof Database>

export class DelegateDurableDb {
  readonly path: string
  private readonly db: SqliteDb
  failNextWrite = false
  private closed = false
  private readonly upsertStmt
  private readonly insertStmt
  private readonly casUpdateStmt
  private readonly casDeleteStmt
  private readonly casClaimNotifyStmt
  private readonly casCompleteNotifyStmt
  private readonly casReleaseNotifyStmt
  private readonly casMarkAAttemptedStmt
  private readonly getStmt
  private readonly getByIdemStmt
  private readonly listStmt
  private readonly listActiveStmt
  private readonly countActiveStmt
  private readonly deleteStmt

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.path = dbPath
    this.db = new Database(dbPath)
    this.db.pragma('busy_timeout = 10000')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
    this.upsertStmt = this.db.prepare(`
      INSERT INTO delegate_jobs (
        job_id, agent_id, state, kind, session_key, parent_session_key, generation,
        owner_instance_id, owner_lease_until, claim_token, attempt_no, fencing_epoch,
        checkpoint_kind, callback, callback_state, callback_epoch, idempotency_key,
        failure_class, failure_detail, result_json, created_at, updated_at,
        last_activity_at, expires_at, parent_engine, notify_lane, notify_id,
        callback_origin_session_key, callback_origin_user_id, notify_retry_at, notify_attempt,
        notify_delivery_token, notify_claimed_until, terminal_committed_at
      ) VALUES (
        @job_id, @agent_id, @state, @kind, @session_key, @parent_session_key, @generation,
        @owner_instance_id, @owner_lease_until, @claim_token, @attempt_no, @fencing_epoch,
        @checkpoint_kind, @callback, @callback_state, @callback_epoch, @idempotency_key,
        @failure_class, @failure_detail, @result_json, @created_at, @updated_at,
        @last_activity_at, @expires_at, @parent_engine, @notify_lane, @notify_id,
        @callback_origin_session_key, @callback_origin_user_id, @notify_retry_at, @notify_attempt,
        @notify_delivery_token, @notify_claimed_until, @terminal_committed_at
      )
      ON CONFLICT(job_id) DO UPDATE SET
        agent_id=excluded.agent_id,
        state=excluded.state,
        kind=excluded.kind,
        session_key=excluded.session_key,
        parent_session_key=excluded.parent_session_key,
        generation=excluded.generation,
        owner_instance_id=excluded.owner_instance_id,
        owner_lease_until=excluded.owner_lease_until,
        claim_token=excluded.claim_token,
        attempt_no=excluded.attempt_no,
        fencing_epoch=excluded.fencing_epoch,
        checkpoint_kind=excluded.checkpoint_kind,
        callback=excluded.callback,
        callback_state=excluded.callback_state,
        callback_epoch=excluded.callback_epoch,
        idempotency_key=excluded.idempotency_key,
        failure_class=excluded.failure_class,
        failure_detail=excluded.failure_detail,
        result_json=excluded.result_json,
        updated_at=excluded.updated_at,
        last_activity_at=excluded.last_activity_at,
        expires_at=excluded.expires_at,
        parent_engine=excluded.parent_engine,
        notify_lane=excluded.notify_lane,
        notify_id=excluded.notify_id,
        callback_origin_session_key=excluded.callback_origin_session_key,
        callback_origin_user_id=excluded.callback_origin_user_id,
        notify_retry_at=excluded.notify_retry_at,
        notify_attempt=excluded.notify_attempt,
        notify_delivery_token=excluded.notify_delivery_token,
        notify_claimed_until=excluded.notify_claimed_until,
        terminal_committed_at=excluded.terminal_committed_at
    `)
    this.insertStmt = this.db.prepare(`
      INSERT INTO delegate_jobs (
        job_id, agent_id, state, kind, session_key, parent_session_key, generation,
        owner_instance_id, owner_lease_until, claim_token, attempt_no, fencing_epoch,
        checkpoint_kind, callback, callback_state, callback_epoch, idempotency_key,
        failure_class, failure_detail, result_json, created_at, updated_at,
        last_activity_at, expires_at, parent_engine, notify_lane, notify_id,
        callback_origin_session_key, callback_origin_user_id, notify_retry_at, notify_attempt,
        notify_delivery_token, notify_claimed_until, terminal_committed_at
      ) VALUES (
        @job_id, @agent_id, @state, @kind, @session_key, @parent_session_key, @generation,
        @owner_instance_id, @owner_lease_until, @claim_token, @attempt_no, @fencing_epoch,
        @checkpoint_kind, @callback, @callback_state, @callback_epoch, @idempotency_key,
        @failure_class, @failure_detail, @result_json, @created_at, @updated_at,
        @last_activity_at, @expires_at, @parent_engine, @notify_lane, @notify_id,
        @callback_origin_session_key, @callback_origin_user_id, @notify_retry_at, @notify_attempt,
        @notify_delivery_token, @notify_claimed_until, @terminal_committed_at
      )
    `)
    this.casUpdateStmt = this.db.prepare(`
      UPDATE delegate_jobs SET
        agent_id=@agent_id,
        state=@state,
        kind=@kind,
        session_key=@session_key,
        parent_session_key=@parent_session_key,
        generation=@generation,
        owner_instance_id=@owner_instance_id,
        owner_lease_until=@owner_lease_until,
        claim_token=@claim_token,
        attempt_no=@attempt_no,
        fencing_epoch=@fencing_epoch,
        checkpoint_kind=@checkpoint_kind,
        callback=@callback,
        callback_state=@callback_state,
        callback_epoch=@callback_epoch,
        idempotency_key=@idempotency_key,
        failure_class=@failure_class,
        failure_detail=@failure_detail,
        result_json=@result_json,
        updated_at=@updated_at,
        last_activity_at=@last_activity_at,
        expires_at=@expires_at,
        parent_engine=@parent_engine,
        notify_lane=@notify_lane,
        notify_id=@notify_id,
        callback_origin_session_key=@callback_origin_session_key,
        callback_origin_user_id=@callback_origin_user_id,
        notify_retry_at=@notify_retry_at,
        notify_attempt=@notify_attempt,
        notify_delivery_token=@notify_delivery_token,
        notify_claimed_until=@notify_claimed_until,
        terminal_committed_at=@terminal_committed_at
      WHERE job_id=@job_id
        AND state=@expected_state
        AND fencing_epoch=@expected_epoch
        AND (
          (@expected_token IS NULL AND claim_token IS NULL)
          OR claim_token=@expected_token
        )
      RETURNING *
    `)
    this.casDeleteStmt = this.db.prepare(`
      DELETE FROM delegate_jobs
      WHERE job_id=@job_id
        AND state=@expected_state
        AND fencing_epoch=@expected_epoch
        AND (
          (@expected_token IS NULL AND claim_token IS NULL)
          OR claim_token=@expected_token
        )
    `)
    this.casClaimNotifyStmt = this.db.prepare(`
      UPDATE delegate_jobs SET
        callback_state='injecting',
        notify_delivery_token=@delivery_token,
        notify_claimed_until=@claimed_until,
        last_activity_at=@now,
        updated_at=@now
      WHERE job_id=@job_id
        AND state=@expected_state
        AND fencing_epoch=@expected_epoch
        AND (
          (@expected_token IS NULL AND claim_token IS NULL)
          OR claim_token=@expected_token
        )
        AND (
          callback_state='pending'
          OR (
            callback_state='injecting'
            AND (notify_claimed_until IS NULL OR notify_claimed_until < @now)
          )
        )
      RETURNING *
    `)
    this.casCompleteNotifyStmt = this.db.prepare(`
      UPDATE delegate_jobs SET
        callback_state='delivered',
        notify_delivery_token=NULL,
        notify_claimed_until=NULL,
        notify_retry_at=NULL,
        last_activity_at=@now,
        updated_at=@now
      WHERE job_id=@job_id
        AND state=@expected_state
        AND fencing_epoch=@expected_epoch
        AND (
          (@expected_token IS NULL AND claim_token IS NULL)
          OR claim_token=@expected_token
        )
        AND callback_state='injecting'
        AND notify_delivery_token=@delivery_token
      RETURNING *
    `)
    this.casReleaseNotifyStmt = this.db.prepare(`
      UPDATE delegate_jobs SET
        callback_state='pending',
        notify_delivery_token=NULL,
        notify_claimed_until=NULL,
        notify_retry_at=@retry_at,
        notify_attempt=@notify_attempt,
        last_activity_at=@now,
        updated_at=@now
      WHERE job_id=@job_id
        AND state=@expected_state
        AND fencing_epoch=@expected_epoch
        AND (
          (@expected_token IS NULL AND claim_token IS NULL)
          OR claim_token=@expected_token
        )
        AND callback_state='injecting'
        AND notify_delivery_token=@delivery_token
      RETURNING *
    `)
    this.casMarkAAttemptedStmt = this.db.prepare(`
      UPDATE delegate_jobs SET
        notify_a_attempted_at=COALESCE(notify_a_attempted_at, @now),
        last_activity_at=@now,
        updated_at=@now
      WHERE job_id=@job_id
        AND state=@expected_state
        AND fencing_epoch=@expected_epoch
        AND (
          (@expected_token IS NULL AND claim_token IS NULL)
          OR claim_token=@expected_token
        )
        AND callback_state='injecting'
        AND notify_delivery_token=@delivery_token
      RETURNING *
    `)
    this.getStmt = this.db.prepare('SELECT * FROM delegate_jobs WHERE job_id = ?')
    this.getByIdemStmt = this.db.prepare(
      'SELECT * FROM delegate_jobs WHERE idempotency_key = ? LIMIT 1',
    )
    this.listStmt = this.db.prepare('SELECT * FROM delegate_jobs')
    this.listActiveStmt = this.db.prepare(
      `SELECT * FROM delegate_jobs WHERE state IN ('queued','running','paused_for_cutover')`,
    )
    this.countActiveStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM delegate_jobs WHERE state IN ('queued','running','paused_for_cutover')`,
    )
    this.deleteStmt = this.db.prepare('DELETE FROM delegate_jobs WHERE job_id = ?')
  }

  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }) ?? 0)
    if (current >= DELEGATE_DURABLE_SCHEMA_VERSION) return
    const apply = this.db.transaction(() => {
      if (current < 1) this.db.exec(DDL_V1)
      if (current < 2) this.addNotifyDeliveryColumns()
      if (current < 3) this.addNotifyAAttemptedColumn()
      this.db.pragma(`user_version = ${DELEGATE_DURABLE_SCHEMA_VERSION}`)
    })
    apply()
  }

  private addNotifyDeliveryColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(delegate_jobs)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    )
    const columns: Array<[string, string]> = [
      ['callback_origin_session_key', 'TEXT'],
      ['callback_origin_user_id', 'TEXT'],
      ['notify_retry_at', 'INTEGER'],
      ['notify_attempt', 'INTEGER NOT NULL DEFAULT 0'],
      ['notify_delivery_token', 'TEXT'],
      ['notify_claimed_until', 'INTEGER'],
      ['terminal_committed_at', 'INTEGER'],
    ]
    for (const [name, type] of columns) {
      if (existing.has(name)) continue
      this.db.exec(`ALTER TABLE delegate_jobs ADD COLUMN ${name} ${type}`)
    }
  }

  private addNotifyAAttemptedColumn(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(delegate_jobs)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    )
    if (existing.has('notify_a_attempted_at')) return
    this.db.exec('ALTER TABLE delegate_jobs ADD COLUMN notify_a_attempted_at INTEGER')
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  upsert(record: DurableJobRecord): void {
    this.throwIfInjectedFailure()
    this.upsertStmt.run(toRow(record))
  }

  /**
   * Insert a new row inside a transaction that also arbitrates idempotency
   * and non-terminal capacity. The DB is the authority for both.
   */
  insertCreate(
    record: DurableJobRecord,
    maxJobs: number,
  ): { ok: true } | { error: 'capacity' } | { reused: DurableJobRecord } {
    this.throwIfInjectedFailure()
    return this.transaction(() => {
      if (record.idempotencyKey) {
        const hit = this.findByIdempotencyKey(record.idempotencyKey)
        if (hit) return { reused: hit }
      }
      const n = this.countNonTerminal()
      if (n >= maxJobs) return { error: 'capacity' as const }
      try {
        this.insertStmt.run(toRow(record))
        return { ok: true as const }
      } catch (err) {
        const code = (err as { code?: string }).code ?? ''
        if (code.startsWith('SQLITE_CONSTRAINT') && record.idempotencyKey) {
          const hit = this.findByIdempotencyKey(record.idempotencyKey)
          if (hit) return { reused: hit }
        }
        throw err
      }
    })
  }

  /**
   * Fence CAS: only the row matching (job_id, expected state, epoch, token)
   * is replaced. Returns the persisted row, or undefined when this writer lost.
   */
  casUpdate(
    expected: {
      jobId: string
      state: string
      fencingEpoch: number
      claimToken?: string | null
    },
    record: DurableJobRecord,
  ): DurableJobRecord | undefined {
    this.throwIfInjectedFailure()
    const row = this.casUpdateStmt.get({
      ...toRow(record),
      expected_state: expected.state,
      expected_epoch: expected.fencingEpoch,
      expected_token: expected.claimToken ?? null,
    }) as Record<string, unknown> | undefined
    return row ? fromRow(row) : undefined
  }

  casDelete(expected: {
    jobId: string
    state: string
    fencingEpoch: number
    claimToken?: string | null
  }): boolean {
    this.throwIfInjectedFailure()
    const info = this.casDeleteStmt.run({
      job_id: expected.jobId,
      expected_state: expected.state,
      expected_epoch: expected.fencingEpoch,
      expected_token: expected.claimToken ?? null,
    })
    return info.changes === 1
  }

  casClaimNotify(args: {
    jobId: string
    state: string
    fencingEpoch: number
    claimToken?: string | null
    deliveryToken: string
    now: number
    claimedUntil: number
  }): DurableJobRecord | undefined {
    this.throwIfInjectedFailure()
    const row = this.casClaimNotifyStmt.get({
      job_id: args.jobId,
      expected_state: args.state,
      expected_epoch: args.fencingEpoch,
      expected_token: args.claimToken ?? null,
      delivery_token: args.deliveryToken,
      now: args.now,
      claimed_until: args.claimedUntil,
    }) as Record<string, unknown> | undefined
    return row ? fromRow(row) : undefined
  }

  casCompleteNotify(args: {
    jobId: string
    state: string
    fencingEpoch: number
    claimToken?: string | null
    deliveryToken: string
    now: number
  }): DurableJobRecord | undefined {
    this.throwIfInjectedFailure()
    const row = this.casCompleteNotifyStmt.get({
      job_id: args.jobId,
      expected_state: args.state,
      expected_epoch: args.fencingEpoch,
      expected_token: args.claimToken ?? null,
      delivery_token: args.deliveryToken,
      now: args.now,
    }) as Record<string, unknown> | undefined
    return row ? fromRow(row) : undefined
  }

  casReleaseNotify(args: {
    jobId: string
    state: string
    fencingEpoch: number
    claimToken?: string | null
    deliveryToken: string
    now: number
    retryAt: number
    notifyAttempt: number
  }): DurableJobRecord | undefined {
    this.throwIfInjectedFailure()
    const row = this.casReleaseNotifyStmt.get({
      job_id: args.jobId,
      expected_state: args.state,
      expected_epoch: args.fencingEpoch,
      expected_token: args.claimToken ?? null,
      delivery_token: args.deliveryToken,
      now: args.now,
      retry_at: args.retryAt,
      notify_attempt: args.notifyAttempt,
    }) as Record<string, unknown> | undefined
    return row ? fromRow(row) : undefined
  }

  casMarkAAttempted(args: {
    jobId: string
    state: string
    fencingEpoch: number
    claimToken?: string | null
    deliveryToken: string
    now: number
  }): DurableJobRecord | undefined {
    this.throwIfInjectedFailure()
    const row = this.casMarkAAttemptedStmt.get({
      job_id: args.jobId,
      expected_state: args.state,
      expected_epoch: args.fencingEpoch,
      expected_token: args.claimToken ?? null,
      delivery_token: args.deliveryToken,
      now: args.now,
    }) as Record<string, unknown> | undefined
    return row ? fromRow(row) : undefined
  }

  countNonTerminal(): number {
    const row = this.countActiveStmt.get() as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  private throwIfInjectedFailure(): void {
    if (!this.failNextWrite) return
    this.failNextWrite = false
    const err = new Error('delegate durable persist failed')
    ;(err as NodeJS.ErrnoException).code = 'ENOSPC'
    throw err
  }

  get(jobId: string): DurableJobRecord | undefined {
    const row = this.getStmt.get(jobId) as Record<string, unknown> | undefined
    return row ? fromRow(row) : undefined
  }

  findByIdempotencyKey(key: string): DurableJobRecord | undefined {
    const row = this.getByIdemStmt.get(key) as Record<string, unknown> | undefined
    return row ? fromRow(row) : undefined
  }

  loadAll(): DurableJobRecord[] {
    return (this.listStmt.all() as Record<string, unknown>[]).map(fromRow)
  }

  loadNonTerminal(): DurableJobRecord[] {
    return (this.listActiveStmt.all() as Record<string, unknown>[]).map(fromRow)
  }

  delete(jobId: string): void {
    this.throwIfInjectedFailure()
    this.deleteStmt.run(jobId)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* shutdown path */
    }
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

export function openDelegateDurableDb(
  dbPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): DelegateDurableDb {
  return new DelegateDurableDb(dbPath ?? resolveDelegateJobsDbPath(env))
}

function toRow(record: DurableJobRecord): Record<string, unknown> {
  return {
    job_id: record.id,
    agent_id: record.agentId,
    state: record.state,
    kind: record.kind,
    session_key: record.sessionKey ?? null,
    parent_session_key: record.parentSessionKey ?? null,
    generation: record.generation,
    owner_instance_id: record.ownerInstanceId ?? null,
    owner_lease_until: record.ownerLeaseUntil ?? null,
    claim_token: record.claimToken ?? null,
    attempt_no: record.attemptNo,
    fencing_epoch: record.fencingEpoch,
    checkpoint_kind: record.checkpointKind,
    callback: record.callback,
    callback_state: record.callbackState,
    callback_epoch: record.callbackEpoch,
    idempotency_key: record.idempotencyKey ?? null,
    failure_class: record.failureClass ?? null,
    failure_detail: record.failureDetail ?? null,
    result_json: record.result ? JSON.stringify(record.result) : null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    last_activity_at: record.lastActivityAt,
    expires_at: record.expiresAt ?? null,
    parent_engine: record.parentEngine ?? null,
    notify_lane: record.notifyLane ?? null,
    notify_id: record.notifyId ?? null,
    callback_origin_session_key: record.callbackOriginSessionKey ?? null,
    callback_origin_user_id: record.callbackOriginUserId ?? null,
    notify_retry_at: record.notifyRetryAt ?? null,
    notify_attempt: record.notifyAttempt ?? 0,
    notify_delivery_token: record.notifyDeliveryToken ?? null,
    notify_claimed_until: record.notifyClaimedUntil ?? null,
    terminal_committed_at: record.terminalCommittedAt ?? null,
    notify_a_attempted_at: record.notifyAAttemptedAt ?? null,
  }
}

function fromRow(row: Record<string, unknown>): DurableJobRecord {
  let result: DurableJobResult | null | undefined
  if (typeof row.result_json === 'string' && row.result_json) {
    try {
      result = JSON.parse(row.result_json) as DurableJobResult
    } catch {
      result = undefined
    }
  }
  return {
    id: String(row.job_id),
    agentId: String(row.agent_id),
    state: row.state as DelegateJobState,
    kind: (row.kind as DelegateJobKind) ?? 'delegate',
    sessionKey: str(row.session_key),
    parentSessionKey: str(row.parent_session_key),
    generation: num(row.generation),
    ownerInstanceId: str(row.owner_instance_id),
    ownerLeaseUntil: row.owner_lease_until == null ? null : num(row.owner_lease_until),
    claimToken: str(row.claim_token),
    attemptNo: num(row.attempt_no),
    fencingEpoch: num(row.fencing_epoch),
    checkpointKind: (row.checkpoint_kind as DelegateCheckpointKind) ?? 'none',
    callback: (row.callback as DelegateCallback) ?? 'none',
    callbackState: (row.callback_state as DelegateCallbackState) ?? 'none',
    callbackEpoch: num(row.callback_epoch),
    idempotencyKey: str(row.idempotency_key),
    failureClass: row.failure_class as DelegateFailureClass | undefined,
    failureDetail: str(row.failure_detail),
    result: result ?? null,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    lastActivityAt: num(row.last_activity_at) || num(row.updated_at),
    expiresAt: row.expires_at == null ? null : num(row.expires_at),
    parentEngine: str(row.parent_engine),
    notifyLane: str(row.notify_lane),
    notifyId: str(row.notify_id),
    callbackOriginSessionKey: str(row.callback_origin_session_key),
    callbackOriginUserId: str(row.callback_origin_user_id),
    notifyRetryAt: row.notify_retry_at == null ? null : num(row.notify_retry_at),
    notifyAttempt: num(row.notify_attempt),
    notifyDeliveryToken: str(row.notify_delivery_token),
    notifyClaimedUntil: row.notify_claimed_until == null ? null : num(row.notify_claimed_until),
    terminalCommittedAt: row.terminal_committed_at == null ? undefined : num(row.terminal_committed_at),
    notifyAAttemptedAt: row.notify_a_attempted_at == null ? null : num(row.notify_a_attempted_at),
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
