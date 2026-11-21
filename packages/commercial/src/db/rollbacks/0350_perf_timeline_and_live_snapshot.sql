-- Rollback for 0350_perf_timeline_and_live_snapshot.sql (OCV5-824)
DROP INDEX IF EXISTS idx_live_streams_retired_updated;
DROP INDEX IF EXISTS idx_turn_dispatches_user_session_open;
DROP INDEX IF EXISTS idx_turn_dispatches_user_session_terminal;

ALTER TABLE client_session_live_streams
  DROP COLUMN IF EXISTS latest_turn_usage_json,
  DROP COLUMN IF EXISTS latest_turn_status_json;

ALTER TABLE client_sessions
  DROP COLUMN IF EXISTS last_dispatch_summary,
  DROP COLUMN IF EXISTS last_preview;

ALTER TABLE client_session_turn_tape_records
  DROP COLUMN IF EXISTS is_superseded_api_error,
  DROP COLUMN IF EXISTS visible_payload_bytes,
  DROP COLUMN IF EXISTS payload_bytes;
