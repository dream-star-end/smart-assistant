-- 0243_tutorial_snapshots.sql
-- 社区教程兼容演进：Markdown 投稿保留；新增会话快照、内容寻址 blob、
-- 作者撤回/管理员下架、以及 admin-only 案例评测/罗盘。
-- 公开 blob 只在仍被 status='approved' 的 publication 引用时可见。

ALTER TABLE community_tutorials
  DROP CONSTRAINT IF EXISTS community_tutorials_review_state_chk;

ALTER TABLE community_tutorials
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'markdown',
  ADD COLUMN IF NOT EXISTS snapshot_json JSONB,
  ADD COLUMN IF NOT EXISTS source_session_id TEXT,
  ADD COLUMN IF NOT EXISTS sanitizer_version TEXT;

-- 0206 在 status 列上写了未命名 CHECK,PG 自动名为 community_tutorials_status_check。
-- 只 DROP community_tutorials_status_chk 不会去掉它,draft/takedown 会被旧约束拒绝。
ALTER TABLE community_tutorials
  DROP CONSTRAINT IF EXISTS community_tutorials_kind_chk,
  DROP CONSTRAINT IF EXISTS community_tutorials_status_check,
  DROP CONSTRAINT IF EXISTS community_tutorials_status_chk,
  DROP CONSTRAINT IF EXISTS community_tutorials_review_state_chk,
  DROP CONSTRAINT IF EXISTS community_tutorials_snapshot_chk;

ALTER TABLE community_tutorials
  ADD CONSTRAINT community_tutorials_kind_chk
    CHECK (kind IN ('markdown', 'snapshot')),
  ADD CONSTRAINT community_tutorials_status_chk
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'withdrawn', 'takedown')),
  ADD CONSTRAINT community_tutorials_snapshot_chk CHECK (
    (kind = 'markdown' AND snapshot_json IS NULL AND sanitizer_version IS NULL)
    OR
    (kind = 'snapshot'
      AND snapshot_json IS NOT NULL
      AND sanitizer_version IS NOT NULL
      AND char_length(sanitizer_version) BETWEEN 1 AND 64)
  ),
  ADD CONSTRAINT community_tutorials_review_state_chk CHECK (
    (status IN ('draft', 'pending') AND published_at IS NULL)
    OR
    (status = 'approved'
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NOT NULL)
    OR
    (status = 'rejected'
      AND review_note IS NOT NULL AND btrim(review_note) <> ''
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NULL)
    OR
    (status = 'withdrawn' AND published_at IS NULL)
    OR
    (status = 'takedown'
      AND review_note IS NOT NULL AND btrim(review_note) <> ''
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NULL)
  );

COMMENT ON COLUMN community_tutorials.source_session_id IS
  '作者私有源会话 id；禁止出现在公开 DTO / blob。';

CREATE TABLE tutorial_blobs (
  sha256     TEXT PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  kind       TEXT NOT NULL CHECK (kind IN (
               'messages', 'artifact', 'media', 'htmlpreview', 'check_evidence', 'manifest'
             )),
  mime       TEXT NOT NULL CHECK (char_length(mime) BETWEEN 1 AND 127),
  bytes      INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 8388608),
  body       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tutorial_blobs_body_len_chk CHECK (octet_length(body) = bytes)
);

CREATE TABLE tutorial_blob_refs (
  publication_id BIGINT NOT NULL REFERENCES community_tutorials(id) ON DELETE CASCADE,
  sha256         TEXT NOT NULL REFERENCES tutorial_blobs(sha256) ON DELETE RESTRICT,
  role           TEXT NOT NULL CHECK (char_length(role) BETWEEN 1 AND 120),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (publication_id, role)
);

CREATE INDEX idx_tutorial_blob_refs_sha
  ON tutorial_blob_refs (sha256);

COMMENT ON TABLE tutorial_blobs IS
  '内容寻址教程快照字节；公开下载必须经 tutorial_blob_refs 反查当前 approved publication。零引用行可由 gcOrphanTutorialBlobs 回收；draft/withdrawn/takedown 仍保留 ref，因此不会 GC 掉作者还看得到的正文。';

CREATE TABLE tutorial_case_specs (
  id                 BIGSERIAL PRIMARY KEY,
  public_id          TEXT NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  title              TEXT NOT NULL CHECK (char_length(title) BETWEEN 8 AND 160),
  source_url         TEXT NOT NULL CHECK (char_length(source_url) BETWEEN 8 AND 500),
  source_platform    TEXT NOT NULL CHECK (char_length(source_platform) BETWEEN 2 AND 80),
  collected_at       TIMESTAMPTZ NOT NULL,
  frozen_prompt      TEXT NOT NULL CHECK (char_length(frozen_prompt) BETWEEN 20 AND 20000),
  frozen_materials   JSONB NOT NULL,
  auth_scope         TEXT NOT NULL CHECK (auth_scope IN ('synthetic_eval')),
  rubric             JSONB NOT NULL,
  created_by         BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tutorial_eval_jobs (
  id                 BIGSERIAL PRIMARY KEY,
  spec_id            BIGINT NOT NULL REFERENCES tutorial_case_specs(id) ON DELETE RESTRICT,
  publication_id     BIGINT REFERENCES community_tutorials(id) ON DELETE SET NULL,
  idempotency_key    TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN (
                       'queued', 'running', 'passed', 'failed',
                       'compass_pending', 'compass_running', 'compass_ready'
                     )),
  attempt            INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 32),
  lease_expires_at   TIMESTAMPTZ,
  fencing_token      TEXT,
  lease_owner        TEXT,
  eval_user_id       BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  evidence_json      JSONB,
  result             TEXT,
  error_code         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tutorial_eval_jobs_claim
  ON tutorial_eval_jobs (status, lease_expires_at, id)
  WHERE status IN ('queued', 'running', 'failed', 'compass_pending');

CREATE TABLE tutorial_compass_notes (
  id                 BIGSERIAL PRIMARY KEY,
  eval_job_id        BIGINT NOT NULL UNIQUE REFERENCES tutorial_eval_jobs(id) ON DELETE CASCADE,
  cluster_key        TEXT NOT NULL CHECK (char_length(cluster_key) BETWEEN 2 AND 80),
  severity           TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
  summary            TEXT NOT NULL CHECK (char_length(summary) BETWEEN 8 AND 4000),
  reusable_fix       TEXT CHECK (reusable_fix IS NULL OR char_length(reusable_fix) <= 4000),
  grok_model         TEXT,
  taskboard_ticket   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tutorial_compass_cluster
  ON tutorial_compass_notes (cluster_key, created_at DESC);
