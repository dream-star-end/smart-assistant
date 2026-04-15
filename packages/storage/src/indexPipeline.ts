/**
 * Index Pipeline (P1.7)
 *
 * Background pipeline that builds and maintains vector embeddings for
 * archival memory and session turns. Responsible for:
 *
 * - Incremental indexing: embed new/updated entries as they arrive
 * - Batch reindexing: rebuild all vectors (e.g. after model change)
 * - Deduplication: detect near-duplicate archival entries
 * - Delete cascade: remove vectors when source entries are deleted
 * - Version tracking: detect embedding model changes requiring reindex
 *
 * The pipeline is designed to run as a background job within the gateway,
 * triggered by eventBus events or cron schedules.
 */

import { randomUUID } from 'node:crypto'
import * as sqliteVec from 'sqlite-vec'
import { getSessionsDb } from './sessionsDb.js'
import type { EmbeddingProvider } from './embedding.js'
import {
  initVectorStore,
  upsertArchivalVector,
  deleteArchivalVector,
  upsertSessionVector,
  encodeSessionVecId,
} from './vectorStore.js'

// ── Constants ───────────────────────────────────

/**
 * Max IDs per SQL IN clause to stay below SQLite's MAX_VARIABLE_NUMBER.
 * Conservative bound that works across all SQLite builds.
 */
const MAX_CHUNK_SIZE = 500

/** Max time (ms) a claimed job can be in-flight before considered abandoned. */
const CLAIM_LEASE_MS = 5 * 60_000 // 5 minutes

// ── Schema ──────────────────────────────────────

type IndexSource = 'archival' | 'session'
type IndexAction = 'embed' | 'delete'

let _metaSchemaDone = false

async function ensureIndexMetaSchema(): Promise<void> {
  if (_metaSchemaDone) return
  const db = await getSessionsDb()

  db.exec(`
    CREATE TABLE IF NOT EXISTS archival (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_archival_agent ON archival(agent_id);

    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS index_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('archival','session')),
      source_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('embed','delete')),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT DEFAULT NULL,
      claim_token TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source, source_id, action)
    );
  `)

  // Migration: add columns for existing index_queue tables (upgrade path)
  const cols = db.pragma('table_info(index_queue)') as Array<{ name: string }>
  const colNames = new Set(cols.map(c => c.name))
  if (!colNames.has('claimed_at')) {
    db.exec('ALTER TABLE index_queue ADD COLUMN claimed_at TEXT DEFAULT NULL')
  }
  if (!colNames.has('claim_token')) {
    db.exec('ALTER TABLE index_queue ADD COLUMN claim_token TEXT DEFAULT NULL')
  }

  _metaSchemaDone = true
}

/** Reset schema state (for testing). */
export function resetIndexPipelineState(): void {
  _metaSchemaDone = false
}

// ── Metadata ────────────────────────────────────

async function getMeta(key: string): Promise<string | null> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()
  const row = db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

async function setMeta(key: string, value: string): Promise<void> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()
  db.prepare(
    'INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

// ── Timestamp helper ────────────────────────────

function sqliteDatetime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

// ── Type guards ─────────────────────────────────

function isValidSource(s: string): s is IndexSource {
  return s === 'archival' || s === 'session'
}

function isValidAction(a: string): a is IndexAction {
  return a === 'embed' || a === 'delete'
}

// ── Queue types ─────────────────────────────────

export interface QueueEntry {
  id: number
  source: IndexSource
  sourceId: string
  action: IndexAction
  attempts: number
  createdAt: string
}

interface ClaimResult {
  entries: QueueEntry[]
  claimToken: string
}

// ── Queue operations ────────────────────────────

/**
 * Enqueue an indexing job. Idempotent — duplicate (source, sourceId, action) is ignored.
 */
export async function enqueueIndex(
  source: IndexSource,
  sourceId: string,
  action: IndexAction,
): Promise<void> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()
  db.prepare(
    'INSERT OR IGNORE INTO index_queue (source, source_id, action) VALUES (?, ?, ?)',
  ).run(source, sourceId, action)
}

/**
 * Claim up to `limit` pending jobs atomically.
 *
 * Uses BEGIN IMMEDIATE to prevent concurrent readers from claiming the
 * same rows. Sets `claimed_at` + `claim_token` to mark ownership.
 * Only claims jobs where `claimed_at IS NULL`.
 *
 * Returns entries + a unique claim token that must be passed to
 * ackJobs/releaseJobs to prove ownership.
 */
async function claimBatch(limit: number): Promise<ClaimResult> {
  const safeBatch = Math.min(Math.max(1, limit), MAX_CHUNK_SIZE)
  const db = await getSessionsDb()
  const now = sqliteDatetime(new Date())
  const token = randomUUID()

  const entries = db.transaction(() => {
    const rows = db.prepare(
      'SELECT id, source, source_id, action, attempts, created_at FROM index_queue WHERE claimed_at IS NULL ORDER BY id LIMIT ?',
    ).all(safeBatch) as Array<{
      id: number; source: string; source_id: string; action: string; attempts: number; created_at: string
    }>

    if (rows.length === 0) return []

    const ids = rows.map(r => r.id)
    runChunkedSql(
      db,
      'UPDATE index_queue SET claimed_at = ?, claim_token = ? WHERE id IN',
      ids,
      [now, token],
    )

    return rows.reduce<QueueEntry[]>((acc, r) => {
      if (isValidSource(r.source) && isValidAction(r.action)) {
        acc.push({
          id: r.id,
          source: r.source,
          sourceId: r.source_id,
          action: r.action,
          attempts: r.attempts,
          createdAt: r.created_at,
        })
      }
      return acc
    }, [])
  }).immediate()

  return { entries, claimToken: token }
}

/**
 * Acknowledge (remove) successfully processed jobs.
 * Only removes jobs owned by the given claim token.
 */
async function ackJobs(ids: number[], claimToken: string): Promise<void> {
  if (ids.length === 0) return
  const db = await getSessionsDb()
  for (let i = 0; i < ids.length; i += MAX_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + MAX_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    db.prepare(
      `DELETE FROM index_queue WHERE claim_token = ? AND id IN (${placeholders})`,
    ).run(claimToken, ...chunk)
  }
}

/**
 * Release failed jobs back to the queue.
 * Increments attempts, clears claim ownership.
 * Only affects jobs owned by the given claim token.
 */
async function releaseJobs(ids: number[], claimToken: string): Promise<void> {
  if (ids.length === 0) return
  const db = await getSessionsDb()
  for (let i = 0; i < ids.length; i += MAX_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + MAX_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    db.prepare(
      `UPDATE index_queue SET claimed_at = NULL, claim_token = NULL, attempts = attempts + 1 WHERE claim_token = ? AND id IN (${placeholders})`,
    ).run(claimToken, ...chunk)
  }
}

/**
 * Remove dead-letter jobs that exceeded max attempts AND are not in-flight.
 * @returns Number of jobs removed.
 */
export async function purgeDeadLetters(maxAttempts = 5): Promise<number> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()
  const result = db.prepare(
    'DELETE FROM index_queue WHERE attempts >= ? AND claimed_at IS NULL',
  ).run(maxAttempts)
  return result.changes
}

/**
 * Reclaim jobs whose claim lease has expired (process died mid-processing).
 * Increments attempts (counts as a failed attempt) and clears ownership.
 * @returns Number of jobs reclaimed.
 */
export async function reclaimExpiredLeases(leaseMs = CLAIM_LEASE_MS): Promise<number> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()
  const cutoff = sqliteDatetime(new Date(Date.now() - leaseMs))
  const result = db.prepare(
    'UPDATE index_queue SET claimed_at = NULL, claim_token = NULL, attempts = attempts + 1 WHERE claimed_at IS NOT NULL AND claimed_at < ?',
  ).run(cutoff)
  return result.changes
}

/** Get the number of pending jobs in the queue. */
export async function getQueueSize(): Promise<number> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()
  const row = db.prepare('SELECT COUNT(*) as cnt FROM index_queue').get() as { cnt: number }
  return row.cnt
}

// ── Chunked SQL helper ──────────────────────────

/**
 * Run a parameterized SQL statement with an IN clause in chunks,
 * staying within SQLite's parameter limit.
 * `prefix` must end with "WHERE ... IN" (the parenthesized list is appended).
 * `extraParams` are prepended before the chunk IDs.
 */
function runChunkedSql(
  db: import('better-sqlite3').Database,
  prefix: string,
  ids: number[],
  extraParams: unknown[],
): void {
  for (let i = 0; i < ids.length; i += MAX_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + MAX_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    db.prepare(`${prefix} (${placeholders})`).run(...extraParams, ...chunk)
  }
}

// ── Session vector delete ───────────────────────

async function deleteSessionVector(id: string): Promise<void> {
  const db = await getSessionsDb()
  db.prepare('DELETE FROM sessions_vec WHERE id = ?').run(id)
}

// ── Pipeline processing ─────────────────────────

export interface PipelineStats {
  processed: number
  embedded: number
  deleted: number
  errors: number
}

/**
 * Process a batch of pending index jobs.
 *
 * Jobs are claimed with an owner token. Only the owner can ack/release them.
 * On success, jobs are acked (removed). On failure, jobs are released
 * (attempts incremented, claim cleared for retry).
 *
 * A try/finally ensures all claimed jobs are released on unexpected errors.
 */
export async function processIndexQueue(
  provider: EmbeddingProvider,
  batchSize = 50,
): Promise<PipelineStats> {
  await ensureIndexMetaSchema()
  await initVectorStore(provider.dimensions)
  const { entries: batch, claimToken } = await claimBatch(batchSize)

  const stats: PipelineStats = { processed: 0, embedded: 0, deleted: 0, errors: 0 }
  if (batch.length === 0) return stats

  const allClaimedIds = new Set(batch.map(e => e.id))
  const succeededIds: number[] = []
  const failedIds: number[] = []

  try {
    const db = await getSessionsDb()

    // Group embed jobs by source for batch embedding
    const archivalEmbeds: Array<{ queueId: number; id: string; content: string }> = []
    const sessionEmbeds: Array<{ queueId: number; id: string; content: string }> = []
    const deletes: QueueEntry[] = []

    for (const entry of batch) {
      if (entry.action === 'delete') {
        deletes.push(entry)
        continue
      }

      if (entry.source === 'archival') {
        const row = db.prepare('SELECT id, content FROM archival WHERE id = ?')
          .get(entry.sourceId) as { id: string; content: string } | undefined
        if (row) {
          archivalEmbeds.push({ queueId: entry.id, ...row })
        } else {
          succeededIds.push(entry.id)
        }
      } else if (entry.source === 'session') {
        const parts = entry.sourceId.split('|')
        if (parts.length >= 3) {
          const sessionId = parts.slice(0, -2).join('|')
          const turnIdx = parseInt(parts[parts.length - 2], 10)
          const role = parts[parts.length - 1]
          const rows = db.prepare(
            'SELECT content FROM sessions_fts WHERE session_id = ? AND turn_idx = ? AND role = ?',
          ).all(sessionId, turnIdx, role) as Array<{ content: string }>
          if (rows.length > 0) {
            sessionEmbeds.push({ queueId: entry.id, id: entry.sourceId, content: rows[0].content })
          } else {
            succeededIds.push(entry.id)
          }
        } else {
          succeededIds.push(entry.id)
        }
      }
    }

    // Embed archival entries (per-item error handling)
    if (archivalEmbeds.length > 0) {
      try {
        const texts = archivalEmbeds.map(e => e.content)
        const vectors = await provider.embed(texts, 'document')
        for (let i = 0; i < archivalEmbeds.length; i++) {
          try {
            await upsertArchivalVector(archivalEmbeds[i].id, vectors[i])
            succeededIds.push(archivalEmbeds[i].queueId)
            stats.embedded++
          } catch {
            failedIds.push(archivalEmbeds[i].queueId)
            stats.errors++
          }
        }
      } catch {
        for (const e of archivalEmbeds) failedIds.push(e.queueId)
        stats.errors += archivalEmbeds.length
      }
    }

    // Embed session turns
    if (sessionEmbeds.length > 0) {
      try {
        const texts = sessionEmbeds.map(e => e.content)
        const vectors = await provider.embed(texts, 'document')
        for (let i = 0; i < sessionEmbeds.length; i++) {
          try {
            await upsertSessionVector(sessionEmbeds[i].id, vectors[i])
            succeededIds.push(sessionEmbeds[i].queueId)
            stats.embedded++
          } catch {
            failedIds.push(sessionEmbeds[i].queueId)
            stats.errors++
          }
        }
      } catch {
        for (const e of sessionEmbeds) failedIds.push(e.queueId)
        stats.errors += sessionEmbeds.length
      }
    }

    // Process deletes
    for (const entry of deletes) {
      try {
        if (entry.source === 'archival') {
          await deleteArchivalVector(entry.sourceId)
        } else if (entry.source === 'session') {
          await deleteSessionVector(entry.sourceId)
        }
        succeededIds.push(entry.id)
        stats.deleted++
      } catch {
        failedIds.push(entry.id)
        stats.errors++
      }
    }
  } finally {
    // Release any job not explicitly categorized (unexpected exception path)
    const handledIds = new Set([...succeededIds, ...failedIds])
    const unhandledIds = [...allClaimedIds].filter(id => !handledIds.has(id))

    await ackJobs(succeededIds, claimToken)
    await releaseJobs([...failedIds, ...unhandledIds], claimToken)
  }

  stats.processed = batch.length
  return stats
}

// ── Full reindex ────────────────────────────────

export interface ReindexOptions {
  /** Agent ID to reindex (all agents if omitted) */
  agentId?: string
  /** Only reindex archival, only sessions, or both (default: both) */
  scope?: 'archival' | 'session' | 'both'
}

/**
 * Full reindex: enqueue all existing entries for re-embedding.
 * Uses cursor iteration (.iterate()) to avoid loading all rows into memory.
 *
 * @returns Actual number of jobs enqueued.
 */
export async function enqueueFullReindex(options: ReindexOptions = {}): Promise<{
  archivalQueued: number
  sessionQueued: number
}> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()
  const agentFilter = options.agentId ? ' WHERE agent_id = ?' : ''
  const agentParams = options.agentId ? [options.agentId] : []
  const scope = options.scope ?? 'both'

  let archivalQueued = 0
  let sessionQueued = 0

  if (scope === 'archival' || scope === 'both') {
    const iter = db.prepare(
      `SELECT id FROM archival${agentFilter}`,
    ).iterate(...agentParams) as IterableIterator<{ id: string }>

    const insertStmt = db.prepare(
      "INSERT OR IGNORE INTO index_queue (source, source_id, action) VALUES ('archival', ?, 'embed')",
    )
    db.transaction(() => {
      for (const row of iter) {
        const result = insertStmt.run(row.id)
        if (result.changes > 0) archivalQueued++
      }
    })()
  }

  if (scope === 'session' || scope === 'both') {
    const sessionFilter = options.agentId
      ? ' JOIN sessions_meta m ON m.id = f.session_id WHERE m.agent_id = ?'
      : ''
    const iter = db.prepare(
      `SELECT DISTINCT f.session_id, f.turn_idx, f.role FROM sessions_fts f${sessionFilter}`,
    ).iterate(...agentParams) as IterableIterator<{ session_id: string; turn_idx: number; role: string }>

    const insertStmt = db.prepare(
      "INSERT OR IGNORE INTO index_queue (source, source_id, action) VALUES ('session', ?, 'embed')",
    )
    db.transaction(() => {
      for (const row of iter) {
        const vecId = encodeSessionVecId(row.session_id, row.turn_idx, row.role)
        const result = insertStmt.run(vecId)
        if (result.changes > 0) sessionQueued++
      }
    })()
  }

  return { archivalQueued, sessionQueued }
}

/**
 * Check if a reindex is needed due to model/dimensions change.
 */
export async function isReindexNeeded(provider: EmbeddingProvider): Promise<boolean> {
  const storedModel = await getMeta('embedding_model')
  const storedDims = await getMeta('embedding_dimensions')

  if (!storedModel || !storedDims) return true
  return storedModel !== provider.modelId || storedDims !== String(provider.dimensions)
}

/**
 * Record the current embedding model in metadata.
 * Call after a successful full reindex.
 */
export async function recordEmbeddingModel(provider: EmbeddingProvider): Promise<void> {
  await setMeta('embedding_model', provider.modelId)
  await setMeta('embedding_dimensions', String(provider.dimensions))
}

// ── Deduplication ───────────────────────────────

export interface DuplicateGroup {
  /** IDs of entries in this duplicate group */
  ids: string[]
  /** Representative content snippet */
  snippet: string
}

/**
 * Find near-duplicate archival entries using exact content match.
 *
 * @param agentId  Agent ID to scope the search
 * @returns Groups of entries with identical content
 */
export async function findExactDuplicates(agentId: string): Promise<DuplicateGroup[]> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()

  const rows = db.prepare(`
    SELECT content, COUNT(*) as cnt, SUBSTR(content, 1, 100) as snippet
    FROM archival
    WHERE agent_id = ?
    GROUP BY content
    HAVING cnt > 1
  `).all(agentId) as Array<{ content: string; cnt: number; snippet: string }>

  const result: DuplicateGroup[] = []
  const idStmt = db.prepare(
    'SELECT id FROM archival WHERE agent_id = ? AND content = ? ORDER BY created_at ASC, id ASC',
  )

  for (const row of rows) {
    const ids = (idStmt.all(agentId, row.content) as Array<{ id: string }>).map(r => r.id)
    result.push({ ids, snippet: row.snippet })
  }

  return result
}

/**
 * Deduplicate: keep the oldest entry in each duplicate group, delete the rest.
 *
 * Detection and deletion happen in a single IMMEDIATE transaction to
 * prevent TOCTOU races. Both archival rows and associated vectors are
 * deleted atomically.
 *
 * "Oldest" is determined by (created_at ASC, id ASC) — the entry with
 * the earliest created_at (or earliest id on tie) is kept.
 *
 * Returns IDs of deleted entries.
 */
export async function deduplicateArchival(agentId: string): Promise<string[]> {
  await ensureIndexMetaSchema()
  const db = await getSessionsDb()

  // To operate on vec0 virtual tables, the sqlite-vec extension must be loaded
  // on the current connection. Loading is idempotent — safe to call repeatedly.
  let deleteVecStmt: import('better-sqlite3').Statement | null = null
  try {
    sqliteVec.load(db)
    const vecTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='archival_vec'",
    ).get() !== undefined
    if (vecTableExists) {
      deleteVecStmt = db.prepare('DELETE FROM archival_vec WHERE id = ?')
    }
  } catch {
    // sqlite-vec extension not available — skip vector cleanup
  }

  // Atomic detection + deletion in IMMEDIATE transaction
  return db.transaction(() => {
    // Find all duplicate entries that are NOT the keeper.
    // The keeper is the entry with the earliest (created_at, id).
    // An entry is a duplicate if there exists another entry with the same
    // content that is strictly older (or has a smaller id on tie).
    const dupes = db.prepare(`
      SELECT a.id FROM archival a
      WHERE a.agent_id = ?
        AND EXISTS (
          SELECT 1 FROM archival b
          WHERE b.agent_id = a.agent_id
            AND b.content = a.content
            AND (b.created_at < a.created_at
                 OR (b.created_at = a.created_at AND b.id < a.id))
        )
    `).all(agentId) as Array<{ id: string }>

    if (dupes.length === 0) return []

    const deleteStmt = db.prepare('DELETE FROM archival WHERE id = ?')
    const ids: string[] = []

    for (const row of dupes) {
      deleteStmt.run(row.id)
      deleteVecStmt?.run(row.id)
      ids.push(row.id)
    }

    return ids
  }).immediate()
}
