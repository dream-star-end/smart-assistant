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
-- 幂等:IF NOT EXISTS;若 CONCURRENTLY 中途失败会留 INVALID 索引,需人工 DROP 后重跑。

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_ac_user_channel_kind_active
  ON agent_containers (user_id, runtime_channel, runtime_kind)
  WHERE state = 'active';
