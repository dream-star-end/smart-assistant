-- Rollback for 0346_commercial_perf_timeline_and_live_snapshot.sql (OCV5-824 / OCV5-856)
DROP TRIGGER IF EXISTS trg_client_sessions_invalidate_last_preview ON client_sessions;
DROP FUNCTION IF EXISTS trg_client_sessions_invalidate_last_preview();

ALTER TABLE client_session_live_streams
  DROP COLUMN IF EXISTS latest_turn_usage_seq,
  DROP COLUMN IF EXISTS latest_turn_status_seq,
  DROP COLUMN IF EXISTS latest_turn_usage_json,
  DROP COLUMN IF EXISTS latest_turn_status_json;

ALTER TABLE client_sessions
  DROP COLUMN IF EXISTS last_preview;

ALTER TABLE client_session_turn_tape_records
  DROP COLUMN IF EXISTS is_superseded_api_error,
  DROP COLUMN IF EXISTS visible_payload_bytes,
  DROP COLUMN IF EXISTS payload_bytes;
