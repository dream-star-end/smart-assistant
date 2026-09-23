-- Content-review strikes live on the master database so the admin action,
-- the inbox notice, the appeal, and the account ban share one count.
-- Session-level bans are not the product path.

CREATE TABLE IF NOT EXISTS content_review_strikes (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  review_id BIGINT NOT NULL,
  session_key TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  inbox_message_id BIGINT,
  status TEXT NOT NULL CHECK (status IN ('active', 'appealed', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by BIGINT,
  UNIQUE (user_id, review_id)
);

CREATE INDEX IF NOT EXISTS idx_content_review_strikes_user_status
  ON content_review_strikes (user_id, status);

CREATE TABLE IF NOT EXISTS content_review_appeals (
  id BIGSERIAL PRIMARY KEY,
  strike_id BIGINT NOT NULL REFERENCES content_review_strikes (id),
  user_id BIGINT NOT NULL REFERENCES users (id),
  statement TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decided_by BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS content_review_appeals_one_pending
  ON content_review_appeals (strike_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS content_review_account_bans (
  user_id BIGINT PRIMARY KEY REFERENCES users (id),
  strike_count INTEGER NOT NULL,
  banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
