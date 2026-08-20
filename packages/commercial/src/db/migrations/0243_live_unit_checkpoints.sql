-- 0243_live_unit_checkpoints — derived full-fold cache for GET view=units.
-- Frames remain the authority. This row is a rebuildable cache: epoch mismatch
-- or JSON failure falls back to a live reduce. K/preview windows are never
-- stored (B2). live→tape prune deletes the row with the stream.

CREATE TABLE client_session_live_unit_checkpoints (
  stream_key          TEXT PRIMARY KEY
                        REFERENCES client_session_live_streams(stream_key) ON DELETE CASCADE,
  session_id          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  reducer_epoch       TEXT NOT NULL,
  through_frame_seq   BIGINT NOT NULL CHECK (through_frame_seq > 0),
  through_record_id   BIGINT NOT NULL CHECK (through_record_id > 0),
  units_jsonb         JSONB NOT NULL,
  session_key         TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_unit_checkpoint_session
  ON client_session_live_unit_checkpoints(user_id, session_id);

COMMENT ON TABLE client_session_live_unit_checkpoints IS
  'Derived full-fold cache for in-flight live-unit hydrate. Not billing/tape authority.';
