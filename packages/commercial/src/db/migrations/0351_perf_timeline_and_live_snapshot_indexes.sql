-- no-transaction
-- order-dependency: 0350_perf_timeline_and_live_snapshot
-- OCV5-824 (B1 + B5): online CONCURRENTLY partial indexes separated from 0350's
-- short ALTER TABLE transaction so ACCESS EXCLUSIVE locks never span index
-- builds and normal table reads/writes stay unblocked during index creation.
--
-- Fail-loud preflight (follows 0265_desktop_kind_unique_index.sql precedent):
-- if an earlier interrupted CONCURRENTLY build left any invalid index with one
-- of these names, abort loudly with the DROP INDEX CONCURRENTLY runbook instead
-- of silently skipping via IF NOT EXISTS and recording schema_migrations.

-- compat: read-only pg_class/pg_index preflight checking only the four new 0351 index names for indisvalid=false; mutates no schema or rows and is safe for pre-0351 binaries and rollbacks
DO $$
DECLARE
  invalid_names TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO invalid_names
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname IN (
     'idx_turn_dispatches_user_session_terminal',
     'idx_turn_dispatches_user_session_open',
     'idx_live_streams_retired_updated',
     'idx_live_frames_stream_frame_seq'
   )
     AND NOT i.indisvalid;
  IF invalid_names IS NOT NULL THEN
    RAISE EXCEPTION '0351 fail-loud: invalid index(es) detected (%). Runbook: DROP INDEX CONCURRENTLY <name>; then re-run migrate. Do not insert into schema_migrations.', invalid_names;
  END IF;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_turn_dispatches_user_session_terminal
  ON turn_dispatches (user_id, session_id, terminal_at DESC NULLS LAST, admitted_at DESC, dispatch_id DESC)
  WHERE status = 'terminal';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_turn_dispatches_user_session_open
  ON turn_dispatches (user_id, session_id, admitted_at DESC, dispatch_id DESC)
  WHERE status IN ('admitted', 'accepted', 'rejecting');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_live_streams_retired_updated
  ON client_session_live_streams (updated_at)
  WHERE provenance ? 'retired_at' AND source = 'gateway';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_live_frames_stream_frame_seq
  ON client_session_live_frames (stream_key, frame_seq DESC, record_id DESC)
  WHERE frame_seq IS NOT NULL;

-- Postflight: verify all 4 indexes are valid before schema_migrations records 0351.
-- compat: read-only pg_class/pg_index postflight verifying all four new CONCURRENTLY indexes are valid; mutates no schema or rows and rollback drops only these four indexes
DO $$
DECLARE
  missing_or_invalid TEXT;
BEGIN
  SELECT string_agg(req.name, ', ' ORDER BY req.name)
    INTO missing_or_invalid
    FROM (
      VALUES
        ('idx_turn_dispatches_user_session_terminal'),
        ('idx_turn_dispatches_user_session_open'),
        ('idx_live_streams_retired_updated'),
        ('idx_live_frames_stream_frame_seq')
    ) AS req(name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = req.name
        AND i.indisvalid
   );
  IF missing_or_invalid IS NOT NULL THEN
    RAISE EXCEPTION '0351 fail-loud: required index(es) missing or invalid (%). Runbook: DROP INDEX CONCURRENTLY <name>; then re-run migrate.', missing_or_invalid;
  END IF;
END $$;
