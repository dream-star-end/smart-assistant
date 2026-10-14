-- order-dependency: 0304_billing_workload_column
-- 0306 (selfhost) OCV5-424: per-service pools under one shared scheduling policy.
--
-- Every service keeps its own pool (claude/codex/grok accounts in claude_accounts,
-- codex relay keys in api_relay_credentials, Box logins in box_claude_profiles, and
-- API keys for Anthropic / static providers / Gemini in the new pool_api_keys). The
-- shared policy (account-pool/policy) decides cooldowns for all of them and never
-- writes 'disabled': disabled is an admin decision only, recorded in disabled_by in
-- the same UPDATE that changes status.
--
-- Additive only: new nullable/defaulted columns, two new tables, and a backfill that
-- marks every row that is disabled today as an admin decision (its origin cannot be
-- proven, so it stays disabled; see docs/ocv5-424-pool-policy.md).
-- Rollback: db/rollbacks/0306_pool_policy.sql.
--
-- BEGIN TESTED MANUAL ROLLBACK 0306
-- DROP TABLE IF EXISTS pool_events;
-- DROP TABLE IF EXISTS pool_api_keys;
-- DELETE FROM schema_migrations WHERE version = '0306_pool_policy';
-- END TESTED MANUAL ROLLBACK 0306

ALTER TABLE claude_accounts ADD COLUMN IF NOT EXISTS cooldown_reason TEXT
  CONSTRAINT claude_accounts_cooldown_reason_check
  CHECK (cooldown_reason IN ('rate_limited', 'quota', 'auth', 'credential', 'upstream'));
ALTER TABLE claude_accounts ADD COLUMN IF NOT EXISTS backoff_level SMALLINT NOT NULL DEFAULT 0
  CONSTRAINT claude_accounts_backoff_level_check CHECK (backoff_level BETWEEN 0 AND 30);
ALTER TABLE claude_accounts ADD COLUMN IF NOT EXISTS next_probe_at TIMESTAMPTZ;
ALTER TABLE claude_accounts ADD COLUMN IF NOT EXISTS disabled_by TEXT
  CONSTRAINT claude_accounts_disabled_by_check CHECK (disabled_by = 'admin');

ALTER TABLE api_relay_credentials ADD COLUMN IF NOT EXISTS cooldown_reason TEXT
  CONSTRAINT api_relay_credentials_cooldown_reason_check
  CHECK (cooldown_reason IN ('rate_limited', 'quota', 'auth', 'credential', 'upstream'));
ALTER TABLE api_relay_credentials ADD COLUMN IF NOT EXISTS backoff_level SMALLINT NOT NULL DEFAULT 0
  CONSTRAINT api_relay_credentials_backoff_level_check CHECK (backoff_level BETWEEN 0 AND 30);
ALTER TABLE api_relay_credentials ADD COLUMN IF NOT EXISTS next_probe_at TIMESTAMPTZ;
ALTER TABLE api_relay_credentials ADD COLUMN IF NOT EXISTS disabled_by TEXT
  CONSTRAINT api_relay_credentials_disabled_by_check CHECK (disabled_by = 'admin');

ALTER TABLE box_claude_profiles ADD COLUMN IF NOT EXISTS cooldown_reason TEXT
  CONSTRAINT box_claude_profiles_cooldown_reason_check
  CHECK (cooldown_reason IN ('rate_limited', 'quota', 'auth', 'credential', 'upstream'));
ALTER TABLE box_claude_profiles ADD COLUMN IF NOT EXISTS backoff_level SMALLINT NOT NULL DEFAULT 0
  CONSTRAINT box_claude_profiles_backoff_level_check CHECK (backoff_level BETWEEN 0 AND 30);

-- API keys of every service that has no account row: Anthropic keys (claude pool),
-- static providers (deepseek, minimax, ...), Gemini. Keys are AES-256-GCM like
-- OAuth tokens; only the fingerprint (sha256 prefix + last 4) is ever shown.
CREATE TABLE IF NOT EXISTS pool_api_keys (
  id               BIGSERIAL PRIMARY KEY,
  service          TEXT NOT NULL CHECK (service ~ '^[a-z][a-z0-9-]{1,31}$'),
  label            TEXT NOT NULL DEFAULT '' CHECK (char_length(label) <= 80),
  key_enc          BYTEA NOT NULL,
  key_nonce        BYTEA NOT NULL,
  fingerprint      TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
  key_hint         TEXT NOT NULL DEFAULT '' CHECK (char_length(key_hint) <= 8),
  source           TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'env')),
  tier             SMALLINT NOT NULL DEFAULT 1 CHECK (tier BETWEEN 0 AND 9),
  weight           SMALLINT NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 1000),
  egress_proxy_id  BIGINT REFERENCES egress_proxies(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cooldown', 'disabled')),
  disabled_by      TEXT CHECK (disabled_by = 'admin'),
  health_score     SMALLINT NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  cooldown_until   TIMESTAMPTZ,
  cooldown_reason  TEXT CHECK (cooldown_reason IN ('rate_limited', 'quota', 'auth', 'credential', 'upstream')),
  backoff_level    SMALLINT NOT NULL DEFAULT 0 CHECK (backoff_level BETWEEN 0 AND 30),
  next_probe_at    TIMESTAMPTZ,
  success_count    BIGINT NOT NULL DEFAULT 0,
  fail_count       BIGINT NOT NULL DEFAULT 0,
  last_error       TEXT,
  last_used_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pool_api_keys_service_fingerprint_uniq UNIQUE (service, fingerprint),
  CONSTRAINT pool_api_keys_disabled_by_status_check
    CHECK ((status = 'disabled') = (disabled_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pool_api_keys_service_status_idx ON pool_api_keys (service, status);

-- Shared audit of every policy transition (all pools). Kept 30 days by the
-- audit retention sweeper.
CREATE TABLE IF NOT EXISTS pool_events (
  id           BIGSERIAL PRIMARY KEY,
  service      TEXT NOT NULL,
  member_kind  TEXT NOT NULL CHECK (member_kind IN ('account', 'relay_key', 'api_key', 'box_profile')),
  member_id    TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  reason       TEXT,
  until_at     TIMESTAMPTZ,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pool_events_at_idx ON pool_events (at);
CREATE INDEX IF NOT EXISTS pool_events_member_idx ON pool_events (member_kind, member_id, at DESC);

-- Existing disabled rows: origin unknown → treated as an admin decision (stay disabled).
UPDATE claude_accounts SET disabled_by = 'admin'
 WHERE status = 'disabled' AND disabled_by IS NULL;
UPDATE api_relay_credentials SET disabled_by = 'admin'
 WHERE status = 'disabled' AND disabled_by IS NULL;
