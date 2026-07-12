// SelfhealStore — durable SQLite state for the personal-version self-heal
// receiver + executor (self-heal slice ② / block B2a).
//
// A dedicated database file (`selfheal.db`) keeps this subsystem physically
// isolated from `sessions.db`: the self-heal control plane must survive/replay
// independently of ordinary chat persistence, and a corrupt/locked chat DB must
// never wedge repair intake (nor vice versa).
//
// Four tables, each with a single, explicit durability role:
//
//   selfheal_jobs        — one row per dispatched repair (repair_id PK). The
//                          receiver INSERTs `received`; the jobWorker leases it
//                          (received→starting→running→succeeded/failed) with a
//                          crash-recoverable lease (lease_owner + lease_until).
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

export async function getSelfhealDb(): Promise<Database.Database> {
  if (_db) return _db
  await mkdir(dirname(SELFHEAL_DB), { recursive: true })
  const db = new Database(SELFHEAL_DB)
  db.pragma('journal_mode = WAL')
  // BUSY handling: repair intake + executor share this DB; a short busy_timeout
  // lets the rare writer overlap resolve instead of throwing SQLITE_BUSY.
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS selfheal_jobs (
      repair_id    TEXT PRIMARY KEY,
      incident_id  TEXT NOT NULL,
      attempt      INTEGER NOT NULL DEFAULT 0,
      payload_hash TEXT NOT NULL,
      capability   TEXT,
      status       TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','starting','running','succeeded','failed','cancelled')),
      lease_owner  TEXT,
      lease_until  INTEGER NOT NULL DEFAULT 0,
      session_key  TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
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
  `)

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
  | 'succeeded'
  | 'failed'
  | 'cancelled'

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
    .prepare('INSERT INTO selfheal_nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING')
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
 * Startup crash recovery: expire the lease on every non-terminal job so the
 * next {@link claimNextJob} can immediately take it over, instead of waiting out
 * a full lease window. Safe on the single-instance personal version — at gateway
 * boot there is no other live worker, so any 'starting'/'running' row is an
 * orphan from a hard-crashed prior process. Idempotent; returns rows touched.
 */
export async function reclaimOrphanedLeases(now = Date.now()): Promise<number> {
  const db = await getSelfhealDb()
  const res = db
    .prepare(
      "UPDATE selfheal_jobs SET lease_until = 0, updated_at = ? WHERE status IN ('starting','running')",
    )
    .run(now)
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
 */
export async function claimQueuedTurn(executionId: string, now = Date.now()): Promise<boolean> {
  const db = await getSelfhealDb()
  const txn = db.transaction((): boolean => {
    const res = db
      .prepare(
        "UPDATE durable_turn_queue SET status = 'consumed' WHERE execution_id = ? AND status = 'queued'",
      )
      .run(executionId)
    if (res.changes === 0) return false
    db.prepare(
      "UPDATE selfheal_executions SET status = 'running', updated_at = ? WHERE execution_id = ? AND status = 'accepted'",
    ).run(now, executionId)
    return true
  })
  return txn()
}

export async function setExecutionStatus(
  executionId: string,
  status: SelfhealExecutionStatus,
): Promise<void> {
  const db = await getSelfhealDb()
  db.prepare('UPDATE selfheal_executions SET status = ?, updated_at = ? WHERE execution_id = ?').run(
    status,
    Date.now(),
    executionId,
  )
}

export async function getExecution(executionId: string): Promise<SelfhealExecution | null> {
  const db = await getSelfhealDb()
  const row = db.prepare('SELECT * FROM selfheal_executions WHERE execution_id = ?').get(executionId) as
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
