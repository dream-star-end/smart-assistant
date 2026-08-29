-- 0206_community_tutorials.sql
-- 用户共建教程：所有已登录用户可投稿，管理员审核通过后公开。
-- 投稿记录不可编辑；修订通过新投稿完成，避免已审核内容被静默替换。

CREATE TABLE community_tutorials (
  id              BIGSERIAL PRIMARY KEY,
  author_user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 4 AND 100),
  summary         TEXT NOT NULL CHECK (char_length(summary) BETWEEN 10 AND 280),
  category        TEXT NOT NULL CHECK (category IN ('research', 'coding', 'general')),
  body_markdown   TEXT NOT NULL CHECK (char_length(body_markdown) BETWEEN 40 AND 50000),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  review_note     TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  reviewed_by     BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at     TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_tutorials_review_state_chk CHECK (
    (status IN ('pending', 'withdrawn')
      AND review_note IS NULL AND reviewed_by IS NULL
      AND reviewed_at IS NULL AND published_at IS NULL)
    OR
    (status = 'approved'
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NOT NULL)
    OR
    (status = 'rejected'
      AND review_note IS NOT NULL AND btrim(review_note) <> ''
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NULL)
  )
);

CREATE INDEX idx_community_tutorials_published
  ON community_tutorials (published_at DESC, id DESC)
  WHERE status = 'approved';

CREATE INDEX idx_community_tutorials_author
  ON community_tutorials (author_user_id, created_at DESC, id DESC);

CREATE INDEX idx_community_tutorials_pending
  ON community_tutorials (created_at ASC, id ASC)
  WHERE status = 'pending';

COMMENT ON TABLE community_tutorials IS
  'V5 用户共建教程投稿；仅 approved 行可进入公开教程目录。';
