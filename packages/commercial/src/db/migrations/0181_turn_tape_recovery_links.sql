-- 0181_turn_tape_recovery_links — audited, non-billable recovery of a retry
-- whose original immutable tape identity was already occupied by a synthetic
-- terminal record. The source tape and financial rows remain untouched.

CREATE TABLE turn_tape_recovery_links (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_tape_id TEXT NOT NULL,
  recovery_tape_id TEXT NOT NULL,
  source_tape_sha256 TEXT NOT NULL CHECK (source_tape_sha256 ~ '^[0-9a-f]{64}$'),
  recovery_tape_sha256 TEXT NOT NULL CHECK (recovery_tape_sha256 ~ '^[0-9a-f]{64}$'),
  source_turn_key TEXT NOT NULL CHECK (source_turn_key ~ '^[0-9a-f]{64}$'),
  recovery_turn_key TEXT NOT NULL CHECK (recovery_turn_key ~ '^[0-9a-f]{64}$'),
  authorized_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason = 'held_retry_conflict'),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (session_id,user_id,recovery_tape_id),
  UNIQUE (session_id,user_id,source_tape_id),
  CHECK (source_tape_id <> recovery_tape_id),
  CHECK (source_turn_key <> recovery_turn_key),
  FOREIGN KEY (session_id)
    REFERENCES client_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id,user_id,source_tape_id)
    REFERENCES client_session_turn_tapes(session_id,user_id,tape_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (session_id,user_id,recovery_tape_id)
    REFERENCES client_session_turn_tapes(session_id,user_id,tape_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

COMMENT ON TABLE turn_tape_recovery_links IS
  'Superadmin-authorized one-to-one provenance. Source tape and costs stay immutable; recovery tape is content-only.';
