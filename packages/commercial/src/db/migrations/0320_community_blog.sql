-- order-dependency: none  (0316–0319 are commercial-only numbers and never ship to selfhost)
-- 0320_community_blog.sql (OCV5-577)
-- 「经验分享」builds on community_tutorials (kind='markdown'): authors upload images before they
-- submit, the AI moderation worker (PR-B) may approve or reject without a human reviewer, and the
-- admin queue only shows rows that still wait for a human.
--
-- BEGIN MANUAL ROLLBACK 0320
-- ALTER TABLE community_tutorials DROP CONSTRAINT IF EXISTS community_tutorials_review_state_chk;
-- ALTER TABLE community_tutorials ADD CONSTRAINT community_tutorials_review_state_chk CHECK (
--   (status IN ('draft', 'pending') AND published_at IS NULL)
--   OR (status = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NOT NULL)
--   OR (status = 'rejected' AND review_note IS NOT NULL AND btrim(review_note) <> ''
--       AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NULL)
--   OR (status = 'withdrawn' AND published_at IS NULL)
--   OR (status = 'takedown' AND review_note IS NOT NULL AND btrim(review_note) <> ''
--       AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NULL)
-- );  -- fails while AI-reviewed rows (reviewed_by IS NULL) exist; withdraw or re-review them first
-- DROP INDEX IF EXISTS idx_community_tutorials_needs_human;
-- ALTER TABLE community_tutorials DROP COLUMN IF EXISTS view_count,
--   DROP COLUMN IF EXISTS needs_human, DROP COLUMN IF EXISTS review_source;
-- DROP TABLE IF EXISTS tutorial_blob_uploads;
-- DELETE FROM tutorial_blobs WHERE kind = 'image';  -- only after their refs are gone
-- ALTER TABLE tutorial_blobs DROP CONSTRAINT IF EXISTS tutorial_blobs_kind_chk,
--   DROP CONSTRAINT IF EXISTS tutorial_blobs_bytes_chk;
-- ALTER TABLE tutorial_blobs ADD CONSTRAINT tutorial_blobs_kind_check CHECK (kind IN (
--   'messages', 'artifact', 'media', 'htmlpreview', 'check_evidence', 'manifest')),
--   ADD CONSTRAINT tutorial_blobs_bytes_check CHECK (bytes > 0 AND bytes <= 8388608);
-- END MANUAL ROLLBACK 0320

-- 0244 declared both checks inline, so PG named them tutorial_blobs_kind_check / _bytes_check.
-- compat: only widens the allowed kinds and sizes; every row old code writes still passes
ALTER TABLE tutorial_blobs
  DROP CONSTRAINT IF EXISTS tutorial_blobs_kind_check,
  DROP CONSTRAINT IF EXISTS tutorial_blobs_kind_chk,
  DROP CONSTRAINT IF EXISTS tutorial_blobs_bytes_check,
  DROP CONSTRAINT IF EXISTS tutorial_blobs_bytes_chk;

-- compat: superset of the dropped kind check; old code never writes 'image'
ALTER TABLE tutorial_blobs
  ADD CONSTRAINT tutorial_blobs_kind_chk CHECK (kind IN (
    'messages', 'artifact', 'media', 'htmlpreview', 'check_evidence', 'manifest', 'image'
  ));

-- compat: raises the cap from 8 MiB to 10 MiB; old writers stay under 8 MiB
ALTER TABLE tutorial_blobs
  ADD CONSTRAINT tutorial_blobs_bytes_chk CHECK (bytes > 0 AND bytes <= 10485760);

-- Who uploaded which image. Authorizes the author's own preview and binding at submit time, and
-- counts uploads for the daily limit. Rows go when the blob goes.
CREATE TABLE IF NOT EXISTS tutorial_blob_uploads (
  sha256     TEXT NOT NULL REFERENCES tutorial_blobs(sha256) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sha256, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tutorial_blob_uploads_user
  ON tutorial_blob_uploads (user_id, created_at DESC);

COMMENT ON TABLE tutorial_blob_uploads IS
  '经验分享图片的上传者。只授权作者预览与投稿绑定；公开读取仍只认 approved publication 的 tutorial_blob_refs。';

-- compat: nullable / defaulted columns; old code neither reads nor writes them
ALTER TABLE community_tutorials
  ADD COLUMN IF NOT EXISTS review_source TEXT,
  ADD COLUMN IF NOT EXISTS needs_human BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS view_count BIGINT NOT NULL DEFAULT 0;

-- compat: a new check on a new nullable column that old code never writes
ALTER TABLE community_tutorials
  DROP CONSTRAINT IF EXISTS community_tutorials_review_source_chk,
  ADD CONSTRAINT community_tutorials_review_source_chk
    CHECK (review_source IS NULL OR review_source IN ('human', 'ai'));

-- compat: rows that were already waiting for an admin keep showing in the human queue; old code never reads needs_human
UPDATE community_tutorials SET needs_human = true WHERE status = 'pending' AND needs_human = false;

-- needs_human is deliberately not tied to status by a CHECK: code older than 0320 changes status
-- without knowing the column, so a rollback must keep working. Readers filter
-- `status = 'pending' AND needs_human`.

-- compat: approved/rejected may now carry review_source='ai' instead of a reviewer; every row old code writes still has reviewed_by and passes
ALTER TABLE community_tutorials
  DROP CONSTRAINT IF EXISTS community_tutorials_review_state_chk;

-- `IS NOT DISTINCT FROM`, not `=`: a NULL review_source must make the branch false, not NULL —
-- a NULL CHECK result passes, which would let an approved row carry neither reviewer nor 'ai'.
-- compat: strictly weaker than the dropped check (adds an OR branch); old writes still pass
ALTER TABLE community_tutorials
  ADD CONSTRAINT community_tutorials_review_state_chk CHECK (
    (status IN ('draft', 'pending') AND published_at IS NULL)
    OR
    (status = 'approved'
      AND (reviewed_by IS NOT NULL OR review_source IS NOT DISTINCT FROM 'ai')
      AND reviewed_at IS NOT NULL AND published_at IS NOT NULL)
    OR
    (status = 'rejected'
      AND review_note IS NOT NULL AND btrim(review_note) <> ''
      AND (reviewed_by IS NOT NULL OR review_source IS NOT DISTINCT FROM 'ai')
      AND reviewed_at IS NOT NULL AND published_at IS NULL)
    OR
    (status = 'withdrawn' AND published_at IS NULL)
    OR
    (status = 'takedown'
      AND review_note IS NOT NULL AND btrim(review_note) <> ''
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_community_tutorials_needs_human
  ON community_tutorials (created_at ASC, id ASC)
  WHERE status = 'pending' AND needs_human;

COMMENT ON COLUMN community_tutorials.needs_human IS
  'pending 行是否在等人工审核。只在 status=pending 时有意义；不用 CHECK 绑定 status，以免回滚到 0320 之前的代码后撤回/审核失败。';
COMMENT ON COLUMN community_tutorials.review_source IS
  '最后一次改判的来源：human（管理员）或 ai（PR-B 审核 worker）。0320 之前的行为 NULL。';
