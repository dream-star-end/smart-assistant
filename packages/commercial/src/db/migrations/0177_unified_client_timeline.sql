-- 0177_unified_client_timeline — stable cursor epoch for the browser's one
-- real chronological record stream.  This is intentionally independent from
-- history_revision: ordinary append, hot/archive spill and mutable billing
-- overlays must not evict history pages that the user has already loaded.

ALTER TABLE client_sessions
  ADD COLUMN IF NOT EXISTS timeline_generation BIGINT NOT NULL DEFAULT 1
    CHECK (timeline_generation >= 1);

COMMENT ON COLUMN client_sessions.timeline_generation IS
  'Browser timeline cursor epoch; advances only when durable timeline unit identity/order changes.';
