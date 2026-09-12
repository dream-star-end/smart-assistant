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
import { effectiveDelegateOutcome } from './delegateOutcome.js'
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

export const DELEGATE_DURABLE_SCHEMA_VERSION = 5

/**
 * OCV5-164: how long a retired (TTL-elapsed) terminal row stays readable for
 * process auditing. Before this, `sweep()` physically deleted the row at the
 * 2h job TTL, so the ledger could never answer "what ran last week" — and the
 * window was biased the wrong way, because rows with a stuck callback were the
 * only ones sweep skipped. Env `OC_DELEGATE_LEDGER_RETENTION_DAYS` overrides.
 */
export const DELEGATE_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60_000
export const MIN_DELEGATE_LEDGER_RETENTION_MS = 24 * 60 * 60_000
export const MAX_DELEGATE_LEDGER_RETENTION_MS = 90 * 24 * 60 * 60_000

/**
 * Row-count floor kept in addition to the time window ("取宽"): a retired row
 * is pruned only when it is outside the retention window AND not among the
 * newest N retired rows. Bounds nothing away from the 7d guarantee; it only
 * keeps more history on a quiet container.
 */
export const DELEGATE_LEDGER_MIN_RETAINED_ROWS = 5_000

export function resolveDelegateLedgerRetentionMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const days = Number.parseFloat(String(env.OC_DELEGATE_LEDGER_RETENTION_DAYS ?? ''))
  if (!Number.isFinite(days) || days <= 0) return DELEGATE_LEDGER_RETENTION_MS
  return Math.min(
    MAX_DELEGATE_LEDGER_RETENTION_MS,
    Math.max(MIN_DELEGATE_LEDGER_RETENTION_MS, Math.round(days * 24 * 60 * 60_000)),
  )
}

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
  /** OCV5-164: set when the TTL sweep retired the row (audit-only from then on). */
  retiredAt?: number | null
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

/**
 * OCV5-164 v4. `retired_at` marks a row that the TTL sweep would previously
 * have DELETEd. Retired rows are invisible to every runtime read (see the
 * `retired_at IS NULL` guard on each statement below), so behaviour is
 * unchanged; they exist only so the ledger can be audited for 7 days.
 *
 * The idempotency uniqueness must follow the same rule: a cron occurrence key
 * whose row was retired has to be re-usable, exactly as it was when the row
 * was physically deleted. Hence the unique index is rebuilt as partial.
 */
const DDL_V4 = `
DROP INDEX IF EXISTS idx_delegate_jobs_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegate_jobs_idempotency
  ON delegate_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_delegate_jobs_retired
  ON delegate_jobs(retired_at) WHERE retired_at IS NOT NULL;
`

/** No FK to delegate_jobs: runtime retirement/pruning must not delete unread failures. */
const DDL_V5 = `
ALTER TABLE delegate_jobs ADD COLUMN failure_inbox_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (failure_inbox_enabled IN (0, 1));
CREATE TABLE delegate_failure_inbox (
  job_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL CHECK (length(user_id) > 0),
  parent_session TEXT NOT NULL CHECK (length(parent_session) > 0),
  child_session TEXT,
  summary_code TEXT NOT NULL,
  summary_text TEXT NOT NULL CHECK (length(summary_text) <= 256),
  failed_at INTEGER NOT NULL,
  ack_at INTEGER,
  PRIMARY KEY (job_id, generation)
);
CREATE INDEX idx_delegate_failure_unacked
  ON delegate_failure_inbox(user_id, failed_at DESC, job_id DESC, generation DESC)
  WHERE ack_at IS NULL;
`

export type DelegateFailureCursor = { failedAt: number; jobId: string; generation: number }
export type DelegateFailureInboxItem = {
  jobId: string
  generation: number
  userId: string
  parentSession: string
  childSession: string | null
  summaryCode: string
  summaryText: string
  failedAt: number
  ackAt: number | null
}

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
  private readonly casRetireStmt
  private readonly prunePastRetentionStmt
  private readonly listRetiredStmt
  private readonly countLedgerStmt

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
        AND retired_at IS NULL
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
        AND retired_at IS NULL
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
        AND retired_at IS NULL
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
        AND retired_at IS NULL
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
        AND retired_at IS NULL
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
        AND retired_at IS NULL
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
    // Every runtime read filters retired rows so the ledger is append-only for
    // auditing while the live state machine sees exactly what it saw before.
    this.getStmt = this.db.prepare(
      'SELECT * FROM delegate_jobs WHERE job_id = ? AND retired_at IS NULL',
    )
    this.getByIdemStmt = this.db.prepare(
      'SELECT * FROM delegate_jobs WHERE idempotency_key = ? AND retired_at IS NULL LIMIT 1',
    )
    this.listStmt = this.db.prepare('SELECT * FROM delegate_jobs WHERE retired_at IS NULL')
    this.listActiveStmt = this.db.prepare(
      `SELECT * FROM delegate_jobs
        WHERE state IN ('queued','running','paused_for_cutover') AND retired_at IS NULL`,
    )
    this.countActiveStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM delegate_jobs
        WHERE state IN ('queued','running','paused_for_cutover') AND retired_at IS NULL`,
    )
    this.deleteStmt = this.db.prepare('DELETE FROM delegate_jobs WHERE job_id = ?')
    /**
     * OCV5-164 retire = the old TTL DELETE. Same fence predicate as casDelete
     * so a racing writer still wins; the row simply stays on disk.
     */
    this.casRetireStmt = this.db.prepare(`
      UPDATE delegate_jobs SET retired_at=@now
      WHERE job_id=@job_id
        AND retired_at IS NULL
        AND state=@expected_state
        AND fencing_epoch=@expected_epoch
        AND (
          (@expected_token IS NULL AND claim_token IS NULL)
          OR claim_token=@expected_token
        )
    `)
    /**
     * Time window OR newest-N floor ("取宽"): only rows failing both are
     * dropped. COALESCE order mirrors what an auditor would call the row's
     * settle time.
     */
    this.prunePastRetentionStmt = this.db.prepare(`
      DELETE FROM delegate_jobs
      WHERE retired_at IS NOT NULL
        AND COALESCE(terminal_committed_at, updated_at, retired_at) < @cutoff
        AND job_id NOT IN (
          SELECT job_id FROM delegate_jobs
           WHERE retired_at IS NOT NULL
           ORDER BY COALESCE(terminal_committed_at, updated_at, retired_at) DESC
           LIMIT @keep_rows
        )
    `)
    this.listRetiredStmt = this.db.prepare(
      `SELECT * FROM delegate_jobs WHERE retired_at IS NOT NULL
        ORDER BY COALESCE(terminal_committed_at, updated_at, retired_at) DESC LIMIT ?`,
    )
    this.countLedgerStmt = this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN retired_at IS NULL THEN 1 ELSE 0 END) AS live,
              MIN(created_at) AS oldest
         FROM delegate_jobs`,
    )
  }

  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }) ?? 0)
    if (current >= DELEGATE_DURABLE_SCHEMA_VERSION) return
    const apply = this.db.transaction(() => {
      if (current < 1) this.db.exec(DDL_V1)
      if (current < 2) this.addNotifyDeliveryColumns()
      if (current < 3) this.addNotifyAAttemptedColumn()
      if (current < 4) this.addRetiredAtColumn()
      if (current < 5) this.db.exec(DDL_V5)
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

  /** OCV5-164 v4: soft-retire marker + partial idempotency uniqueness. */
  private addRetiredAtColumn(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(delegate_jobs)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    )
    if (!existing.has('retired_at')) {
      this.db.exec('ALTER TABLE delegate_jobs ADD COLUMN retired_at INTEGER')
    }
    this.db.exec(DDL_V4)
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  upsert(record: DurableJobRecord): void {
    this.throwIfInjectedFailure()
    this.transaction(() => {
      this.upsertStmt.run(toRow(record))
      const row = this.db.prepare('SELECT * FROM delegate_jobs WHERE job_id=?').get(record.id)
      this.persistFailureInbox(row as Record<string, unknown>)
    })
  }

  /**
   * Insert a new row inside a transaction that also arbitrates idempotency
   * and non-terminal capacity. The DB is the authority for both.
   */
  insertCreate(
    record: DurableJobRecord,
    maxJobs: number,
    opts: { failureInbox?: boolean } = {},
  ): { ok: true } | { error: 'capacity' } | { reused: DurableJobRecord } {
    this.throwIfInjectedFailure()
    return this.transaction(() => {
      if (record.idempotencyKey) {
        const hit = this.findByIdempotencyKey(record.idempotencyKey)
        if (hit) return { reused: hit }
      }
      const n = this.countNonTerminal()
      if (n >= maxJobs) return { error: 'capacity' as const }
      if (opts.failureInbox && (!record.callbackOriginUserId?.trim() || !record.parentSessionKey?.trim())) {
        throw new Error('delegate failure inbox requires verified owner and parent')
      }
      try {
        this.insertStmt.run(toRow(record))
      } catch (err) {
        const code = (err as { code?: string }).code ?? ''
        if (code.startsWith('SQLITE_CONSTRAINT') && record.idempotencyKey) {
          const hit = this.findByIdempotencyKey(record.idempotencyKey)
          if (hit) return { reused: hit }
        }
        throw err
      }
      // Only an INSERT collision is reusable. An auxiliary write failure must
      // roll back, not find this transaction's own row and misreport reuse.
      if (opts.failureInbox) {
        this.db.prepare('UPDATE delegate_jobs SET failure_inbox_enabled=1 WHERE job_id=?').run(record.id)
        this.persistFailureInbox({ ...toRow(record), failure_inbox_enabled: 1 })
      }
      return { ok: true as const }
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
    return this.transaction(() => {
      const row = this.casUpdateStmt.get({
        ...toRow(record),
        expected_state: expected.state,
        expected_epoch: expected.fencingEpoch,
        expected_token: expected.claimToken ?? null,
      }) as Record<string, unknown> | undefined
      if (!row) return undefined
      this.persistFailureInbox(row)
      return fromRow(row)
    })
  }

  /** Runs inside the winning job write transaction, before wake/onTerminal. */
  private persistFailureInbox(row: Record<string, unknown>): void {
    if (row.failure_inbox_enabled !== 1) return
    const record = fromRow(row)
    const outcome = effectiveDelegateOutcome(record)
    if (outcome !== 'failed' && outcome !== 'killed_by_cutover') return
    // Deliberately do not retain raw output/errors/credentials in the cross-session index.
    const summaryCode = outcome === 'killed_by_cutover' ? 'killed_by_cutover' : 'delegate_failed'
    const summaryText = outcome === 'killed_by_cutover' ? '子任务因服务切换中断' : '子任务失败，可展开详情'
    this.db.prepare(`
      INSERT INTO delegate_failure_inbox
        (job_id, generation, user_id, parent_session, child_session, summary_code, summary_text, failed_at)
      VALUES (@jobId, @generation, @userId, @parentSession, @childSession, @summaryCode, @summaryText, @failedAt)
      ON CONFLICT(job_id, generation) DO NOTHING
    `).run({
      jobId: record.id, generation: record.generation,
      userId: record.callbackOriginUserId ?? '', parentSession: record.parentSessionKey ?? '',
      childSession: record.sessionKey ?? null, summaryCode, summaryText,
      failedAt: record.terminalCommittedAt ?? record.lastActivityAt,
    })
  }

  /** Indexed user-scoped inbox; independent of runtime TTL and surface cap. */
  listUnacknowledgedFailures(
    userId: string,
    opts: { limit?: number; before?: DelegateFailureCursor } = {},
  ): { items: DelegateFailureInboxItem[]; nextCursor: DelegateFailureCursor | null; count: number } {
    if (!userId.trim()) throw new Error('failure inbox user required')
    const limit = Math.min(50, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit!) : 20))
    const before = opts.before
    if (before && (!Number.isSafeInteger(before.failedAt) || !Number.isSafeInteger(before.generation) || !before.jobId)) {
      throw new Error('invalid failure inbox cursor')
    }
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM delegate_failure_inbox
        WHERE user_id=@userId AND ack_at IS NULL
          ${before ? 'AND (failed_at, job_id, generation) < (@failedAt, @jobId, @generation)' : ''}
        ORDER BY failed_at DESC, job_id DESC, generation DESC LIMIT @limit
      `).all({ userId, limit: limit + 1, ...(before ?? {}) }) as Array<Record<string, unknown>>
      const more = rows.length > limit
      const items = rows.slice(0, limit).map(failureInboxFromRow)
      const last = items.at(-1)
      const count = (this.db.prepare(`SELECT count(*) AS n FROM delegate_failure_inbox
        WHERE user_id=? AND ack_at IS NULL`).get(userId) as { n: number }).n
      return { items, count, nextCursor: more && last
        ? { failedAt: last.failedAt, jobId: last.jobId, generation: last.generation } : null }
    })
  }

  /** Idempotent across tabs/restarts. Ownership comes from the inbox, not the expired job. */
  acknowledgeFailure(userId: string, jobId: string, generation: number, now: number): boolean {
    if (!userId.trim() || !Number.isSafeInteger(generation) || !Number.isSafeInteger(now)) {
      throw new Error('invalid failure acknowledgement')
    }
    this.throwIfInjectedFailure()
    return this.db.prepare(`UPDATE delegate_failure_inbox SET ack_at=COALESCE(ack_at, @now)
      WHERE user_id=@userId AND job_id=@jobId AND generation=@generation
      RETURNING job_id`).get({ userId, jobId, generation, now }) !== undefined
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

  /**
   * OCV5-164 soft-retire, replacing the TTL DELETE. Returns false when the
   * fence no longer matches, exactly like {@link casDelete}, so a concurrent
   * writer still wins the row.
   */
  casRetire(args: {
    jobId: string
    state: string
    fencingEpoch: number
    claimToken?: string | null
    now: number
  }): boolean {
    this.throwIfInjectedFailure()
    const info = this.casRetireStmt.run({
      job_id: args.jobId,
      expected_state: args.state,
      expected_epoch: args.fencingEpoch,
      expected_token: args.claimToken ?? null,
      now: args.now,
    })
    return (info.changes ?? 0) > 0
  }

  /** Drop retired rows older than the retention window, keeping a newest-N floor. */
  prunePastRetention(args: {
    cutoff: number
    keepRows?: number
  }): number {
    this.throwIfInjectedFailure()
    const info = this.prunePastRetentionStmt.run({
      cutoff: args.cutoff,
      keep_rows: Math.max(0, args.keepRows ?? DELEGATE_LEDGER_MIN_RETAINED_ROWS),
    })
    return info.changes ?? 0
  }

  /** Audit-only read of retired history. Never feeds the state machine. */
  loadRetired(limit = 1_000): DurableJobRecord[] {
    return (this.listRetiredStmt.all(limit) as Record<string, unknown>[]).map(fromRow)
  }

  /** Audit/observability counters for the retention window. */
  ledgerStats(): { total: number; live: number; retired: number; oldestCreatedAt: number | null } {
    const row = this.countLedgerStmt.get() as
      | { total?: number; live?: number; oldest?: number | null }
      | undefined
    const total = Number(row?.total ?? 0)
    const live = Number(row?.live ?? 0)
    return {
      total,
      live,
      retired: Math.max(0, total - live),
      oldestCreatedAt: row?.oldest == null ? null : Number(row.oldest),
    }
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
    retiredAt: row.retired_at == null ? null : num(row.retired_at),
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function failureInboxFromRow(row: Record<string, unknown>): DelegateFailureInboxItem {
  return {
    jobId: String(row.job_id), generation: num(row.generation), userId: String(row.user_id),
    parentSession: String(row.parent_session), childSession: str(row.child_session) ?? null,
    summaryCode: String(row.summary_code), summaryText: String(row.summary_text),
    failedAt: num(row.failed_at), ackAt: row.ack_at == null ? null : num(row.ack_at),
  }
}
