-- order-dependency: 0316_commercial_literature_captcha_requests
-- 0317_commercial_muse_media.sql (commercial; OCV5-576 sync, OCV5-574 later adds billing columns)
-- Same two tables as the selfhost 0315_selfhost_muse_media (OCV5-561), which the sync does not
-- carry: the merged audit retention purge and retention registry name these tables, so they must
-- exist in the commercial database even while OC_MUSE_BRIDGE_ENABLED stays off.
-- Rollback: db/rollbacks/0317_commercial_muse_media.sql.

-- compat: additive tables; old binaries never touch them and no service is activated by this migration
CREATE TABLE IF NOT EXISTS muse_bridge_credentials (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  token_sha256 BYTEA NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  last_bridge_version TEXT
);

CREATE TABLE IF NOT EXISTS muse_media_jobs (
  id TEXT PRIMARY KEY CHECK (id ~ '^mj_[0-9a-f-]{36}$'),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_id BIGINT,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  prompt_sha256 BYTEA NOT NULL,
  prompt_preview TEXT NOT NULL,
  params JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  error_code TEXT,
  upstream_error_code TEXT,
  bridge_credential_id BIGINT REFERENCES muse_bridge_credentials(id) ON DELETE SET NULL,
  files JSONB,
  muse_artifact_ids TEXT[],
  muse_snapshot_id TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS muse_media_jobs_user_kind_queued_idx
  ON muse_media_jobs (user_id, kind, queued_at DESC);
CREATE INDEX IF NOT EXISTS muse_media_jobs_open_idx
  ON muse_media_jobs (status) WHERE status IN ('queued', 'running');
