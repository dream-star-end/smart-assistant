-- Rollback for 0347_commercial_perf_timeline_and_live_snapshot_indexes.sql (run outside transaction).

DROP INDEX CONCURRENTLY IF EXISTS idx_live_frames_stream_frame_seq;
DROP INDEX CONCURRENTLY IF EXISTS idx_live_streams_retired_updated;
DROP INDEX CONCURRENTLY IF EXISTS idx_turn_dispatches_user_session_open;
DROP INDEX CONCURRENTLY IF EXISTS idx_turn_dispatches_user_session_terminal;
