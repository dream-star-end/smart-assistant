-- 0267_turn_dispatches_agent_container.sql
-- P1 桌面虚拟容器底座 B-07:turn_dispatches 绑定目标容器。
-- 普通事务。设计稿 v2 §4.5.3。
--
-- 新行由 admission 写入 agent_container_id + runtime_kind 快照。旧行保持 NULL,
-- reconciler 对 NULL 走旧 uid + bound_ip + runtime_kind='docker' 解析。
-- ON DELETE RESTRICT:容器行在仍有 dispatch 引用时不得删。

ALTER TABLE turn_dispatches
  ADD COLUMN IF NOT EXISTS agent_container_id BIGINT REFERENCES agent_containers(id) ON DELETE RESTRICT;

ALTER TABLE turn_dispatches
  ADD COLUMN IF NOT EXISTS runtime_kind TEXT;
