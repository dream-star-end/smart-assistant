/**
 * Vector Store (P1.2)
 *
 * SQLite-based vector storage using sqlite-vec extension.
 * Provides vector tables alongside existing FTS5 tables for hybrid search.
 *
 * Two vector tables:
 *   archival_vec  — vectors for archival memory entries
 *   sessions_vec  — vectors for session turn content
 *
 * Hybrid search combines BM25 (FTS5) + cosine similarity (vec) via
 * Reciprocal Rank Fusion (RRF) for improved recall.
 */

import type Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { getSessionsDb } from './sessionsDb.js'
import type { EmbeddingProvider } from './embedding.js'

// ── Initialization ───────────────────────────────

let _vecDb: Database.Database | null = null
let _vecDimensions = 0

/**
 * Load sqlite-vec extension and create vector tables.
 * Must be called before any vector operations.
 * Idempotent — safe to call multiple times with the same dimensions.
 * Re-initializes if the underlying DB handle has changed (e.g. after closeSessionsDb).
 */
export async function initVectorStore(dimensions: number): Promise<Database.Database> {
  if (!Number.isFinite(dimensions) || dimensions <= 0 || !Number.isInteger(dimensions)) {
    throw new Error(`initVectorStore: dimensions must be a positive integer, got ${dimensions}`)
  }

  const db = await getSessionsDb()

  // Re-initialize if DB handle changed (e.g. after closeSessionsDb + reopen)
  if (_vecDb && _vecDb === db && _vecDimensions > 0) {
    if (dimensions !== _vecDimensions) {
      throw new Error(
        `initVectorStore: already initialized with dimensions=${_vecDimensions}, cannot change to ${dimensions}`,
      )
    }
    return db
  }

  sqliteVec.load(db)

  // Check if vec tables already exist with potentially different dimensions.
  // vec0 tables are opaque — if they exist with wrong dimensions, inserts/queries
  // will fail at that point. We create if not exists and trust the schema.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS archival_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `)

  // Verify existing tables have compatible dimensions by probing both tables.
  // If dimensions mismatch, vec0 will error on query with the wrong-sized vector.
  const probe = new Float32Array(dimensions)
  for (const table of ['archival_vec', 'sessions_vec']) {
    try {
      db.prepare(`SELECT id FROM ${table} WHERE embedding MATCH ? AND k = 1`).all(probe)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('dimensions') || msg.includes('vector')) {
        throw new Error(
          `initVectorStore: ${table} has incompatible dimensions (requested ${dimensions}): ${msg}`,
        )
      }
      // Empty table is fine — probe returns 0 rows
    }
  }

  _vecDb = db
  _vecDimensions = dimensions
  return db
}

/**
 * Get the initialized DB, throwing if initVectorStore() hasn't been called
 * or if the DB handle has been invalidated.
 */
async function getVecDb(): Promise<Database.Database> {
  const db = await getSessionsDb()
  if (!_vecDb || _vecDb !== db) {
    throw new Error('Vector store not initialized — call initVectorStore(dimensions) first')
  }
  return db
}

/**
 * Check if vector store is initialized with a live DB handle.
 * Returns false if the DB was closed (better-sqlite3 .open property).
 */
function isVecReady(): boolean {
  return _vecDb !== null && (_vecDb as any).open !== false && _vecDimensions > 0
}

/** Reset state (for testing). */
export function resetVectorStore(): void {
  _vecDb = null
  _vecDimensions = 0
}

// ── Session vector ID encoding ───────────────────
// Session IDs contain colons (e.g. "agent:main:webchat:dm:user123"),
// so we use "|" as delimiter which does not appear in session keys.

const VEC_ID_SEP = '|'

export function encodeSessionVecId(sessionId: string, turnIdx: number, role: string): string {
  return `${sessionId}${VEC_ID_SEP}${turnIdx}${VEC_ID_SEP}${role}`
}

export function decodeSessionVecId(vecId: string): { sessionId: string; turnIdx: number; role: string } {
  const lastSep = vecId.lastIndexOf(VEC_ID_SEP)
  const role = vecId.substring(lastSep + 1)
  const rest = vecId.substring(0, lastSep)
  const secondLastSep = rest.lastIndexOf(VEC_ID_SEP)
  const turnIdx = parseInt(rest.substring(secondLastSep + 1), 10)
  const sessionId = rest.substring(0, secondLastSep)
  return { sessionId, turnIdx, role }
}

// ── Archival Vector Operations ───────────────────

/**
 * Upsert a vector for an archival entry.
 * The id must match an archival.id in the archival table.
 */
export async function upsertArchivalVector(
  id: string,
  embedding: Float32Array,
): Promise<void> {
  const db = await getVecDb()
  // vec0 virtual tables do not support UPSERT — use atomic DELETE+INSERT
  db.transaction(() => {
    db.prepare('DELETE FROM archival_vec WHERE id = ?').run(id)
    db.prepare('INSERT INTO archival_vec (id, embedding) VALUES (?, ?)').run(id, embedding)
  })()
}

/**
 * Delete a vector for an archival entry.
 */
export async function deleteArchivalVector(id: string): Promise<void> {
  const db = await getVecDb()
  db.prepare('DELETE FROM archival_vec WHERE id = ?').run(id)
}

/**
 * Vector-only KNN search on archival entries.
 * Note: Agent filtering is post-KNN — the global top-k*factor neighbors are
 * fetched first, then filtered. This means agent-scoped recall can be lower
 * than global recall. We over-fetch by 10x to mitigate.
 */
export async function searchArchivalByVector(
  queryEmbedding: Float32Array,
  agentId: string,
  limit: number,
): Promise<Array<{ id: string; distance: number }>> {
  const db = await getVecDb()
  const overFetch = limit * 10
  const rows = db.prepare(`
    SELECT v.id, v.distance
    FROM archival_vec v
    JOIN archival a ON a.id = v.id
    WHERE v.embedding MATCH ? AND k = ? AND a.agent_id = ?
    ORDER BY v.distance
  `).all(queryEmbedding, overFetch, agentId) as Array<{ id: string; distance: number }>
  return rows.slice(0, limit)
}

// ── Session Vector Operations ────────────────────

/**
 * Upsert a vector for a session turn.
 * Use encodeSessionVecId() to create the id.
 */
export async function upsertSessionVector(
  id: string,
  embedding: Float32Array,
): Promise<void> {
  const db = await getVecDb()
  // vec0 virtual tables do not support UPSERT — use atomic DELETE+INSERT
  db.transaction(() => {
    db.prepare('DELETE FROM sessions_vec WHERE id = ?').run(id)
    db.prepare('INSERT INTO sessions_vec (id, embedding) VALUES (?, ?)').run(id, embedding)
  })()
}

/**
 * Vector-only KNN search on session turns.
 * Agent filtering is post-KNN with 10x over-fetch.
 */
export async function searchSessionsByVector(
  queryEmbedding: Float32Array,
  agentId: string | undefined,
  limit: number,
): Promise<Array<{ id: string; distance: number }>> {
  const db = await getVecDb()
  const overFetch = limit * 10

  if (agentId) {
    // Use "|" separator to extract sessionId from vec ID
    const rows = db.prepare(`
      SELECT v.id, v.distance
      FROM sessions_vec v
      JOIN sessions_meta m
        ON m.id = substr(v.id, 1, instr(v.id, '|') - 1)
      WHERE v.embedding MATCH ? AND k = ? AND m.agent_id = ?
      ORDER BY v.distance
    `).all(queryEmbedding, overFetch, agentId) as Array<{ id: string; distance: number }>
    return rows.slice(0, limit)
  }

  const rows = db.prepare(`
    SELECT id, distance
    FROM sessions_vec
    WHERE embedding MATCH ? AND k = ?
    ORDER BY distance
  `).all(queryEmbedding, limit) as Array<{ id: string; distance: number }>
  return rows
}

// ── Reciprocal Rank Fusion ───────────────────────

export interface RRFCandidate {
  id: string
  /** Fused RRF score (higher = better) */
  score: number
  /** Rank in BM25 result list (1-based), or null if absent */
  bm25Rank: number | null
  /** Rank in vector result list (1-based), or null if absent */
  vecRank: number | null
}

/**
 * Reciprocal Rank Fusion (RRF) merges two ranked lists.
 *
 * RRF score = sum( 1 / (k + rank_i) ) for each list where the item appears.
 * k is a constant (default 60) that dampens the influence of high ranks.
 *
 * @param bm25Ids  IDs from BM25 search, ordered by relevance (best first)
 * @param vecIds   IDs from vector search, ordered by relevance (best first)
 * @param k        RRF constant (default: 60)
 * @returns Merged candidates sorted by fused score (highest first)
 */
export function reciprocalRankFusion(
  bm25Ids: string[],
  vecIds: string[],
  k = 60,
): RRFCandidate[] {
  const candidates = new Map<string, RRFCandidate>()

  for (let i = 0; i < bm25Ids.length; i++) {
    const id = bm25Ids[i]
    const rank = i + 1
    candidates.set(id, {
      id,
      score: 1 / (k + rank),
      bm25Rank: rank,
      vecRank: null,
    })
  }

  for (let i = 0; i < vecIds.length; i++) {
    const id = vecIds[i]
    const rank = i + 1
    const existing = candidates.get(id)
    if (existing) {
      existing.score += 1 / (k + rank)
      existing.vecRank = rank
    } else {
      candidates.set(id, {
        id,
        score: 1 / (k + rank),
        bm25Rank: null,
        vecRank: rank,
      })
    }
  }

  return Array.from(candidates.values()).sort((a, b) => b.score - a.score)
}

// ── Hybrid Search: Archival ──────────────────────

export interface HybridArchivalResult {
  id: string
  content: string
  tags: string
  /** RRF fused score (higher = better) */
  score: number
  bm25Rank: number | null
  vecRank: number | null
}

/**
 * Hybrid search on archival memory: BM25 + Vector + RRF fusion.
 *
 * Falls back to BM25-only if:
 * - embedding provider is null
 * - vector store is not initialized
 * - embedding generation fails
 */
export async function hybridArchivalSearch(
  agentId: string,
  query: string,
  provider: EmbeddingProvider | null,
  limit = 5,
): Promise<HybridArchivalResult[]> {
  const db = await getSessionsDb()
  const fetchLimit = limit * 4

  // 1. BM25 search
  const cleanQuery = query.replace(/["()*]/g, ' ').trim()
  const bm25Rows = cleanQuery
    ? (db.prepare(`
        SELECT a.id, a.content, a.tags, bm25(archival_fts) AS score
        FROM archival_fts
        JOIN archival a ON a.rowid = archival_fts.rowid
        WHERE archival_fts MATCH ? AND a.agent_id = ?
        ORDER BY score
        LIMIT ?
      `).all(cleanQuery, agentId, fetchLimit) as Array<{
        id: string; content: string; tags: string; score: number
      }>)
    : []

  // 2. Vector search (if provider available and vec store initialized)
  let vecResults: Array<{ id: string; distance: number }> = []
  if (provider && isVecReady()) {
    try {
      const [queryVec] = await provider.embed([query], 'query')
      vecResults = await searchArchivalByVector(queryVec, agentId, fetchLimit)
    } catch {
      // Fall back to BM25-only on embedding/vector failure
    }
  }

  // 3. RRF fusion
  const bm25Ids = bm25Rows.map(r => r.id)
  const vecIds = vecResults.map(r => r.id)
  const fused = reciprocalRankFusion(bm25Ids, vecIds)

  // 4. Assemble results with content
  const contentMap = new Map<string, { content: string; tags: string }>()
  for (const r of bm25Rows) {
    contentMap.set(r.id, { content: r.content, tags: r.tags })
  }

  // Load content for vector-only hits not in BM25 results
  const missingIds = fused
    .filter(c => !contentMap.has(c.id))
    .map(c => c.id)
    .slice(0, limit)

  if (missingIds.length > 0) {
    const placeholders = missingIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id, content, tags FROM archival WHERE id IN (${placeholders})`,
    ).all(...missingIds) as Array<{ id: string; content: string; tags: string }>
    for (const r of rows) {
      contentMap.set(r.id, { content: r.content, tags: r.tags })
    }
  }

  return fused.slice(0, limit).map(c => ({
    id: c.id,
    content: contentMap.get(c.id)?.content ?? '',
    tags: contentMap.get(c.id)?.tags ?? '',
    score: c.score,
    bm25Rank: c.bm25Rank,
    vecRank: c.vecRank,
  }))
}

// ── Hybrid Search: Sessions ──────────────────────

export interface HybridSessionResult {
  sessionId: string
  agentId: string
  channel: string
  peerId: string
  title: string
  lastAt: number
  snippet: string
  /** RRF fused score (higher = better) */
  score: number
  bm25Rank: number | null
  vecRank: number | null
}

/**
 * Hybrid search on sessions: BM25 + Vector + RRF fusion.
 *
 * Falls back to BM25-only if embedding provider is unavailable or errors.
 */
export async function hybridSessionSearch(
  query: string,
  provider: EmbeddingProvider | null,
  limit = 5,
  agentId?: string,
): Promise<HybridSessionResult[]> {
  const db = await getSessionsDb()
  const fetchLimit = limit * 4

  // 1. BM25 search (existing logic from searchSessions)
  const cleanQuery = query.replace(/["()*]/g, ' ').trim()
  if (!cleanQuery && !provider) return []

  const agentFilter = agentId ? 'AND m.agent_id = ?' : ''
  const bm25Params = agentId ? [cleanQuery, agentId, fetchLimit] : [cleanQuery, fetchLimit]

  const bm25Rows = cleanQuery
    ? (db.prepare(`
        SELECT
          f.session_id,
          f.turn_idx,
          snippet(sessions_fts, 3, '<mark>', '</mark>', '...', 16) AS snippet,
          bm25(sessions_fts) AS score,
          m.agent_id, m.channel, m.peer_id, m.title, m.last_at
        FROM sessions_fts f
        LEFT JOIN sessions_meta m ON m.id = f.session_id
        WHERE sessions_fts MATCH ?
        ${agentFilter}
        ORDER BY score
        LIMIT ?
      `).all(...bm25Params) as Array<{
        session_id: string; turn_idx: number; snippet: string; score: number
        agent_id: string | null; channel: string | null; peer_id: string | null
        title: string | null; last_at: number | null
      }>)
    : []

  // Dedupe BM25 to unique sessions
  const bm25Deduped: typeof bm25Rows = []
  const seenBm25 = new Set<string>()
  for (const r of bm25Rows) {
    if (seenBm25.has(r.session_id)) continue
    seenBm25.add(r.session_id)
    bm25Deduped.push(r)
  }

  // 2. Vector search
  let vecResults: Array<{ id: string; distance: number }> = []
  if (provider && isVecReady() && query.trim()) {
    try {
      const [queryVec] = await provider.embed([query], 'query')
      vecResults = await searchSessionsByVector(queryVec, agentId, fetchLimit)
    } catch {
      // Fall back to BM25-only
    }
  }

  // Extract sessionId from vec result id using "|" separator
  const vecSessionIds: string[] = []
  const vecSeenSessions = new Set<string>()
  for (const r of vecResults) {
    const { sessionId } = decodeSessionVecId(r.id)
    if (!vecSeenSessions.has(sessionId)) {
      vecSeenSessions.add(sessionId)
      vecSessionIds.push(sessionId)
    }
  }

  // 3. RRF fusion
  const bm25Ids = bm25Deduped.map(r => r.session_id)
  const fused = reciprocalRankFusion(bm25Ids, vecSessionIds)

  // 4. Build metadata map from BM25 results
  const metaMap = new Map<string, {
    agentId: string; channel: string; peerId: string; title: string; lastAt: number; snippet: string
  }>()
  for (const r of bm25Deduped) {
    metaMap.set(r.session_id, {
      agentId: r.agent_id ?? 'unknown',
      channel: r.channel ?? 'unknown',
      peerId: r.peer_id ?? 'unknown',
      title: r.title ?? '(untitled)',
      lastAt: r.last_at ?? 0,
      snippet: r.snippet,
    })
  }

  // Load metadata for vector-only hits
  const missingSessionIds = fused
    .filter(c => !metaMap.has(c.id))
    .map(c => c.id)
    .slice(0, limit)

  if (missingSessionIds.length > 0) {
    const placeholders = missingSessionIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id, agent_id, channel, peer_id, title, last_at FROM sessions_meta WHERE id IN (${placeholders})`,
    ).all(...missingSessionIds) as Array<{
      id: string; agent_id: string; channel: string; peer_id: string; title: string | null; last_at: number
    }>
    for (const r of rows) {
      metaMap.set(r.id, {
        agentId: r.agent_id,
        channel: r.channel,
        peerId: r.peer_id,
        title: r.title ?? '(untitled)',
        lastAt: r.last_at,
        snippet: '(vector match)',
      })
    }
  }

  return fused.slice(0, limit).map(c => {
    const meta = metaMap.get(c.id)
    return {
      sessionId: c.id,
      agentId: meta?.agentId ?? 'unknown',
      channel: meta?.channel ?? 'unknown',
      peerId: meta?.peerId ?? 'unknown',
      title: meta?.title ?? '(untitled)',
      lastAt: meta?.lastAt ?? 0,
      snippet: meta?.snippet ?? '',
      score: c.score,
      bm25Rank: c.bm25Rank,
      vecRank: c.vecRank,
    }
  })
}
