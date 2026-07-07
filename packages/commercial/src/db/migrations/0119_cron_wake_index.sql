-- 0119_cron_wake_index.sql
-- v5 cron 触发权威上移 master —— master 侧派生唤醒索引。
-- 方案权威源:docs/plans/v5-cron-master-wake-2026-07-07.md §1。
--
-- 设计要点(读方案「架构原则」):cron.yaml(容器卷)仍是任务定义**唯一权威**;
-- 本表只持有**派生唤醒索引**(可随时从卷重算,不构成第二权威)——粒度=用户
-- (非 per-job:避免行级同步复杂度,一个用户只需一个「下一次该醒」的时刻)。
-- master cronWake scheduler 到点仅负责「确保容器活着」,执行与送达判定仍在容器。
--
-- 双层保鲜:①容器 push(POST /internal/v3/cron-index,addJob/updateJob/start/tick 后
-- 上报绝对时刻);②master 兜底 rescan(每 30min 本机读卷 cron.yaml 重算对账 upsert)。
--
-- 变更(全部 additive;v3/v5 共享库,但 v3 现网不含 cronWake 代码 → 永不读写本表 →
-- 对 v3 零影响,同 research_jobs/marketplace 既有惯例):
--   cron_wake_index  用户粒度派生索引 + due 部分索引(runtime_channel, next_fire_at)。
--
-- runtime_channel 维度:与 agent_containers 同款行级 channel 隔离 —— v5 实例只 upsert/
-- 认领 runtime_channel='v5' 的行(cronWake 内 getRuntimeChannel() 过滤),两实例互不干扰。
-- user_id 加 FK ON DELETE CASCADE:用户被删则派生索引自动清理,不留孤儿行(同 research_*)。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0118 惯例);migration
-- runner 自带 BEGIN/COMMIT + schema_migrations 记账,本文件不写事务控制。

CREATE TABLE IF NOT EXISTS cron_wake_index (
  user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runtime_channel TEXT        NOT NULL,
  -- 该用户所有 enabled 任务里最早的下一次触发时刻(绝对 UTC 瞬时)。
  -- NULL = 无 enabled 任务(卷缺 / cron.yaml 无任务 / 全 disabled)→ 永不 due。
  next_fire_at    TIMESTAMPTZ,
  jobs_enabled    INT         NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, runtime_channel),
  -- DB 层兜底:代码侧 getRuntimeChannel() 已 fail-closed 只允许 v3|v5,这里再挡一道
  -- 防手工 SQL / 旧代码写出第三种 channel 值(同 0091 agent_containers.runtime_channel 惯例)。
  CHECK (runtime_channel IN ('v3', 'v5'))
);

-- due 认领主索引:cronWake tick 查 `runtime_channel=当前 AND next_fire_at <= NOW()+90s`。
-- 部分索引(WHERE next_fire_at IS NOT NULL)—— 无 enabled 任务的用户行(next_fire_at=NULL)
-- 不进索引,due 扫描只碰真正可能到点的行。
CREATE INDEX IF NOT EXISTS idx_cron_wake_due
  ON cron_wake_index (runtime_channel, next_fire_at)
  WHERE next_fire_at IS NOT NULL;
