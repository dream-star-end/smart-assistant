-- 0158_skill_retrieval_shadow — 四路技能检索 shadow 结果与实际 skill_view 金标。
--
-- IMPORTANT: 0157 是本 feature worktree 的占位编号。集成前必须对生产
-- schema_migrations ledger 校准；若 0157 已被占用，改用新的单调版本并同步
-- deploy/v5/release-metadata.json，绝不能 out-of-order 直接上线。
--
-- 隐私：只存用户消息 SHA-256，不存原文；routes 只含每路最多 5 个技能 slug；
-- actual_skills 只含同 turn 成功 skill_view 的 slug。user_id 由容器双因子身份推导。
--
-- 乱序：usage 可能先于 selection 到达，因此 selection 字段可空且 status='pending'；
-- 后到 selection 以 trace_id 幂等补齐。30 天离场语义登记在 admin/auditRetention.ts。

CREATE TABLE IF NOT EXISTS skill_retrieval_shadow_events (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trace_id      TEXT NOT NULL UNIQUE,
  session_key   TEXT,
  agent_id      TEXT,
  message_hash  TEXT,
  sample_rate   DOUBLE PRECISION,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'ok', 'timeout', 'error')),
  routes        JSONB NOT NULL DEFAULT '{}'::jsonb,
  actual_skills TEXT[] NOT NULL DEFAULT '{}'::text[],
  catalog_size  INTEGER,
  elapsed_ms    DOUBLE PRECISION,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (message_hash IS NULL OR message_hash ~ '^[0-9a-f]{64}$'),
  CHECK (sample_rate IS NULL OR (sample_rate > 0 AND sample_rate <= 1)),
  CHECK (catalog_size IS NULL OR (catalog_size >= 0 AND catalog_size <= 10000)),
  CHECK (elapsed_ms IS NULL OR (elapsed_ms >= 0 AND elapsed_ms <= 60000))
);

CREATE INDEX IF NOT EXISTS idx_skill_retrieval_shadow_created
  ON skill_retrieval_shadow_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_retrieval_shadow_agent_created
  ON skill_retrieval_shadow_events (agent_id, created_at DESC)
  WHERE status = 'ok';

COMMENT ON TABLE skill_retrieval_shadow_events IS
  'V5 sampled cost-free skill retrieval shadow: message hash + four top-5 routes + successful skill_view gold; raw user text is never stored; 30d retention.';
