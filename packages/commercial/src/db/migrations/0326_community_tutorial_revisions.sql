-- order-dependency: none  (0324/0325 are held by OCV5-591 aurora media-studio branches, not on feat/v5-selfhost; number pending 管家 confirmation)
-- 0326_community_tutorial_revisions.sql (OCV5-577 follow-up)
-- 经验分享 authors can edit what they submitted, and every edit is reviewed again:
--   - pending / rejected posts are edited in place and go back to review (content_version + 1);
--   - an approved post stays online unchanged while the edit waits in a revision row; an approved
--     revision replaces the live content, a rejected one leaves it as it was.
-- Edit images live in community_tutorial_revision_images, not in tutorial_blob_refs: that table
-- decides public readability, so an unreviewed image must never be bound to an approved post.
--
-- Additive only, with no DROP of any kind (selfhost breaking-DDL gate).
--
-- BEGIN MANUAL ROLLBACK 0326
-- DROP TABLE IF EXISTS community_tutorial_revision_images;
-- ALTER TABLE community_tutorial_moderations DROP COLUMN IF EXISTS revision_id;
-- DROP TABLE IF EXISTS community_tutorial_revisions;
-- ALTER TABLE community_tutorials DROP COLUMN IF EXISTS content_version;
-- END MANUAL ROLLBACK 0326

-- compat: defaulted column; old code neither reads nor writes it
ALTER TABLE community_tutorials
  ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 1;

-- compat: new table; code older than 0326 neither reads nor writes it
CREATE TABLE IF NOT EXISTS community_tutorial_revisions (
  id              BIGSERIAL PRIMARY KEY,
  publication_id  BIGINT NOT NULL REFERENCES community_tutorials(id) ON DELETE CASCADE,
  author_user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- direct: an in-place edit of a pending/rejected post (kept for audit and the edit limit);
  -- pending → approved | rejected | superseded (edited again) | withdrawn (post withdrawn or taken down).
  status          TEXT NOT NULL
                  CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'withdrawn', 'direct')),
  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary         TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 600),
  category        TEXT NOT NULL CHECK (category IN ('research', 'coding', 'general')),
  body_markdown   TEXT NOT NULL CHECK (char_length(body_markdown) BETWEEN 1 AND 60000),
  needs_human     BOOLEAN NOT NULL DEFAULT false,
  review_note     TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  reviewed_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  review_source   TEXT CHECK (review_source IS NULL OR review_source IN ('human', 'ai')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_tutorial_revisions_rejected_chk
    CHECK (status <> 'rejected' OR (review_note IS NOT NULL AND btrim(review_note) <> ''))
);

-- At most one edit of a post waits for review at a time.
-- compat: unique index on the table created just above; no existing rows, old code never writes it
CREATE UNIQUE INDEX IF NOT EXISTS uq_community_tutorial_revisions_pending
  ON community_tutorial_revisions (publication_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_community_tutorial_revisions_post
  ON community_tutorial_revisions (publication_id, id DESC);

-- Edit limit (edits per author in the last 24 hours).
CREATE INDEX IF NOT EXISTS idx_community_tutorial_revisions_author
  ON community_tutorial_revisions (author_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_tutorial_revisions_needs_human
  ON community_tutorial_revisions (created_at ASC, id ASC)
  WHERE status = 'pending' AND needs_human;

-- compat: new table; code older than 0326 neither reads nor writes it
CREATE TABLE IF NOT EXISTS community_tutorial_revision_images (
  revision_id  BIGINT NOT NULL REFERENCES community_tutorial_revisions(id) ON DELETE CASCADE,
  sha256       TEXT NOT NULL REFERENCES tutorial_blobs(sha256) ON DELETE RESTRICT,
  PRIMARY KEY (revision_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_community_tutorial_revision_images_sha
  ON community_tutorial_revision_images (sha256);

-- compat: nullable column; old code inserts without it
ALTER TABLE community_tutorial_moderations
  ADD COLUMN IF NOT EXISTS revision_id BIGINT REFERENCES community_tutorial_revisions(id) ON DELETE SET NULL;

COMMENT ON COLUMN community_tutorials.content_version IS
  '正文版本：每次原地修改或修改稿通过 +1。管理员审核带上它，作者中途改过就拒绝旧结论。';
COMMENT ON TABLE community_tutorial_revisions IS
  '经验分享的修改记录。已发布帖的修改在这里等审核，通过后替换线上内容；direct 行是待审/未通过稿件的原地修改（审计与频控）。';
COMMENT ON TABLE community_tutorial_revision_images IS
  '待审修改稿引用的图片。不进 tutorial_blob_refs（那张表决定公开可读）；孤儿回收也看这张表。';
COMMENT ON COLUMN community_tutorial_moderations.revision_id IS
  '这次审核判的是哪一版修改稿；NULL = 判的是稿件本身。';
