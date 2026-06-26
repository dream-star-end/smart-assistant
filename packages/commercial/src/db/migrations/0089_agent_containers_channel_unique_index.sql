-- no-transaction
-- 0089_agent_containers_channel_unique_index.sql
-- P1a — 建 (user_id, runtime_channel) 分域 active 唯一索引(为 v3/v5 同用户并行 active 容器铺路)。
--
-- ⚠️ 本迁移带 `-- no-transaction` 标记:CREATE INDEX CONCURRENTLY 不能在事务块内执行
-- (migrate.ts 据标记跳过 BEGIN/COMMIT)。CONCURRENTLY = 在线建索引,不长锁表,生产可用。
--
-- 【additive、可安全先行】此处只【新建】复合唯一索引;旧的 uniq_ac_user_id_active
-- (ON agent_containers(user_id) WHERE state='active',见 0018)【仍保留】。
-- 两者并存期间,旧索引仍强制"同 user 至多一个 active"(更严)→ v3 行为完全不变,
-- v5 并行 active 仍被旧索引挡住(符合"未到放开 v5 容器前不变")。
--
-- 真正"解除并行 active 限制"= 在【所有 reader/writer 已 channel-aware 部署 + 验证后】、
-- 由单独的 DROP 旧索引步骤完成(见 deploy/v5/P1-PLAN.md;DR=0 须 boss 给窗口 + 先备份)。
-- 那一步同样走 no-transaction(DROP INDEX CONCURRENTLY)。
--
-- 幂等:IF NOT EXISTS;若 CONCURRENTLY 中途失败会留 INVALID 索引,需人工 DROP 后重跑。

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_ac_user_channel_active
  ON agent_containers (user_id, runtime_channel)
  WHERE state = 'active';
