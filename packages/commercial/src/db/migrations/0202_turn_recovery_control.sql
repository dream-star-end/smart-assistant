-- 0202_turn_recovery_control — Master-owned durable controls and automatic
-- recovery scheduling.  All tables are additive and rollback-safe: older
-- runtimes ignore them while newer Masters retain pending work across process
-- restarts and browser disconnects.

CREATE TABLE IF NOT EXISTS turn_permission_requests (
  user_id                BIGINT NOT NULL,
  request_id             TEXT NOT NULL,
  session_id             TEXT NOT NULL,
  client_message_id      TEXT,
  tool_use_id            TEXT,
  tool_name              TEXT NOT NULL,
  input_sha256           TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  input_json             JSONB NOT NULL,
  ask_payload_json       JSONB,
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','responded','expired','cancelled')),
  expires_at             TIMESTAMPTZ NOT NULL,
  response_control_id    TEXT,
  response_json          JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_turn_permission_pending
  ON turn_permission_requests (expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS turn_recovery_jobs (
  job_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   BIGINT NOT NULL,
  session_id                TEXT NOT NULL,
  root_client_message_id    TEXT NOT NULL,
  source_client_message_id  TEXT NOT NULL,
  source_turn_key           TEXT NOT NULL,
  error_code                TEXT NOT NULL,
  recovery_mode             TEXT NOT NULL CHECK (recovery_mode IN ('replay','checkpoint')),
  semantic_recovery_attempt INTEGER NOT NULL
                              CHECK (semantic_recovery_attempt BETWEEN 1 AND 10),
  transport_wait_attempt    INTEGER NOT NULL DEFAULT 0 CHECK (transport_wait_attempt >= 0),
  request_json              JSONB NOT NULL,
  tape_sha256               TEXT NOT NULL CHECK (tape_sha256 ~ '^[0-9a-f]{64}$'),
  status                    TEXT NOT NULL DEFAULT 'queued'
                              CHECK (status IN (
                                'queued','leased','sent','forwarded','completed','paused',
                                'cancelled','manual_reconcile'
                              )),
  lease_owner               TEXT,
  lease_epoch               BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until               TIMESTAMPTZ,
  next_attempt_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pause_reason              TEXT,
  dispatch_id               UUID,
  dispatch_attempt_no       INTEGER,
  terminal_outcome          TEXT CHECK (terminal_outcome IN ('completed','interrupted','crashed')),
  container_receipt_at      TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, session_id, root_client_message_id, semantic_recovery_attempt)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_recovery_dispatch
  ON turn_recovery_jobs (dispatch_id,dispatch_attempt_no)
  WHERE dispatch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_turn_recovery_due
  ON turn_recovery_jobs (next_attempt_at, created_at)
  WHERE status IN ('queued','leased','sent');

CREATE INDEX IF NOT EXISTS idx_turn_recovery_root
  ON turn_recovery_jobs (user_id, session_id, root_client_message_id, semantic_recovery_attempt);

CREATE TABLE IF NOT EXISTS turn_control_requests (
  control_id              TEXT PRIMARY KEY,
  user_id                 BIGINT NOT NULL,
  session_id              TEXT NOT NULL,
  root_client_message_id  TEXT,
  kind                    TEXT NOT NULL CHECK (kind IN ('stop','permission')),
  request_id              TEXT,
  payload_json            JSONB NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','leased','applied','terminal','cancelled')),
  lease_owner             TEXT,
  lease_epoch             BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until             TIMESTAMPTZ,
  delivery_attempt        INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempt >= 0),
  next_attempt_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_code              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at              TIMESTAMPTZ,
  terminal_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_turn_control_due
  ON turn_control_requests (user_id, next_attempt_at, created_at)
  WHERE status IN ('pending','leased');

COMMENT ON TABLE turn_permission_requests IS
  'Master-authoritative permission prompt identity and exact sanitized input contract; browser disconnect does not imply denial.';
COMMENT ON TABLE turn_recovery_jobs IS
  'Master-owned automatic semantic recovery scheduler. semantic_recovery_attempt advances only after durable runtime receipt; transport_wait_attempt is backoff-only.';
COMMENT ON TABLE turn_control_requests IS
  'Durable Stop/permission response outbox. Stop admission atomically cancels queued recovery descendants for the same root.';
