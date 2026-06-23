-- 0082_skill_search_log.sql
-- Central feedback log for semantic skill_search, written master-side in the
-- skill-embed relay (every semantic search already flows through master, so
-- this is the natural central collection point — no per-container sink needed).
--
-- Enables later optimization without re-scraping container volumes: query
-- distribution, what the ranker returned, embed-vs-fallback rate, per-model.
-- (Correlating which skill was actually skill_view'd afterwards — the "gold"
-- for online recall@k — is a documented fast-follow on top of this.)

CREATE TABLE IF NOT EXISTS skill_search_log (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       BIGINT      NOT NULL,
  container_id  BIGINT      NOT NULL,
  raw_query     TEXT        NOT NULL,
  cleaned_query TEXT        NOT NULL,
  method        TEXT        NOT NULL CHECK (method IN ('embed', 'fallback')),
  ok            BOOLEAN     NOT NULL,
  reason        TEXT,                   -- fallback reason when ok = false
  returned      JSONB       NOT NULL,   -- [{name, score}] in ranked order
  model         TEXT        NOT NULL,
  backend_id    TEXT        NOT NULL,
  dimensions    INTEGER     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_search_log_created ON skill_search_log (created_at);
