-- order-dependency: 0338_antigravity_gemini_4_carbon
-- OCV5-749: Shared Remote Pool Core + 5-Duty Driver Architecture (v4).
--
-- Purely additive schema evolution (zero DROP / RENAME / TRUNCATE statements so both
-- scripts/lib/v5-migration-ddl.sh and scripts/lib/v5-selfhost-rollback.sh pass cleanly):
--   1. remote_agent_profiles gains open regex-validated driver_id / engine_id, monotonic
--      ready_generation, verified_fingerprint, and last_probe_ok_at while preserving legacy
--      engine / runner_mode columns for R1 dual-read and rollback compatibility.
--   2. remote_agent_bindings gains remote_protocol_version (default 1 for legacy writers) plus
--      driver/core/fingerprint provenance columns.
--   3. remote_native_threads and remote_native_turns gain nullable driver/semantics/digest
--      metadata columns so v3 Codex rows remain untouched and v4 per_turn + cumulative receipts
--      share the single financial uniqueness boundary.
--   4. remote_driver_verification_runs tracks automatic drift verification runs with a partial
--      unique active index on (profile_id, target_fingerprint) and alert deduplication state.

-- compat: all new profile columns are nullable or carry valid defaults; pre-0339 readers and writers ignore them.
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
