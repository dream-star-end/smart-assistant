// SelfhealStore — durable SQLite state for the personal-version self-heal
// receiver + executor (self-heal slice ② / block B2a).
//
// A dedicated database file (`selfheal.db`) keeps this subsystem physically
// isolated from `sessions.db`: the self-heal control plane must survive/replay
// independently of ordinary chat persistence, and a corrupt/locked chat DB must
// never wedge repair intake (nor vice versa).
//
// Tables, each with a single, explicit durability role:
//
//   selfheal_jobs        — one row per dispatched repair (repair_id PK). The
//                          receiver INSERTs `received`; the jobWorker leases it
//                          (received→starting→running→succeeded/failed) with a
//                          crash-recoverable lease (lease_owner + lease_until).
//                          `release_revoked` is the cancel-side release fuse: a
//                          cancel of a TERMINAL job flips it so a parked
//                          pending_release cutover can never be released later.
//   selfheal_executions  — at-most-once turn ledger (execution_id = repair_id).
//                          `accepted` means the turn has been durably enqueued
//                          (see durable_turn_queue) — never "accepted but not
//                          submitted". Transitions accepted→running→done/failed.
//   durable_turn_queue   — the at-most-once fence. `enqueueExecution` writes the
//                          execution row AND the queue row in ONE transaction, so
//                          `accepted` ALWAYS implies a `queued` row exists. The
//                          executor CAS-flips queued→consumed; only the winner
//                          submits the turn. A crash before consume is re-drained
//                          (no swallow); a crash after consume is not retried
//                          (at-most-once — repairs must never double-execute).
//   selfheal_nonces      — replay defense for the inbound webhook. INSERT-or-fail
//                          on the nonce PK; a second delivery with the same nonce
//                          loses the INSERT and is rejected. TTL-purged.
//   selfheal_callback_outbox — durable broker→master callback queue (BLOCKER2):
//                          the pending_release progress marker and the deployed
//                          done callback are ENQUEUED here (idempotent on
//                          repair_id+phase) and pumped with retry/backoff by the
//                          gateway callbackPump — a single network failure can no
//                          longer permanently break the v5-side state machine.
//
// better-sqlite3 is synchronous; every mutation that must be atomic uses a
// db.transaction() closure exactly like sessionsDb.ts.

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { HOME } from './paths.js'

// Physically separate from sessions.db (see module header). Not added to
// paths.ts on purpose — this file is the sole owner of the self-heal DB path.
const SELFHEAL_DB = join(HOME, 'selfheal.db')

let _db: Database.Database | null = null
let _walTimer: ReturnType<typeof setInterval> | null = null

function _onExit(): void {
  if (_db) {
    if (_walTimer !== null) {
      clearInterval(_walTimer)
      _walTimer = null
    }
    try {
      _db.pragma('wal_checkpoint(TRUNCATE)')
      _db.close()
    } catch {}
    _db = null
  }
}

// Column body of selfheal_jobs — single source for CREATE TABLE and the
// cancelling-CHECK rebuild guard below. `cancelling` is the durable
// mid-teardown state of the cancel contract (design §A2): a live session's
// cancel first CASes running→cancelling, and only a CONFIRMED teardown may CAS
// cancelling→cancelled, so `terminated=true` is decidable across crashes.
const SELFHEAL_JOBS_COLUMNS_DDL = `
      repair_id    TEXT PRIMARY KEY,
      incident_id  TEXT NOT NULL,
      attempt      INTEGER NOT NULL DEFAULT 0,
      payload_hash TEXT NOT NULL,
      capability   TEXT,
      status       TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','starting','running','cancelling','succeeded','failed','cancelled')),
      lease_owner  TEXT,
      lease_until  INTEGER NOT NULL DEFAULT 0,
      session_key  TEXT,
      release_revoked INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
`

/**
 * Idempotent schema guard: an older selfheal.db was created with a status CHECK
 * that lacks 'cancelling'. SQLite cannot ALTER a CHECK, so rebuild the table
 * (new table → copy → drop → rename) inside one transaction. Production never
 * shipped the old schema (defensive only), but a dev DB may carry it.
 *
 * The rebuild target uses the CURRENT column DDL (which includes
 * `release_revoked`), and the copy lists the LEGACY columns explicitly — new
 * columns take their defaults. A DB old enough to lack 'cancelling' predates
 * release_revoked, so the legacy column list is fixed.
 */
function ensureCancellingStatusSchema(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'selfheal_jobs'")
    .get() as { sql: string } | undefined
  if (!row || row.sql.includes("'cancelling'")) return
  db.transaction(() => {
    db.exec(`
      CREATE TABLE selfheal_jobs_rebuild (${SELFHEAL_JOBS_COLUMNS_DDL});
      INSERT INTO selfheal_jobs_rebuild
        (repair_id, incident_id, attempt, payload_hash, capability, status,
         lease_owner, lease_until, session_key, created_at, updated_at)
        SELECT repair_id, incident_id, attempt, payload_hash, capability, status,
               lease_owner, lease_until, session_key, created_at, updated_at
        FROM selfheal_jobs;
      DROP TABLE selfheal_jobs;
      ALTER TABLE selfheal_jobs_rebuild RENAME TO selfheal_jobs;
      CREATE INDEX IF NOT EXISTS idx_selfheal_jobs_status ON selfheal_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_selfheal_jobs_lease ON selfheal_jobs(status, lease_until);
    `)
  })()
}

/**
 * Idempotent schema guard (same mechanism family as the cancelling rebuild): a
 * DB created AFTER the cancelling rebuild but BEFORE the release-revoked fuse
 * has the current CHECK yet lacks the `release_revoked` column. A plain
 * defaulted column is ALTER-addable — no rebuild needed.
 */
function ensureReleaseRevokedColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(selfheal_jobs)').all() as { name: string }[]
  if (cols.some((c) => c.name === 'release_revoked')) return
  db.exec('ALTER TABLE selfheal_jobs ADD COLUMN release_revoked INTEGER NOT NULL DEFAULT 0')
}

export async function getSelfhealDb(): Promise<Database.Database> {
  if (_db) return _db
  await mkdir(dirname(SELFHEAL_DB), { recursive: true })
  const db = new Database(SELFHEAL_DB)
  db.pragma('journal_mode = WAL')
  // BUSY handling: repair intake + executor share this DB; a short busy_timeout
  // lets the rare writer overlap resolve instead of throwing SQLITE_BUSY.
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS selfheal_jobs (${SELFHEAL_JOBS_COLUMNS_DDL});
    CREATE INDEX IF NOT EXISTS idx_selfheal_jobs_status ON selfheal_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_selfheal_jobs_lease ON selfheal_jobs(status, lease_until);

    CREATE TABLE IF NOT EXISTS selfheal_executions (
      execution_id TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'accepted'
                     CHECK (status IN ('accepted','running','done','failed')),
      session_key  TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS durable_turn_queue (
      id           TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','consumed')),
      created_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_turn_queue_exec ON durable_turn_queue(execution_id);
    CREATE INDEX IF NOT EXISTS idx_durable_turn_queue_status ON durable_turn_queue(status);

    CREATE TABLE IF NOT EXISTS selfheal_nonces (
      nonce   TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_selfheal_nonces_seen ON selfheal_nonces(seen_at);

    -- Durable, atomic broker idempotency + single-winner claim. The root broker
    -- claims a (repair_id:action_kind) key BEFORE any side effect, keyed also by
    -- params_hash so a same-key request with different params is a conflict (not
    -- a silent replay of the old outcome). A 'claimed' row with no response marks
    -- a claim whose handler crashed mid-execution ⇒ at-most-once: never re-run.
    CREATE TABLE IF NOT EXISTS broker_actions (
      claim_key   TEXT PRIMARY KEY,
      repair_id   TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'claimed'
                    CHECK (status IN ('claimed','committed')),
      response    TEXT,
      claimed_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Durable broker→master callback outbox (BLOCKER2). One row per
    -- (repair_id, phase): 'pending_release' carries the release-gate progress
    -- marker, 'done' the deployed callback. Enqueue is idempotent (UNIQUE +
    -- ON CONFLICT DO NOTHING); the callbackPump drains queued rows in id order
    -- with exponential backoff and never gives up short of an explicit
    -- master-side refusal (→ 'abandoned').
    CREATE TABLE IF NOT EXISTS selfheal_callback_outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      repair_id       TEXT NOT NULL,
      phase           TEXT NOT NULL CHECK (phase IN ('pending_release','done')),
      message         TEXT NOT NULL,
      detail_json     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','abandoned')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      UNIQUE(repair_id, phase)
    );
    CREATE INDEX IF NOT EXISTS idx_selfheal_cb_outbox_due
      ON selfheal_callback_outbox(status, next_attempt_at);
  `)

  // Schema guard: rebuild selfheal_jobs when an old DB lacks 'cancelling' in the
  // status CHECK (the CREATE above no-ops on an existing table), then ALTER-add
  // the release_revoked fuse column when a newer-but-pre-fuse DB lacks it.
  ensureCancellingStatusSchema(db)
  ensureReleaseRevokedColumn(db)

  // Periodic WAL checkpoint to bound WAL growth (mirrors sessionsDb.ts).
  _walTimer = setInterval(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {}
  }, 30 * 60_000)
  _walTimer.unref()
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {}

  process.on('exit', _onExit)
  _db = db
  return db
}

export async function closeSelfhealDb(): Promise<void> {
  if (_walTimer !== null) {
    clearInterval(_walTimer)
    _walTimer = null
  }
  process.removeListener('exit', _onExit)
  if (_db) {
    try {
      _db.pragma('wal_checkpoint(TRUNCATE)')
      _db.close()
    } catch {}
    _db = null
  }
}

// ── Types ──────────────────────────────────────────

export type SelfhealJobStatus =
  | 'received'
  | 'starting'
  | 'running'
  /** Durable mid-teardown state: cancel of a LIVE session parks here until the
   *  teardown is CONFIRMED, then CASes to 'cancelled'. Crash-safe: a re-received
   *  cancel resumes the teardown from this state. */
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

/** Job states under which turn execution may proceed (the SQLite-side fence). */
const EXECUTABLE_JOB_STATES: SelfhealJobStatus[] = ['starting', 'running']

export interface SelfhealJob {
  repairId: string
  incidentId: string
  attempt: number
  payloadHash: string
  capability: string | null
  status: SelfhealJobStatus
  leaseOwner: string | null
  leaseUntil: number
  sessionKey: string | null
  /** Cancel-side release fuse: a cancel of a terminal job durably revokes any
   *  held (pending_release) cutover — the broker refuses to release it. */
  releaseRevoked: boolean
  createdAt: number
  updatedAt: number
}

export type SelfhealExecutionStatus = 'accepted' | 'running' | 'done' | 'failed'

export interface SelfhealExecution {
  executionId: string
  status: SelfhealExecutionStatus
  sessionKey: string | null
  createdAt: number
  updatedAt: number
}

interface JobRow {
  repair_id: string
  incident_id: string
  attempt: number
  payload_hash: string
  capability: string | null
  status: SelfhealJobStatus
  lease_owner: string | null
  lease_until: number
  session_key: string | null
  release_revoked: number
  created_at: number
  updated_at: number
}

function rowToJob(r: JobRow): SelfhealJob {
  return {
    repairId: r.repair_id,
    incidentId: r.incident_id,
    attempt: r.attempt,
    payloadHash: r.payload_hash,
    capability: r.capability,
    status: r.status,
    leaseOwner: r.lease_owner,
    leaseUntil: r.lease_until,
    sessionKey: r.session_key,
    releaseRevoked: r.release_revoked === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ── Nonce replay defense ───────────────────────────

/**
 * Atomically record a webhook nonce. Returns `true` when the nonce was unseen
 * (INSERT won) and `false` when it was already present (replay). The INSERT
 * ON CONFLICT DO NOTHING makes this a single-statement compare-and-set: two
 * concurrent deliveries with the same nonce cannot both observe `true`.
 */
export async function recordNonceIfFresh(nonce: string, now = Date.now()): Promise<boolean> {
  const db = await getSelfhealDb()
  const res = db
    .prepare(
      'INSERT INTO selfheal_nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING',
    )
    .run(nonce, now)
  return res.changes > 0
}

/** Delete nonces older than `ttlMs`. Called opportunistically after intake. */
export async function purgeExpiredNonces(ttlMs: number, now = Date.now()): Promise<number> {
  const db = await getSelfhealDb()
  const res = db.prepare('DELETE FROM selfheal_nonces WHERE seen_at < ?').run(now - ttlMs)
  return res.changes
}

// ── Jobs ───────────────────────────────────────────

export type InsertJobResult =
  | { outcome: 'inserted'; job: SelfhealJob }
  | { outcome: 'duplicate'; job: SelfhealJob } // same repair_id + same payload_hash (idempotent)
  | { outcome: 'conflict'; job: SelfhealJob } // same repair_id, DIFFERENT payload_hash

/**
 * Durably record an incoming repair dispatch. This is the receiver's commit
 * point — a 202 is only returned to v5 after this row is on disk.
 *
 * Idempotency / conflict semantics (contract §派单请求):
 *   - New repair_id                                → { inserted }
 *   - repair_id exists, SAME payload_hash          → { duplicate }  (202 again)
 *   - repair_id exists, DIFFERENT payload_hash     → { conflict }   (409)
 *
 * Runs in a transaction so the read-check-insert is atomic against a
 * concurrent duplicate delivery.
 */
export async function insertJobReceived(input: {
  repairId: string
  incidentId: string
  attempt: number
  payloadHash: string
  now?: number
}): Promise<InsertJobResult> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const txn = db.transaction((): InsertJobResult => {
    const existing = db
      .prepare('SELECT * FROM selfheal_jobs WHERE repair_id = ?')
      .get(input.repairId) as JobRow | undefined
    if (existing) {
      const job = rowToJob(existing)
      if (existing.payload_hash === input.payloadHash) return { outcome: 'duplicate', job }
      return { outcome: 'conflict', job }
    }
    db.prepare(`
      INSERT INTO selfheal_jobs
        (repair_id, incident_id, attempt, payload_hash, capability, status, lease_owner, lease_until, session_key, created_at, updated_at)
      VALUES (@repairId, @incidentId, @attempt, @payloadHash, NULL, 'received', NULL, 0, NULL, @now, @now)
    `).run({
      repairId: input.repairId,
      incidentId: input.incidentId,
      attempt: input.attempt,
      payloadHash: input.payloadHash,
      now,
    })
    const inserted = db
      .prepare('SELECT * FROM selfheal_jobs WHERE repair_id = ?')
      .get(input.repairId) as JobRow
    return { outcome: 'inserted', job: rowToJob(inserted) }
  })
  return txn()
}

export async function getJob(repairId: string): Promise<SelfhealJob | null> {
  const db = await getSelfhealDb()
  const row = db.prepare('SELECT * FROM selfheal_jobs WHERE repair_id = ?').get(repairId) as
    | JobRow
    | undefined
  return row ? rowToJob(row) : null
}

/** List jobs currently in any of the given states (cancel/ops introspection). */
export async function listJobsByStatus(statuses: SelfhealJobStatus[]): Promise<SelfhealJob[]> {
  if (statuses.length === 0) return []
  const db = await getSelfhealDb()
  const placeholders = statuses.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT * FROM selfheal_jobs WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
    )
    .all(...statuses) as JobRow[]
  return rows.map(rowToJob)
}

/**
 * Cancel tombstone for a repair the gateway has never seen (design §A2 case ①):
 * an UNKNOWN repairId being cancelled atomically inserts a terminal 'cancelled'
 * row so a LATE dispatch for the same repair can never start executing (the
 * receiver's payload-hash check turns it into a 409 conflict). Returns true when
 * THIS call inserted the tombstone; false when the repair row already existed
 * (caller re-reads and follows the normal cancel path).
 *
 * NOT NULL column values are fixed by the contract: incident_id = the cancel
 * body's incidentId, attempt = 0, payload_hash = 'tombstone'.
 */
export async function insertCancelTombstone(input: {
  repairId: string
  incidentId: string
  now?: number
}): Promise<boolean> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const res = db
    .prepare(`
      INSERT INTO selfheal_jobs
        (repair_id, incident_id, attempt, payload_hash, capability, status, lease_owner, lease_until, session_key, created_at, updated_at)
      VALUES (?, ?, 0, 'tombstone', NULL, 'cancelled', NULL, 0, NULL, ?, ?)
      ON CONFLICT(repair_id) DO NOTHING
    `)
    .run(input.repairId, input.incidentId, now, now)
  return res.changes > 0
}

/**
 * Atomically lease one claimable job for execution. "Claimable" means either:
 *   - status = 'received'                        (fresh, never started), or
 *   - status IN ('starting','running') with an EXPIRED lease (crash recovery —
 *     the prior owner died mid-flight; the lease elapsed so we may take over).
 *
 * The claim CAS is a single UPDATE guarded on (repair_id + the claimable
 * predicate). Only one worker can flip the row to 'starting' with a fresh
 * lease; concurrent claimers see `changes === 0` and move on. Returns the
 * leased job (post-update) or null if nothing was claimable.
 *
 * Note: re-claiming a 'starting'/'running' crashed job is SAFE because the
 * downstream turn submission is idempotent on execution_id (see
 * enqueueExecution / claimQueuedTurn) — a re-drive never double-executes.
 */
export async function claimNextJob(input: {
  owner: string
  leaseMs: number
  now?: number
}): Promise<SelfhealJob | null> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const leaseUntil = now + input.leaseMs
  const txn = db.transaction((): SelfhealJob | null => {
    const candidate = db
      .prepare(`
        SELECT repair_id FROM selfheal_jobs
        WHERE status = 'received'
           OR (status IN ('starting','running') AND lease_until < @now)
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get({ now }) as { repair_id: string } | undefined
    if (!candidate) return null
    const res = db
      .prepare(`
        UPDATE selfheal_jobs
        SET status = 'starting', lease_owner = @owner, lease_until = @leaseUntil, updated_at = @now
        WHERE repair_id = @repairId
          AND (status = 'received' OR (status IN ('starting','running') AND lease_until < @now))
      `)
      .run({ owner: input.owner, leaseUntil, now, repairId: candidate.repair_id })
    if (res.changes === 0) return null // lost the race to another worker
    const row = db
      .prepare('SELECT * FROM selfheal_jobs WHERE repair_id = ?')
      .get(candidate.repair_id) as JobRow
    return rowToJob(row)
  })
  return txn()
}

/**
 * Startup cleanup: proactively zero the lease on jobs whose lease has ALREADY
 * EXPIRED, so the next claim takes them over without re-checking the clock. Only
 * expired leases are touched (Codex HIGH #10): a still-fresh lease belongs to a
 * LIVE worker — a rolling restart / second instance — and clobbering it would
 * let two workers drive the same repair (and, with reopenExecutionForRedrive,
 * double-run its turn). A hard-crashed worker's lease elapses on its own; a
 * graceful shutdown proactively releases its leases (see
 * {@link releaseJobLeasesForOwner}) for immediate recovery. Returns rows touched.
 */
export async function reclaimOrphanedLeases(now = Date.now()): Promise<number> {
  const db = await getSelfhealDb()
  const res = db
    .prepare(
      "UPDATE selfheal_jobs SET lease_until = 0, updated_at = ? WHERE status IN ('starting','running') AND lease_until <= ?",
    )
    .run(now, now)
  return res.changes
}

/**
 * Graceful-shutdown fast recovery: a stopping worker releases the leases it
 * still holds on its own non-terminal jobs (owner match → lease_until=0) so the
 * next process re-claims them immediately instead of waiting out the lease
 * window. Only the caller's OWN in-flight jobs are released, so this is safe even
 * if another live worker exists. Returns rows touched.
 */
export async function releaseJobLeasesForOwner(owner: string, now = Date.now()): Promise<number> {
  const db = await getSelfhealDb()
  const res = db
    .prepare(
      "UPDATE selfheal_jobs SET lease_until = 0, updated_at = ? WHERE lease_owner = ? AND status IN ('starting','running')",
    )
    .run(now, owner)
  return res.changes
}

/**
 * Renew the lease on a job we own. Guards on lease_owner so a worker that lost
 * the lease (took too long, another worker reclaimed) cannot clobber the new
 * owner. Returns true if the renewal applied.
 */
export async function renewJobLease(input: {
  repairId: string
  owner: string
  leaseMs: number
  now?: number
}): Promise<boolean> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const res = db
    .prepare(`
      UPDATE selfheal_jobs
      SET lease_until = @leaseUntil, updated_at = @now
      WHERE repair_id = @repairId AND lease_owner = @owner
        AND status IN ('starting','running')
    `)
    .run({ repairId: input.repairId, owner: input.owner, leaseUntil: now + input.leaseMs, now })
  return res.changes > 0
}

/** Persist the short-lived capability token fetched from v5 onto the job row. */
export async function setJobCapability(repairId: string, capability: string): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare('UPDATE selfheal_jobs SET capability = ?, updated_at = ? WHERE repair_id = ?').run(
    capability,
    Date.now(),
    repairId,
  )
}

/**
 * Durably revoke any held release for a repair (cancel of a terminal job —
 * HIGH3). Idempotent; the broker's releaseApproved checks this fuse at entry
 * and refuses with reason 'release_revoked'.
 */
export async function setJobReleaseRevoked(repairId: string, now = Date.now()): Promise<boolean> {
  const db = await getSelfhealDb()
  const res = db
    .prepare('UPDATE selfheal_jobs SET release_revoked = 1, updated_at = ? WHERE repair_id = ?')
    .run(now, repairId)
  return res.changes > 0
}

/** Persist the deterministic session key onto the job row. */
export async function setJobSessionKey(repairId: string, sessionKey: string): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare('UPDATE selfheal_jobs SET session_key = ?, updated_at = ? WHERE repair_id = ?').run(
    sessionKey,
    Date.now(),
    repairId,
  )
}

/**
 * Transition a job's status. `expect` optionally guards the transition so a
 * stale writer cannot resurrect a terminal job (e.g. cancel racing success).
 * Returns true if the update applied.
 */
export async function setJobStatus(
  repairId: string,
  status: SelfhealJobStatus,
  expect?: SelfhealJobStatus[],
): Promise<boolean> {
  const db = await getSelfhealDb()
  const now = Date.now()
  if (expect && expect.length > 0) {
    const placeholders = expect.map(() => '?').join(',')
    const res = db
      .prepare(
        `UPDATE selfheal_jobs SET status = ?, updated_at = ? WHERE repair_id = ? AND status IN (${placeholders})`,
      )
      .run(status, now, repairId, ...expect)
    return res.changes > 0
  }
  const res = db
    .prepare('UPDATE selfheal_jobs SET status = ?, updated_at = ? WHERE repair_id = ?')
    .run(status, now, repairId)
  return res.changes > 0
}

// ── Executions + durable turn queue (at-most-once) ──

export type EnqueueExecutionResult =
  | { outcome: 'enqueued'; execution: SelfhealExecution } // fresh — accepted + queued written
  | { outcome: 'exists'; execution: SelfhealExecution } // already accepted/running/done/failed
  /** Fence rejection (design §A2): the owning job is absent or not in an
   *  executable state (starting/running) — e.g. cancelled between the worker's
   *  CAS and this enqueue. Nothing is written; the turn must never run. */
  | { outcome: 'rejected'; reason: string }

/**
 * The at-most-once commit point. In ONE transaction, INSERT the execution row
 * (status 'accepted') AND the durable_turn_queue row (status 'queued'). Because
 * both writes share a transaction, `accepted` can never exist without a queued
 * (or later consumed) turn — eliminating the "recorded accepted but never
 * submitted → permanent swallow" failure mode.
 *
 * Idempotent on execution_id: a second call for an existing execution returns
 * `{ exists }` and writes nothing (never a second queue row → never a second
 * turn).
 *
 * Cancel fence (design §A2, second line of defense behind the per-repair
 * mutex): execution_id doubles as the repair_id, and a NEW enqueue is only
 * allowed while the owning selfheal_job is in an executable state
 * ('starting'/'running') — checked INSIDE this same transaction, so a cancel
 * that already CASed the job to cancelling/cancelled can never be raced into a
 * fresh turn.
 */
export async function enqueueExecution(input: {
  executionId: string
  sessionKey: string
  now?: number
}): Promise<EnqueueExecutionResult> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const txn = db.transaction((): EnqueueExecutionResult => {
    const existing = db
      .prepare('SELECT * FROM selfheal_executions WHERE execution_id = ?')
      .get(input.executionId) as
      | {
          execution_id: string
          status: SelfhealExecutionStatus
          session_key: string | null
          created_at: number
          updated_at: number
        }
      | undefined
    if (existing) {
      return {
        outcome: 'exists',
        execution: {
          executionId: existing.execution_id,
          status: existing.status,
          sessionKey: existing.session_key,
          createdAt: existing.created_at,
          updatedAt: existing.updated_at,
        },
      }
    }
    // Cancel fence: only an executable job may enqueue a fresh turn (see doc).
    const job = db
      .prepare('SELECT status FROM selfheal_jobs WHERE repair_id = ?')
      .get(input.executionId) as { status: SelfhealJobStatus } | undefined
    if (!job || !EXECUTABLE_JOB_STATES.includes(job.status)) {
      return {
        outcome: 'rejected',
        reason: job ? `job status is '${job.status}'` : 'no job row for execution',
      }
    }
    db.prepare(`
      INSERT INTO selfheal_executions (execution_id, status, session_key, created_at, updated_at)
      VALUES (?, 'accepted', ?, ?, ?)
    `).run(input.executionId, input.sessionKey, now, now)
    // Queue row id is derived from execution_id (UNIQUE on execution_id also
    // enforces one queue row per execution). Deterministic id keeps replay/debug
    // simple and prevents accidental duplicate rows.
    db.prepare(`
      INSERT INTO durable_turn_queue (id, execution_id, status, created_at)
      VALUES (?, ?, 'queued', ?)
    `).run(`q:${input.executionId}`, input.executionId, now)
    return {
      outcome: 'enqueued',
      execution: {
        executionId: input.executionId,
        status: 'accepted',
        sessionKey: input.sessionKey,
        createdAt: now,
        updatedAt: now,
      },
    }
  })
  return txn()
}

/**
 * Claim the queued turn for an execution: CAS durable_turn_queue queued→consumed
 * AND, in the same transaction, execution accepted→running. Returns true iff
 * THIS caller won the claim — i.e. it (and only it) must now submit the turn.
 *
 * This is the at-most-once fence: exactly one caller ever observes `true` for a
 * given execution_id. A crash BEFORE this claim leaves the row 'queued' (a later
 * re-drive wins → no swallow); a crash AFTER this claim leaves it 'consumed' (a
 * later re-drive loses → no double-execute).
 *
 * Cancel fence (design §A2, mirrors enqueueExecution): the claim additionally
 * requires the owning selfheal_job to still be in an executable state
 * ('starting'/'running') INSIDE this transaction — a job CASed to
 * cancelling/cancelled can never have its queued turn consumed (zero submit).
 */
export async function claimQueuedTurn(executionId: string, now = Date.now()): Promise<boolean> {
  const db = await getSelfhealDb()
  const txn = db.transaction((): boolean => {
    const res = db
      .prepare(`
        UPDATE durable_turn_queue SET status = 'consumed'
        WHERE execution_id = ? AND status = 'queued'
          AND EXISTS (
            SELECT 1 FROM selfheal_jobs j
            WHERE j.repair_id = durable_turn_queue.execution_id
              AND j.status IN ('starting','running')
          )
      `)
      .run(executionId)
    if (res.changes === 0) return false
    db.prepare(
      "UPDATE selfheal_executions SET status = 'running', updated_at = ? WHERE execution_id = ? AND status = 'accepted'",
    ).run(now, executionId)
    return true
  })
  return txn()
}

/**
 * Re-open a claimed-but-unfinished execution for one more attempt (crash
 * recovery). Called ONLY by the job-lease holder before re-driving, so a
 * 'running' row here is a crashed prior attempt — the job lease guarantees no
 * live one. Resets execution 'running'→'accepted' and its consumed turn back to
 * 'queued' (one transaction) so the next {@link claimQueuedTurn} wins and
 * re-runs. 'done'/'failed'/absent are left untouched — a completed turn is never
 * re-run. This makes turn execution at-LEAST-once; the broker keeps SIDE EFFECTS
 * at-most-once. Returns true if a running attempt was re-opened.
 */
export async function reopenExecutionForRedrive(
  executionId: string,
  now = Date.now(),
): Promise<boolean> {
  const db = await getSelfhealDb()
  const txn = db.transaction((): boolean => {
    const exec = db
      .prepare('SELECT status FROM selfheal_executions WHERE execution_id = ?')
      .get(executionId) as { status: string } | undefined
    if (!exec || exec.status !== 'running') return false
    db.prepare(
      "UPDATE selfheal_executions SET status = 'accepted', updated_at = ? WHERE execution_id = ? AND status = 'running'",
    ).run(now, executionId)
    db.prepare(
      "UPDATE durable_turn_queue SET status = 'queued' WHERE execution_id = ? AND status = 'consumed'",
    ).run(executionId)
    return true
  })
  return txn()
}

export async function setExecutionStatus(
  executionId: string,
  status: SelfhealExecutionStatus,
): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare(
    'UPDATE selfheal_executions SET status = ?, updated_at = ? WHERE execution_id = ?',
  ).run(status, Date.now(), executionId)
}

export async function getExecution(executionId: string): Promise<SelfhealExecution | null> {
  const db = await getSelfhealDb()
  const row = db
    .prepare('SELECT * FROM selfheal_executions WHERE execution_id = ?')
    .get(executionId) as
    | {
        execution_id: string
        status: SelfhealExecutionStatus
        session_key: string | null
        created_at: number
        updated_at: number
      }
    | undefined
  if (!row) return null
  return {
    executionId: row.execution_id,
    status: row.status,
    sessionKey: row.session_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── broker action claim (durable, atomic single-winner idempotency) ──────────

export type BrokerClaimOutcome = 'won' | 'replay' | 'conflict' | 'in_progress'

export interface BrokerClaimResult {
  outcome: BrokerClaimOutcome
  /** Present only for 'replay': the JSON-serialized recorded response. */
  response?: string
}

/**
 * Atomically claim a broker action. Single winner: the first caller for a
 * claim_key inserts a 'claimed' row and gets 'won' — it (and only it) may then
 * perform the side effect and call {@link finalizeBrokerAction}. Later callers:
 *   - same params_hash + committed     → 'replay' (recorded response returned);
 *   - same params_hash + still claimed → 'in_progress' (a prior handler crashed
 *     before finalizing ⇒ NEVER re-execute — at-most-once for side effects);
 *   - different params_hash            → 'conflict' (key reused with new params).
 * The get+insert run in one SQLite transaction (and better-sqlite3 is
 * synchronous), so two concurrent claims can never both win.
 */
export async function tryClaimBrokerAction(input: {
  claimKey: string
  repairId: string
  actionKind: string
  paramsHash: string
  now?: number
}): Promise<BrokerClaimResult> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const txn = db.transaction((): BrokerClaimResult => {
    const row = db
      .prepare('SELECT params_hash, status, response FROM broker_actions WHERE claim_key = ?')
      .get(input.claimKey) as
      | { params_hash: string; status: string; response: string | null }
      | undefined
    if (!row) {
      db.prepare(
        `INSERT INTO broker_actions (claim_key, repair_id, action_kind, params_hash, status, claimed_at, updated_at)
         VALUES (?, ?, ?, ?, 'claimed', ?, ?)`,
      ).run(input.claimKey, input.repairId, input.actionKind, input.paramsHash, now, now)
      return { outcome: 'won' }
    }
    if (row.params_hash !== input.paramsHash) return { outcome: 'conflict' }
    if (row.status === 'committed' && row.response != null)
      return { outcome: 'replay', response: row.response }
    return { outcome: 'in_progress' }
  })
  return txn()
}

/** Record the terminal (side-effecting) outcome for a won claim. */
export async function finalizeBrokerAction(
  claimKey: string,
  response: string,
  now = Date.now(),
): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare(
    "UPDATE broker_actions SET status = 'committed', response = ?, updated_at = ? WHERE claim_key = ? AND status = 'claimed'",
  ).run(response, now, claimKey)
}

/** Release a won claim whose action turned out to be a non-side-effecting reject
 *  (e.g. param validation failed), so a corrected retry can proceed. Only deletes
 *  still-'claimed' rows — a committed side effect is never removed. */
export async function releaseBrokerClaim(claimKey: string): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare("DELETE FROM broker_actions WHERE claim_key = ? AND status = 'claimed'").run(claimKey)
}

export interface BrokerActionRecord {
  claimKey: string
  repairId: string
  actionKind: string
  paramsHash: string
  status: 'claimed' | 'committed'
  response: string | null
  claimedAt: number
  updatedAt: number
}

/** Read one broker action record (release path re-verifies the durable
 *  pending_release cutover record through this). */
export async function getBrokerAction(claimKey: string): Promise<BrokerActionRecord | null> {
  const db = await getSelfhealDb()
  const row = db
    .prepare(
      'SELECT claim_key, repair_id, action_kind, params_hash, status, response, claimed_at, updated_at FROM broker_actions WHERE claim_key = ?',
    )
    .get(claimKey) as
    | {
        claim_key: string
        repair_id: string
        action_kind: string
        params_hash: string
        status: 'claimed' | 'committed'
        response: string | null
        claimed_at: number
        updated_at: number
      }
    | undefined
  if (!row) return null
  return {
    claimKey: row.claim_key,
    repairId: row.repair_id,
    actionKind: row.action_kind,
    paramsHash: row.params_hash,
    status: row.status,
    response: row.response,
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Overwrite the recorded response of a COMMITTED action (observability update —
 * e.g. a cutover that was held 'pending_release' later gets released and its
 * durable record should reflect 'deployed'). Never touches 'claimed' rows (that
 * is {@link finalizeBrokerAction}'s job). Returns true if a row was updated.
 */
export async function overwriteBrokerActionResponse(
  claimKey: string,
  response: string,
  now = Date.now(),
): Promise<boolean> {
  const db = await getSelfhealDb()
  const res = db
    .prepare(
      "UPDATE broker_actions SET response = ?, updated_at = ? WHERE claim_key = ? AND status = 'committed'",
    )
    .run(response, now, claimKey)
  return res.changes > 0
}

// ── broker→master callback outbox (durable delivery — BLOCKER2) ──────────────

export type SelfhealCallbackPhase = 'pending_release' | 'done'
export type SelfhealCallbackStatus = 'queued' | 'sent' | 'abandoned'

export interface SelfhealCallbackRow {
  id: number
  repairId: string
  phase: SelfhealCallbackPhase
  message: string
  /** JSON-serialized detail OBJECT (the master requires an object detail). */
  detailJson: string
  status: SelfhealCallbackStatus
  attempts: number
  nextAttemptAt: number
  createdAt: number
  updatedAt: number
}

/** Retry backoff: base 5s, doubling per attempt, capped at 5min. Exported for
 *  test assertions — the pump itself never computes delays (single authority). */
export const SELFHEAL_CALLBACK_BACKOFF_BASE_MS = 5_000
export const SELFHEAL_CALLBACK_BACKOFF_CAP_MS = 5 * 60_000

interface CallbackOutboxDbRow {
  id: number
  repair_id: string
  phase: SelfhealCallbackPhase
  message: string
  detail_json: string
  status: SelfhealCallbackStatus
  attempts: number
  next_attempt_at: number
  created_at: number
  updated_at: number
}

function rowToCallback(r: CallbackOutboxDbRow): SelfhealCallbackRow {
  return {
    id: r.id,
    repairId: r.repair_id,
    phase: r.phase,
    message: r.message,
    detailJson: r.detail_json,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * BLOCKER(审计R2):broker 结果 finalize 与 master 回调 enqueue **同一 SQLite
 * 事务** —— cutover/release 绝不允许被 durably committed 而 pending_release/done
 * 标记却没入 outbox(pump 永远送不出去,replay 又只重放已提交响应不再补投)。
 * 事务失败时 claim 保持 'claimed'(replay=in_progress,fail-closed 绝不重跑副作用),
 * 由调用方如实上报 commit_failed。
 */
export async function commitBrokerOutcomeWithCallback(input: {
  finalize: { claimKey: string; response: string }[]
  overwriteCommitted?: { claimKey: string; response: string }
  callback: {
    repairId: string
    phase: SelfhealCallbackPhase
    message: string
    detail: Record<string, unknown>
  }
  now?: number
}): Promise<void> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const txn = db.transaction(() => {
    for (const f of input.finalize) {
      db.prepare(
        "UPDATE broker_actions SET status = 'committed', response = ?, updated_at = ? WHERE claim_key = ? AND status = 'claimed'",
      ).run(f.response, now, f.claimKey)
    }
    if (input.overwriteCommitted) {
      db.prepare(
        "UPDATE broker_actions SET response = ?, updated_at = ? WHERE claim_key = ? AND status = 'committed'",
      ).run(input.overwriteCommitted.response, now, input.overwriteCommitted.claimKey)
    }
    db.prepare(`
      INSERT INTO selfheal_callback_outbox
        (repair_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(repair_id, phase) DO NOTHING
    `).run(
      input.callback.repairId,
      input.callback.phase,
      input.callback.message,
      JSON.stringify(input.callback.detail),
      now,
      now,
      now,
    )
  })
  txn()
}

/**
 * Idempotently enqueue a broker→master callback. UNIQUE(repair_id, phase) +
 * ON CONFLICT DO NOTHING: a crash-re-driven cutover/release can call this again
 * without producing a duplicate delivery. Returns true when THIS call inserted
 * the row.
 */
export async function enqueueCallback(input: {
  repairId: string
  phase: SelfhealCallbackPhase
  message: string
  detail: Record<string, unknown>
  now?: number
}): Promise<boolean> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const res = db
    .prepare(`
      INSERT INTO selfheal_callback_outbox
        (repair_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(repair_id, phase) DO NOTHING
    `)
    .run(input.repairId, input.phase, input.message, JSON.stringify(input.detail), now, now, now)
  return res.changes > 0
}

/**
 * Read the due queued callbacks, id-ascending, up to `limit`.
 *
 * Per-repair ordering guard: a repair's 'done' must never be delivered before
 * its 'pending_release' (the master's state machine reads the progress marker
 * first). Enqueue order gives pending_release the smaller id, so a row is due
 * only when NO earlier still-queued row exists for the same repair — a backed-
 * off pending_release therefore also holds back its done row.
 */
export async function claimDueCallbacks(
  now: number,
  limit: number,
): Promise<SelfhealCallbackRow[]> {
  const db = await getSelfhealDb()
  const rows = db
    .prepare(`
      SELECT * FROM selfheal_callback_outbox o
      WHERE o.status = 'queued' AND o.next_attempt_at <= @now
        AND NOT EXISTS (
          SELECT 1 FROM selfheal_callback_outbox p
          WHERE p.repair_id = o.repair_id AND p.status = 'queued' AND p.id < o.id
        )
      ORDER BY o.id ASC
      LIMIT @limit
    `)
    .all({ now, limit }) as CallbackOutboxDbRow[]
  return rows.map(rowToCallback)
}

/** Mark one callback delivered (2xx, or 409 = master already applied it). */
export async function markCallbackSent(id: number, now = Date.now()): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare(
    "UPDATE selfheal_callback_outbox SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'queued'",
  ).run(now, id)
}

/** Permanently abandon one callback (repair unknown/terminal on the master). */
export async function markCallbackAbandoned(id: number, now = Date.now()): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare(
    "UPDATE selfheal_callback_outbox SET status = 'abandoned', updated_at = ? WHERE id = ? AND status = 'queued'",
  ).run(now, id)
}

/**
 * Record a failed delivery attempt and schedule the retry with exponential
 * backoff (base 5s doubling per attempt, cap 5min). The row stays 'queued' —
 * durable delivery never gives up on transient failures.
 */
export async function bumpCallbackAttempt(id: number, now = Date.now()): Promise<void> {
  const db = await getSelfhealDb()
  const txn = db.transaction(() => {
    const row = db
      .prepare("SELECT attempts FROM selfheal_callback_outbox WHERE id = ? AND status = 'queued'")
      .get(id) as { attempts: number } | undefined
    if (!row) return
    const delay = Math.min(
      SELFHEAL_CALLBACK_BACKOFF_BASE_MS * 2 ** row.attempts,
      SELFHEAL_CALLBACK_BACKOFF_CAP_MS,
    )
    db.prepare(
      'UPDATE selfheal_callback_outbox SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ? WHERE id = ?',
    ).run(now + delay, now, id)
  })
  txn()
}

/**
 * Abandon every still-queued callback of a repair (cancel of a terminal job —
 * HIGH3: the revoked repair must not keep pumping stale markers at the master).
 * Returns the number of rows abandoned.
 */
export async function abandonQueuedCallbacks(repairId: string, now = Date.now()): Promise<number> {
  const db = await getSelfhealDb()
  const res = db
    .prepare(
      "UPDATE selfheal_callback_outbox SET status = 'abandoned', updated_at = ? WHERE repair_id = ? AND status = 'queued'",
    )
    .run(now, repairId)
  return res.changes
}

/** All callback rows of one repair (ops/test introspection). */
export async function listCallbacksForRepair(repairId: string): Promise<SelfhealCallbackRow[]> {
  const db = await getSelfhealDb()
  const rows = db
    .prepare('SELECT * FROM selfheal_callback_outbox WHERE repair_id = ? ORDER BY id ASC')
    .all(repairId) as CallbackOutboxDbRow[]
  return rows.map(rowToCallback)
}
