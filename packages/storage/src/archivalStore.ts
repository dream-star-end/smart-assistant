// ArchivalStore — Long-term knowledge storage (the "Archival" layer in
// Letta/MemGPT-inspired tiered memory).
//
// Unlike Core Memory (USER.md + MEMORY.md) which is always in the system
// prompt, Archival Memory is searched on demand via FTS5.
// Capacity is unlimited — stored in the same SQLite as sessions.
//
// Use cases: API docs, project architecture notes, code patterns,
// detailed procedures that don't fit in the 4K MEMORY.md budget.

import { getSessionsDb } from './sessionsDb.js'

let _initialized = false

async function ensureSchema(): Promise<void> {
  if (_initialized) return
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

    CREATE VIRTUAL TABLE IF NOT EXISTS archival_fts USING fts5(
      content, tags,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    -- Triggers to keep FTS in sync with the content table
    CREATE TRIGGER IF NOT EXISTS archival_ai AFTER INSERT ON archival BEGIN
      INSERT INTO archival_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS archival_ad AFTER DELETE ON archival BEGIN
      INSERT INTO archival_fts(archival_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS archival_au AFTER UPDATE ON archival BEGIN
      INSERT INTO archival_fts(archival_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO archival_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
  `)
  _initialized = true
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
  const rows = db
    .prepare(
      `SELECT a.id, a.content, a.tags, bm25(archival_fts) AS score
       FROM archival_fts
       JOIN archival a ON a.rowid = archival_fts.rowid
       WHERE archival_fts MATCH ? AND a.agent_id = ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(query, agentId, limit) as Array<{
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
