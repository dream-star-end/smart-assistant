-- order-dependency: 0326_community_blog
-- 0327_community_tutorial_moderation.sql (OCV5-577 PR-B commercial sync; was selfhost 0321)
-- AI moderation for 经验分享 (kind='markdown') posts: one durable job per post, claimed with a
-- lease so a restart never loses or double-applies a verdict, plus an append-only record of every
-- model verdict for the admin queue, audits and cost accounting. The platform pays for these
-- calls; nothing here touches billing tables.
--
-- BEGIN MANUAL ROLLBACK 0327
-- DROP TABLE IF EXISTS community_tutorial_moderations;
-- DROP TABLE IF EXISTS community_tutorial_moderation_jobs;
-- END MANUAL ROLLBACK 0327

-- compat: new tables; code older than 0327 neither reads nor writes them
CREATE TABLE IF NOT EXISTS community_tutorial_moderation_jobs (
  publication_id   BIGINT PRIMARY KEY REFERENCES community_tutorials(id) ON DELETE CASCADE,
  -- Mode at enqueue time. shadow = record only (the post stays in the human queue);
  -- on = a confident verdict publishes or rejects the post.
  mode             TEXT NOT NULL CHECK (mode IN ('shadow', 'on')),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 10),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_tutorial_moderation_jobs_claim
  ON community_tutorial_moderation_jobs (next_attempt_at, publication_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS community_tutorial_moderations (
  id              BIGSERIAL PRIMARY KEY,
  publication_id  BIGINT NOT NULL REFERENCES community_tutorials(id) ON DELETE CASCADE,
  attempt         INTEGER NOT NULL CHECK (attempt >= 1),
  mode            TEXT NOT NULL CHECK (mode IN ('shadow', 'on')),
  verdict         TEXT NOT NULL CHECK (verdict IN ('pass', 'reject', 'uncertain', 'error')),
  -- Whether this verdict changed the post (on-mode pass/reject that won the pending race).
  applied         BOOLEAN NOT NULL DEFAULT false,
  -- {"violation": {"choice": "no", "confidence": 0.97, "yes": 0.03}, "ad": {...}, ...}
  categories      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- [{"sha256": "...", "violation": "no", "ad": "no", "confidence": 0.95, "verdict": "pass"}]
  images          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Shown to the author on rejection; built from templates, never echoed model text.
  reason          TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  -- Shown to admins: why the post was not handled automatically.
  admin_note      TEXT CHECK (admin_note IS NULL OR char_length(admin_note) <= 1000),
  injection       BOOLEAN NOT NULL DEFAULT false,
  text_model      TEXT,
  vision_model    TEXT,
  prompt_version  TEXT NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 40),
  input_tokens    INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens   INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  latency_ms      INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code      TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_tutorial_moderations_post
  ON community_tutorial_moderations (publication_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_community_tutorial_moderations_recent
  ON community_tutorial_moderations (created_at DESC, id DESC);

COMMENT ON TABLE community_tutorial_moderation_jobs IS
  '经验分享 AI 审核作业，每篇一行；lease 认领，重启不丢不重。';
COMMENT ON TABLE community_tutorial_moderations IS
  '经验分享 AI 审核记录（每次模型判定一行），用于管理端复核、审计和成本统计。平台承担费用，不写计费表。';
