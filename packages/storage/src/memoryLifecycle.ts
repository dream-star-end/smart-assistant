/**
 * Memory Lifecycle Management (P1.5)
 *
 * Tracks access frequency for archival memory entries and provides
 * consolidation, decay, and cleanup operations to prevent unbounded growth.
 *
 * Schema extension on archival table:
 *   access_count   INTEGER DEFAULT 0
 *   last_accessed   TEXT (datetime, same format as created_at)
 *
 * Lifecycle operations:
 *   - recordAccess: increment access_count + update last_accessed on search hits
 *   - decay: reduce access_count for entries not accessed within a window
 *   - cleanup: delete entries below a threshold after decay
 *   - stats: per-agent lifecycle metrics
 */

import { getSessionsDb } from './sessionsDb.js'

let _migrated = false

/**
 * Ensure the archival table has lifecycle columns.
 * Creates the archival table if it doesn't exist yet (same DDL as archivalStore).
 * Only marks as migrated after both columns are confirmed present.
 */
async function ensureLifecycleSchema(): Promise<void> {
  if (_migrated) return
  const db = await getSessionsDb()

  // Ensure archival table exists (same DDL as archivalStore.ensureSchema)
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
  `)

  const cols = db.pragma('table_info(archival)') as Array<{ name: string }>
  if (!cols.some(c => c.name === 'access_count')) {
    db.exec('ALTER TABLE archival ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.some(c => c.name === 'last_accessed')) {
    db.exec("ALTER TABLE archival ADD COLUMN last_accessed TEXT DEFAULT ''")
  }

  // Verify both columns now exist before marking as migrated
  const updatedCols = db.pragma('table_info(archival)') as Array<{ name: string }>
  if (updatedCols.some(c => c.name === 'access_count') &&
      updatedCols.some(c => c.name === 'last_accessed')) {
    _migrated = true
  }
}

/** Reset migration state (for testing). */
export function resetLifecycleState(): void {
  _migrated = false
}

// ── Timestamp helpers ────────────────────────────

/**
 * Format a Date as SQLite datetime string (same format as datetime('now')).
 * archival.created_at uses "YYYY-MM-DD HH:MM:SS" format via datetime('now'),
 * so we use the same format for last_accessed and cutoff comparisons.
 */
function sqliteDatetime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

// ── Access Tracking ──────────────────────────────

/**
 * Record an access (search hit) for one or more archival entry IDs.
 * Increments access_count and sets last_accessed to now.
 * Duplicate IDs in the input are deduplicated.
 */
export async function recordAccess(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await ensureLifecycleSchema()
  const db = await getSessionsDb()
  const now = sqliteDatetime(new Date())

  // Deduplicate to avoid inflating access_count
  const uniqueIds = [...new Set(ids)]

  const stmt = db.prepare(
    'UPDATE archival SET access_count = access_count + 1, last_accessed = ? WHERE id = ?',
  )
  const tx = db.transaction(() => {
    for (const id of uniqueIds) {
      stmt.run(now, id)
    }
  })
  tx()
}

// ── Decay ────────────────────────────────────────

export interface DecayOptions {
  /** Agent ID to scope the operation */
  agentId: string
  /** Entries not accessed within this many days get decayed (default: 30) */
  inactiveDays?: number
  /** Amount to reduce access_count by (default: 1) */
  decayAmount?: number
}

/**
 * Decay access_count for entries not accessed within the inactivity window.
 * access_count is floored at 0.
 *
 * @returns Number of entries affected
 */
export async function decayAccess(options: DecayOptions): Promise<number> {
  await ensureLifecycleSchema()
  const db = await getSessionsDb()
  const inactiveDays = options.inactiveDays ?? 30
  const decayAmount = options.decayAmount ?? 1

  if (inactiveDays <= 0 || decayAmount <= 0) return 0

  const cutoff = sqliteDatetime(new Date(Date.now() - inactiveDays * 86_400_000))

  const result = db.prepare(`
    UPDATE archival
    SET access_count = MAX(0, access_count - ?)
    WHERE agent_id = ?
      AND access_count > 0
      AND (last_accessed < ? OR last_accessed = '')
  `).run(decayAmount, options.agentId, cutoff)

  return result.changes
}

// ── Cleanup ──────────────────────────────────────

export interface CleanupOptions {
  /** Agent ID to scope the operation */
  agentId: string
  /** Delete entries with access_count at or below this threshold (default: 0) */
  minAccessCount?: number
  /** Only delete entries older than this many days (default: 60) */
  minAgeDays?: number
  /** Max entries to delete per run (default: 50) */
  maxDeletes?: number
}

export interface CleanupResult {
  /** Number of entries deleted */
  deletedCount: number
  /** IDs of deleted entries (for vector index cleanup) */
  deletedIds: string[]
}

/**
 * Delete low-value archival entries that have decayed below the threshold
 * and are older than the minimum age.
 *
 * Selection + deletion are atomic within a transaction to avoid
 * race conditions with concurrent access.
 *
 * Returns the IDs of deleted entries so callers can clean up associated
 * vector embeddings.
 */
export async function cleanupArchival(options: CleanupOptions): Promise<CleanupResult> {
  await ensureLifecycleSchema()
  const db = await getSessionsDb()
  const minAccess = options.minAccessCount ?? 0
  const minAgeDays = options.minAgeDays ?? 60
  const maxDeletes = options.maxDeletes ?? 50

  if (maxDeletes <= 0) return { deletedCount: 0, deletedIds: [] }

  const cutoff = sqliteDatetime(new Date(Date.now() - minAgeDays * 86_400_000))

  // Atomic select + delete in a single transaction
  const selectStmt = db.prepare(`
    SELECT id FROM archival
    WHERE agent_id = ?
      AND access_count <= ?
      AND created_at < ?
    ORDER BY access_count ASC, created_at ASC
    LIMIT ?
  `)

  const result = db.transaction(() => {
    const candidates = selectStmt.all(
      options.agentId, minAccess, cutoff, maxDeletes,
    ) as Array<{ id: string }>

    if (candidates.length === 0) return { deletedCount: 0, deletedIds: [] as string[] }

    const ids = candidates.map(c => c.id)
    const placeholders = ids.map(() => '?').join(',')

    // Re-check predicates in DELETE for safety against concurrent access
    db.prepare(
      `DELETE FROM archival WHERE id IN (${placeholders}) AND access_count <= ? AND created_at < ?`,
    ).run(...ids, minAccess, cutoff)

    // Query which IDs were actually deleted (no longer in the table)
    const surviving = new Set(
      (db.prepare(
        `SELECT id FROM archival WHERE id IN (${placeholders})`,
      ).all(...ids) as Array<{ id: string }>).map(r => r.id),
    )
    const actuallyDeleted = ids.filter(id => !surviving.has(id))

    return { deletedCount: actuallyDeleted.length, deletedIds: actuallyDeleted }
  })()

  return result
}

// ── Stats ────────────────────────────────────────

export interface LifecycleStats {
  /** Total archival entries for this agent */
  totalEntries: number
  /** Entries never accessed (access_count = 0) */
  neverAccessed: number
  /** Entries accessed in the last 30 days */
  recentlyAccessed: number
  /** Average access_count */
  avgAccessCount: number
  /** Entries eligible for cleanup (access_count=0, older than 60 days) */
  cleanupCandidates: number
}

/**
 * Get lifecycle statistics for an agent's archival memory.
 */
export async function getLifecycleStats(agentId: string): Promise<LifecycleStats> {
  await ensureLifecycleSchema()
  const db = await getSessionsDb()

  const thirtyDaysAgo = sqliteDatetime(new Date(Date.now() - 30 * 86_400_000))
  const sixtyDaysAgo = sqliteDatetime(new Date(Date.now() - 60 * 86_400_000))

  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END), 0) as never_accessed,
      COALESCE(SUM(CASE WHEN last_accessed >= ? THEN 1 ELSE 0 END), 0) as recently_accessed,
      COALESCE(AVG(access_count), 0) as avg_access,
      COALESCE(SUM(CASE WHEN access_count = 0 AND created_at < ? THEN 1 ELSE 0 END), 0) as cleanup_candidates
    FROM archival
    WHERE agent_id = ?
  `).get(thirtyDaysAgo, sixtyDaysAgo, agentId) as {
    total: number
    never_accessed: number
    recently_accessed: number
    avg_access: number
    cleanup_candidates: number
  }

  return {
    totalEntries: row.total,
    neverAccessed: row.never_accessed,
    recentlyAccessed: row.recently_accessed,
    avgAccessCount: row.avg_access,
    cleanupCandidates: row.cleanup_candidates,
  }
}
