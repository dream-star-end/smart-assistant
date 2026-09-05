-- order-dependency: 0260_research_workspace
-- 0261_research_fetch_attempts.sql
-- R5 文献流水线 Phase A: per-source 全文下载尝试指标行(R5 设计 §4.6)。
-- 单写者 = master(fetchFulltext 链);行级粒度支撑 per-source 成功率报表
-- (Phase E)与 per-record 诊断(job result JSON 是批次摘要且随 GC 丢失)。
-- record_id 是容器侧 SourceRecord.id(非 DB 实体,无 FK);user_id 级联清理。
--
-- rollback:
--   DROP INDEX IF EXISTS idx_rfa_strategy_status;
--   DROP INDEX IF EXISTS idx_rfa_user_created;
--   DROP TABLE IF EXISTS research_fetch_attempts;

CREATE TABLE IF NOT EXISTS research_fetch_attempts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_id   TEXT NOT NULL,
  doi         TEXT,
  arxiv_id    TEXT,
  strategy    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  reason      TEXT,
  http_status INTEGER,
  doc_id      TEXT,
  bytes       BIGINT,
  ms          INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rfa_strategy_status
  ON research_fetch_attempts (strategy, status, created_at);

CREATE INDEX IF NOT EXISTS idx_rfa_user_created
  ON research_fetch_attempts (user_id, created_at);

COMMENT ON TABLE research_fetch_attempts IS
  'Per-source fulltext download attempts (fetchFulltext chain). One row per candidate URL attempt; single writer = master. Feeds per-strategy success-rate metrics.';
