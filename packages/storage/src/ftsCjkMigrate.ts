// Idempotent rebuild of sessions_fts / archival_fts so CJK is pre-tokenized.
//
// Crash contract:
//   - All destructive DDL + copy lives in one SQLite transaction (DDL is
//     transactional). Kill -9 mid-flight rolls back; the original FTS table
//     is still there on the next open.
//   - A leftover `sessions_fts_cjk_stage` from a pre-transaction experiment
//     is dropped at the start of a rebuild, or used to recover if
//     `sessions_fts` itself is missing.
//   - Re-entry after success is a no-op (schema column + oc_schema_kv).
//   - Never writes the live path unless the caller opened that file.

import Database from 'better-sqlite3'
import { cjkFtsColumn, tokenizeCjkForFts } from './ftsQuery.js'

export const FTS_CJK_KV_TABLE = 'oc_schema_kv'
export const FTS_CJK_SESSIONS_KEY = 'sessions_fts_cjk'
export const FTS_CJK_ARCHIVAL_KEY = 'archival_fts_cjk'
export const FTS_CJK_VERSION = '1'
export const FTS_CJK_STAGE_TABLE = 'sessions_fts_cjk_stage'

export const SESSIONS_FTS_CJK_DDL = `CREATE VIRTUAL TABLE sessions_fts USING fts5(
      session_id UNINDEXED,
      turn_idx UNINDEXED,
      role UNINDEXED,
      content,
      content_fts,
      tokenize = 'unicode61 remove_diacritics 2'
    )`

const ARCHIVAL_FTS_DDL = `CREATE VIRTUAL TABLE archival_fts USING fts5(
        content, tags,
        tokenize = 'unicode61 remove_diacritics 2'
      )`

export interface FtsCjkMigrateResult {
  action: 'skipped' | 'rebuilt' | 'recovered' | 'marked'
  rows: number
  ms: number
  reason?: string
}

export function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
  ).get(name) as { ok: number } | undefined
  return row != null
}

export function ftsColumnNames(db: Database.Database, table: string): string[] {
  try {
    const rows = db.pragma(`table_xinfo(${table})`) as Array<{ name: string }>
    return rows.map((row) => row.name)
  } catch {
    return []
  }
}

export function sessionsFtsHasContentFts(db: Database.Database): boolean {
  return ftsColumnNames(db, 'sessions_fts').includes('content_fts')
}

export function ensureSchemaKv(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FTS_CJK_KV_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

export function getSchemaKv(db: Database.Database, key: string): string | undefined {
  if (!tableExists(db, FTS_CJK_KV_TABLE)) return undefined
  const row = db.prepare(`SELECT value FROM ${FTS_CJK_KV_TABLE} WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setSchemaKv(db: Database.Database, key: string, value: string): void {
  ensureSchemaKv(db)
  db.prepare(
    `INSERT INTO ${FTS_CJK_KV_TABLE}(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

const registeredHandles = new WeakSet<Database.Database>()

export function registerFtsCjkFunctions(db: Database.Database): void {
  if (registeredHandles.has(db)) return
  db.function('oc_fts_cjk_tokens', { deterministic: true }, (value: string | null) =>
    tokenizeCjkForFts(value ?? ''),
  )
  db.function('oc_fts_cjk_column', { deterministic: true }, (value: string | null) =>
    cjkFtsColumn(value ?? ''),
  )
  registeredHandles.add(db)
}

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return Number(row.n) || 0
}

function dropLeftoverRebuildTables(db: Database.Database): void {
  for (const name of [
    'sessions_fts_rebuild',
    'sessions_fts_new',
    'sessions_fts_cjk_rebuild',
    'archival_fts_rebuild',
    'archival_fts_new',
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${name}`)
  }
}

function createSessionsFtsCjk(db: Database.Database): void {
  db.exec(SESSIONS_FTS_CJK_DDL)
}

function rebuildSessionsFtsFromStage(db: Database.Database): number {
  const staged = countRows(db, FTS_CJK_STAGE_TABLE)
  db.exec('DROP TABLE IF EXISTS sessions_fts')
  createSessionsFtsCjk(db)
  db.exec(`
    INSERT INTO sessions_fts(session_id, turn_idx, role, content, content_fts)
    SELECT session_id, turn_idx, role, content, oc_fts_cjk_column(content)
      FROM ${FTS_CJK_STAGE_TABLE}
  `)
  const copied = countRows(db, 'sessions_fts')
  if (copied !== staged) {
    throw new Error(`sessions_fts CJK rebuild count mismatch: staged=${staged} copied=${copied}`)
  }
  db.exec(`DROP TABLE ${FTS_CJK_STAGE_TABLE}`)
  setSchemaKv(db, FTS_CJK_SESSIONS_KEY, FTS_CJK_VERSION)
  return copied
}

/**
 * Rebuild sessions_fts so it has `content_fts`. Idempotent and reentrant.
 * Original `content` is copied byte-for-byte (loadSessionTurns / snippet col 3).
 */
export function migrateSessionsFtsCjk(db: Database.Database): FtsCjkMigrateResult {
  const started = Date.now()
  registerFtsCjkFunctions(db)
  dropLeftoverRebuildTables(db)

  const hasFts = tableExists(db, 'sessions_fts')
  const hasStage = tableExists(db, FTS_CJK_STAGE_TABLE)
  const already = hasFts && sessionsFtsHasContentFts(db)
  const marked = getSchemaKv(db, FTS_CJK_SESSIONS_KEY) === FTS_CJK_VERSION

  if (already && marked && !hasStage) {
    return { action: 'skipped', rows: countRows(db, 'sessions_fts'), ms: Date.now() - started }
  }

  if (!hasFts && hasStage) {
    const rows = db.transaction(() => rebuildSessionsFtsFromStage(db))()
    return { action: 'recovered', rows, ms: Date.now() - started, reason: 'stage table only' }
  }

  if (already) {
    if (hasStage) db.exec(`DROP TABLE IF EXISTS ${FTS_CJK_STAGE_TABLE}`)
    setSchemaKv(db, FTS_CJK_SESSIONS_KEY, FTS_CJK_VERSION)
    return {
      action: marked ? 'skipped' : 'marked',
      rows: countRows(db, 'sessions_fts'),
      ms: Date.now() - started,
      reason: 'schema already has content_fts',
    }
  }

  if (!hasFts) {
    createSessionsFtsCjk(db)
    setSchemaKv(db, FTS_CJK_SESSIONS_KEY, FTS_CJK_VERSION)
    return { action: 'marked', rows: 0, ms: Date.now() - started, reason: 'created empty cjk schema' }
  }

  const rows = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${FTS_CJK_STAGE_TABLE}`)
    db.exec(`
      CREATE TABLE ${FTS_CJK_STAGE_TABLE} AS
      SELECT session_id, turn_idx, role, content FROM sessions_fts
    `)
    return rebuildSessionsFtsFromStage(db)
  })()
  return { action: 'rebuilt', rows, ms: Date.now() - started }
}

export function installArchivalCjkTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS archival_ai;
    DROP TRIGGER IF EXISTS archival_ad;
    DROP TRIGGER IF EXISTS archival_au;

    CREATE TRIGGER archival_ai AFTER INSERT ON archival BEGIN
      INSERT INTO archival_fts(rowid, content, tags)
      VALUES (new.rowid, oc_fts_cjk_tokens(new.content), oc_fts_cjk_tokens(new.tags));
    END;

    CREATE TRIGGER archival_ad AFTER DELETE ON archival BEGIN
      DELETE FROM archival_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER archival_au AFTER UPDATE OF content, tags ON archival BEGIN
      DELETE FROM archival_fts WHERE rowid = old.rowid;
      INSERT INTO archival_fts(rowid, content, tags)
      VALUES (new.rowid, oc_fts_cjk_tokens(new.content), oc_fts_cjk_tokens(new.tags));
    END;
  `)
}

/**
 * Rebuild archival_fts from the `archival` base table (source of truth).
 * Display always reads `archival.content`, so tokenizing the FTS copy is safe.
 */
export function migrateArchivalFtsCjk(db: Database.Database): FtsCjkMigrateResult {
  const started = Date.now()
  registerFtsCjkFunctions(db)
  if (!tableExists(db, 'archival')) {
    return { action: 'skipped', rows: 0, ms: Date.now() - started, reason: 'no archival table' }
  }
  if (!tableExists(db, 'archival_fts')) {
    db.exec(ARCHIVAL_FTS_DDL)
  }

  const marked = getSchemaKv(db, FTS_CJK_ARCHIVAL_KEY) === FTS_CJK_VERSION
  if (marked) {
    installArchivalCjkTriggers(db)
    return { action: 'skipped', rows: countRows(db, 'archival'), ms: Date.now() - started }
  }

  const rows = db.transaction(() => {
    // Direct FTS writes do not fire archival_* triggers.
    db.exec('DELETE FROM archival_fts')
    db.exec(`
      INSERT INTO archival_fts(rowid, content, tags)
      SELECT rowid, oc_fts_cjk_tokens(content), oc_fts_cjk_tokens(tags) FROM archival
    `)
    const base = countRows(db, 'archival')
    const fts = countRows(db, 'archival_fts')
    if (base !== fts) {
      throw new Error(`archival_fts CJK rebuild count mismatch: base=${base} fts=${fts}`)
    }
    installArchivalCjkTriggers(db)
    setSchemaKv(db, FTS_CJK_ARCHIVAL_KEY, FTS_CJK_VERSION)
    return base
  })()
  return { action: 'rebuilt', rows, ms: Date.now() - started }
}

export function migrateFtsCjk(db: Database.Database): {
  sessions: FtsCjkMigrateResult
  archival: FtsCjkMigrateResult
} {
  registerFtsCjkFunctions(db)
  return {
    sessions: migrateSessionsFtsCjk(db),
    archival: migrateArchivalFtsCjk(db),
  }
}
