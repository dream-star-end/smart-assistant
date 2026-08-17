// ArchivalStore — Long-term knowledge storage (the "Archival" layer in
// Letta/MemGPT-inspired tiered memory).
//
// Unlike Core Memory (USER.md always-block + MEMORY.md index, injected into
// the system prompt; Core file bodies are retrieved on demand), Archival
// Memory is searched on demand via FTS5.
// Capacity is unlimited — stored in the same SQLite as sessions.
//
// Use cases: API docs, project architecture notes, code patterns,
// detailed procedures that don't fit in the 4K MEMORY.md budget.

import { migrateArchivalFtsCjk, registerFtsCjkFunctions } from './ftsCjkMigrate.js'
import { literalFtsQuery } from './ftsQuery.js'
import { getSessionsDb } from './sessionsDb.js'

// Single shared promise so that concurrent first-use calls all wait for the
// same initialization rather than racing through the DROP/CREATE trigger steps.
let _initPromise: Promise<void> | null = null

async function ensureSchema(): Promise<void> {
  if (_initPromise) return _initPromise
  _initPromise = _runInit().catch((err) => {
    // Clear the cached promise on failure so that the next caller retries
    // rather than permanently receiving the same rejected promise.
    _initPromise = null
    throw err
  })
  return _initPromise
}

async function _runInit(): Promise<void> {
  const db = await getSessionsDb()

  // Run the entire schema bootstrap + trigger migration inside a single
  // write transaction so there is never a window where the triggers are absent
  // while the table already exists and is being mutated.
  db.transaction(() => {
    // Base tables.
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

      CREATE VIRTUAL TABLE IF NOT EXISTS archival_fts USING fts5(
        content, tags,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)

    // CJK pre-tokenize (idempotent). Must run after archival / archival_fts
    // exist and after oc_fts_cjk_tokens is registered on this handle.
    registerFtsCjkFunctions(db)
    migrateArchivalFtsCjk(db)

    // Self-heal orphan FTS rows. Root cause observed 2026-04-17: an old
    // archival row was deleted via a path that bypassed the AFTER DELETE
    // trigger (e.g. an earlier code version or manual SQL), leaving a
    // rowid in archival_fts with no matching base row. SQLite's autoincrement
    // logic assigns the next INSERT that same orphaned rowid, which then
    // collides inside the archival_ai trigger when it tries to re-insert
    // into archival_fts — surfacing as a cryptic "constraint failed" with
    // no further detail. Deleting orphans at startup restores write health.
    db.exec(`
      DELETE FROM archival_fts
       WHERE rowid NOT IN (SELECT rowid FROM archival);
    `)
  })()
}

function genId(): string {
  return `arc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface ArchivalEntry {
  id: string
  agentId: string
  content: string
  tags: string
  createdAt: string
  updatedAt: string
}

export interface ArchivalSearchResult {
  id: string
  content: string
  tags: string
  score: number
}

export async function archivalAdd(
  agentId: string,
  content: string,
  tags?: string,
): Promise<string> {
  await ensureSchema()
  const db = await getSessionsDb()
  const id = genId()
  db.prepare('INSERT INTO archival (id, agent_id, content, tags) VALUES (?, ?, ?, ?)').run(
    id,
    agentId,
    content,
    tags ?? '',
  )
  return id
}

export async function archivalSearch(
  agentId: string,
  query: string,
  limit = 5,
): Promise<ArchivalSearchResult[]> {
  await ensureSchema()
  const db = await getSessionsDb()
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
    return rows.map((row, index) => ({ ...row, score: 1 / (61 + index) }))
  }
  const cleanQuery = literalFtsQuery(query)
  if (!cleanQuery) return []
  const rows = db
    .prepare(
      `SELECT a.id, a.content, a.tags, bm25(archival_fts) AS score
       FROM archival_fts
       JOIN archival a ON a.rowid = archival_fts.rowid
       WHERE archival_fts MATCH ? AND a.agent_id = ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(cleanQuery, agentId, limit) as Array<{
    id: string
    content: string
    tags: string
    score: number
  }>
  return rows
}

export async function archivalDelete(agentId: string, id: string): Promise<boolean> {
  await ensureSchema()
  const db = await getSessionsDb()
  const result = db.prepare('DELETE FROM archival WHERE id = ? AND agent_id = ?').run(id, agentId)
  return result.changes > 0
}

export async function archivalCount(agentId: string): Promise<number> {
  await ensureSchema()
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM archival WHERE agent_id = ?')
    .get(agentId) as { cnt: number }
  return row.cnt
}
