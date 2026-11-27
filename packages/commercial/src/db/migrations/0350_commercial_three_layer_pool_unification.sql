-- order-dependency: 0349_commercial_context_eval_observability
-- OCV5-890 (Wave 1A): Three-layer pool unification core authoritative tables.
-- compat: purely additive tables (session_engine_pointers, session_rolling_checkpoints, session_placement_migrations, artifact_blobs, artifact_blob_uploads, model_logical_pool_bindings) and indexes with openclaude_app DML and sequence grants; pre-0350 binaries ignore them and rollback leaves them inert or drops them cleanly.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Authoritative session engine pointers (replaces local resume-map.json + antigravityPromptState + placement epoch).
CREATE TABLE IF NOT EXISTS session_engine_pointers (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  placement_epoch BIGINT NOT NULL DEFAULT 1 CHECK (placement_epoch >= 1),
  pool_kind TEXT NOT NULL DEFAULT 'local_container'
    CHECK (pool_kind IN ('local_container', 'remote_pool', 'desktop_tunnel', 'box_pool')),
  engine TEXT NOT NULL
    CHECK (engine IN ('ccb', 'codex', 'antigravity', 'grok', 'cursor', 'zcode')),
  native_session_id TEXT,
  operation_id UUID,
  profile_id TEXT,
  capsule_id TEXT,
  history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  rejected_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_cache_meta_json JSONB,
  usage_baseline_json JSONB,
  history_context_version INTEGER,
  promoted_from_history BOOLEAN NOT NULL DEFAULT FALSE,
  migration_state TEXT NOT NULL DEFAULT 'active'
    CHECK (migration_state IN ('active', 'migrating')),
  active_migration_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_key)
);

CREATE INDEX IF NOT EXISTS idx_session_engine_pointers_pool_state
  ON session_engine_pointers (pool_kind, migration_state, updated_at DESC);

-- 2. Authoritative rolling checkpoints (replaces local checkpoints/<hash>.json).
CREATE TABLE IF NOT EXISTS session_rolling_checkpoints (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  checkpoint_generation TEXT NOT NULL,
  placement_epoch BIGINT NOT NULL DEFAULT 1 CHECK (placement_epoch >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('anchored_v2', 'native_handoff')),
  anchor_seq BIGINT NOT NULL DEFAULT 0 CHECK (anchor_seq >= 0),
  source_engine TEXT NOT NULL
    CHECK (source_engine IN ('ccb', 'codex', 'antigravity', 'grok', 'cursor', 'zcode')),
  summary TEXT NOT NULL CHECK (length(summary) > 0),
  instructions TEXT,
  acked_by_turn_key TEXT,
  acked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_key, checkpoint_generation)
);

CREATE INDEX IF NOT EXISTS idx_session_rolling_checkpoints_pending
  ON session_rolling_checkpoints (user_id, session_key, created_at DESC)
  WHERE acked_at IS NULL;

-- 3. Cross-pool placement migration CAS audit and idempotency fence.
CREATE TABLE IF NOT EXISTS session_placement_migrations (
  migration_id TEXT PRIMARY KEY CHECK (length(migration_id) BETWEEN 8 AND 128),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  from_epoch BIGINT NOT NULL CHECK (from_epoch >= 1),
  to_epoch BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('migrating', 'committed', 'aborted')),
  from_placement_json JSONB NOT NULL,
  to_placement_json JSONB NOT NULL,
  capsule_ref_json JSONB,
  continuity_tier TEXT
    CHECK (continuity_tier IS NULL OR continuity_tier IN ('hot_native', 'warm_capsule', 'tape_rebuilt', 'cold_degraded')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK (to_epoch = from_epoch + 1)
);

-- compat: partial unique index on newly created session_placement_migrations table (empty at migration time); pre-0350 binaries ignore this table and rollback drops it cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_session_placement_migrations_inflight
  ON session_placement_migrations (user_id, session_key)
  WHERE state = 'migrating';

CREATE INDEX IF NOT EXISTS idx_session_placement_migrations_session
  ON session_placement_migrations (user_id, session_key, created_at DESC);

-- 4. Content-addressed artifact blob metadata (replaces host Docker volume path coupling).
CREATE TABLE IF NOT EXISTS artifact_blobs (
  blob_id TEXT PRIMARY KEY CHECK (length(blob_id) BETWEEN 8 AND 128),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 64),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 1073741824),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 128),
  kind TEXT NOT NULL
    CHECK (kind IN ('upload', 'generated', 'research', 'tool_spill', 'capsule_file', 'tape_archive')),
  logical_name TEXT,
  container_relative_path TEXT,
  storage_backend TEXT NOT NULL DEFAULT 'local_cas'
    CHECK (storage_backend IN ('local_cas', 's3', 'minio', 'volume_mirror')),
  storage_uri TEXT NOT NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artifact_blobs_tenant_sha
  ON artifact_blobs (tenant_id, sha256)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_artifact_blobs_tenant_kind
  ON artifact_blobs (tenant_id, kind, created_at DESC)
  WHERE deleted_at IS NULL;

-- 5. Multipart artifact upload state machine (supports partSha256 idempotent resume).
CREATE TABLE IF NOT EXISTS artifact_blob_uploads (
  upload_id TEXT PRIMARY KEY CHECK (length(upload_id) BETWEEN 8 AND 128),
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('upload', 'generated', 'research', 'tool_spill', 'capsule_file', 'tape_archive')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes >= 0 AND expected_size_bytes <= 1073741824),
  chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes BETWEEN 65536 AND 16777216),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 4096),
  received_parts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'aborted')),
  completed_blob_id TEXT REFERENCES artifact_blobs(blob_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artifact_blob_uploads_tenant_status
  ON artifact_blob_uploads (tenant_id, status, updated_at DESC);

-- 6. Logical model to multi-pool driver bindings (-remote degrades to compatibility alias).
CREATE TABLE IF NOT EXISTS model_logical_pool_bindings (
  binding_id BIGSERIAL PRIMARY KEY,
  logical_model_id TEXT NOT NULL CHECK (length(logical_model_id) BETWEEN 1 AND 128),
  pool_kind TEXT NOT NULL CHECK (pool_kind IN ('local_pool', 'remote_pool', 'box_pool')),
  driver_id TEXT NOT NULL CHECK (length(driver_id) BETWEEN 1 AND 64),
  canonical_model_id TEXT NOT NULL CHECK (length(canonical_model_id) BETWEEN 1 AND 128),
  priority INTEGER NOT NULL DEFAULT 100,
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (logical_model_id, pool_kind, driver_id)
);

CREATE INDEX IF NOT EXISTS idx_model_logical_pool_bindings_lookup
  ON model_logical_pool_bindings (logical_model_id, enabled, priority ASC);

-- compat: idempotent DML and sequence GRANT on newly created three-layer pool tables for commercial openclaude_app role; no-op when role is absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaude_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE
        session_engine_pointers,
        session_rolling_checkpoints,
        session_placement_migrations,
        artifact_blobs,
        artifact_blob_uploads,
        model_logical_pool_bindings
      TO openclaude_app;
    GRANT USAGE, SELECT
      ON SEQUENCE model_logical_pool_bindings_binding_id_seq
      TO openclaude_app;
  END IF;
END $$;
