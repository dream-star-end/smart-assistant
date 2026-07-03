-- 0101_v5_migration_audit.sql
-- v3→v5 每用户迁移的审计流水(观测 + 幂等重试依据)。
--
-- 每个迁移子步骤(预热/会话/卷/切换/回滚)开始与结束各写一行,记录耗时、体量、落点、
-- 错误。编排器(channelMigration/cutover.ts)据此做幂等重入、失败重试、看板统计。
--
-- 消费方:仅 v5 树 channelMigration/* 迁移工具。v3 树建表但不写(与 0096 订阅表同构:
-- 共享库建表,v3 不引用)。现网零影响:纯建新表 + 索引,不触碰任何既有表。

CREATE TABLE IF NOT EXISTS v5_migration_audit (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'preseed' | 'sessions' | 'volumes' | 'cutover' | 'rollback'
  phase        TEXT NOT NULL,
  -- 'started' | 'ok' | 'error'
  status       TEXT NOT NULL CHECK (status IN ('started','ok','error')),
  -- 结构化明细:{ bytes, sessionCount, volumes:[...], hostUuid, remote, error, ... }
  detail       JSONB,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_v5_migration_audit_user
  ON v5_migration_audit (user_id, started_at DESC);

-- 看板:按 phase/status 聚合最近迁移健康度。
CREATE INDEX IF NOT EXISTS idx_v5_migration_audit_phase_status
  ON v5_migration_audit (phase, status, started_at DESC);

COMMENT ON TABLE v5_migration_audit IS
  'v3→v5 每用户迁移审计流水(preseed/sessions/volumes/cutover/rollback 各 started/ok/error);仅 v5 迁移工具写。';
