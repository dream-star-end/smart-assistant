-- no-transaction
-- Rollback for 0351_perf_timeline_and_live_snapshot_indexes.sql (OCV5-824)
DROP INDEX CONCURRENTLY IF EXISTS idx_live_streams_retired_updated;
DROP INDEX CONCURRENTLY IF EXISTS idx_turn_dispatches_user_session_open;
DROP INDEX CONCURRENTLY IF EXISTS idx_turn_dispatches_user_session_terminal;
