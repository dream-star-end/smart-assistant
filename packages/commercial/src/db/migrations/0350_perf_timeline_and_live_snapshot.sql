-- order-dependency: 0349_user_site_collaborators
-- Purely additive nullable columns and single-table preview-invalidation
-- trigger in a short bounded-lock transaction (NO index builds here; indexes
-- live in 0351_perf_timeline_and_live_snapshot_indexes.sql with -- no-transaction
-- and CREATE INDEX CONCURRENTLY).

SET LOCAL lock_timeout = '5s';

-- 1. Tape record precomputed byte sizes & superseded API-error flag
--    (NULL on legacy rows -> read path seamlessly falls back to octet_length / EXISTS).
ALTER TABLE client_session_turn_tape_records
  ADD COLUMN IF NOT EXISTS payload_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS visible_payload_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS is_superseded_api_error BOOLEAN;

-- 2. Sidebar preview cache on client_sessions
--    (NULL on legacy rows or external message writers -> listClientSessions safely
--    falls back to SQL JSON extraction).
ALTER TABLE client_sessions
  ADD COLUMN IF NOT EXISTS last_preview TEXT;

-- compat: purely additive trigger function that only clears the new nullable last_preview column when messages changes without updating last_preview; pre-0350 writers ignore last_preview and rollback drops the trigger and function cleanly
CREATE OR REPLACE FUNCTION trg_client_sessions_invalidate_last_preview()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.messages IS DISTINCT FROM OLD.messages
     AND NEW.last_preview IS NOT DISTINCT FROM OLD.last_preview THEN
    NEW.last_preview := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- compat: idempotent re-run guard scoped exclusively to the new 0350 trigger; never touches pre-0350 triggers or blocks old writers
DROP TRIGGER IF EXISTS trg_client_sessions_invalidate_last_preview ON client_sessions;
-- compat: single-table BEFORE UPDATE OF messages trigger auto-invalidates new nullable last_preview to NULL when pre-0350 or external writers update messages; rollback drops trigger cleanly without affecting old binaries
CREATE TRIGGER trg_client_sessions_invalidate_last_preview
  BEFORE UPDATE OF messages ON client_sessions
  FOR EACH ROW
  EXECUTE FUNCTION trg_client_sessions_invalidate_last_preview();

-- 3. O(1) latest turn_status / turn_usage pointer & sequence tracking columns on
--    client_session_live_streams:
--      seq IS NULL  => legacy un-tracked stream (fall back to bounded frame_seq scan)
--      seq = 0      => tracked stream with no fact of this kind yet (O(1) skip scan)
--      seq > 0      => latest fact frame_seq; if *_json IS NULL (e.g. NUL/surrogate
--                      payload not representable in JSONB), fetch exact frame_seq row.
ALTER TABLE client_session_live_streams
  ADD COLUMN IF NOT EXISTS latest_turn_status_json JSONB,
  ADD COLUMN IF NOT EXISTS latest_turn_usage_json JSONB,
  ADD COLUMN IF NOT EXISTS latest_turn_status_seq BIGINT,
  ADD COLUMN IF NOT EXISTS latest_turn_usage_seq BIGINT;
