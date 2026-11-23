import type Database from 'better-sqlite3'

/**
 * Idempotent secondary indexes for sessions.db observability & memory tables.
 * Includes leading timestamp indexes on event_log and usage_log so retention
 * sweeps (`DELETE ... WHERE timestamp < ?`) use index range scans instead of
 * full-table scans.
 */
export function ensureSessionsDbObservabilityIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_log_type_ts ON event_log(type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_log_agent_ts ON event_log(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_key);
    CREATE INDEX IF NOT EXISTS idx_event_log_peer ON event_log(peer_id);
    CREATE INDEX IF NOT EXISTS idx_usage_log_agent_ts ON usage_log(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_log_timestamp ON usage_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_log_session ON usage_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_usage_agent_ts ON memory_usage_events(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_memory_usage_session_turn ON memory_usage_events(session_key, turn_index);
    CREATE INDEX IF NOT EXISTS idx_memory_usage_pending ON memory_usage_events(reported_at, timestamp);
    CREATE INDEX IF NOT EXISTS idx_memory_turn_context_agent_ts ON memory_turn_context(agent_id, created_at);
  `)
}

/**
 * Low-frequency maintenance helper: remove orphaned sessions_fts rows that no
 * longer have a matching sessions_meta row. Deliberately excluded from
 * getSessionsDb() cold start to avoid full-table FTS scans during boot.
 */
export function pruneOrphanedSessionsFtsRows(db: Database.Database): number {
  const result = db
    .prepare(
      'DELETE FROM sessions_fts WHERE NOT EXISTS (SELECT 1 FROM sessions_meta WHERE sessions_meta.id = sessions_fts.session_id)',
    )
    .run()
  return Number(result.changes)
}
