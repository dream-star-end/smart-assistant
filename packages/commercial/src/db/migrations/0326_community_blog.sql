-- order-dependency: 0324_media_studio
-- 0326_community_blog.sql (OCV5-577 commercial sync; was selfhost 0320_community_blog)
-- Commercial prod already applied through 0324; 0325 reserved for media music draft.
-- Renumber required: migrate.ts refuses out-of-order versions ≤ max(applied).
-- 「经验分享」builds on community_tutorials (kind='markdown'): authors upload images before they
-- submit, the AI moderation worker (PR-B) may approve or reject, and the admin queue only shows
-- rows that still wait for a human.
--
-- Additive only, with no DROP of any kind: the selfhost train's breaking-DDL gate
-- (scripts/lib/v5-migration-ddl.sh) refuses ALTER ... DROP. So no existing check is widened:
--   - images are stored as tutorial_blobs kind 'media' (already allowed), at most 8 MiB after
--     server-side processing (the existing cap; clients compress to webp first);
--   - an AI verdict still records reviewed_by (the earliest active admin, as system actor) and is
--     told apart by review_source = 'ai'.
--
-- BEGIN MANUAL ROLLBACK 0326
-- DROP INDEX IF EXISTS idx_community_tutorials_needs_human;
-- ALTER TABLE community_tutorials DROP CONSTRAINT IF EXISTS community_tutorials_review_source_chk;
-- ALTER TABLE community_tutorials DROP COLUMN IF EXISTS view_count,
--   DROP COLUMN IF EXISTS needs_human, DROP COLUMN IF EXISTS review_source;
-- DROP TABLE IF EXISTS tutorial_blob_uploads;
-- END MANUAL ROLLBACK 0326

-- Who uploaded which image. Authorizes the author's own preview and binding at submit time, and
-- counts uploads for the daily limit. Rows go when the blob goes.
-- compat: new table; code older than 0326 neither reads nor writes it
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
  ADD CONSTRAINT community_tutorials_review_source_chk
    CHECK (review_source IS NULL OR review_source IN ('human', 'ai'));

-- compat: rows that were already waiting for an admin keep showing in the human queue; old code never reads needs_human
UPDATE community_tutorials SET needs_human = true WHERE status = 'pending' AND needs_human = false;

-- needs_human is deliberately not tied to status by a CHECK: code older than 0326 changes status
-- without knowing the column, so a rollback must keep working. Readers filter
-- `status = 'pending' AND needs_human`.

CREATE INDEX IF NOT EXISTS idx_community_tutorials_needs_human
  ON community_tutorials (created_at ASC, id ASC)
  WHERE status = 'pending' AND needs_human;

COMMENT ON COLUMN community_tutorials.needs_human IS
  'pending 行是否在等人工审核。只在 status=pending 时有意义；不用 CHECK 绑定 status，以免回滚到 0326 之前的代码后撤回/审核失败。';
COMMENT ON COLUMN community_tutorials.review_source IS
  '最后一次改判的来源：human（管理员）或 ai（审核 worker，reviewed_by 记最早的在职管理员作系统操作者）。0326 之前的行为 NULL。';
