-- 0099_user_v5_migration_state.sql
-- v3 → v5 用户「切换即迁移」的权威源(single authority)。
--
-- 背景(架构决策,2026-07-03):
--   v3(现网)与 v5(Aurora)共享同一 PG / Redis / JWT / 账号池;物理隔离的只有容器面
--   (每用户 5 个 docker 卷按 channel 前缀分:oc-v3-* vs oc-v5-*)和 master 网关的
--   sessions.db(/root/.openclaude vs /root/.openclaude-v5)。用户从 v3 无缝切到 v5,需要
--   把这两层 per-user 状态(会话历史 + 卷内记忆/技能/cron/上传)迁到 v5 侧,并有一个
--   全局单一权威标记"该用户现在归 v3 还是 v5",用于:①流量路由 ②v3 后台 mutator
--   (idleSweep/lifecycle)跳过已迁移用户 ③v5 只服务已迁移/放量用户。
--
-- 语义(single authority):
--   - v5_migrated_at IS NOT NULL  ⟺  用户已完成切换、现网权威在 v5(路由到 v5)。
--     它同时是"何时切"的审计时间戳。markMigrated 置 NOW(),rollback 清回 NULL。
--   - v5_migration_status 是生命周期/审计辅助,不参与"是否在 v5"的判定:
--       NULL         = 从未触碰(纯 v3 存量用户,默认)
--       'seeding'    = 后台预热拷贝进行中(仍在 v3)
--       'migrating'  = 切换栅栏进行中(停 v3 容器→最后 delta,仍在 v3 直到置 migrated)
--       'migrated'   = 已切换(与 v5_migrated_at IS NOT NULL 同步置位)
--       'rolled_back'= 曾迁移后回滚(v5_migrated_at 清回 NULL,路由回 v3)
--     判定权威恒为 v5_migrated_at;status 仅供编排/看板/审计读。
--
-- v3 现网零影响声明:纯加两列(均 NULL 默认)+ 一个部分索引;v3 树代码只读
--   v5_migrated_at 做 mutator/路由门控(默认 NULL → 现状行为完全不变),不写。
--   幂等:ADD COLUMN IF NOT EXISTS / pg_constraint 探测 / CREATE INDEX IF NOT EXISTS。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS v5_migrated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS v5_migration_status TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_v5_migration_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_v5_migration_status_check
      CHECK (v5_migration_status IN ('seeding','migrating','migrated','rolled_back'));
  END IF;
END $$;

-- 一致性防线:status='migrated' 必须有 migrated_at,反之亦然(单一权威不撕裂)。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_v5_migrated_consistency_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_v5_migrated_consistency_check
      CHECK (
        (v5_migration_status = 'migrated') = (v5_migrated_at IS NOT NULL)
      );
  END IF;
END $$;

-- 编排/看板扫描进行中(seeding/migrating)与已迁移(migrated)用户;NULL(绝大多数存量
-- 用户)不进索引,不影响既有 users 查询计划。
CREATE INDEX IF NOT EXISTS idx_users_v5_migration_status
  ON users (v5_migration_status)
  WHERE v5_migration_status IS NOT NULL;

COMMENT ON COLUMN users.v5_migrated_at IS
  'v3→v5 切换权威时间戳:IS NOT NULL ⟺ 用户现网权威在 v5(路由到 v5)。rollback 清回 NULL。';
COMMENT ON COLUMN users.v5_migration_status IS
  '迁移生命周期辅助(seeding|migrating|migrated|rolled_back),不参与"是否在 v5"判定;权威恒为 v5_migrated_at。';
