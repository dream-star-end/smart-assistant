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
//   selfheal_release_fuse_cleared_epochs — append-only tombstones keyed by the
//                          immutable release_request_id. Once an epoch is
//                          cleared, a delayed engage for that epoch can never
//                          resurrect the fuse or overwrite a newer epoch.
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
      condition_key TEXT,
      execution_class TEXT,
      action_opcode TEXT,
      tier1_claimed_at INTEGER,
      tier1_receipt TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
`

// Column body of selfheal_callback_outbox — single source for the base CREATE
// and the batch1b release-schema rebuild guard. `release_request_id` (NULL =
// legacy repair-level callback) discriminates the two durable callback kinds.
// The legacy UNIQUE(repair_id, phase) TABLE constraint is REPLACED by two
// PARTIAL unique indexes (created post-guard, see
// SELFHEAL_CALLBACK_OUTBOX_PARTIAL_INDEXES): repair-level rows dedup on
// (repair_id, phase); release rows dedup on (release_request_id, phase) — so a
// repair's per-release callbacks (deploying + one terminal PER release request)
// coexist without colliding on the legacy repair key. The phase CHECK carries
// the release phases; the wire transport still maps them to progress|done|
// failed in the pump.
const SELFHEAL_CALLBACK_OUTBOX_COLUMNS_DDL = `
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      repair_id          TEXT NOT NULL,
      release_request_id TEXT,
      phase              TEXT NOT NULL CHECK (phase IN
                           ('pending_release','done','failed','deploying','deployed','deploy_failed','deploy_unknown','manual_required')),
      message            TEXT NOT NULL,
      detail_json        TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','sent','abandoned')),
      attempts           INTEGER NOT NULL DEFAULT 0,
      next_attempt_at    INTEGER NOT NULL,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
`

// The two partial unique indexes that replace the legacy UNIQUE(repair_id,
// phase) constraint. Created AFTER all schema guards run, so the
// `release_request_id` column is guaranteed present (fresh DB: base CREATE;
// upgraded DB: the release rebuild guard). Idempotent (IF NOT EXISTS).
const SELFHEAL_CALLBACK_OUTBOX_PARTIAL_INDEXES = `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cb_repair_phase
      ON selfheal_callback_outbox(repair_id, phase) WHERE release_request_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cb_release_phase
      ON selfheal_callback_outbox(release_request_id, phase) WHERE release_request_id IS NOT NULL;
`

// Column body of selfheal_release_jobs (batch1b, §5.1). A DEDICATED ledger,
// physically isolated from selfheal_jobs: the latter's received→…→terminal
// LEASE is built for "crash → re-claim/redrive", whereas a release deployment
// must be "claim → NEVER replay" (opposite recovery semantics). Mixing them
// would let the generic reclaimer re-run a deploy. Timestamps here are ISO-8601
// TEXT (contract §5.1 DDL verbatim), unlike selfheal_jobs' epoch integers.
const SELFHEAL_RELEASE_JOBS_COLUMNS_DDL = `
      release_request_id TEXT PRIMARY KEY,
      repair_id          TEXT NOT NULL,
      incident_id        TEXT NOT NULL,
      payload_hash       TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'received' CHECK (status IN
                           ('received','deploying','deployed','deploy_failed','deploy_unknown','manual_required','cancelled')),
      approved_sha       TEXT NOT NULL,
      base_sha           TEXT,
      deploy_plan_hash   TEXT,
      manifest_hash      TEXT,
      plan_json          TEXT NOT NULL,
      origin             TEXT NOT NULL DEFAULT 'v5' CHECK (origin IN ('v5','breakglass','auto')),
      claimed_at         TEXT,
      scope_unit         TEXT,
      receipt_json       TEXT,
      checkpoint_json    TEXT,
      canonical_pushed_at TEXT,
      failure_reason     TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
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

/**
 * Idempotent schema guard: `condition_key` freezes the AUTHORITATIVE condition
 * key of the dispatched incident onto the job row (fetched from the v5 master
 * via the root-held capability at job start — never from the model). The
 * broker authorizes drill repairs against this frozen value; NULL means the
 * key was never frozen (legacy row) and is treated as non-drill.
 */
function ensureConditionKeyColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(selfheal_jobs)').all() as { name: string }[]
  if (cols.some((c) => c.name === 'condition_key')) return
  db.exec('ALTER TABLE selfheal_jobs ADD COLUMN condition_key TEXT')
}

/**
 * Idempotent schema guard (batch1a): Tier1 routing frozen from the master
 * context (execution_class + action_opcode, set-once with condition_key) plus
 * tier1_receipt (set-once record of the executed opcode = at-most-once replay
 * guard). Plain defaulted columns are ALTER-addable.
 */
/**
 * Idempotent schema guard: an outbox created before batch1a has a phase CHECK
 * lacking 'failed'. SQLite cannot ALTER a CHECK — rebuild (new table → copy →
 * drop → rename) in one transaction, preserving in-flight rows.
 */
function ensureCallbackFailedPhase(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='selfheal_callback_outbox'")
    .get() as { sql: string } | undefined
  if (!row || row.sql.includes("'failed'")) return
  db.transaction(() => {
    db.exec(`
      CREATE TABLE selfheal_callback_outbox_rebuild (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        repair_id       TEXT NOT NULL,
        phase           TEXT NOT NULL CHECK (phase IN ('pending_release','done','failed')),
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
      INSERT INTO selfheal_callback_outbox_rebuild
        SELECT id, repair_id, phase, message, detail_json, status, attempts,
               next_attempt_at, created_at, updated_at FROM selfheal_callback_outbox;
      DROP TABLE selfheal_callback_outbox;
      ALTER TABLE selfheal_callback_outbox_rebuild RENAME TO selfheal_callback_outbox;
      CREATE INDEX IF NOT EXISTS idx_selfheal_cb_outbox_due
        ON selfheal_callback_outbox(status, next_attempt_at);
    `)
  })()
}

/**
 * Idempotent schema guard (batch1b): an outbox created before the release batch
 * lacks the `release_request_id` column, the release phase CHECK values, and
 * still carries the legacy UNIQUE(repair_id, phase) TABLE constraint. SQLite can
 * ALTER neither a CHECK nor a table constraint — rebuild (new table → copy →
 * drop → rename) in ONE transaction, preserving in-flight rows verbatim (legacy
 * rows take release_request_id = NULL, keeping them under the repair-level
 * partial index). The two partial unique indexes are (re)created by the caller
 * after all guards run — see SELFHEAL_CALLBACK_OUTBOX_PARTIAL_INDEXES. Runs
 * AFTER ensureCallbackFailedPhase so a pre-'failed' DB is first normalized.
 */
function ensureReleaseCallbackSchema(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='selfheal_callback_outbox'")
    .get() as { sql: string } | undefined
  if (!row) return
  const hasRrid = (
    db.prepare('PRAGMA table_info(selfheal_callback_outbox)').all() as { name: string }[]
  ).some((c) => c.name === 'release_request_id')
  // Already batch1b (has the column AND the release phase values) → no rebuild.
  if (hasRrid && row.sql.includes("'deploying'")) return
  db.transaction(() => {
    db.exec(`
      CREATE TABLE selfheal_callback_outbox_rebuild (${SELFHEAL_CALLBACK_OUTBOX_COLUMNS_DDL});
      INSERT INTO selfheal_callback_outbox_rebuild
        (id, repair_id, release_request_id, phase, message, detail_json, status,
         attempts, next_attempt_at, created_at, updated_at)
        SELECT id, repair_id, NULL, phase, message, detail_json, status,
               attempts, next_attempt_at, created_at, updated_at
        FROM selfheal_callback_outbox;
      DROP TABLE selfheal_callback_outbox;
      ALTER TABLE selfheal_callback_outbox_rebuild RENAME TO selfheal_callback_outbox;
      CREATE INDEX IF NOT EXISTS idx_selfheal_cb_outbox_due
        ON selfheal_callback_outbox(status, next_attempt_at);
    `)
  })()
}

function ensureTier1Columns(db: Database.Database): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(selfheal_jobs)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!cols.has('execution_class')) db.exec('ALTER TABLE selfheal_jobs ADD COLUMN execution_class TEXT')
  if (!cols.has('action_opcode')) db.exec('ALTER TABLE selfheal_jobs ADD COLUMN action_opcode TEXT')
  if (!cols.has('tier1_claimed_at')) db.exec('ALTER TABLE selfheal_jobs ADD COLUMN tier1_claimed_at INTEGER')
  if (!cols.has('tier1_receipt')) db.exec('ALTER TABLE selfheal_jobs ADD COLUMN tier1_receipt TEXT')
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
    -- (repair_id, phase) for legacy repair-level callbacks (release_request_id
    -- NULL: 'pending_release' progress, 'done'/'failed' terminal), and one row
    -- per (release_request_id, phase) for batch1b release callbacks (deploying/
    -- deployed/deploy_failed/deploy_unknown/manual_required). Enqueue is
    -- idempotent (partial unique indexes + ON CONFLICT DO NOTHING); the
    -- callbackPump drains queued rows in id order with exponential backoff and
    -- never gives up short of an explicit master-side refusal (→ 'abandoned').
    -- Partial unique indexes are created after the schema guards (see below).
    CREATE TABLE IF NOT EXISTS selfheal_callback_outbox (${SELFHEAL_CALLBACK_OUTBOX_COLUMNS_DDL});
    CREATE INDEX IF NOT EXISTS idx_selfheal_cb_outbox_due
      ON selfheal_callback_outbox(status, next_attempt_at);

    -- batch1b (§5.1): durable release-deployment ledger, ISOLATED from
    -- selfheal_jobs (opposite recovery semantics — claim-then-never-replay).
    -- Idempotent PK = release_request_id; pre-claim (claimed_at set-once) is the
    -- at-most-once deploy gate; receipt/checkpoint are set-once durable proofs.
    CREATE TABLE IF NOT EXISTS selfheal_release_jobs (${SELFHEAL_RELEASE_JOBS_COLUMNS_DDL});
    CREATE INDEX IF NOT EXISTS idx_selfheal_release_jobs_status
      ON selfheal_release_jobs(status);

    -- batch1b (§5.2): local Tier2 release fuse (single row, id = 1). Engaged on
    -- deploy_unknown to block ANY new release claim locally BEFORE a callback
    -- reaches PG; cleared only via the audited two-sided converge protocol.
    CREATE TABLE IF NOT EXISTS selfheal_release_fuse (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      engaged            INTEGER NOT NULL DEFAULT 0,
      reason             TEXT,
      release_request_id TEXT,
      engaged_at         TEXT,
      cleared_at         TEXT,
      cleared_by         TEXT
    );
    INSERT OR IGNORE INTO selfheal_release_fuse (id, engaged) VALUES (1, 0);

    -- Append-only cleared-epoch ledger. The singleton row above describes the
    -- CURRENT fuse, while this table permanently rejects delayed re-engagement
    -- of an already-cleared immutable release request epoch.
    CREATE TABLE IF NOT EXISTS selfheal_release_fuse_cleared_epochs (
      release_request_id TEXT PRIMARY KEY,
      cleared_at         TEXT NOT NULL,
      cleared_by         TEXT NOT NULL
    );
    -- Upgrade bridge: old versions preserved their most recently cleared epoch
    -- only on the disengaged singleton. Tombstone it once so a delayed old
    -- worker cannot resurrect that epoch after this binary starts.
    INSERT OR IGNORE INTO selfheal_release_fuse_cleared_epochs
      (release_request_id, cleared_at, cleared_by)
      SELECT release_request_id, cleared_at, COALESCE(cleared_by, 'legacy-migration')
      FROM selfheal_release_fuse
      WHERE engaged = 0 AND release_request_id IS NOT NULL AND cleared_at IS NOT NULL;
  `)

  // Schema guard: rebuild selfheal_jobs when an old DB lacks 'cancelling' in the
  // status CHECK (the CREATE above no-ops on an existing table), then ALTER-add
  // the release_revoked fuse column when a newer-but-pre-fuse DB lacks it.
  ensureCancellingStatusSchema(db)
  ensureReleaseRevokedColumn(db)
  ensureConditionKeyColumn(db)
  ensureTier1Columns(db)
  ensureCallbackFailedPhase(db)
  ensureReleaseCallbackSchema(db)
  // Partial unique indexes replace the legacy UNIQUE(repair_id, phase) TABLE
  // constraint (batch1b). Created AFTER the guards so `release_request_id` is
  // guaranteed to exist on both fresh and upgraded DBs.
  db.exec(SELFHEAL_CALLBACK_OUTBOX_PARTIAL_INDEXES)

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
  /** Authoritative condition key frozen from the v5 master context at job
   *  start (NULL = never frozen; treated as non-drill by the broker). */
  conditionKey: string | null
  /** Tier1 routing frozen from the master context (set-once with conditionKey):
   *  executionClass = 'tier1' | 'tier2' | null(unfrozen); actionOpcode present
   *  only for tier1. */
  executionClass: 'tier1' | 'tier2' | null
  actionOpcode: string | null
  /** Tier1 PRE-CLAIM timestamp (set-once BEFORE the SSH): the at-most-once
   *  gate. Only the claim winner transmits; a crash leaving claimed-without-
   *  receipt is settled as 'unknown' (never re-transmitted). */
  tier1ClaimedAt: number | null
  /** Set-once record of the executed Tier1 opcode receipt (JSON). */
  tier1Receipt: string | null
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
  condition_key: string | null
  execution_class: string | null
  action_opcode: string | null
  tier1_claimed_at: number | null
  tier1_receipt: string | null
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
    conditionKey: r.condition_key,
    executionClass:
      r.execution_class === 'tier1' || r.execution_class === 'tier2' ? r.execution_class : null,
    actionOpcode: r.action_opcode,
    tier1ClaimedAt: r.tier1_claimed_at,
    tier1Receipt: r.tier1_receipt,
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

/** Freeze the authoritative condition key (from the v5 master context) onto
 *  the job row. Set-once: a frozen value is never overwritten — the first
 *  root-fetched context wins, so a later (potentially replayed) fetch cannot
 *  reclassify a drill repair as non-drill or vice versa. */
export async function setJobConditionKey(repairId: string, conditionKey: string): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare(
    'UPDATE selfheal_jobs SET condition_key = ?, updated_at = ? WHERE repair_id = ? AND condition_key IS NULL',
  ).run(conditionKey, Date.now(), repairId)
}

/** Atomically freeze the full authoritative routing (condition_key +
 *  execution_class + action_opcode) in ONE write (BLOCKER1: two separate
 *  set-once writes could interleave a crash and mix two context versions).
 *  Anchored set-once on condition_key: the first root-fetched routing wins. */
export async function setJobFrozenRouting(
  repairId: string,
  conditionKey: string,
  executionClass: 'tier1' | 'tier2',
  actionOpcode: string | null,
): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare(
    'UPDATE selfheal_jobs SET condition_key = ?, execution_class = ?, action_opcode = ?, updated_at = ? WHERE repair_id = ? AND condition_key IS NULL',
  ).run(conditionKey, executionClass, actionOpcode, Date.now(), repairId)
}

/** Atomic Tier1 PRE-CLAIM (BLOCKER2): a single conditional UPDATE that sets
 *  tier1_claimed_at only when it is still NULL. Returns true for the ONE caller
 *  that won the claim — only the winner may transmit the SSH opcode. A crash
 *  after this (claimed) but before the receipt is settled as 'unknown' on
 *  re-claim, never a re-transmit. */
export async function claimJobTier1(repairId: string, now = Date.now()): Promise<boolean> {
  const db = await getSelfhealDb()
  const res = db
    .prepare(
      'UPDATE selfheal_jobs SET tier1_claimed_at = ?, updated_at = ? WHERE repair_id = ? AND tier1_claimed_at IS NULL',
    )
    .run(now, now, repairId)
  return res.changes > 0
}

/** Record the Tier1 opcode receipt. Set-once — the committed record after a
 *  won pre-claim + SSH. */
export async function setJobTier1Receipt(repairId: string, receiptJson: string): Promise<boolean> {
  const db = await getSelfhealDb()
  const res = db
    .prepare(
      'UPDATE selfheal_jobs SET tier1_receipt = ?, updated_at = ? WHERE repair_id = ? AND tier1_receipt IS NULL',
    )
    .run(receiptJson, Date.now(), repairId)
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

export type SelfhealCallbackPhase =
  | 'pending_release'
  | 'done'
  | 'failed'
  /** batch1b release phases. Wire transport still maps them (pending_release/
   *  deploying → progress; deployed/done → done; deploy_failed/deploy_unknown/
   *  manual_required/failed → failed); the release semantics live in detail. */
  | 'deploying'
  | 'deployed'
  | 'deploy_failed'
  | 'deploy_unknown'
  | 'manual_required'
export type SelfhealCallbackStatus = 'queued' | 'sent' | 'abandoned'

export interface SelfhealCallbackRow {
  id: number
  repairId: string
  /** batch1b: NULL for legacy repair-level callbacks; the release request id for
   *  release callbacks (the master routes on it — see §4). */
  releaseRequestId: string | null
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
  release_request_id: string | null
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
    releaseRequestId: r.release_request_id,
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
/**
 * ATOMICALLY terminalize a Tier1 job AND enqueue its terminal callback in ONE
 * SQLite transaction (BLOCKER: enqueue + terminal status must not be two
 * commits — a crash between them leaves a delivered callback + a local running
 * orphan; and a cancel that terminalized first must make this CAS lose so no
 * stale callback is enqueued). The CAS gates the enqueue: if the job is no
 * longer in `fromStatuses` (a cancel won), NOTHING is enqueued and this returns
 * false. Idempotent enqueue per (repairId, phase). EVERY Tier1 terminal path
 * (completed/action_failed/unknown → done; rejected/drift/unprovisioned →
 * failed) goes through here — no best-effort fire-and-forget callback remains.
 */
export async function terminalizeTier1WithCallback(input: {
  repairId: string
  fromStatuses: SelfhealJobStatus[]
  toStatus: 'succeeded' | 'failed'
  phase: 'done' | 'failed'
  message: string
  detail: Record<string, unknown>
  now?: number
}): Promise<boolean> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const placeholders = input.fromStatuses.map(() => '?').join(',')
  const txn = db.transaction(() => {
    const cas = db
      .prepare(
        `UPDATE selfheal_jobs SET status = ?, updated_at = ? WHERE repair_id = ? AND status IN (${placeholders})`,
      )
      .run(input.toStatus, now, input.repairId, ...input.fromStatuses)
    if (cas.changes === 0) return false // a cancel (or prior terminal) won — no callback
    db.prepare(`
      INSERT INTO selfheal_callback_outbox
        (repair_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(repair_id, phase) WHERE release_request_id IS NULL DO NOTHING
    `).run(input.repairId, input.phase, input.message, JSON.stringify(input.detail), now, now, now)
    return true
  })
  return txn()
}

/** The frozen fields of a release-job intake, shared by the standalone
 *  {@link insertReleaseJobReceived} and the SAME-TRANSACTION insert inside
 *  {@link commitBrokerOutcomeWithCallback} (R2-4: the auto-deploy enqueue is now
 *  durable WITH the cutover commit, not a best-effort post-commit hook). The
 *  transaction owns the `created_at`/`updated_at` clock. */
export interface ReleaseJobInsertInput {
  releaseRequestId: string
  repairId: string
  incidentId: string
  payloadHash: string
  approvedSha: string
  baseSha?: string | null
  deployPlanHash?: string | null
  manifestHash?: string | null
  planJson: string
  origin?: SelfhealReleaseJobOrigin
}

/**
 * Atomically commit a broker outcome and its durable side effects in ONE SQLite
 * transaction (审计R2 BLOCKER + R2-4):
 *   - `finalize` — CAS each claimed broker_action → committed (the outcome);
 *   - `overwriteCommitted` — optional response overwrite of an already-committed
 *     record (pending_release → deployed on a one-click release);
 *   - `callback` — optional repair-level master callback (deduped on
 *     (repair_id, phase) for release_request_id IS NULL);
 *   - `releaseJobInsert` — optional local release job, PK-idempotent on
 *     release_request_id (ON CONFLICT DO NOTHING → crash-replay safe). The auto
 *     cutover uses this so "cutover committed ⟺ release job exists" holds across
 *     a crash (no more "record present, job absent" post-commit window).
 * Because everything runs in the single transaction, ANY failure (disk full, a
 * malformed insert) rolls the WHOLE outcome back — the caller reports
 * commit_failed and the claim stays held (fail-closed), never a half state.
 */
export async function commitBrokerOutcomeWithCallback(input: {
  finalize: { claimKey: string; response: string }[]
  overwriteCommitted?: { claimKey: string; response: string }
  callback?: {
    repairId: string
    phase: SelfhealCallbackPhase
    message: string
    detail: Record<string, unknown>
  }
  releaseJobInsert?: ReleaseJobInsertInput
  now?: number
}): Promise<void> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  // The release_jobs ledger stores ISO-8601 TEXT timestamps (unlike the outbox's
  // epoch-ms integers) — project the transaction clock accordingly.
  const iso = new Date(now).toISOString()
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
    if (input.callback) {
      db.prepare(`
        INSERT INTO selfheal_callback_outbox
          (repair_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
        ON CONFLICT(repair_id, phase) WHERE release_request_id IS NULL DO NOTHING
      `).run(
        input.callback.repairId,
        input.callback.phase,
        input.callback.message,
        JSON.stringify(input.callback.detail),
        now,
        now,
        now,
      )
    }
    if (input.releaseJobInsert) {
      const j = input.releaseJobInsert
      // PK-idempotent on release_request_id: a crash-replayed cutover commit must
      // NOT insert a second job. ON CONFLICT(release_request_id) DO NOTHING only
      // swallows a PK re-hit — a genuinely malformed insert (NOT NULL/CHECK) still
      // throws and rolls the whole transaction back (atomicity preserved).
      const ins = db.prepare(`
        INSERT INTO selfheal_release_jobs
          (release_request_id, repair_id, incident_id, payload_hash, status, approved_sha,
           base_sha, deploy_plan_hash, manifest_hash, plan_json, origin, created_at, updated_at)
        VALUES (@rrid, @repairId, @incidentId, @payloadHash, 'received', @approvedSha,
                @baseSha, @deployPlanHash, @manifestHash, @planJson, @origin, @iso, @iso)
        ON CONFLICT(release_request_id) DO NOTHING
      `).run({
        rrid: j.releaseRequestId,
        repairId: j.repairId,
        incidentId: j.incidentId,
        payloadHash: j.payloadHash,
        approvedSha: j.approvedSha,
        baseSha: j.baseSha ?? null,
        deployPlanHash: j.deployPlanHash ?? null,
        manifestHash: j.manifestHash ?? null,
        planJson: j.planJson,
        origin: j.origin ?? 'auto',
        iso,
      })
      // R3-3: the conflict path must be an EXACT replay, not a same-rrid different-
      // content collision — re-read the surviving row and verify the identity
      // fields; a mismatch poisons the commit (throw → the whole cutover finalize
      // rolls back and the claim stays held for human inspection).
      if (ins.changes === 0) {
        const existing = db
          .prepare(
            `SELECT repair_id, payload_hash, approved_sha FROM selfheal_release_jobs
              WHERE release_request_id = ?`,
          )
          .get(j.releaseRequestId) as
          | { repair_id: string; payload_hash: string; approved_sha: string }
          | undefined
        if (
          !existing ||
          existing.repair_id !== j.repairId ||
          existing.payload_hash !== j.payloadHash ||
          existing.approved_sha !== j.approvedSha
        ) {
          throw new Error(
            `selfheal release job rrid conflict is not an exact replay (rrid=${j.releaseRequestId})`,
          )
        }
      }
    }
  })
  txn()
}

/**
 * Idempotently enqueue a broker→master callback. Two idempotency keys, selected
 * by whether `releaseRequestId` is present:
 *   - absent/NULL → legacy repair-level callback, deduped on (repair_id, phase)
 *     under the `ux_cb_repair_phase` partial index (release_request_id IS NULL);
 *   - present     → batch1b release callback, deduped on (release_request_id,
 *     phase) under `ux_cb_release_phase` — so a repair's per-release callbacks
 *     coexist without colliding on the legacy repair key.
 * ON CONFLICT DO NOTHING keeps a crash-re-driven cutover/release from producing
 * a duplicate delivery. Returns true when THIS call inserted the row.
 */
export async function enqueueCallback(input: {
  repairId: string
  phase: SelfhealCallbackPhase
  message: string
  detail: Record<string, unknown>
  releaseRequestId?: string | null
  now?: number
}): Promise<boolean> {
  const db = await getSelfhealDb()
  const now = input.now ?? Date.now()
  const rrid = input.releaseRequestId ?? null
  const detailJson = JSON.stringify(input.detail)
  const res =
    rrid === null
      ? db
          .prepare(`
            INSERT INTO selfheal_callback_outbox
              (repair_id, release_request_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
            VALUES (?, NULL, ?, ?, ?, 'queued', 0, ?, ?, ?)
            ON CONFLICT(repair_id, phase) WHERE release_request_id IS NULL DO NOTHING
          `)
          .run(input.repairId, input.phase, input.message, detailJson, now, now, now)
      : db
          .prepare(`
            INSERT INTO selfheal_callback_outbox
              (repair_id, release_request_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
            ON CONFLICT(release_request_id, phase) WHERE release_request_id IS NOT NULL DO NOTHING
          `)
          .run(input.repairId, rrid, input.phase, input.message, detailJson, now, now, now)
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

// ── Release jobs (batch1b Tier2 code self-heal:放行→部署) ─────────────────────
//
// A DEDICATED ledger (§5.1), never mixed into selfheal_jobs: a release deploy is
// "claim → NEVER replay" while selfheal_jobs is "claim → re-claim/redrive on
// crash" — the generic reclaimer must never touch these rows. Every mutation is
// a set-once / CAS write in a transaction, mirroring claimJobTier1 /
// setJobTier1Receipt / terminalizeTier1WithCallback. All timestamps are ISO-8601
// TEXT (contract §5.1 DDL); the callback outbox keeps its epoch-integer clock, so
// the two-table writes carry both an ISO string and its epoch-ms projection.

export type SelfhealReleaseJobStatus =
  | 'received'
  | 'deploying'
  | 'deployed'
  | 'deploy_failed'
  | 'deploy_unknown'
  | 'manual_required'
  | 'cancelled'

export type SelfhealReleaseJobOrigin = 'v5' | 'breakglass' | 'auto'

/** The four terminal deploy phases that carry a callback (deployed → done wire;
 *  deploy_failed/deploy_unknown/manual_required → failed wire). `cancelled` is a
 *  terminal status too but is reached via {@link cancelReleaseJob} with NO
 *  callback (the master initiated the cancel and already knows). */
export type SelfhealReleaseTerminalPhase =
  | 'deployed'
  | 'deploy_failed'
  | 'deploy_unknown'
  | 'manual_required'

const RELEASE_TERMINAL_STATUSES: SelfhealReleaseJobStatus[] = [
  'deployed',
  'deploy_failed',
  'deploy_unknown',
  'manual_required',
  'cancelled',
]

export interface SelfhealReleaseJob {
  releaseRequestId: string
  repairId: string
  incidentId: string
  payloadHash: string
  status: SelfhealReleaseJobStatus
  approvedSha: string
  baseSha: string | null
  deployPlanHash: string | null
  manifestHash: string | null
  /** Full deploy plan frozen at intake from the LOCAL durable cutover record
   *  (§7): surfaces / deployArgs / manualReasons / hashes + changedFiles. */
  planJson: string
  origin: SelfhealReleaseJobOrigin
  /** Pre-claim timestamp (set-once): the at-most-once deploy gate. */
  claimedAt: string | null
  /** systemd transient scope unit name (leftover-process identification). */
  scopeUnit: string | null
  /** Set-once terminal receipt JSON (§8.2). */
  receiptJson: string | null
  /** Set-once durable checkpoint JSON (§9): the ONLY token that lets recovery
   *  "retry push only" instead of deploy_unknown. */
  checkpointJson: string | null
  canonicalPushedAt: string | null
  failureReason: string | null
  createdAt: string
  updatedAt: string
}

interface ReleaseJobRow {
  release_request_id: string
  repair_id: string
  incident_id: string
  payload_hash: string
  status: SelfhealReleaseJobStatus
  approved_sha: string
  base_sha: string | null
  deploy_plan_hash: string | null
  manifest_hash: string | null
  plan_json: string
  origin: SelfhealReleaseJobOrigin
  claimed_at: string | null
  scope_unit: string | null
  receipt_json: string | null
  checkpoint_json: string | null
  canonical_pushed_at: string | null
  failure_reason: string | null
  created_at: string
  updated_at: string
}

function rowToReleaseJob(r: ReleaseJobRow): SelfhealReleaseJob {
  return {
    releaseRequestId: r.release_request_id,
    repairId: r.repair_id,
    incidentId: r.incident_id,
    payloadHash: r.payload_hash,
    status: r.status,
    approvedSha: r.approved_sha,
    baseSha: r.base_sha,
    deployPlanHash: r.deploy_plan_hash,
    manifestHash: r.manifest_hash,
    planJson: r.plan_json,
    origin: r.origin,
    claimedAt: r.claimed_at,
    scopeUnit: r.scope_unit,
    receiptJson: r.receipt_json,
    checkpointJson: r.checkpoint_json,
    canonicalPushedAt: r.canonical_pushed_at,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function isoNow(now?: string): string {
  return now ?? new Date().toISOString()
}

/** Project an ISO timestamp to the outbox's epoch-ms clock (falls back to
 *  wall-clock if the ISO string is unparseable — never NaN into the DB). */
function isoToEpochMs(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? Date.now() : ms
}

export type InsertReleaseJobResult =
  | { outcome: 'inserted'; job: SelfhealReleaseJob }
  | { outcome: 'duplicate'; job: SelfhealReleaseJob } // same rrid + same payload_hash
  | { outcome: 'conflict'; job: SelfhealReleaseJob } // same rrid, DIFFERENT payload_hash

/**
 * Durably record a release request at intake (§3.1 step 4). The receiver has
 * ALREADY re-verified the frozen fields against the LOCAL durable cutover record
 * and passes them here — the store is the single durable authority for the job,
 * not the webhook. Idempotent on release_request_id (PK): a re-delivery with the
 * same payload_hash → duplicate (202); a different payload_hash → conflict (409).
 * The read-check-insert runs in one transaction against concurrent redelivery.
 */
export async function insertReleaseJobReceived(input: {
  releaseRequestId: string
  repairId: string
  incidentId: string
  payloadHash: string
  approvedSha: string
  baseSha?: string | null
  deployPlanHash?: string | null
  manifestHash?: string | null
  planJson: string
  origin?: SelfhealReleaseJobOrigin
  now?: string
}): Promise<InsertReleaseJobResult> {
  const db = await getSelfhealDb()
  const now = isoNow(input.now)
  const txn = db.transaction((): InsertReleaseJobResult => {
    const existing = db
      .prepare('SELECT * FROM selfheal_release_jobs WHERE release_request_id = ?')
      .get(input.releaseRequestId) as ReleaseJobRow | undefined
    if (existing) {
      const job = rowToReleaseJob(existing)
      if (existing.payload_hash === input.payloadHash) return { outcome: 'duplicate', job }
      return { outcome: 'conflict', job }
    }
    db.prepare(`
      INSERT INTO selfheal_release_jobs
        (release_request_id, repair_id, incident_id, payload_hash, status, approved_sha,
         base_sha, deploy_plan_hash, manifest_hash, plan_json, origin, created_at, updated_at)
      VALUES (@rrid, @repairId, @incidentId, @payloadHash, 'received', @approvedSha,
              @baseSha, @deployPlanHash, @manifestHash, @planJson, @origin, @now, @now)
    `).run({
      rrid: input.releaseRequestId,
      repairId: input.repairId,
      incidentId: input.incidentId,
      payloadHash: input.payloadHash,
      approvedSha: input.approvedSha,
      baseSha: input.baseSha ?? null,
      deployPlanHash: input.deployPlanHash ?? null,
      manifestHash: input.manifestHash ?? null,
      planJson: input.planJson,
      origin: input.origin ?? 'v5',
      now,
    })
    const inserted = db
      .prepare('SELECT * FROM selfheal_release_jobs WHERE release_request_id = ?')
      .get(input.releaseRequestId) as ReleaseJobRow
    return { outcome: 'inserted', job: rowToReleaseJob(inserted) }
  })
  return txn()
}

export type ClaimReleaseJobResult =
  | { outcome: 'claimed'; job: SelfhealReleaseJob }
  /** The local Tier2 release fuse is engaged. The fuse check and claim CAS are
   *  one BEGIN IMMEDIATE transaction, so no new claim can cross an engage. */
  | { outcome: 'fuse_engaged' }
  /** Another release is already 'deploying' host-wide (global singleflight) —
   *  the caller must NOT claim; retry when the in-flight deploy settles. */
  | { outcome: 'busy' }
  /** This job is not claimable (already claimed / terminal / cancelled / absent
   *  / not 'received'). The pre-claim CAS lost — nothing was mutated. */
  | { outcome: 'noop' }

/**
 * Atomic pre-claim (§8 step 3): under one BEGIN IMMEDIATE transaction, first
 * require the local release fuse disengaged, then CAS `received & claimed_at IS
 * NULL` → `deploying + claimed_at + scope_unit`, GATED by a GLOBAL singleflight — if ANY
 * OTHER row is already 'deploying', return `busy` and mutate nothing (at most one
 * host-wide deploy in flight, honoring the single production-mutation lease).
 * When `deployingCallback` is supplied, the winning claim ALSO enqueues the
 * 'deploying' progress callback in the SAME transaction (idempotent on
 * (release_request_id, phase)), so the master's `accepted → deploying` progress
 * can never be lost between a durable claim and a separate enqueue commit. Only
 * the claim WINNER enqueues; a `noop`/`busy` never does.
 */
export async function claimReleaseJob(input: {
  releaseRequestId: string
  scopeUnit: string
  deployingCallback?: { repairId: string; message: string; detail: Record<string, unknown> }
  now?: string
}): Promise<ClaimReleaseJobResult> {
  const db = await getSelfhealDb()
  const now = isoNow(input.now)
  const nowMs = isoToEpochMs(now)
  const txn = db.transaction((): ClaimReleaseJobResult => {
    const fuse = db
      .prepare('SELECT engaged FROM selfheal_release_fuse WHERE id = 1')
      .get() as { engaged: number } | undefined
    if (fuse?.engaged !== 0) return { outcome: 'fuse_engaged' }
    const other = db
      .prepare(
        "SELECT release_request_id FROM selfheal_release_jobs WHERE status = 'deploying' AND release_request_id != ? LIMIT 1",
      )
      .get(input.releaseRequestId) as { release_request_id: string } | undefined
    if (other) return { outcome: 'busy' }
    const cas = db
      .prepare(`
        UPDATE selfheal_release_jobs
        SET status = 'deploying', claimed_at = @now, scope_unit = @scopeUnit, updated_at = @now
        WHERE release_request_id = @rrid AND status = 'received' AND claimed_at IS NULL
      `)
      .run({ now, scopeUnit: input.scopeUnit, rrid: input.releaseRequestId })
    if (cas.changes === 0) return { outcome: 'noop' }
    if (input.deployingCallback) {
      db.prepare(`
        INSERT INTO selfheal_callback_outbox
          (repair_id, release_request_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, 'deploying', ?, ?, 'queued', 0, ?, ?, ?)
        ON CONFLICT(release_request_id, phase) WHERE release_request_id IS NOT NULL DO NOTHING
      `).run(
        input.deployingCallback.repairId,
        input.releaseRequestId,
        input.deployingCallback.message,
        JSON.stringify(input.deployingCallback.detail),
        nowMs,
        nowMs,
        nowMs,
      )
    }
    const row = db
      .prepare('SELECT * FROM selfheal_release_jobs WHERE release_request_id = ?')
      .get(input.releaseRequestId) as ReleaseJobRow
    return { outcome: 'claimed', job: rowToReleaseJob(row) }
  })
  // Acquire the SQLite writer reservation before reading the fuse. An engage
  // that committed first is observed; one that starts later waits until the
  // claim CAS commits, giving the two mutations a single serial order.
  return txn.immediate()
}

/** Set-once durable checkpoint (§9 deploy_effect_applied). Returns false if a
 *  checkpoint already exists — the first (post-proof) write is authoritative and
 *  is never overwritten. */
export async function setReleaseJobCheckpoint(
  releaseRequestId: string,
  checkpointJson: string,
  now?: string,
): Promise<boolean> {
  const db = await getSelfhealDb()
  const iso = isoNow(now)
  const res = db
    .prepare(
      'UPDATE selfheal_release_jobs SET checkpoint_json = ?, updated_at = ? WHERE release_request_id = ? AND checkpoint_json IS NULL',
    )
    .run(checkpointJson, iso, releaseRequestId)
  return res.changes > 0
}

/**
 * Set-once terminal receipt (§8.2), then READ BACK and return the LANDED value
 * (single-authority discipline, aligning with setJobTier1Receipt): a caller that
 * LOST the set-once race still learns the AUTHORITATIVE receipt that is durably
 * stored, never its own rejected write. `applied` tells the caller whether THIS
 * call won. Both the CAS and the read-back run in one transaction.
 */
export async function setReleaseJobReceipt(
  releaseRequestId: string,
  receiptJson: string,
  now?: string,
): Promise<{ applied: boolean; receiptJson: string | null }> {
  const db = await getSelfhealDb()
  const iso = isoNow(now)
  const txn = db.transaction((): { applied: boolean; receiptJson: string | null } => {
    const res = db
      .prepare(
        'UPDATE selfheal_release_jobs SET receipt_json = ?, updated_at = ? WHERE release_request_id = ? AND receipt_json IS NULL',
      )
      .run(receiptJson, iso, releaseRequestId)
    const row = db
      .prepare('SELECT receipt_json FROM selfheal_release_jobs WHERE release_request_id = ?')
      .get(releaseRequestId) as { receipt_json: string | null } | undefined
    return { applied: res.changes > 0, receiptJson: row?.receipt_json ?? null }
  })
  return txn()
}

/**
 * ATOMICALLY terminalize a release job AND enqueue its terminal callback in ONE
 * transaction (mirrors terminalizeTier1WithCallback). The CAS gates the enqueue:
 * if the job is no longer in `fromStatuses` (a cancel or a prior terminal won),
 * NOTHING is enqueued and this returns false. The callback phase equals the
 * terminal status (deployed/deploy_failed/deploy_unknown/manual_required); the
 * outbox row is idempotent per (release_request_id, phase). `failureReason` is
 * persisted onto the row (also usable to stamp `canonical_push_pending` on a
 * deployed terminal — §8.2).
 */
export async function terminalizeReleaseJobWithCallback(input: {
  releaseRequestId: string
  repairId: string
  fromStatuses: SelfhealReleaseJobStatus[]
  toStatus: SelfhealReleaseTerminalPhase
  message: string
  detail: Record<string, unknown>
  failureReason?: string | null
  now?: string
}): Promise<boolean> {
  const db = await getSelfhealDb()
  const iso = isoNow(input.now)
  const nowMs = isoToEpochMs(iso)
  const placeholders = input.fromStatuses.map(() => '?').join(',')
  const txn = db.transaction((): boolean => {
    const cas = db
      .prepare(
        `UPDATE selfheal_release_jobs SET status = ?, failure_reason = ?, updated_at = ? WHERE release_request_id = ? AND status IN (${placeholders})`,
      )
      .run(input.toStatus, input.failureReason ?? null, iso, input.releaseRequestId, ...input.fromStatuses)
    if (cas.changes === 0) return false // a cancel (or prior terminal) won — no callback
    db.prepare(`
      INSERT INTO selfheal_callback_outbox
        (repair_id, release_request_id, phase, message, detail_json, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(release_request_id, phase) WHERE release_request_id IS NOT NULL DO NOTHING
    `).run(
      input.repairId,
      input.releaseRequestId,
      input.toStatus,
      input.message,
      JSON.stringify(input.detail),
      nowMs,
      nowMs,
      nowMs,
    )
    return true
  })
  return txn()
}

export type CancelReleaseJobResult = 'cancelled' | 'too_late' | 'idempotent' | 'not_found'

/**
 * Cancel a release job by release_request_id (§3.2). Three defined outcomes plus
 * not_found:
 *   - 'received' & NOT pre-claimed → CAS to 'cancelled' → 'cancelled' (200);
 *   - claimed but not yet terminal ('deploying') → 'too_late' (409 — the receipt
 *     adjudicates the real outcome);
 *   - already terminal → 'idempotent' (200);
 *   - no such row → 'not_found' (caller decides the HTTP mapping).
 * The read-decide-CAS runs in one transaction so a concurrent claim cannot slip
 * between the read and the cancel.
 */
export async function cancelReleaseJob(
  releaseRequestId: string,
  now?: string,
): Promise<CancelReleaseJobResult> {
  const db = await getSelfhealDb()
  const iso = isoNow(now)
  const txn = db.transaction((): CancelReleaseJobResult => {
    const row = db
      .prepare('SELECT status, claimed_at FROM selfheal_release_jobs WHERE release_request_id = ?')
      .get(releaseRequestId) as { status: SelfhealReleaseJobStatus; claimed_at: string | null } | undefined
    if (!row) return 'not_found'
    if (RELEASE_TERMINAL_STATUSES.includes(row.status)) return 'idempotent'
    if (row.status === 'received' && row.claimed_at === null) {
      db.prepare(
        "UPDATE selfheal_release_jobs SET status = 'cancelled', updated_at = ? WHERE release_request_id = ? AND status = 'received' AND claimed_at IS NULL",
      ).run(iso, releaseRequestId)
      return 'cancelled'
    }
    return 'too_late' // 'deploying' (pre-claimed) — receipt adjudicates
  })
  return txn()
}

/** Set-once record that the approved SHA was fast-forward pushed to canonical
 *  (§8 step 5 / §4.2 ⑥). Returns false if already stamped. */
export async function markReleaseJobCanonicalPushed(
  releaseRequestId: string,
  now?: string,
): Promise<boolean> {
  const db = await getSelfhealDb()
  const iso = isoNow(now)
  const res = db
    .prepare(
      'UPDATE selfheal_release_jobs SET canonical_pushed_at = ?, updated_at = ? WHERE release_request_id = ? AND canonical_pushed_at IS NULL',
    )
    .run(iso, iso, releaseRequestId)
  return res.changes > 0
}

/** Update the observability failure_reason on a release job (e.g. stamp
 *  'canonical_push_pending' after a deployed terminal whose canonical push kept
 *  failing — §8.2). Not set-once: it tracks the evolving push state. */
export async function setReleaseJobFailureReason(
  releaseRequestId: string,
  failureReason: string,
  now?: string,
): Promise<boolean> {
  const db = await getSelfhealDb()
  const iso = isoNow(now)
  const res = db
    .prepare(
      'UPDATE selfheal_release_jobs SET failure_reason = ?, updated_at = ? WHERE release_request_id = ?',
    )
    .run(failureReason, iso, releaseRequestId)
  return res.changes > 0
}

export async function getReleaseJob(releaseRequestId: string): Promise<SelfhealReleaseJob | null> {
  const db = await getSelfhealDb()
  const row = db
    .prepare('SELECT * FROM selfheal_release_jobs WHERE release_request_id = ?')
    .get(releaseRequestId) as ReleaseJobRow | undefined
  return row ? rowToReleaseJob(row) : null
}

/** List release jobs in any of the given states (worker sweep / ops). */
export async function listReleaseJobsByStatus(
  statuses: SelfhealReleaseJobStatus[],
): Promise<SelfhealReleaseJob[]> {
  if (statuses.length === 0) return []
  const db = await getSelfhealDb()
  const placeholders = statuses.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT * FROM selfheal_release_jobs WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
    )
    .all(...statuses) as ReleaseJobRow[]
  return rows.map(rowToReleaseJob)
}

// ── Release fuse (batch1b §5.2: local Tier2 deploy circuit breaker) ───────────

export interface SelfhealReleaseFuse {
  engaged: boolean
  reason: string | null
  releaseRequestId: string | null
  engagedAt: string | null
  clearedAt: string | null
  clearedBy: string | null
}

interface ReleaseFuseRow {
  engaged: number
  reason: string | null
  release_request_id: string | null
  engaged_at: string | null
  cleared_at: string | null
  cleared_by: string | null
}

/** Read the single fuse row (id=1). Seeded on DB open, so it always exists. */
export async function getReleaseFuse(): Promise<SelfhealReleaseFuse> {
  const db = await getSelfhealDb()
  const r = db
    .prepare(
      'SELECT engaged, reason, release_request_id, engaged_at, cleared_at, cleared_by FROM selfheal_release_fuse WHERE id = 1',
    )
    .get() as ReleaseFuseRow | undefined
  return {
    engaged: (r?.engaged ?? 0) === 1,
    reason: r?.reason ?? null,
    releaseRequestId: r?.release_request_id ?? null,
    engagedAt: r?.engaged_at ?? null,
    clearedAt: r?.cleared_at ?? null,
    clearedBy: r?.cleared_by ?? null,
  }
}

/** Engage one immutable local Tier2 fuse epoch.
 *
 * The tombstone lookup, singleton read, and singleton write share one
 * BEGIN IMMEDIATE transaction. An already-cleared releaseRequestId can
 * therefore never be resurrected by a delayed worker after a newer epoch has
 * engaged. Returns true only for the call that installed the current epoch; an
 * already-engaged fuse remains a no-op and keeps the ORIGINAL cause. */
export async function engageReleaseFuse(input: {
  reason: string
  releaseRequestId: string
  now?: string
}): Promise<boolean> {
  const db = await getSelfhealDb()
  if (typeof input.releaseRequestId !== 'string' || input.releaseRequestId.length === 0) {
    throw new Error('releaseRequestId is required to engage the release fuse')
  }
  const iso = isoNow(input.now)
  return db
    .transaction(() => {
      const cleared = db
        .prepare(
          'SELECT 1 FROM selfheal_release_fuse_cleared_epochs WHERE release_request_id = ?',
        )
        .get(input.releaseRequestId)
      if (cleared) return false

      const current = db
        .prepare('SELECT engaged, release_request_id FROM selfheal_release_fuse WHERE id = 1')
        .get() as { engaged: number; release_request_id: string | null }
      if (current.engaged === 1) return false

      db.prepare(`
        UPDATE selfheal_release_fuse
        SET engaged = 1, reason = ?, release_request_id = ?, engaged_at = ?, cleared_at = NULL, cleared_by = NULL
        WHERE id = 1
      `).run(input.reason, input.releaseRequestId, iso)
      return true
    })
    .immediate()
}

export type ClearReleaseFuseResult =
  | { outcome: 'cleared'; releaseRequestId: string }
  | { outcome: 'already_cleared'; releaseRequestId: string }
  | {
      outcome: 'epoch_mismatch'
      releaseRequestId: string
      currentReleaseRequestId: string | null
    }

/** Clear one exact, V5-adjudicated local Tier2 fuse epoch.
 *
 * Every authenticated exact clear appends an immutable releaseRequestId
 * tombstone, even if this personal host never projected that epoch (for
 * example B arrived while local A was already engaged). A different active
 * singleton is preserved. This lets V5 converge its durable per-epoch queue
 * without allowing a delayed B callback to engage after B was adjudicated. */
export async function clearReleaseFuse(input: {
  clearedBy: string
  expectedReleaseRequestId: string
  now?: string
}): Promise<ClearReleaseFuseResult> {
  const db = await getSelfhealDb()
  if (
    typeof input.expectedReleaseRequestId !== 'string' ||
    input.expectedReleaseRequestId.length === 0
  ) {
    throw new Error('expectedReleaseRequestId is required to clear the release fuse')
  }
  const iso = isoNow(input.now)
  return db
    .transaction((): ClearReleaseFuseResult => {
      const prior = db
        .prepare(
          'SELECT 1 FROM selfheal_release_fuse_cleared_epochs WHERE release_request_id = ?',
        )
        .get(input.expectedReleaseRequestId)
      if (prior) {
        return {
          outcome: 'already_cleared',
          releaseRequestId: input.expectedReleaseRequestId,
        }
      }

      const current = db
        .prepare('SELECT engaged, release_request_id FROM selfheal_release_fuse WHERE id = 1')
        .get() as { engaged: number; release_request_id: string | null }
      db.prepare(`
        INSERT INTO selfheal_release_fuse_cleared_epochs
          (release_request_id, cleared_at, cleared_by)
        VALUES (?, ?, ?)
      `).run(input.expectedReleaseRequestId, iso, input.clearedBy)
      if (
        current.engaged === 1 &&
        current.release_request_id === input.expectedReleaseRequestId
      ) {
        db.prepare(`
          UPDATE selfheal_release_fuse
          SET engaged = 0, cleared_at = ?, cleared_by = ?
          WHERE id = 1
        `).run(iso, input.clearedBy)
      }
      return { outcome: 'cleared', releaseRequestId: input.expectedReleaseRequestId }
    })
    .immediate()
}
