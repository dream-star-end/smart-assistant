-- order-dependency: none  (0323 assigned to this branch by 管家 2026-10-23; media-studio draft moves to 0324)
-- OCV5-599 (plan v3.6 §7.4): turn_dispatches carries the canonical traceId of the attempt that
-- owns the row, so a dispatch links forward to its trace without going through turn_traces.
-- Additive only: nullable, no default, no backfill, no constraint, no index (8k rows; lookups by
-- trace go through turn_traces). Old binaries never name the column and keep working.
ALTER TABLE turn_dispatches ADD COLUMN IF NOT EXISTS trace_id TEXT;
COMMENT ON COLUMN turn_dispatches.trace_id IS
  'Master canonical traceId of the owning attempt (x-openclaude-trace-id). NULL for rows admitted before 0323.';
