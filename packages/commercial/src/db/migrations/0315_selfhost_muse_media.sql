-- order-dependency: 0314_selfhost_box_gpt_6_astra_pro
-- 0315_selfhost_muse_media.sql (selfhost only; OCV5-561)
-- Muse image/video system tools: bridge credentials (sha256 of the bridge token only) and the
-- per-job audit trail used for rate limits and post-restart status. The hub's in-memory
-- `dispatched` state is never written; rows go queued → running → succeeded/failed/cancelled.
--
-- BEGIN MANUAL ROLLBACK 0315
-- DROP TABLE IF EXISTS muse_media_jobs;
-- DROP TABLE IF EXISTS muse_bridge_credentials;
-- END MANUAL ROLLBACK 0315

-- compat: additive selfhost-only tables for OCV5-561; no existing reader or writer touches them
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
