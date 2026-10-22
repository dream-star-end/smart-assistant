-- order-dependency: none  (0320/0321 are selfhost-only community blog migrations, not in the commercial tree; the blog sync must renumber them above 0322, as OCV5-576 did for selfhost 0313-0315)
-- 0322_minimax_voices.sql (commercial; OCV5-589, media studio OCV5-586)
-- Ownership of MiniMax designed / cloned voices. Such voices belong to the whole MiniMax account behind
-- the media key, so every synthesis checks the voice is a system voice or a row here owned by the
-- caller (minimax/voices.ts). Voice cloning records the user's consent statement (user decision D7,
-- 2026-10-23). Rows are user-owned configuration: kept until the owner is deleted (FK cascade).
-- Numbering: 0320_community_blog / 0321_community_tutorial_moderation live on feat/v5-selfhost only.
-- Commercial applies 0322 directly after 0319; a later selfhost→commercial blog sync must renumber
-- those two above the highest applied commercial migration.
-- Rollback: db/rollbacks/0322_minimax_voices.sql.

-- compat: additive table; old binaries never read or write it
CREATE TABLE IF NOT EXISTS minimax_voices (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Caller idempotency key (the studio take id). A row is written as 'pending' before the upstream
  -- call so a retry with the same request_id never creates a second voice (Codex plan r1 P1-2).
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  params_sha256 TEXT NOT NULL CHECK (params_sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed')),
  voice_id TEXT NOT NULL UNIQUE CHECK (voice_id ~ '^oc[0-9]+x[a-z2-7]{12}$'),
  kind TEXT NOT NULL CHECK (kind IN ('design', 'clone')),
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  prompt TEXT CHECK (prompt IS NULL OR length(prompt) <= 2000),
  consent JSONB,
  usage_id BIGINT REFERENCES minimax_media_usage_records(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (user_id, request_id),
  -- A clone always carries its consent statement; a designed voice never does.
  CONSTRAINT minimax_voices_consent_matches_kind CHECK (
    (kind = 'clone' AND consent IS NOT NULL) OR (kind = 'design' AND consent IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS minimax_voices_user_created_idx
  ON minimax_voices (user_id, created_at DESC) WHERE status = 'active' AND deleted_at IS NULL;
