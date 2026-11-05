-- order-dependency: 0143_model_catalog
-- OCV5-721: Remote Agent Brain Pool (nodes, profiles, model offers, active bindings)
-- and model_catalog.placement column for transition-period remote model suffixing.
-- compat: Additive tables + additive column with DEFAULT 'local' on model_catalog. Old binaries ignore the new tables and default placement to 'local'. No backfill and no balance change.

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS placement TEXT NOT NULL DEFAULT 'local'
  CHECK (placement IN ('local', 'remote_pool'));

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS pool_auto_disabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN model_catalog.placement IS
  'Execution placement: local (default) or remote_pool (transition-period remote brain pool; projected with " 远端" display suffix).';

COMMENT ON COLUMN model_catalog.pool_auto_disabled IS
  'TRUE when a remote_pool catalog entry was automatically disabled only because eligible enabled pool offers dropped to 0 (FALSE when disabled by a global catalog administrator).';

CREATE TABLE IF NOT EXISTS remote_agent_nodes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label               TEXT NOT NULL UNIQUE,
  ssh_host            TEXT NOT NULL,
  ssh_port            INTEGER NOT NULL DEFAULT 22 CHECK (ssh_port BETWEEN 1 AND 65535),
  ssh_user            TEXT NOT NULL,
  host_key_fp         TEXT NOT NULL,
  key_id              TEXT NOT NULL,
  controller_sha256   TEXT NOT NULL,
  mux_cap_slots       INTEGER NOT NULL DEFAULT 8 CHECK (mux_cap_slots BETWEEN 1 AND 64),
  max_hot_slots       INTEGER NOT NULL DEFAULT 16 CHECK (max_hot_slots BETWEEN 1 AND 128),
  max_active_slots    INTEGER NOT NULL DEFAULT 8 CHECK (max_active_slots BETWEEN 1 AND 64),
  status              TEXT NOT NULL DEFAULT 'pending_verify'
                      CHECK (status IN ('pending_verify', 'active', 'cooldown', 'degraded', 'disabled')),
  disabled_by         TEXT CHECK (disabled_by IN ('admin', 'probe_failed', 'host_key_mismatch')),
  health_score        SMALLINT NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  rtt_ms_p50          INTEGER,
  rtt_ms_p95          INTEGER,
  last_probe_at       TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remote_agent_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id             UUID NOT NULL REFERENCES remote_agent_nodes(id) ON DELETE CASCADE,
  engine              TEXT NOT NULL CHECK (engine IN ('cc', 'codex', 'antigravity', 'grok-build')),
  profile_name        TEXT NOT NULL,
  account_fingerprint TEXT NOT NULL,
  account_hint        TEXT,
  plan_type           TEXT,
  cli_version         TEXT,
  runner_mode         TEXT NOT NULL DEFAULT 'interactive'
                      CHECK (engine <> 'cc' OR runner_mode = 'interactive'),
  mod_digest          TEXT,
  discovered_models   JSONB NOT NULL DEFAULT '[]'::jsonb,
  quota_windows       JSONB NOT NULL DEFAULT '[]'::jsonb,
  quota_updated_at    TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'cooldown', 'degraded', 'disabled', 'needs_relogin')),
  disabled_by         TEXT,
  cooldown_reason     TEXT,
  cooldown_until      TIMESTAMPTZ,
  next_probe_at       TIMESTAMPTZ,
  probe_failures      INTEGER NOT NULL DEFAULT 0,
  health_score        SMALLINT NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  weight              INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 1000),
  hot_slots           INTEGER NOT NULL DEFAULT 0 CHECK (hot_slots >= 0),
  active_slots        INTEGER NOT NULL DEFAULT 0 CHECK (active_slots >= 0),
  max_hot_slots       INTEGER NOT NULL DEFAULT 4 CHECK (max_hot_slots BETWEEN 1 AND 32),
  max_active_slots    INTEGER NOT NULL DEFAULT 2 CHECK (max_active_slots BETWEEN 1 AND 16),
  last_used_at        TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (node_id, engine, profile_name),
  UNIQUE (engine, account_fingerprint)
);

CREATE TABLE IF NOT EXISTS remote_model_offers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          UUID NOT NULL REFERENCES remote_agent_profiles(id) ON DELETE CASCADE,
  upstream_model_id   TEXT NOT NULL,
  canonical_model_id  TEXT NOT NULL,
  base_display_name   TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_uid      BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, upstream_model_id)
);

CREATE TABLE IF NOT EXISTS remote_agent_bindings (
  operation_id        UUID PRIMARY KEY,
  run_id              UUID NOT NULL UNIQUE,
  uid                 BIGINT NOT NULL,
  container_db_id     BIGINT NOT NULL,
  docker_id           TEXT NOT NULL,
  session_key         TEXT NOT NULL,
  node_id             UUID NOT NULL REFERENCES remote_agent_nodes(id),
  profile_id          UUID NOT NULL REFERENCES remote_agent_profiles(id),
  canonical_model_id  TEXT NOT NULL,
  native_session_id   TEXT,
  generation          BIGINT NOT NULL DEFAULT 1,
  state               TEXT NOT NULL CHECK (state IN (
                        'preparing', 'hot_idle', 'admitting', 'running',
                        'interrupted', 'reconnecting', 'settling',
                        'draining', 'released', 'unknown'
                      )),
  last_acked_seq      BIGINT NOT NULL DEFAULT 0,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remote_agent_bindings_active_session
  ON remote_agent_bindings (uid, session_key)
  WHERE state NOT IN ('released', 'unknown');

CREATE INDEX IF NOT EXISTS idx_remote_agent_bindings_profile_active
  ON remote_agent_bindings (profile_id, state)
  WHERE state NOT IN ('released', 'unknown');
