-- Knowledge Planet unattended auto-reply. Separate from human confirmation ledger.

CREATE TABLE IF NOT EXISTS plugin_automation_controls (
  connection_id BIGINT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  disclaimer_version INTEGER,
  disclaimer_accepted_at TIMESTAMPTZ,
  account_daily_limit SMALLINT NOT NULL DEFAULT 10 CHECK (account_daily_limit BETWEEN 1 AND 30),
  paused_reason VARCHAR(64),
  revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, user_id),
  CHECK (
    NOT enabled OR (
      disclaimer_version IS NOT NULL AND disclaimer_version > 0
      AND disclaimer_accepted_at IS NOT NULL
      AND paused_reason IS NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS plugin_automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  group_id VARCHAR(32) NOT NULL CHECK (group_id ~ '^[0-9]{6,32}$'),
  name VARCHAR(100) NOT NULL,
  instructions VARCHAR(4000) NOT NULL,
  trigger_kind VARCHAR(24) NOT NULL DEFAULT 'new_topic'
    CHECK (trigger_kind IN ('new_topic', 'new_question')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cursor_topic_id VARCHAR(32),
  cursor_created_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  daily_limit SMALLINT NOT NULL DEFAULT 5 CHECK (daily_limit BETWEEN 1 AND 10),
  cooldown_minutes SMALLINT NOT NULL DEFAULT 15 CHECK (cooldown_minutes BETWEEN 5 AND 1440),
  max_reply_chars SMALLINT NOT NULL DEFAULT 800 CHECK (max_reply_chars BETWEEN 100 AND 1200),
  consecutive_failures SMALLINT NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 32767),
  paused_reason VARCHAR(64),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, user_id)
    REFERENCES plugin_automation_controls(connection_id, user_id) ON DELETE CASCADE,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  -- Empty groups have no exact topic anchor. In that case cursor_created_at is the no-backfill
  -- boundary and cursor_topic_id remains NULL until the first post-enable topic is observed.
  CHECK (NOT enabled OR cursor_created_at IS NOT NULL),
  CHECK (NOT enabled OR paused_reason IS NULL)
);

CREATE INDEX IF NOT EXISTS plugin_automation_rules_due
  ON plugin_automation_rules(next_run_at, id)
  WHERE deleted_at IS NULL AND enabled = TRUE AND paused_reason IS NULL;
CREATE INDEX IF NOT EXISTS plugin_automation_rules_account
  ON plugin_automation_rules(user_id, connection_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_automation_rules_active_group
  ON plugin_automation_rules(connection_id, group_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS plugin_automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES plugin_automation_rules(id) ON DELETE CASCADE,
  connection_id BIGINT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_topic_id VARCHAR(32) NOT NULL CHECK (source_topic_id ~ '^[0-9]{6,32}$'),
  source_created_at TIMESTAMPTZ NOT NULL,
  source_hash BYTEA NOT NULL CHECK (octet_length(source_hash) = 32),
  status VARCHAR(16) NOT NULL CHECK (
    status IN ('reserved','generating','ready','dispatching','succeeded','skipped','failed','unknown')
  ),
  reason_code VARCHAR(64),
  reply_enc BYTEA,
  reply_nonce BYTEA,
  reply_key_version INTEGER NOT NULL DEFAULT 1,
  reply_hash BYTEA,
  billing_request_id VARCHAR(128) NOT NULL UNIQUE,
  dispatch_claim_token UUID,
  dispatch_claim_until TIMESTAMPTZ,
  dispatch_owner_token UUID,
  dispatch_armed_at TIMESTAMPTZ,
  upstream_comment_id VARCHAR(32),
  result_digest VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (rule_id, source_topic_id),
  CHECK ((reply_enc IS NULL) = (reply_nonce IS NULL)),
  CHECK (reply_hash IS NULL OR octet_length(reply_hash) = 32),
  CHECK ((dispatch_claim_token IS NULL) = (dispatch_claim_until IS NULL)),
  CHECK (dispatch_claim_token IS NULL OR status = 'ready'),
  CHECK (dispatch_owner_token IS NULL OR status = 'dispatching'),
  CHECK (
    status NOT IN ('ready','dispatching')
    OR (reply_enc IS NOT NULL AND reply_nonce IS NOT NULL AND reply_hash IS NOT NULL)
  ),
  CHECK (
    status <> 'dispatching'
    OR (dispatch_armed_at IS NOT NULL AND dispatch_owner_token IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('succeeded','skipped','failed','unknown')
    OR finished_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS plugin_automation_runs_ready
  ON plugin_automation_runs(status, created_at, id)
  WHERE status IN ('reserved','ready','dispatching');
CREATE INDEX IF NOT EXISTS plugin_automation_runs_daily
  ON plugin_automation_runs(connection_id, user_id, created_at, status);
CREATE INDEX IF NOT EXISTS plugin_automation_runs_rule_daily
  ON plugin_automation_runs(rule_id, created_at, status);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_automation_runs_one_dispatching_per_account
  ON plugin_automation_runs(connection_id)
  WHERE status = 'dispatching';

COMMENT ON TABLE plugin_automation_controls IS
  'Independent high-risk consent and emergency kill switch for unattended Plugin replies';
COMMENT ON TABLE plugin_automation_rules IS
  'Per-group Knowledge Planet auto-reply rules; first enable seeds newest cursor and never backfills';
COMMENT ON TABLE plugin_automation_runs IS
  'Durable per-source auto-reply idempotency, billing and dispatch-fence audit';
