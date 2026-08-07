-- 0201_durable_live_turn_frames — persist every browser-visible runtime frame
-- before it is forwarded.  Immutable turn tapes remain the completed-turn
-- authority; these rows are the exact live-process authority while a turn is
-- open or ends without a complete tape.

CREATE TABLE client_session_live_streams (
  stream_key            TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES client_sessions(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,
  client_message_id     TEXT,
  dispatch_id           UUID,
  attempt_no            INTEGER,
  agent_container_id    BIGINT,
  source                 TEXT NOT NULL CHECK (source IN ('gateway','rollout_import')),
  projection_source      TEXT NOT NULL DEFAULT 'live'
                           CHECK (projection_source IN ('live','tape')),
  terminal_status        TEXT CHECK (terminal_status IN ('completed','interrupted','crashed')),
  tape_id                TEXT,
  tape_sha256            TEXT,
  import_sha256          TEXT,
  provenance             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((dispatch_id IS NULL) = (attempt_no IS NULL)),
  CHECK (source <> 'rollout_import' OR import_sha256 IS NOT NULL)
);

CREATE UNIQUE INDEX idx_live_stream_dispatch
  ON client_session_live_streams(dispatch_id,attempt_no)
  WHERE source='gateway' AND dispatch_id IS NOT NULL;

CREATE UNIQUE INDEX idx_live_stream_import
  ON client_session_live_streams(import_sha256)
  WHERE source='rollout_import';

CREATE INDEX idx_live_stream_session_projection
  ON client_session_live_streams(user_id,session_id,projection_source,created_at);

CREATE TABLE client_session_live_frames (
  record_id              BIGSERIAL PRIMARY KEY,
  stream_key             TEXT NOT NULL REFERENCES client_session_live_streams(stream_key) ON DELETE CASCADE,
  source                 TEXT NOT NULL CHECK (source IN ('gateway','rollout_import')),
  agent_container_id     BIGINT,
  session_key            TEXT,
  frame_seq              BIGINT,
  import_ordinal         BIGINT,
  payload                 BYTEA NOT NULL,
  payload_sha256          TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (source='gateway' AND agent_container_id IS NOT NULL AND session_key IS NOT NULL
      AND frame_seq IS NOT NULL AND import_ordinal IS NULL)
    OR
    (source='rollout_import' AND agent_container_id IS NULL AND frame_seq IS NULL
      AND import_ordinal IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_live_frame_gateway_identity
  ON client_session_live_frames(agent_container_id,session_key,frame_seq)
  WHERE source='gateway';

CREATE UNIQUE INDEX idx_live_frame_import_identity
  ON client_session_live_frames(stream_key,import_ordinal)
  WHERE source='rollout_import';

CREATE INDEX idx_live_frame_stream_order
  ON client_session_live_frames(stream_key,record_id);

COMMENT ON TABLE client_session_live_streams IS
  'Exact browser process-stream authority. Completed lossless tapes atomically switch projection_source to tape; abnormal turns continue projecting these rows.';
COMMENT ON TABLE client_session_live_frames IS
  'Append-only exact outbound frames committed before browser visibility. No dispatch-retention FK: session/account deletion owns lifecycle.';
