/**
 * OCV5-22 stage 1: volume SQLite for delegate jobs (WAL, single writer).
 *
 * Path sits next to sessions.db / taskboard.db under OPENCLAUDE_HOME
 * (`delegate-jobs.db`). Override: OPENCLAUDE_DELEGATE_JOBS_DB.
 * Schema version is PRAGMA user_version (gateway-local SQLite, not a
 * commercial PG migration). Flag OC_DELEGATE_DURABLE defaults off.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { withReceiptWriteBarrier } from '@openclaude/storage/receiptWriteBarrier'
import { checkedReceiptToolOwner } from './receiptOwnerCapability.js'
import type { ReceiptToolOwner } from './engine/engineAdapter.js'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { effectiveDelegateOutcome } from './delegateOutcome.js'
import { checkedDelegateRetrySource, checkedDelegateRetryActionKey, type DelegateRetrySource,
  type DelegateRetryActionKey, type DelegateRetryAction } from './delegateRetrySource.js'
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

export const DELEGATE_DURABLE_SCHEMA_VERSION = 9

// Additive local SQLite schema; no FK/TTL cascade from runtime jobs to retry identity.
const DDL_V9 = `
CREATE TABLE delegate_retry_source (
  job_id TEXT NOT NULL, generation INTEGER NOT NULL, user_id TEXT NOT NULL,
  parent_client_session_id TEXT, parent_session TEXT, child_session TEXT, target_agent_id TEXT,
  metadata_json TEXT, created_at INTEGER NOT NULL, retired_at INTEGER,
  PRIMARY KEY(job_id,generation)
);
CREATE INDEX idx_delegate_retry_source_parent ON delegate_retry_source(user_id,parent_client_session_id)
  WHERE retired_at IS NULL;
CREATE TABLE delegate_retry_parent_fence (
  user_id TEXT NOT NULL, client_session_id TEXT NOT NULL, deleted_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,client_session_id)
);
CREATE TABLE delegate_retry_action (
  user_id TEXT NOT NULL, source_job_id TEXT NOT NULL, generation INTEGER NOT NULL,
  action_id TEXT NOT NULL, target_job_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, dispatched_at INTEGER, terminal_code TEXT,
  PRIMARY KEY(user_id,source_job_id,generation,action_id)
);
`

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

/** Trusted create-time binding. Nonce is supplied by the paired caller; only its hash is stored. */
export type DelegateReceiptContext = {
  parentTurnKey: string
  nativeToolUseId: string
  receiptNonceHash: string
  parent?: { agentId: string; owner: ReceiptToolOwner }
}
export type DelegateDeliveryReceipt = DelegateReceiptContext & {
  jobId: string
  generation: number
  userId: string
  parentSession: string
  resultDigest: string
  state: 'offered' | 'ingest_claimed' | 'ingested' | 'notify_pending' | 'notify_claimed' | 'notified'
  createdAt: number
}
const DDL_V6 = `
ALTER TABLE delegate_jobs ADD COLUMN delivery_receipt_context TEXT;
CREATE TABLE delegate_delivery_receipt (
  job_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  parent_session TEXT NOT NULL,
  parent_turn_key TEXT NOT NULL,
  native_tool_use_id TEXT NOT NULL,
  receipt_nonce_hash TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered'
    CHECK(state IN ('offered','ingest_claimed','ingested','notify_pending','notify_claimed','notified')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, generation)
);
CREATE INDEX idx_delegate_receipt_pending ON delegate_delivery_receipt(parent_session, state, created_at);
`
const DDL_V7 = `
ALTER TABLE delegate_delivery_receipt ADD COLUMN owner_token TEXT;
ALTER TABLE delegate_delivery_receipt ADD COLUMN parent_owner_epoch TEXT;
ALTER TABLE delegate_delivery_receipt ADD COLUMN input_proof TEXT;
`
function checkedReceiptContext(context: DelegateReceiptContext): DelegateReceiptContext {
  if (typeof context.parentTurnKey !== 'string' || !context.parentTurnKey.trim() || context.parentTurnKey.length > 256 ||
      typeof context.nativeToolUseId !== 'string' || !context.nativeToolUseId.trim() || context.nativeToolUseId.length > 256 ||
      typeof context.receiptNonceHash !== 'string' || !/^[a-f0-9]{64}$/.test(context.receiptNonceHash)) {
    throw new Error('invalid delegate receipt context')
  }
  let parent: DelegateReceiptContext['parent']
  if (context.parent !== undefined) {
    const { agentId, owner: rawOwner } = context.parent
    if (typeof agentId !== 'string' || !agentId || agentId.length > 256) throw new Error('invalid receipt parent agent')
    const owner = checkedReceiptToolOwner(rawOwner)
    if (owner.turnKey !== context.parentTurnKey || owner.consumerToolUseId !== context.nativeToolUseId) throw new Error('receipt creator owner mismatch')
    parent = { agentId, owner }
  }
  return { parentTurnKey: context.parentTurnKey, nativeToolUseId: context.nativeToolUseId, receiptNonceHash: context.receiptNonceHash,
    ...(parent ? { parent } : {}) }
}

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
    const apply = this.db.transaction(() => {
      // Obtain the migration writer lock before reading the version. A second
      // opener must observe the first opener's commit, not rerun its ALTER.
      const current = Number(this.db.pragma('user_version', { simple: true }) ?? 0)
      if (current >= DELEGATE_DURABLE_SCHEMA_VERSION) return
      if (current < 1) this.db.exec(DDL_V1)
      if (current < 2) this.addNotifyDeliveryColumns()
      if (current < 3) this.addNotifyAAttemptedColumn()
      if (current < 4) this.addRetiredAtColumn()
      if (current < 5) this.db.exec(DDL_V5)
      if (current < 6) this.db.exec(DDL_V6)
      if (current < 7) this.db.exec(DDL_V7)
      if (current < 8) this.db.exec(`CREATE INDEX idx_delegate_user_active ON delegate_jobs(callback_origin_user_id,state) WHERE retired_at IS NULL`)
      if (current < 9) this.db.exec(DDL_V9)
      this.db.pragma(`user_version = ${DELEGATE_DURABLE_SCHEMA_VERSION}`)
    })
    apply.immediate()
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
      if (this.hasDeliveryReceiptEnrollment(record.id)) throw new Error('receipt job requires fenced update')
      if (this.isRetryTarget(record.id)) throw new Error('retry target requires fenced update')
      this.upsertStmt.run(toRow(record))
      const row = this.db.prepare('SELECT * FROM delegate_jobs WHERE job_id=?').get(record.id)
      this.persistFailureInbox(row as Record<string, unknown>)
      this.persistDeliveryReceipt(row as Record<string, unknown>)
    })
  }

  /**
   * Insert a new row inside a transaction that also arbitrates idempotency
   * and non-terminal capacity. The DB is the authority for both.
   */
  insertCreate(
    record: DurableJobRecord,
    maxJobs: number,
    opts: { failureInbox?: boolean; deliveryReceipt?: DelegateReceiptContext; retrySource?: DelegateRetrySource } = {},
  ): { ok: true } | { error: 'capacity' } | { reused: DurableJobRecord } {
    this.throwIfInjectedFailure()
    return this.transaction(() => {
      if (record.idempotencyKey) {
        const hit = this.findByIdempotencyKey(record.idempotencyKey)
        if (hit) {
          this.checkReceiptReuse(hit, record, opts.deliveryReceipt)
          this.checkRetrySourceReuse(hit, opts.retrySource)
          return { reused: hit }
        }
      }
      const n = this.countNonTerminal()
      if (n >= maxJobs) return { error: 'capacity' as const }
      if ((opts.failureInbox || opts.deliveryReceipt || opts.retrySource) && (!record.callbackOriginUserId?.trim() || !record.parentSessionKey?.trim())) {
        throw new Error('delegate failure inbox requires verified owner and parent')
      }
      const receipt = opts.deliveryReceipt ? checkedReceiptContext(opts.deliveryReceipt) : undefined
      const source = opts.retrySource ? checkedDelegateRetrySource(opts.retrySource) : undefined
      if (source && (source.userId !== record.callbackOriginUserId || source.parentSessionKey !== record.parentSessionKey ||
          source.childSessionKey !== record.sessionKey || source.targetAgentId !== record.agentId)) {
        throw new Error('delegate retry source/job mismatch')
      }
      if (source && this.isRetryParentFenced(source.userId, source.parentClientSessionId)) {
        throw new Error('delegate retry source parent deleted')
      }
      if (receipt && (record.kind !== 'delegate' || record.callback !== 'stdout-wait' || record.callbackState !== 'none')) {
        throw new Error('receipt admission requires a new stdout-wait delegate')
      }
      try {
        this.insertStmt.run(toRow(record))
      } catch (err) {
        const code = (err as { code?: string }).code ?? ''
        if (code.startsWith('SQLITE_CONSTRAINT') && record.idempotencyKey) {
          const hit = this.findByIdempotencyKey(record.idempotencyKey)
          if (hit) {
            this.checkReceiptReuse(hit, record, opts.deliveryReceipt)
            this.checkRetrySourceReuse(hit, source)
            return { reused: hit }
          }
        }
        throw err
      }
      // Only an INSERT collision is reusable. An auxiliary write failure must
      // roll back, not find this transaction's own row and misreport reuse.
      if (source) {
        this.db.prepare(`INSERT INTO delegate_retry_source
          (job_id,generation,user_id,parent_client_session_id,parent_session,child_session,target_agent_id,metadata_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(record.id, record.generation, source.userId, source.parentClientSessionId,
            source.parentSessionKey, source.childSessionKey, source.targetAgentId, JSON.stringify(source), record.createdAt)
      }
      if (opts.failureInbox || receipt || source) {
        this.db.prepare('UPDATE delegate_jobs SET failure_inbox_enabled=1 WHERE job_id=?').run(record.id)
        this.persistFailureInbox({ ...toRow(record), failure_inbox_enabled: 1 })
      }
      if (receipt) {
        this.db.prepare('UPDATE delegate_jobs SET delivery_receipt_context=? WHERE job_id=?')
          .run(JSON.stringify(receipt), record.id)
        this.persistDeliveryReceipt({ ...toRow(record), delivery_receipt_context: JSON.stringify(receipt) })
      }
      return { ok: true as const }
    })
  }

  /** No fallback to job/result rows or directory scans after TTL or missing provenance. */
  hasActiveRetryChild(sessionKey: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM delegate_jobs WHERE session_key=? AND retired_at IS NULL
      AND state IN ('queued','running','paused_for_cutover') LIMIT 1`).get(sessionKey))
  }

  getRetrySource(userId: string, jobId: string, generation: number): DelegateRetrySource | undefined {
    const row = this.db.prepare(`SELECT metadata_json FROM delegate_retry_source
      WHERE user_id=? AND job_id=? AND generation=? AND retired_at IS NULL`)
      .get(userId, jobId, generation) as { metadata_json: string | null } | undefined
    if (!row?.metadata_json) return undefined
    const source = checkedDelegateRetrySource(JSON.parse(row.metadata_json))
    if (source.userId !== userId || this.isRetryParentFenced(userId, source.parentClientSessionId)) return undefined
    return source
  }

  private isRetryParentFenced(userId: string, clientSessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM delegate_retry_parent_fence WHERE user_id=? AND client_session_id=?')
      .get(userId, clientSessionId)
  }

  /** Enumerate authenticated INSERT columns, never parse metadata or discover nonce directories. */
  retryLifecycleRefs(userId?: string): { items: Array<{ userId: string; clientSessionId: string }>; pending: number } {
    const rows = this.db.prepare(`SELECT DISTINCT user_id,parent_client_session_id FROM delegate_retry_source
      WHERE retired_at IS NULL ${userId === undefined ? '' : 'AND user_id=?'}`)
      .all(...(userId === undefined ? [] : [userId])) as Array<{ user_id: unknown; parent_client_session_id: unknown }>
    const items: Array<{ userId: string; clientSessionId: string }> = []
    let pending = 0
    for (const row of rows) {
      if (typeof row.user_id !== 'string' || !row.user_id.trim() ||
          typeof row.parent_client_session_id !== 'string' || !row.parent_client_session_id.trim()) { pending++; continue }
      items.push({ userId: row.user_id, clientSessionId: row.parent_client_session_id })
    }
    return { items, pending }
  }

  /** Caller must have just classified this exact owner/ref as SQL-deleted.
   * Tombstone and removal share the original DB transaction. Retained identity
   * blocks old writers/replays, without retaining parent/child/metadata payload. */
  fenceDeletedRetryParent(ref: { userId: string; clientSessionId: string }, now: number): void {
    if (!ref.userId.trim() || !ref.clientSessionId.trim() || !Number.isSafeInteger(now)) throw new Error('invalid retry deletion identity')
    this.throwIfInjectedFailure()
    this.transaction(() => {
      this.db.prepare(`INSERT INTO delegate_retry_parent_fence VALUES(?,?,?) ON CONFLICT DO NOTHING`)
        .run(ref.userId, ref.clientSessionId, now)
      this.db.prepare(`DELETE FROM delegate_failure_inbox WHERE user_id=? AND EXISTS (
        SELECT 1 FROM delegate_retry_source s WHERE s.job_id=delegate_failure_inbox.job_id
          AND s.generation=delegate_failure_inbox.generation AND s.user_id=? AND s.parent_client_session_id=?)`)
        .run(ref.userId, ref.userId, ref.clientSessionId)
      this.db.prepare(`UPDATE delegate_retry_action SET state='source_deleted',terminal_code='source_deleted'
        WHERE user_id=? AND EXISTS (SELECT 1 FROM delegate_retry_source s WHERE s.user_id=?
          AND s.parent_client_session_id=? AND ((s.job_id=source_job_id AND s.generation=delegate_retry_action.generation)
            OR s.job_id=target_job_id))`).run(ref.userId, ref.userId, ref.clientSessionId)
      this.db.prepare(`UPDATE delegate_retry_source SET retired_at=COALESCE(retired_at,?),
        parent_client_session_id=NULL,parent_session=NULL,child_session=NULL,target_agent_id=NULL,metadata_json=NULL
        WHERE user_id=? AND parent_client_session_id=?`).run(now, ref.userId, ref.clientSessionId)
    })
  }

  isRetrySourceRetired(jobId: string, generation: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM delegate_retry_source s WHERE s.job_id=? AND s.generation=?
      AND (s.retired_at IS NOT NULL OR EXISTS (SELECT 1 FROM delegate_retry_parent_fence f
        WHERE f.user_id=s.user_id AND f.client_session_id=s.parent_client_session_id))`).get(jobId, generation)
  }

  hasRetrySource(jobId: string, generation: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM delegate_retry_source WHERE job_id=? AND generation=?').get(jobId, generation)
  }

  getRetryAction(key: DelegateRetryActionKey): DelegateRetryAction | undefined {
    checkedDelegateRetryActionKey(key)
    const row = this.db.prepare(`SELECT * FROM delegate_retry_action
      WHERE user_id=? AND source_job_id=? AND generation=? AND action_id=?`)
      .get(key.userId, key.sourceJobId, key.generation, key.actionId) as Record<string, unknown> | undefined
    if (!row) return undefined
    if (!['accepted', 'dispatched', 'terminal', 'source_deleted'].includes(String(row.state))) throw new Error('unknown retry action state')
    return Object.freeze({ ...key, targetJobId: String(row.target_job_id), state: row.state as DelegateRetryAction['state'],
      createdAt: num(row.created_at), dispatchedAt: row.dispatched_at == null ? null : num(row.dispatched_at),
      terminalCode: row.terminal_code == null ? null : String(row.terminal_code) })
  }

  isRetryTarget(jobId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM delegate_retry_action WHERE target_job_id=?').get(jobId)
  }

  getRetryActionForTarget(jobId: string): DelegateRetryAction | undefined {
    const row = this.db.prepare('SELECT user_id,source_job_id,generation,action_id FROM delegate_retry_action WHERE target_job_id=?')
      .get(jobId) as { user_id: string; source_job_id: string; generation: number; action_id: string } | undefined
    return row ? this.getRetryAction({ userId: row.user_id, sourceJobId: row.source_job_id, generation: row.generation, actionId: row.action_id }) : undefined
  }

  /** Only original unclaimed targets, not dispatched intents or TTL tombstones. */
  listUnclaimedRetryTargets(): string[] {
    return (this.db.prepare(`SELECT a.target_job_id FROM delegate_retry_action a JOIN delegate_jobs j ON j.job_id=a.target_job_id
      WHERE a.state IN ('accepted','source_deleted') AND j.state='queued' AND j.retired_at IS NULL ORDER BY a.created_at,a.target_job_id`)
      .all() as Array<{ target_job_id: string }>).map(row => row.target_job_id)
  }

  /** One accepted action and its original queued target in ONE DB transaction.
   * Authorization/native eligibility must precede this; immutable source equality
   * is checked again here. Replay never creates a replacement for a retired job. */
  acceptRetryAction(key: DelegateRetryActionKey, expectedSource: DelegateRetrySource, target: DurableJobRecord, maxJobs: number):
    | { kind: 'accepted' | 'replay'; action: DelegateRetryAction; target?: DurableJobRecord }
    | { error: 'source_unavailable' | 'source_changed' | 'child_busy' | 'capacity' } {
    checkedDelegateRetryActionKey(key)
    const expected = checkedDelegateRetrySource(expectedSource)
    this.throwIfInjectedFailure()
    return this.db.transaction((): ReturnType<DelegateDurableDb['acceptRetryAction']> => {
      const replay = this.getRetryAction(key)
      if (replay) return { kind: 'replay', action: replay, target: this.get(replay.targetJobId) }
      const source = this.getRetrySource(key.userId, key.sourceJobId, key.generation)
      if (!source || !this.db.prepare(`SELECT 1 FROM delegate_failure_inbox WHERE user_id=? AND job_id=? AND generation=?`)
        .get(key.userId, key.sourceJobId, key.generation)) return { error: 'source_unavailable' }
      if (JSON.stringify(source) !== JSON.stringify(expected)) return { error: 'source_changed' }
      if (target.state !== 'queued' || target.callback !== 'origin-inject' || target.kind !== 'delegate' || target.result != null ||
          target.claimToken || target.attemptNo !== 0 || target.fencingEpoch !== 0 || target.idempotencyKey ||
          target.callbackState !== 'none' || target.callbackEpoch !== 0 || target.generation !== 0 || target.id === key.sourceJobId ||
          target.agentId !== source.targetAgentId || target.sessionKey !== source.childSessionKey ||
          target.parentSessionKey !== source.parentSessionKey || target.callbackOriginUserId !== source.userId ||
          target.callbackOriginSessionKey !== source.originSessionKey) throw new Error('invalid retry target binding')
      if (this.hasActiveRetryChild(source.childSessionKey)) return { error: 'child_busy' }
      const inserted = this.insertCreate(target, maxJobs, { retrySource: source })
      if ('error' in inserted) return inserted
      if ('reused' in inserted) throw new Error('retry target unexpectedly reused')
      this.db.prepare(`INSERT INTO delegate_retry_action
        (user_id,source_job_id,generation,action_id,target_job_id,state,created_at) VALUES(?,?,?,?,?,'accepted',?)`)
        .run(key.userId, key.sourceJobId, key.generation, key.actionId, target.id, target.createdAt)
      return { kind: 'accepted', action: this.getRetryAction(key)!, target }
    }).immediate()
  }

  private checkRetrySourceReuse(existing: DurableJobRecord, incoming?: DelegateRetrySource): void {
    const row = this.db.prepare('SELECT metadata_json,retired_at FROM delegate_retry_source WHERE job_id=? AND generation=?')
      .get(existing.id, existing.generation) as { metadata_json: string | null; retired_at: number | null } | undefined
    if (!row && !incoming) return
    if (!row || row.retired_at !== null || !incoming ||
        JSON.stringify(checkedDelegateRetrySource(incoming)) !== row.metadata_json ||
        this.isRetryParentFenced(incoming.userId, incoming.parentClientSessionId)) {
      throw new Error('delegate retry source idempotency binding mismatch')
    }
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
    return this.db.transaction(() => {
      const retry = this.db.prepare('SELECT state FROM delegate_retry_action WHERE target_job_id=?')
        .get(record.id) as { state: DelegateRetryAction['state'] } | undefined
      if (retry && expected.state === 'queued' && record.state === 'running' &&
          (retry.state !== 'accepted' || this.isRetrySourceRetired(record.id, record.generation))) return undefined
      if (this.hasDeliveryReceiptEnrollment(record.id)) {
        const bound = this.get(record.id)
        if (!bound || record.callback !== 'stdout-wait' || record.callbackState !== 'none' ||
            record.kind !== bound.kind || record.generation !== bound.generation ||
            record.callbackOriginUserId !== bound.callbackOriginUserId ||
            record.parentSessionKey !== bound.parentSessionKey) return undefined
      }
      const row = this.casUpdateStmt.get({
        ...toRow(record),
        expected_state: expected.state,
        expected_epoch: expected.fencingEpoch,
        expected_token: expected.claimToken ?? null,
      }) as Record<string, unknown> | undefined
      if (!row) return undefined
      if (retry) {
        if (expected.state === 'queued' && record.state === 'running') {
          this.db.prepare(`UPDATE delegate_retry_action SET state='dispatched',dispatched_at=?
            WHERE target_job_id=? AND state='accepted'`).run(record.lastActivityAt, record.id)
        } else if (['completed', 'failed', 'cancelled', 'killed_by_cutover'].includes(record.state)) {
          this.db.prepare(`UPDATE delegate_retry_action SET state='terminal',terminal_code=?
            WHERE target_job_id=? AND state IN ('accepted','dispatched')`).run(record.failureClass ?? record.state, record.id)
        }
      }
      this.persistFailureInbox(row)
      this.persistDeliveryReceipt(row)
      return fromRow(row)
    }).immediate()
  }

  hasDeliveryReceiptEnrollment(jobId: string): boolean {
    const row = this.db.prepare('SELECT delivery_receipt_context FROM delegate_jobs WHERE job_id=?').get(jobId) as
      { delivery_receipt_context: string | null } | undefined
    return row?.delivery_receipt_context != null
  }

  private checkReceiptReuse(existing: DurableJobRecord, incoming: DurableJobRecord, context?: DelegateReceiptContext): void {
    const row = this.db.prepare('SELECT delivery_receipt_context FROM delegate_jobs WHERE job_id=?').get(existing.id) as
      { delivery_receipt_context: string | null }
    if (row.delivery_receipt_context == null && !context) return
    if (!context || row.delivery_receipt_context == null ||
        JSON.stringify(checkedReceiptContext(context)) !== row.delivery_receipt_context ||
        incoming.kind !== existing.kind || incoming.callback !== existing.callback ||
        incoming.generation !== existing.generation || incoming.parentSessionKey !== existing.parentSessionKey ||
        incoming.callbackOriginUserId !== existing.callbackOriginUserId) {
      throw new Error('delegate receipt idempotency binding mismatch')
    }
  }

  /** Metadata-only offer; possession of a job ID is NOT permission to consume its result. */
  getDeliveryReceipt(jobId: string, generation: number): DelegateDeliveryReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM delegate_delivery_receipt WHERE job_id=? AND generation=?')
      .get(jobId, generation) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      jobId: String(row.job_id), generation: num(row.generation), userId: String(row.user_id),
      parentSession: String(row.parent_session), parentTurnKey: String(row.parent_turn_key),
      nativeToolUseId: String(row.native_tool_use_id), receiptNonceHash: String(row.receipt_nonce_hash),
      resultDigest: String(row.result_digest), state: row.state as DelegateDeliveryReceipt['state'],
      createdAt: num(row.created_at),
    }
  }

  getReceiptParent(jobId: string, generation: number): DelegateReceiptContext['parent'] {
    const row = this.db.prepare('SELECT delivery_receipt_context FROM delegate_jobs WHERE job_id=? AND generation=? AND retired_at IS NULL')
      .get(jobId, generation) as { delivery_receipt_context?: string } | undefined
    if (!row?.delivery_receipt_context) return undefined
    return checkedReceiptContext(JSON.parse(row.delivery_receipt_context)).parent
  }

  listReceiptRecoveryJobs(parentSession?: string): string[] {
    return (this.db.prepare(`SELECT j.job_id FROM delegate_jobs j JOIN delegate_delivery_receipt r
      ON r.job_id=j.job_id AND r.generation=j.generation WHERE j.retired_at IS NULL
      AND r.state IN ('offered','ingest_claimed') AND (? IS NULL OR r.parent_session=?) ORDER BY r.created_at`)
      .all(parentSession ?? null, parentSession ?? null) as { job_id: string }[]).map(row => row.job_id)
  }

  /** Cross-turn read-only handoff. The durable generation/source, not a caller
   * locator, select the row. Deliberately do not SELECT result_json bytes. */
  readReceiptHandoff(jobId: string, scope: {
    userId: string; parentSession: string; parentAgentId: string; consumerTurnKey: string
  }): 'same_turn' | { status: 'receipt_handoff'; jobId: string; generation: number;
    execution: 'running' | 'terminal'; delivery: 'pending' | 'notified' | 'ingested' } | undefined {
    const row = this.db.prepare(`SELECT j.generation, j.state AS job_state,
      j.callback_origin_user_id, j.parent_session_key, j.delivery_receipt_context,
      (j.result_json IS NOT NULL) AS has_result,
      r.state AS receipt_state, r.user_id, r.parent_session, r.parent_turn_key,
      r.native_tool_use_id, r.receipt_nonce_hash
      FROM delegate_jobs j LEFT JOIN delegate_delivery_receipt r
        ON r.job_id=j.job_id AND r.generation=j.generation
      WHERE j.job_id=? AND j.retired_at IS NULL`).get(jobId) as Record<string, unknown> | undefined
    if (!row || row.callback_origin_user_id !== scope.userId || row.parent_session_key !== scope.parentSession ||
        typeof row.delivery_receipt_context !== 'string') return undefined
    const source = checkedReceiptContext(JSON.parse(row.delivery_receipt_context))
    if (!source.parent || source.parent.agentId !== scope.parentAgentId) return undefined
    if (source.parentTurnKey === scope.consumerTurnKey) return 'same_turn'
    if (!Number.isSafeInteger(row.generation) || Number(row.generation) < 0) return undefined
    const terminal = ['completed', 'failed', 'cancelled', 'killed_by_cutover'].includes(String(row.job_state))
    if (terminal !== Boolean(row.has_result) || (!terminal && row.receipt_state != null)) return undefined
    if (terminal && (row.user_id !== scope.userId || row.parent_session !== scope.parentSession ||
        row.parent_turn_key !== source.parentTurnKey || row.native_tool_use_id !== source.nativeToolUseId ||
        row.receipt_nonce_hash !== source.receiptNonceHash ||
        !['offered','ingest_claimed','ingested','notify_pending','notify_claimed','notified'].includes(String(row.receipt_state)))) return undefined
    return { status: 'receipt_handoff', jobId, generation: Number(row.generation),
      execution: terminal ? 'terminal' : 'running',
      delivery: row.receipt_state === 'notified' ? 'notified' : row.receipt_state === 'ingested' ? 'ingested' : 'pending' }
  }

  /** Scoped metadata only; never exposes result bytes or acknowledges delivery. */
  readReceiptStatus(jobId: string, generation: number, scope: {
    userId: string; parentSession: string; parentTurnKey: string; receiptNonceHash: string
  }): 'running' | 'ready' | undefined {
    const row = this.db.prepare('SELECT * FROM delegate_jobs WHERE job_id=? AND generation=? AND retired_at IS NULL')
      .get(jobId, generation) as Record<string, unknown> | undefined
    if (!row || typeof row.delivery_receipt_context !== 'string' ||
        (row.callback_origin_user_id || 'default') !== scope.userId || row.parent_session_key !== scope.parentSession) return undefined
    const context = checkedReceiptContext(JSON.parse(row.delivery_receipt_context))
    if (context.parentTurnKey !== scope.parentTurnKey || context.receiptNonceHash !== scope.receiptNonceHash) return undefined
    return typeof row.result_json === 'string' ? 'ready' : 'running'
  }

  /** Authorized v2 offer, not consumption. Preserve the exact committed JSON
   * bytes: reserializing a parsed result is not its durable digest contract. */
  readReceiptInputOffer(jobId: string, generation: number, scope: {
    userId: string; parentSession: string; parentTurnKey: string; receiptNonceHash: string
  }): { binding: DelegateDeliveryReceipt; resultJson: string } | undefined {
    return this.transaction(() => {
      const binding = this.getDeliveryReceipt(jobId, generation)
      if (!binding || binding.userId !== scope.userId || binding.parentSession !== scope.parentSession ||
          binding.parentTurnKey !== scope.parentTurnKey || binding.receiptNonceHash !== scope.receiptNonceHash) return undefined
      const row = this.db.prepare('SELECT result_json FROM delegate_jobs WHERE job_id=? AND retired_at IS NULL')
        .get(jobId) as { result_json: string | null } | undefined
      if (!row) return undefined
      if (typeof row.result_json !== 'string' || createHash('sha256').update(row.result_json).digest('hex') !== binding.resultDigest) {
        throw new Error('receipt durable result digest mismatch')
      }
      return { binding, resultJson: row.result_json }
    })
  }

  /** Same deterministic inode for the gateway coordinator and the eventual CCB writer. */
  async withDeliveryReceiptBarrier<T>(
    jobId: string,
    generation: number,
    write: (receipt: DelegateDeliveryReceipt) => Promise<T>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.path === ':memory:') throw new Error('receipt barrier requires a persistent database')
    const key = createHash('sha256').update(JSON.stringify([jobId, generation])).digest('hex')
    return withReceiptWriteBarrier(join(dirname(realpathSync(this.path)), 'delegate-receipt-locks', key + '.lock'), async () => {
      const receipt = this.getDeliveryReceipt(jobId, generation)
      if (!receipt) throw new Error('delegate receipt not found')
      return await write(receipt)
    }, opts)
  }

  private persistDeliveryReceipt(row: Record<string, unknown>): void {
    if (row.delivery_receipt_context == null || !['completed', 'failed', 'cancelled', 'killed_by_cutover'].includes(String(row.state))) return
    const context = checkedReceiptContext(JSON.parse(String(row.delivery_receipt_context)))
    if (typeof row.result_json !== 'string') throw new Error('terminal receipt requires a durable result')
    const resultDigest = createHash('sha256').update(row.result_json).digest('hex')
    const existing = this.getDeliveryReceipt(String(row.job_id), num(row.generation))
    if (existing && (existing.resultDigest !== resultDigest || existing.userId !== row.callback_origin_user_id ||
        existing.parentSession !== row.parent_session_key || existing.parentTurnKey !== context.parentTurnKey ||
        existing.nativeToolUseId !== context.nativeToolUseId || existing.receiptNonceHash !== context.receiptNonceHash)) {
      throw new Error('delegate receipt binding is immutable')
    }
    this.db.prepare(`INSERT INTO delegate_delivery_receipt
      (job_id,generation,user_id,parent_session,parent_turn_key,native_tool_use_id,receipt_nonce_hash,result_digest,created_at,updated_at)
      VALUES (@jobId,@generation,@userId,@parentSession,@parentTurnKey,@nativeToolUseId,@receiptNonceHash,@resultDigest,@now,@now)
      ON CONFLICT(job_id,generation) DO NOTHING`).run({
      jobId: row.job_id, generation: row.generation,
      userId: row.callback_origin_user_id, parentSession: row.parent_session_key,
      ...context, resultDigest,
      now: row.terminal_committed_at ?? row.last_activity_at,
    })
  }

  /** Runs inside the winning job write transaction, before wake/onTerminal. */
  private persistFailureInbox(row: Record<string, unknown>): void {
    if (row.failure_inbox_enabled !== 1) return
    const record = fromRow(row)
    if (this.isRetrySourceRetired(record.id, record.generation)) return
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
      `).all({
        userId, limit: limit + 1,
        ...(before ? { failedAt: before.failedAt, jobId: before.jobId, generation: before.generation } : {}),
      }) as Array<Record<string, unknown>>
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

  /** Current-user aggregate only; never reads retained result_json. */
  userSummary(userId: string): { running: number; queued: number; unacknowledgedFailures: number } {
    if (!userId.trim()) throw new Error('delegate summary user required')
    return this.transaction(() => {
      const jobs = this.db.prepare(`SELECT state, count(*) AS n FROM delegate_jobs
        WHERE callback_origin_user_id=? AND retired_at IS NULL AND state IN ('running','queued')
          AND NOT EXISTS (SELECT 1 FROM delegate_retry_source s WHERE s.job_id=delegate_jobs.job_id
            AND s.generation=delegate_jobs.generation AND s.retired_at IS NOT NULL)
        GROUP BY state`).all(userId) as Array<{ state: string; n: number }>
      const inbox = this.db.prepare(`SELECT count(*) AS n FROM delegate_failure_inbox
        WHERE user_id=? AND ack_at IS NULL`).get(userId) as { n: number }
      return { running: jobs.find(row => row.state === 'running')?.n ?? 0,
        queued: jobs.find(row => row.state === 'queued')?.n ?? 0, unacknowledgedFailures: inbox.n }
    })
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
    if (this.hasDeliveryReceiptEnrollment(args.jobId)) return undefined
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
    if (this.hasDeliveryReceiptEnrollment(args.jobId)) return undefined
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
    if (this.hasDeliveryReceiptEnrollment(args.jobId)) return undefined
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
    if (this.hasDeliveryReceiptEnrollment(args.jobId)) return undefined
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
    if (this.hasDeliveryReceiptEnrollment(args.jobId)) return false
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
