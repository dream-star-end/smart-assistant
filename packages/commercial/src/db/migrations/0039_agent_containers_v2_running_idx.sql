-- 0039 — agent_containers v2 running 行的 user_id partial b-tree
--
-- 背景:
--   admin users tab 现在要按 user_id 聚合活跃容器数(v3 + v2 之和)。
--   v3 路径:WHERE state='active' 命中 0018 的 partial unique
--     uniq_ac_user_id_active(已 DROP 全表 user_id UNIQUE 后只剩这条 partial)。
--   v2 路径:WHERE status='running' AND subscription_id IS NOT NULL,
--     之前**没有任何索引覆盖**;走顺扫会越来越慢。
--
-- 数据规模(verified 2026-04-25 commercial-v3):
--   agent_containers total=131
--     v2_running=0(目前没有 running v2 容器)
--     v3_active=1
--     vanished=130
--   普通 CREATE INDEX 在事务里 <100ms 完成,锁风险可忽略。
--   未来即使 v2_running 增长,partial WHERE 让索引体积接近零。
--
-- 防御性短锁:超过阈值就 ROLLBACK,deploy-v3.sh 整个 fail,不前进到 restart。
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_ac_user_running_v2
  ON agent_containers(user_id)
  WHERE status = 'running' AND subscription_id IS NOT NULL;
