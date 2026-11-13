-- OCV5-763: forward-only commercial compatibility for the frozen selfhost schema.
-- order-dependency: 0336_commercial_muse_durable
-- 0337..0339 belong to the independent selfhost history, not this database.
-- Their additive remote schema is folded below without importing their model/catalog writes.
-- Historical migration versions and bytes remain unchanged. No accounts, offers, credentials,
-- prices, balances or model availability are seeded or changed by this migration.
-- Old writers retain NULL/default values. Code rollback retains these additive structures.
-- The refresh reason CHECK is replaced transactionally by a strict superset, never narrowed.
-- Explicitly approved in OCV5-763; production apply still requires the official DDL gate.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- sync-section: 0327_system_action_receipts
CREATE TABLE IF NOT EXISTS system_action_receipts (
  action_id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK (operation_version > 0),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('user','admin')),
  result_json JSONB NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS system_action_receipts_owner ON system_action_receipts(user_id, committed_at);
-- compat: Only this new additive table is granted to the current migration owner; old objects are unchanged.
GRANT SELECT, INSERT ON system_action_receipts TO CURRENT_USER;
-- compat: Only this new additive table is hardened; application role is the same trusted owner used by the deployment migration.
REVOKE UPDATE, DELETE, TRUNCATE ON system_action_receipts FROM CURRENT_USER;
-- end-sync-section: 0327_system_action_receipts

-- sync-section: 0330_turn_lease_binding
ALTER TABLE authority_turn_dispatches
  ADD COLUMN turn_key TEXT,
  ADD CONSTRAINT authority_turn_dispatches_turn_key_check
    CHECK (turn_key IS NULL OR turn_key ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN authority_turn_dispatches.turn_key IS
  'Write-once logical turn key bound by authenticated active-dispatch lease renewal; NULL remains compatible with old writers.';
-- end-sync-section: 0330_turn_lease_binding

-- sync-section: 0331_refresh_reissue_client_ip
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS client_ip INET NULL;

-- compat: Replaced in the same migration transaction by a strict superset of the 0019 CHECK (below). Every existing row and every value old binaries write ('logout','rotated','theft','password_reset','admin') stays valid.
ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_revoked_reason_check;

-- compat: Superset of the 0019 enum plus 'reissued', so existing rows validate. Only the new binary writes 'reissued'; an old binary reading such a row sees an unknown reason, and its refresh path rejects that ticket as plain INVALID_REFRESH without a family revoke.
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_revoked_reason_check
  CHECK (
    revoked_reason IS NULL
    OR revoked_reason IN ('logout', 'rotated', 'theft', 'password_reset', 'admin', 'reissued')
  );
-- end-sync-section: 0331_refresh_reissue_client_ip

-- sync-section: 0332_turn_dispatch_turn_key
ALTER TABLE turn_dispatches
  ADD COLUMN IF NOT EXISTS turn_key TEXT
  CHECK (turn_key IS NULL OR turn_key ~ '^[0-9a-f]{64}$');
COMMENT ON COLUMN turn_dispatches.turn_key IS
  'Lossless turn key of the open attempt, stamped by the first model admit. NULL until then and for rows admitted before 0332. Not a billing amount.';
-- end-sync-section: 0332_turn_dispatch_turn_key

-- sync-section: 0333_remote_agent_pool
ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS placement TEXT NOT NULL DEFAULT 'local'
  CHECK (placement IN ('local', 'remote_pool'));

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS pool_auto_disabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN model_catalog.placement IS
  'Execution placement: local (default) or remote_pool (transition-period remote brain pool; projected with " 远端" display suffix).';

COMMENT ON COLUMN model_catalog.pool_auto_disabled IS
  'TRUE when a remote_pool catalog entry was automatically disabled only because eligible enabled pool offers dropped to 0 (FALSE when disabled by a global catalog administrator).';

CREATE OR REPLACE FUNCTION fn_model_activate_entry(
  p_entry_id             BIGINT,
  p_expected_lock_version INTEGER,
  p_updated_by           BIGINT DEFAULT NULL
) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_state TEXT; v_lock INTEGER;
BEGIN
  SELECT state, lock_version INTO v_state, v_lock
    FROM model_catalog WHERE entry_id = p_entry_id FOR UPDATE;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'fn_model_activate_entry: entry % does not exist', p_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_expected_lock_version IS NOT NULL AND v_lock <> p_expected_lock_version THEN
    RAISE EXCEPTION 'fn_model_activate_entry: lock_version mismatch (expected %, got %)',
      p_expected_lock_version, v_lock USING ERRCODE = 'serialization_failure';
  END IF;
  -- 合法性(staged→active / disabled→active)由 trigger 兜底,这里给出更好的错误面。
  IF v_state NOT IN ('staged', 'disabled') THEN
    RAISE EXCEPTION 'fn_model_activate_entry: entry % is % (only staged/disabled can be activated)',
      p_entry_id, v_state USING ERRCODE = 'check_violation';
  END IF;
  UPDATE model_catalog SET state = 'active', pool_auto_disabled = FALSE, updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = p_entry_id;
END $$;

CREATE OR REPLACE FUNCTION fn_model_disable_entry(
  p_entry_id             BIGINT,
  p_expected_lock_version INTEGER,
  p_updated_by           BIGINT DEFAULT NULL
) RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_state TEXT; v_lock INTEGER;
BEGIN
  SELECT state, lock_version INTO v_state, v_lock
    FROM model_catalog WHERE entry_id = p_entry_id FOR UPDATE;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'fn_model_disable_entry: entry % does not exist', p_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_expected_lock_version IS NOT NULL AND v_lock <> p_expected_lock_version THEN
    RAISE EXCEPTION 'fn_model_disable_entry: lock_version mismatch (expected %, got %)',
      p_expected_lock_version, v_lock USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_state <> 'active' THEN
    RAISE EXCEPTION 'fn_model_disable_entry: entry % is % (only active can be disabled)',
      p_entry_id, v_state USING ERRCODE = 'check_violation';
  END IF;
  UPDATE model_catalog SET state = 'disabled', pool_auto_disabled = FALSE, updated_by = COALESCE(p_updated_by, updated_by)
   WHERE entry_id = p_entry_id;
END $$;

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
-- end-sync-section: 0333_remote_agent_pool

-- sync-section: 0335_codex_remote_native
ALTER TABLE remote_agent_nodes ADD COLUMN shared_active_cap INTEGER NOT NULL DEFAULT 1 CHECK(shared_active_cap BETWEEN 1 AND 64);
ALTER TABLE remote_agent_profiles
  ADD COLUMN probe_snapshot JSONB,
  ADD COLUMN execution_manifest JSONB,
  ADD COLUMN execution_ready BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN auth_epoch TEXT;
-- compat: old binding writes omit the new fields; engine defaults to cc and satisfies the new CHECK, with all existing encodings unchanged.
ALTER TABLE remote_agent_bindings
  ADD COLUMN engine TEXT NOT NULL DEFAULT 'cc' CHECK (engine IN ('cc','codex')),
  ADD COLUMN backend_kind TEXT NOT NULL DEFAULT 'cc5-interactive-v1',
  ADD COLUMN auth_epoch TEXT,
  ADD COLUMN manifest_sha256 TEXT,
  ADD COLUMN recovery_spec JSONB,
  ADD COLUMN remote_start_attempted BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN no_host_effect_proven BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_remote_bindings_occupied_node ON remote_agent_bindings(node_id) WHERE state <> 'released';
CREATE INDEX idx_remote_bindings_history ON remote_agent_bindings(uid,session_key,engine,updated_at DESC);

-- Financial evidence is retained for the same lifetime as its journal/usage. No TTL deletion:
-- an unknown turn is not proof that an effect or charge did not occur.
CREATE TABLE remote_native_threads (
  uid BIGINT NOT NULL, operation_id UUID NOT NULL, native_thread_id TEXT NOT NULL,
  profile_id TEXT NOT NULL, auth_epoch TEXT NOT NULL, upstream_model TEXT NOT NULL,
  total JSONB NOT NULL, last_native_turn_id TEXT, pending_request_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(uid,operation_id,native_thread_id),
  CHECK(jsonb_typeof(total)='object')
);
CREATE TABLE remote_native_turns (
  uid BIGINT NOT NULL, operation_id UUID NOT NULL, native_thread_id TEXT NOT NULL,
  native_turn_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  receipt_sha256 TEXT NOT NULL CHECK(receipt_sha256 ~ '^[a-f0-9]{64}$'),
  receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(uid,operation_id,native_thread_id,native_turn_id),
  FOREIGN KEY(uid,operation_id,native_thread_id) REFERENCES remote_native_threads(uid,operation_id,native_thread_id)
);
-- end-sync-section: 0335_codex_remote_native

-- sync-section: 0337_remote_engine_concurrency
ALTER TABLE remote_agent_profiles
  ADD COLUMN IF NOT EXISTS max_concurrent_lanes INTEGER NOT NULL DEFAULT 5
    CHECK (max_concurrent_lanes BETWEEN 1 AND 64);
COMMENT ON COLUMN remote_agent_profiles.max_concurrent_lanes IS
  'OCV5-746: independent account lane ceiling; every non-released binding occupies one slot. Default 5. Node memory is a separate admission gate.';
-- Legacy node.max_active_slots/shared_active_cap and profile.max_active_slots remain for older
-- releases and the existing admin UI. New placeRemoteLane reads only max_concurrent_lanes.
-- end-sync-section: 0337_remote_engine_concurrency

-- sync-section: 0339_remote_driver_core_v4
ALTER TABLE remote_agent_profiles
  ADD COLUMN IF NOT EXISTS driver_id TEXT
    CHECK (driver_id IS NULL OR driver_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS engine_id TEXT
    CHECK (engine_id IS NULL OR engine_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS ready_generation BIGINT NOT NULL DEFAULT 1
    CHECK (ready_generation >= 1),
  ADD COLUMN IF NOT EXISTS verified_fingerprint TEXT
    CHECK (verified_fingerprint IS NULL OR verified_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS last_probe_ok_at TIMESTAMPTZ;

-- compat: remote_protocol_version defaults to 1 and provenance columns are nullable; pre-0339 binding inserts omit them cleanly.
ALTER TABLE remote_agent_bindings
  ADD COLUMN IF NOT EXISTS remote_protocol_version INTEGER NOT NULL DEFAULT 1
    CHECK (remote_protocol_version IN (1, 3, 4)),
  ADD COLUMN IF NOT EXISTS engine_id TEXT
    CHECK (engine_id IS NULL OR engine_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS driver_id TEXT
    CHECK (driver_id IS NULL OR driver_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS driver_version TEXT
    CHECK (driver_version IS NULL OR char_length(driver_version) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS driver_digest TEXT
    CHECK (driver_digest IS NULL OR driver_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS core_digest TEXT
    CHECK (core_digest IS NULL OR core_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS probe_fingerprint TEXT
    CHECK (probe_fingerprint IS NULL OR probe_fingerprint ~ '^[a-f0-9]{64}$');

CREATE INDEX IF NOT EXISTS idx_remote_bindings_v4_sticky
  ON remote_agent_bindings (uid, session_key, driver_id, updated_at DESC)
  WHERE driver_id IS NOT NULL;

-- compat: nullable v4 driver/semantics columns on remote_native_threads; legacy v3 Codex thread writers omit them.
ALTER TABLE remote_native_threads
  ADD COLUMN IF NOT EXISTS engine_id TEXT
    CHECK (engine_id IS NULL OR engine_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS driver_id TEXT
    CHECK (driver_id IS NULL OR driver_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS usage_semantics TEXT
    CHECK (usage_semantics IS NULL OR char_length(usage_semantics) BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS usage_mode TEXT
    CHECK (usage_mode IS NULL OR usage_mode IN ('per_turn', 'cumulative'));

-- compat: nullable v4 receipt metadata columns on remote_native_turns; legacy v3 Codex turn inserts omit them.
ALTER TABLE remote_native_turns
  ADD COLUMN IF NOT EXISTS engine_id TEXT
    CHECK (engine_id IS NULL OR engine_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS driver_id TEXT
    CHECK (driver_id IS NULL OR driver_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  ADD COLUMN IF NOT EXISTS usage_semantics TEXT
    CHECK (usage_semantics IS NULL OR char_length(usage_semantics) BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS usage_mode TEXT
    CHECK (usage_mode IS NULL OR usage_mode IN ('per_turn', 'cumulative')),
  ADD COLUMN IF NOT EXISTS semantic_digest TEXT
    CHECK (semantic_digest IS NULL OR semantic_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS raw_evidence_digest TEXT
    CHECK (raw_evidence_digest IS NULL OR raw_evidence_digest ~ '^[a-f0-9]{64}$');

-- compat: new permanent ops-ledger table for drift verification runs; pre-0339 code neither reads nor writes it.
CREATE TABLE IF NOT EXISTS remote_driver_verification_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id             UUID NOT NULL REFERENCES remote_agent_nodes(id) ON DELETE CASCADE,
  profile_id          UUID NOT NULL REFERENCES remote_agent_profiles(id) ON DELETE CASCADE,
  engine_id           TEXT NOT NULL CHECK (engine_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  driver_id           TEXT NOT NULL CHECK (driver_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  target_fingerprint  TEXT NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  driver_digest       TEXT NOT NULL CHECK (driver_digest ~ '^[a-f0-9]{64}$'),
  core_digest         TEXT NOT NULL CHECK (core_digest ~ '^[a-f0-9]{64}$'),
  suite_digest        TEXT CHECK (suite_digest IS NULL OR suite_digest ~ '^[a-f0-9]{64}$'),
  ready_generation    BIGINT NOT NULL CHECK (ready_generation >= 1),
  auth_epoch          TEXT,
  auto_eligible       BOOLEAN NOT NULL DEFAULT TRUE,
  state               TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'running', 'passed', 'failed', 'superseded', 'aborted')),
  lease_owner         TEXT,
  lease_until         TIMESTAMPTZ,
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  alert_emitted       BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_digest     TEXT CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_uri        TEXT,
  error_code          TEXT,
  error_detail        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

-- compat: partial unique index on a brand-new table (remote_driver_verification_runs); old code never touches this table.
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_driver_verif_active
  ON remote_driver_verification_runs (profile_id, target_fingerprint)
  WHERE state IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_remote_driver_verif_queue
  ON remote_driver_verification_runs (state, lease_until, created_at);

CREATE INDEX IF NOT EXISTS idx_remote_driver_verif_profile
  ON remote_driver_verification_runs (profile_id, created_at DESC);
-- end-sync-section: 0339_remote_driver_core_v4
