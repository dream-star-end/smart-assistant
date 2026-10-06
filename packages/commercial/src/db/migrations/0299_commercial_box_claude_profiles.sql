-- order-dependency: 0298_commercial_box_api_context_1m
-- 0299 commercial-only: Claude Code logins ("profiles") on a Box account.
--
-- One Cursor account owns one Box. That Box can hold several Claude Code logins,
-- each in its own CLAUDE_CONFIG_DIR (default `/home/box/.claude`, others
-- `/home/box/.claude-<name>`). Until now the Box route used exactly one login
-- (the default directory), so when its 5-hour quota ran out every Box Claude
-- turn failed. This table records which logins an admin discovered on a Box,
-- which of them are enabled for scheduling, which one is the default, and what
-- the runs reported about each (quota utilization, cooldown). Credentials never
-- enter this table: only a masked email hint, a one-way account fingerprint and
-- the login/projects state read by the discovery script.
--
-- An account with no rows keeps today's behaviour (implicit default login), so
-- the migration changes nothing until an admin runs discovery from the account
-- pool page.
--
-- BEGIN TESTED MANUAL ROLLBACK 0299
-- DROP TABLE IF EXISTS box_claude_profiles;
-- DELETE FROM schema_migrations WHERE version = '0299_commercial_box_claude_profiles';
-- END TESTED MANUAL ROLLBACK 0299

CREATE TABLE IF NOT EXISTS box_claude_profiles (
  account_id          BIGINT NOT NULL REFERENCES claude_accounts(id) ON DELETE CASCADE,
  profile             TEXT NOT NULL
                      CHECK (profile ~ '^(default|[a-z0-9][a-z0-9-]{0,31})$'),
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  is_default          BOOLEAN NOT NULL DEFAULT FALSE,
  login_state         TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (login_state IN ('unknown', 'logged_in', 'logged_out')),
  projects_mode       TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (projects_mode IN ('unknown', 'root', 'shared', 'absent', 'own')),
  email_hint          TEXT,
  account_fingerprint TEXT,
  org_type            TEXT,
  discovered_at       TIMESTAMPTZ,
  last_seen_at        TIMESTAMPTZ,
  utilization         REAL,
  cooldown_until      TIMESTAMPTZ,
  last_reason         TEXT,
  health_updated_at   TIMESTAMPTZ,
  updated_by          BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, profile),
  CHECK (NOT is_default OR enabled)
);

-- At most one default login per Box account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bcp_one_default
  ON box_claude_profiles (account_id) WHERE is_default;

COMMENT ON TABLE box_claude_profiles IS
  'Claude Code logins (CLAUDE_CONFIG_DIR profiles) discovered on a Box account; enabled ones take part in Box model scheduling. No credentials.';
