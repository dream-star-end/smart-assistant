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
import { currentEmbeddingProvider, type EmbeddingProvider } from './embedding.js'
import { literalFtsQuery } from './ftsQuery.js'
import { getSessionsDb } from './sessionsDb.js'

// ── Initialization ───────────────────────────────

let _vecDb: Database.Database | null = null
let _vecDimensions = 0

/**
 * Load sqlite-vec extension and create vector tables.
 * Must be called before any vector operations.
 * Idempotent — safe to call multiple times with the same dimensions.
 * Re-initializes if the underlying DB handle has changed (e.g. after closeSessionsDb).
 *
 * When `provider` is omitted, an already-constructed process provider with the
 * same dimensions is used. Pass null to skip model alignment. A provider whose
 * backend, model, or dimensions differ from the stored index rebuilds archival
 * and session vectors from source text before any later query can compare them.
 */
export async function initVectorStore(
  dimensions: number,
  provider?: EmbeddingProvider | null,
): Promise<Database.Database> {
  if (!Number.isFinite(dimensions) || dimensions <= 0 || !Number.isInteger(dimensions)) {
    throw new Error(`initVectorStore: dimensions must be a positive integer, got ${dimensions}`)
  }

  const db = await getSessionsDb()
  const requested = provider === undefined ? currentEmbeddingProvider() : provider
  if (requested && requested.dimensions !== dimensions) {
    if (provider !== undefined) {
      throw new Error(
        `initVectorStore: provider dimensions ${requested.dimensions} do not match requested ${dimensions}`,
      )
    }
  }
  const alignedProvider = requested && requested.dimensions === dimensions ? requested : null

  // Same live handle: still align the model. A container can keep the DB open
  // across a config reload, and dimensions alone do not identify the model.
  if (_vecDb && _vecDb === db && _vecDimensions === dimensions) {
    if (alignedProvider) {
      const ok = await alignEmbeddingIndex(db, alignedProvider)
      if (!ok) {
        throw new Error(
          'initVectorStore: persistent vectors belong to a different embedding model and could not be rebuilt',
        )
      }
    }
    return db
  }
  if (_vecDb && _vecDb === db && _vecDimensions > 0 && !alignedProvider) {
    throw new Error(
      `initVectorStore: already initialized with dimensions=${_vecDimensions}, cannot change to ${dimensions}`,
    )
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
  // A mismatch is fatal only when we have no provider to rebuild from source text.
  const probe = new Float32Array(dimensions)
  let dimensionsMismatch = false
  for (const table of ['archival_vec', 'sessions_vec']) {
    try {
      db.prepare(`SELECT id FROM ${table} WHERE embedding MATCH ? AND k = 1`).all(probe)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('dimensions') || msg.includes('vector')) {
        dimensionsMismatch = true
        if (!alignedProvider) {
          throw new Error(
            `initVectorStore: ${table} has incompatible dimensions (requested ${dimensions}): ${msg}`,
          )
        }
      }
      // Empty table is fine — probe returns 0 rows
    }
  }

  if (alignedProvider) {
    const ok = await alignEmbeddingIndex(db, alignedProvider)
    if (!ok) {
      throw new Error(
        dimensionsMismatch
          ? `initVectorStore: vector tables have incompatible dimensions (requested ${dimensions}) and could not be rebuilt`
          : 'initVectorStore: persistent vectors belong to a different embedding model and could not be rebuilt',
      )
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

// ── Embedding index identity ─────────────────────
// vec0 rows are only an id and a vector. Archival and session search must not
// compare a query from one backend/model with vectors from another, even when
// the dimensions match. The identity row is the authority; a change rebuilds
// both tables from source text before KNN.

interface EmbeddingIndexIdentity {
  backend: string
  model: string
  dimensions: number
}

interface StoredEmbeddingIndex extends EmbeddingIndexIdentity {
  /** Bumps on every rebuild and on every vector write. A stale snapshot must not commit. */
  generation: number
}

const VEC_TABLES = ['archival_vec', 'sessions_vec'] as const
const IDENTITY_ID_CHUNK = 500

let alignChain: Promise<unknown> = Promise.resolve()

function providerIdentity(provider: EmbeddingProvider): EmbeddingIndexIdentity {
  return {
    backend: provider.backendId || provider.providerId,
    model: provider.modelId,
    dimensions: provider.dimensions,
  }
}

function sameIdentity(a: EmbeddingIndexIdentity, b: EmbeddingIndexIdentity): boolean {
  return a.backend === b.backend && a.model === b.model && a.dimensions === b.dimensions
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined
}

function identityColumnExists(db: Database.Database, name: string): boolean {
  const cols = db.prepare('PRAGMA table_info(embedding_index_identity)').all() as Array<{ name: string }>
  return cols.some((col) => col.name === name)
}

function ensureIdentityTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_index_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      backend TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL
    );
  `)
  if (identityColumnExists(db, 'generation')) return
  try {
    db.exec('ALTER TABLE embedding_index_identity ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
  } catch (err) {
    // Two processes can both observe the missing column. The later ALTER
    // raises duplicate column name. Once the winner's column is present,
    // keep going: throwing here disables embedding for a successful add.
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('duplicate column name: generation') || !identityColumnExists(db, 'generation')) {
      throw err
    }
  }
}

function readIdentity(db: Database.Database): StoredEmbeddingIndex | null {
  ensureIdentityTable(db)
  const row = db.prepare(
    'SELECT backend, model, dimensions, generation FROM embedding_index_identity WHERE id = 1',
  ).get() as StoredEmbeddingIndex | undefined
  return row ?? null
}

function writeIdentity(db: Database.Database, identity: EmbeddingIndexIdentity): void {
  ensureIdentityTable(db)
  db.prepare(`
    INSERT INTO embedding_index_identity (id, backend, model, dimensions, generation)
    VALUES (1, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      backend = excluded.backend,
      model = excluded.model,
      dimensions = excluded.dimensions,
      generation = embedding_index_identity.generation + 1
  `).run(identity.backend, identity.model, identity.dimensions)
}

/** Invalidate in-flight rebuild snapshots. Call in the same transaction as the vector write. */
export function notePersistentVectorMutation(db: Database.Database): void {
  ensureIdentityTable(db)
  db.prepare(
    'UPDATE embedding_index_identity SET generation = generation + 1 WHERE id = 1',
  ).run()
}

function listVecIds(db: Database.Database, table: 'archival_vec' | 'sessions_vec'): string[] | null {
  if (!tableExists(db, table)) return []
  try {
    const rows = db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  } catch {
    return null
  }
}

function vecTablesMatchDimensions(db: Database.Database, dimensions: number): boolean {
  const probe = new Float32Array(dimensions)
  for (const table of VEC_TABLES) {
    if (!tableExists(db, table)) return false
    try {
      db.prepare(`SELECT id FROM ${table} WHERE embedding MATCH ? AND k = 1`).all(probe)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('dimensions') || msg.includes('vector')) return false
    }
  }
  return true
}

function recreateVecTables(db: Database.Database, dimensions: number): void {
  db.exec(`
    DROP TABLE IF EXISTS archival_vec;
    DROP TABLE IF EXISTS sessions_vec;
    CREATE VIRTUAL TABLE archival_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
    CREATE VIRTUAL TABLE sessions_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `)
}

interface SourceDoc {
  id: string
  content: string
}

function rowsByIds<T extends { id: string }>(
  db: Database.Database,
  sqlPrefix: string,
  ids: string[],
): T[] {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += IDENTITY_ID_CHUNK) {
    const chunk = ids.slice(i, i + IDENTITY_ID_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.prepare(`${sqlPrefix} (${placeholders})`).all(...chunk) as T[]
    out.push(...rows)
  }
  return out
}

function loadArchivalDocs(db: Database.Database, ids: string[] | null): SourceDoc[] {
  if (!tableExists(db, 'archival')) return []
  if (ids === null) {
    return db.prepare('SELECT id, content FROM archival ORDER BY id').all() as SourceDoc[]
  }
  if (ids.length === 0) return []
  return rowsByIds<SourceDoc>(db, 'SELECT id, content FROM archival WHERE id IN', ids)
}

function loadSessionDocs(db: Database.Database, ids: string[] | null): SourceDoc[] {
  if (!tableExists(db, 'sessions_fts')) return []
  const stmt = db.prepare(
    'SELECT content FROM sessions_fts WHERE session_id = ? AND turn_idx = ? AND role = ? LIMIT 1',
  )
  const picked = new Map<string, string>()
  const consider = (id: string): void => {
    if (picked.has(id)) return
    const decoded = decodeSessionVecId(id)
    if (!decoded.sessionId || !Number.isFinite(decoded.turnIdx) || !decoded.role) return
    const row = stmt.get(decoded.sessionId, decoded.turnIdx, decoded.role) as { content: string } | undefined
    if (row) picked.set(id, row.content)
  }
  if (ids === null) {
    const rows = db.prepare(
      'SELECT session_id, turn_idx, role FROM sessions_fts',
    ).all() as Array<{ session_id: string; turn_idx: number; role: string }>
    for (const row of rows) consider(encodeSessionVecId(row.session_id, row.turn_idx, row.role))
  } else {
    for (const id of ids) consider(id)
  }
  return [...picked.entries()].map(([id, content]) => ({ id, content }))
}

async function embedDocs(provider: EmbeddingProvider, docs: SourceDoc[]): Promise<Float32Array[]> {
  if (docs.length === 0) return []
  const vectors = await provider.embed(docs.map((doc) => doc.content), 'document')
  if (vectors.length !== docs.length) {
    throw new Error(`embedding rebuild count mismatch: expected ${docs.length}, got ${vectors.length}`)
  }
  for (const vector of vectors) {
    if (vector.length !== provider.dimensions) {
      throw new Error(
        `embedding rebuild dimension mismatch: expected ${provider.dimensions}, got ${vector.length}`,
      )
    }
  }
  return vectors
}

function replaceVecRows(
  db: Database.Database,
  table: 'archival_vec' | 'sessions_vec',
  docs: SourceDoc[],
  vectors: Float32Array[],
): void {
  const insert = db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ?)`)
  for (let i = 0; i < docs.length; i++) insert.run(docs[i].id, vectors[i])
}

/**
 * Make the on-disk index match `provider` before any KNN.
 * Returns false when a rebuild was required and embedding failed. Callers must
 * then skip vector search so an old model's vectors are never scored.
 *
 * Embedding runs outside the write lock. The commit takes BEGIN IMMEDIATE and
 * re-reads identity plus generation. A peer that already aligned this model
 * wins: the late snapshot is discarded. A peer write that only bumped the
 * generation makes this snapshot stale, so the rebuild loads source text again.
 */
const MAX_REBUILD_ATTEMPTS = 8

function alignEmbeddingIndex(db: Database.Database, provider: EmbeddingProvider): Promise<boolean> {
  const run = alignChain.then(
    () => alignEmbeddingIndexUnlocked(db, provider),
    () => alignEmbeddingIndexUnlocked(db, provider),
  )
  alignChain = run.then(() => undefined, () => undefined)
  return run
}

type RebuildCommit = 'applied' | 'aligned' | 'stale'

function commitRebuiltIndex(
  db: Database.Database,
  current: EmbeddingIndexIdentity,
  snapshotGeneration: number,
  archivalDocs: SourceDoc[],
  archivalVecs: Float32Array[],
  sessionDocs: SourceDoc[],
  sessionVecs: Float32Array[],
): RebuildCommit {
  const apply = db.transaction((): RebuildCommit => {
    const now = readIdentity(db)
    if (now && sameIdentity(now, current) && vecTablesMatchDimensions(db, current.dimensions)) {
      return 'aligned'
    }
    if ((now?.generation ?? -1) !== snapshotGeneration) return 'stale'
    recreateVecTables(db, current.dimensions)
    replaceVecRows(db, 'archival_vec', archivalDocs, archivalVecs)
    replaceVecRows(db, 'sessions_vec', sessionDocs, sessionVecs)
    writeIdentity(db, current)
    return 'applied'
  })
  return apply.immediate()
}

function stampEmptyIdentity(db: Database.Database, current: EmbeddingIndexIdentity): 'done' | 'retry' {
  const apply = db.transaction((): 'done' | 'retry' => {
    const now = readIdentity(db)
    const dimsOk = vecTablesMatchDimensions(db, current.dimensions)
    if (now && sameIdentity(now, current) && dimsOk) return 'done'
    const archivalIds = listVecIds(db, 'archival_vec')
    const sessionIds = listVecIds(db, 'sessions_vec')
    const unknown = archivalIds === null || sessionIds === null
    const hasVectors = unknown || archivalIds.length + sessionIds.length > 0
    if (now || hasVectors || !dimsOk) return 'retry'
    writeIdentity(db, current)
    return 'done'
  })
  return apply.immediate()
}

async function alignEmbeddingIndexUnlocked(
  db: Database.Database,
  provider: EmbeddingProvider,
): Promise<boolean> {
  const current = providerIdentity(provider)
  for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt++) {
    const stored = readIdentity(db)
    const dimsOk = vecTablesMatchDimensions(db, current.dimensions)
    if (stored && sameIdentity(stored, current) && dimsOk) return true

    const archivalIds = listVecIds(db, 'archival_vec')
    const sessionIds = listVecIds(db, 'sessions_vec')
    const unknown = archivalIds === null || sessionIds === null
    const hasVectors = unknown || archivalIds.length + sessionIds.length > 0
    if (!stored && !hasVectors && dimsOk) {
      if (stampEmptyIdentity(db, current) === 'done') return true
      continue
    }

    const snapshotGeneration = stored?.generation ?? -1
    try {
      const archivalDocs = loadArchivalDocs(db, archivalIds)
      const sessionDocs = loadSessionDocs(db, sessionIds)
      const archivalVecs = await embedDocs(provider, archivalDocs)
      const sessionVecs = await embedDocs(provider, sessionDocs)
      const outcome = commitRebuiltIndex(
        db,
        current,
        snapshotGeneration,
        archivalDocs,
        archivalVecs,
        sessionDocs,
        sessionVecs,
      )
      if (outcome === 'stale') continue
      _vecDimensions = current.dimensions
      if (outcome === 'aligned') {
        process.stderr.write(
          `[oc-memory] kept persistent vectors ${current.backend}/${current.model} (${current.dimensions}d); a concurrent migration already finished\n`,
        )
        return true
      }
      const from = stored ? `${stored.backend}/${stored.model}` : 'untagged'
      process.stderr.write(
        `[oc-memory] rebuilt persistent vectors ${from} -> ${current.backend}/${current.model} (${current.dimensions}d, ${archivalDocs.length} archival, ${sessionDocs.length} sessions)\n`,
      )
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `[oc-memory] persistent vector rebuild failed; refusing cross-model search: ${msg.slice(0, 200)}\n`,
      )
      return false
    }
  }
  process.stderr.write(
    '[oc-memory] persistent vector rebuild failed; refusing cross-model search: snapshot stayed stale\n',
  )
  return false
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
    notePersistentVectorMutation(db)
  })()
}

/**
 * Delete a vector for an archival entry.
 */
export async function deleteArchivalVector(id: string): Promise<void> {
  const db = await getVecDb()
  db.transaction(() => {
    db.prepare('DELETE FROM archival_vec WHERE id = ?').run(id)
    notePersistentVectorMutation(db)
  })()
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
    notePersistentVectorMutation(db)
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

  if (query.trim() === '*') {
    const rows = db
      .prepare(
        `SELECT id, content, tags
         FROM archival
         WHERE agent_id = ?
         ORDER BY updated_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(agentId, limit) as Array<{ id: string; content: string; tags: string }>
    return rows.map((row, index) => ({
      ...row,
      score: 1 / (61 + index),
      bm25Rank: null,
      vecRank: null,
    }))
  }

  // 1. BM25 search
  const cleanQuery = literalFtsQuery(query)
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

  // 2. Vector search (if provider available and vec store initialized).
  // Skip KNN when the stored index belongs to another model and could not be rebuilt.
  let vecResults: Array<{ id: string; distance: number }> = []
  if (provider && isVecReady()) {
    const aligned = await alignEmbeddingIndex(db, provider)
    if (aligned) {
      try {
        const [queryVec] = await provider.embed([query], 'query')
        vecResults = await searchArchivalByVector(queryVec, agentId, fetchLimit)
      } catch {
        // Fall back to BM25-only on embedding/vector failure
      }
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
  const cleanQuery = literalFtsQuery(query)
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

  // 2. Vector search. Skip KNN when the stored index belongs to another model.
  let vecResults: Array<{ id: string; distance: number }> = []
  if (provider && isVecReady() && query.trim()) {
    const aligned = await alignEmbeddingIndex(db, provider)
    if (aligned) {
      try {
        const [queryVec] = await provider.embed([query], 'query')
        vecResults = await searchSessionsByVector(queryVec, agentId, fetchLimit)
      } catch {
        // Fall back to BM25-only
      }
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
