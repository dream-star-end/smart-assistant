-- order-dependency: 0349_user_site_collaborators
-- compat: purely additive nullable columns and indexes on existing tables;
--   pre-0350 binaries ignore them and rollback drops them without data loss.
--   OCV5-824: cure GET /api/sessions/:id TOAST/EXISTS slow query, sidebar
--   listClientSessions JSON expansion & full-table window scan, WS hello
--   unbounded BYTEA fact scan, and retired live_frames maintenance pruning.

-- 1. Tape record precomputed byte sizes & superseded API-error flag
--    (NULL on legacy rows -> read path seamlessly falls back to octet_length / EXISTS).
ALTER TABLE client_session_turn_tape_records
  ADD COLUMN IF NOT EXISTS payload_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS visible_payload_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS is_superseded_api_error BOOLEAN;

-- 2. Sidebar preview & latest terminal dispatch summary cache on client_sessions
--    (NULL on legacy rows -> listClientSessions safely falls back to SQL JSON/LATERAL).
ALTER TABLE client_sessions
  ADD COLUMN IF NOT EXISTS last_preview TEXT,
  ADD COLUMN IF NOT EXISTS last_dispatch_summary JSONB;

-- 3. O(1) latest turn_status / turn_usage pointer columns on client_session_live_streams
--    (NULL on legacy streams -> sessionSnapshot safely falls back to bounded BYTEA scan).
ALTER TABLE client_session_live_streams
  ADD COLUMN IF NOT EXISTS latest_turn_status_json JSONB,
  ADD COLUMN IF NOT EXISTS latest_turn_usage_json JSONB;

-- 4. Partial indexes to eliminate full-table scans on turn_dispatches (listClientSessions
--    LATERAL fallback & WS hello batch aggregation) and retired live_streams pruning.
CREATE INDEX IF NOT EXISTS idx_turn_dispatches_user_session_terminal
  ON turn_dispatches (user_id, session_id, terminal_at DESC NULLS LAST, admitted_at DESC, dispatch_id DESC)
  WHERE status = 'terminal';

CREATE INDEX IF NOT EXISTS idx_turn_dispatches_user_session_open
  ON turn_dispatches (user_id, session_id, admitted_at DESC, dispatch_id DESC)
  WHERE status IN ('admitted', 'accepted', 'rejecting');

CREATE INDEX IF NOT EXISTS idx_live_streams_retired_updated
  ON client_session_live_streams (updated_at)
  WHERE provenance ? 'retired_at' AND source = 'gateway';
