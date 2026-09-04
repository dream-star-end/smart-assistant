-- no-transaction
-- 0255_desktop_kind_unique_index.sql
-- P1 桌面虚拟容器底座:新建 (user_id, runtime_channel, runtime_kind) 分域 active 唯一索引。
--
-- ⚠️ 本迁移带 `-- no-transaction` 标记:CREATE INDEX CONCURRENTLY 不能在事务块内执行
-- (migrate.ts 据标记跳过 BEGIN/COMMIT,并逐条裸执行)。CONCURRENTLY = 在线建索引。
--
-- 【additive、可安全先行】此处只【新建】复合唯一索引;旧的 uniq_ac_user_channel_active
-- (ON agent_containers(user_id, runtime_channel) WHERE state='active',见 0089)【仍保留】。
-- 两者并存期间,旧索引仍强制"同 user 同 channel 至多一个 active"(更严)→ docker 行为完全不变,
-- docker+desktop 双 active 仍被旧索引挡住(符合"kind 过滤上线前不放开")。
--
-- 真正放开双 active = 0256 DROP 旧索引(preflight 断言本索引 indisvalid)。
--
-- Fail-loud (P1-IMPL-07, 对照 0180):故意省略 IF NOT EXISTS。CONCURRENTLY 中断会留下
-- 同名 indisvalid=false 索引;IF NOT EXISTS 会跳过重建并让 migrator 把 0255 记进 ledger,
-- 此后按注释 DROP 再跑也会因 ledger 已 applied 跳过。preflight 在同名 invalid 索引上
-- RAISE EXCEPTION,给出精确 runbook,且不会登记 schema_migrations。
--
-- Runbook(invalid 同名索引):
--   1. SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
--      WHERE c.relname='uniq_ac_user_channel_kind_active';
--   2. 若 indisvalid=false: DROP INDEX CONCURRENTLY uniq_ac_user_channel_kind_active;
--   3. 确认 schema_migrations 无 0255_desktop_kind_unique_index 后重跑 migrate。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'uniq_ac_user_channel_kind_active'
       AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION '0255 fail-loud: uniq_ac_user_channel_kind_active exists but indisvalid=false. Runbook: DROP INDEX CONCURRENTLY uniq_ac_user_channel_kind_active; then re-run migrate. Do not insert into schema_migrations.';
  END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY uniq_ac_user_channel_kind_active
  ON agent_containers (user_id, runtime_channel, runtime_kind)
  WHERE state = 'active';
