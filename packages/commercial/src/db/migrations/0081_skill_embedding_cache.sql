-- 0081_skill_embedding_cache.sql
-- Cross-tenant cache of skill embedding vectors for semantic skill_search.
--
-- Keyed by (content_hash, backend_id, dimensions):
--   - content_hash = sha256 of the skill's canonical form (name+description+
--     tags+related_skills), so any content edit re-keys → automatic re-embed.
--   - backend_id + dimensions namespace the embedding backend (e.g.
--     dashscope.aliyuncs.com / text-embedding-v4 / 1024) so vectors from
--     different providers never collide in one cache.
-- Vectors are deterministic per (content, model) → write once, never update.
-- Baseline skills are shared across tenants, so they are embedded only once.

CREATE TABLE IF NOT EXISTS skill_embedding_cache (
  content_hash  TEXT        NOT NULL,
  backend_id    TEXT        NOT NULL,
  dimensions    INTEGER     NOT NULL CHECK (dimensions > 0),
  embedding     BYTEA       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (content_hash, backend_id, dimensions),
  -- float32 vector: byte length must be exactly dimensions * 4
  CONSTRAINT skill_embedding_len CHECK (octet_length(embedding) = dimensions * 4)
);
