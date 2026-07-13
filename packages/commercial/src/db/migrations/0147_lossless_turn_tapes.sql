-- 0147_lossless_turn_tapes — lossless server-authored turn persistence.
--
-- Completed/interrupt/crash turn payloads are uploaded as content-addressed
-- parts, materialised into immutable records, and represented in
-- client_sessions by one small anchor.  The full text/tool/delegate payload
-- therefore never depends on the 4 MiB hot-tail JSON limit.

ALTER TABLE pending_usage_patches
  ADD COLUMN turn_key TEXT,
  ADD COLUMN parent_turn_key TEXT;

-- The WeChat broker is another paid-output durability hop. Keep the exact
-- authenticated container payload alongside its iLink rendering, and remove
-- the historical retry-counter ceiling (delivery now retries without a count
-- or age cap; attempts remains diagnostic only).
ALTER TABLE wechat_outbox
  ADD COLUMN raw_payload JSONB;

ALTER TABLE wechat_outbox
  DROP CONSTRAINT IF EXISTS wox_attempts_chk;

ALTER TABLE wechat_outbox
  ADD CONSTRAINT wox_attempts_nonnegative_chk CHECK (attempts >= 0);

CREATE INDEX idx_pup_user_turn_key
  ON pending_usage_patches(user_id, turn_key)
  WHERE turn_key IS NOT NULL;

CREATE INDEX idx_pup_user_parent_turn_key
  ON pending_usage_patches(user_id, parent_turn_key)
  WHERE parent_turn_key IS NOT NULL;

CREATE TABLE client_session_turn_tapes (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tape_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'interrupted', 'crashed')),
  turn_key TEXT NOT NULL CHECK (turn_key ~ '^[0-9a-f]{64}$'),
  parent_turn_key TEXT CHECK (parent_turn_key IS NULL OR parent_turn_key ~ '^[0-9a-f]{64}$'),
  tape_sha256 TEXT NOT NULL CHECK (tape_sha256 ~ '^[0-9a-f]{64}$'),
  total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
  part_count INTEGER NOT NULL CHECK (part_count > 0),
  billing_anchor_id TEXT,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  engine_billings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at BIGINT NOT NULL,
  finalized_at BIGINT,
  PRIMARY KEY (session_id, user_id, tape_id),
  FOREIGN KEY (session_id)
    REFERENCES client_sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_cstt_user_created
  ON client_session_turn_tapes(user_id, created_at);

CREATE TABLE client_session_turn_tape_parts (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tape_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK (part_index >= 0),
  part_sha256 TEXT NOT NULL CHECK (part_sha256 ~ '^[0-9a-f]{64}$'),
  payload BYTEA NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (session_id, user_id, tape_id, part_index),
  FOREIGN KEY (session_id, user_id, tape_id)
    REFERENCES client_session_turn_tapes(session_id, user_id, tape_id)
    ON DELETE CASCADE
);

CREATE TABLE client_session_turn_tape_records (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tape_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  role TEXT NOT NULL,
  ts BIGINT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  payload BYTEA NOT NULL,
  PRIMARY KEY (session_id, user_id, tape_id, msg_id),
  UNIQUE (session_id, user_id, tape_id, ordinal),
  FOREIGN KEY (session_id, user_id, tape_id)
    REFERENCES client_session_turn_tapes(session_id, user_id, tape_id)
    ON DELETE CASCADE
);

CREATE TABLE server_authored_turn_anchor_map (
  user_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tape_id TEXT NOT NULL,
  billing_anchor_id TEXT NOT NULL,
  written_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, turn_key),
  FOREIGN KEY (session_id, user_id, tape_id)
    REFERENCES client_session_turn_tapes(session_id, user_id, tape_id)
    ON DELETE CASCADE
);

CREATE TABLE turn_tape_cost_components (
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tape_id TEXT NOT NULL,
  billing_anchor_id TEXT NOT NULL,
  cost_credits NUMERIC(78, 0) NOT NULL CHECK (cost_credits >= 0),
  delegate_agent_id TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (request_id, user_id),
  FOREIGN KEY (session_id, user_id, tape_id)
    REFERENCES client_session_turn_tapes(session_id, user_id, tape_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_ttcc_anchor
  ON turn_tape_cost_components(user_id, session_id, tape_id, billing_anchor_id);
