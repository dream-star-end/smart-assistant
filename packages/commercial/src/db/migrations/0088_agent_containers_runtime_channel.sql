-- 0088_agent_containers_runtime_channel.sql
-- P1a — 给 agent_containers 加 runtime_channel 一等维度,实现 v3/v5 容器在共享
-- openclaude_commercial 库上的行级隔离(同机灰度并行)。
--
-- 背景:历史上 active 容器查找是 `WHERE user_id=$1 AND state='active'`(配
-- uniq_ac_user_id_active:同 user 至多一个 active 容器)。v5 第二实例若不引入显式
-- channel 维度,会复用/误清理 v3 的容器(Codex 审 P0/P1 确认)。
--
-- 本迁移【只加列】(普通事务安全、DEFAULT 'v3' → 现网 v3 行全部归属 v3,语义零变化,
-- 且此刻还没有 reader 消费该列,纯加列不影响现网)。
--
-- ⚠️ 唯一索引切换(把 uniq_ac_user_id_active 换成 (user_id, runtime_channel) WHERE active)
-- 必须用 CREATE UNIQUE INDEX CONCURRENTLY,不能在事务内执行(本 migrate runner 每个 .sql
-- 包 BEGIN/COMMIT)。故索引切换【不在本文件】,走单独的 no-transaction 迁移 / 受控运维步骤
-- (见 deploy/v5/P1-PLAN.md P1a),且只在【所有 reader/writer 已 channel-aware 之后】执行。

ALTER TABLE agent_containers
  ADD COLUMN IF NOT EXISTS runtime_channel TEXT NOT NULL DEFAULT 'v3';

-- 非唯一辅助索引:加速按 channel 过滤(active 唯一性仍由现有 uniq_ac_user_id_active 暂管,
-- 待 reader channel-aware 后再 CONCURRENTLY 切换为 (user_id, runtime_channel) 复合唯一)。
CREATE INDEX IF NOT EXISTS idx_ac_runtime_channel ON agent_containers (runtime_channel);
