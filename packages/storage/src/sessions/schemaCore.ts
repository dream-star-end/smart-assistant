import type Database from 'better-sqlite3'
import { migrateSessionsFtsCjk } from '../ftsCjkMigrate.js'
import { ensureSessionsDbObservabilityIndexes } from '../sessionsDbIndexes.js'

/**
 * E10 — unified triage for idempotent schema migrations: ignore duplicate
 * column errors, log any other SQLite error and continue opening.
 */
export function logMigrationFailure(step: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  if (/duplicate column name/i.test(msg)) return
  console.error(`[sessionsDb] schema migration "${step}" failed (continuing):`, msg)
}

function ensureSessionMetaAndFtsTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions_meta (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      title TEXT,
      started_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_last_at ON sessions_meta(last_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions_meta(agent_id);

    CREATE TABLE IF NOT EXISTS auto_dream_success_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_dream_success_agent_seq
      ON auto_dream_success_events(agent_id, seq);

    CREATE TABLE IF NOT EXISTS session_turn_counters (
      session_id TEXT PRIMARY KEY,
      last_reserved_turn INTEGER NOT NULL CHECK (last_reserved_turn >= 0)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED,
      turn_idx UNINDEXED,
      role UNINDEXED,
      content,
      content_fts,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `)
}

function ensureEventUsageAndMemoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      terminal_status TEXT NOT NULL DEFAULT 'completed'
    );

    CREATE TABLE IF NOT EXISTS memory_usage_events (
      event_id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      turn_index INTEGER,
      operation TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      policy_reason TEXT,
      retrieval_mode TEXT,
      result_count INTEGER,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      query_hash TEXT,
      query_chars INTEGER,
      top_match_hash TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      freshness_gap INTEGER,
      reported_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS memory_turn_context (
      session_key TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      current_fact_intent INTEGER NOT NULL DEFAULT 0,
      intent_kind TEXT,
      evidence_seen INTEGER NOT NULL DEFAULT 0,
      memory_used INTEGER NOT NULL DEFAULT 0,
      soft_reminder_active INTEGER NOT NULL DEFAULT 0,
      freshness_gap INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(session_key, turn_index)
    );

    CREATE TABLE IF NOT EXISTS memory_usage_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_usage_local (
      slug TEXT NOT NULL,
      layer TEXT NOT NULL DEFAULT 'user',
      use_count INTEGER NOT NULL DEFAULT 0,
      search_hit_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      last_search_hit_at INTEGER,
      PRIMARY KEY (slug, layer)
    );
  `)
}

export function ensureCoreObservabilityTables(db: Database.Database): void {
  ensureSessionMetaAndFtsTables(db)
  ensureEventUsageAndMemoryTables(db)
}

function migrateEventLogColumns(db: Database.Database): void {
  try {
    const cols = db.pragma('table_info(event_log)') as Array<{ name: string }>
    if (cols.some((c) => c.name === 'session_id') && !cols.some((c) => c.name === 'session_key')) {
      db.exec('ALTER TABLE event_log RENAME COLUMN session_id TO session_key')
    }
  } catch (err) {
    logMigrationFailure('event_log rename session_id→session_key', err)
  }

  try {
    const cols = db.pragma('table_info(event_log)') as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'peer_id')) {
      db.exec("ALTER TABLE event_log ADD COLUMN peer_id TEXT DEFAULT ''")
    }
    if (!cols.some((c) => c.name === 'channel')) {
      db.exec("ALTER TABLE event_log ADD COLUMN channel TEXT DEFAULT ''")
    }
  } catch (err) {
    logMigrationFailure('event_log add peer_id/channel', err)
  }
}

function migrateUsageLogSchema(db: Database.Database): void {
  try {
    const idxs = db.pragma('index_list(usage_log)') as Array<{ name: string; unique: number }>
    if (!idxs.some((i) => i.name === 'idx_usage_log_dedup')) {
      db.exec(`
        DELETE FROM usage_log WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM usage_log GROUP BY session_id, turn_index
        )
      `)
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_dedup ON usage_log(session_id, turn_index)',
      )
    }
  } catch (err) {
    logMigrationFailure('usage_log dedup unique index', err)
  }

  try {
    const usageCols = db.pragma('table_info(usage_log)') as Array<{ name: string }>
    if (!usageCols.some((c) => c.name === 'terminal_status')) {
      db.exec("ALTER TABLE usage_log ADD COLUMN terminal_status TEXT NOT NULL DEFAULT 'completed'")
    }
  } catch (err) {
    logMigrationFailure('usage_log add terminal_status', err)
  }
}

export function migrateObservabilityTables(db: Database.Database): void {
  migrateEventLogColumns(db)
  migrateUsageLogSchema(db)
  ensureSessionsDbObservabilityIndexes(db)
  migrateSessionsFtsCjk(db)
}
