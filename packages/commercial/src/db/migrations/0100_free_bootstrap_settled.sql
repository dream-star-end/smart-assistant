-- 0100_free_bootstrap_settled.sql
-- v3 老用户切 v5 时抑制"首期 300 免费积分"二次赠送(boss 决策 2026-07-03:对存量抑制)。
--
-- 背景:
--   v5 免费档首期发放 300 period_credits 走 billing/subscription.ts:ensureFreeSubscription
--   —— 用户首次访问 v5(/api/me 等)且无订阅行时,创建 free 行并发放 300 + 写一条
--   'subscription' 流水。v3 现网从不写 user_subscriptions(v3 单钱包,零引用),故该发放
--   只对 v5 首访触发。v3 存量用户注册时可能已在 users.credits(永久钱包)拿过欢迎金,
--   切 v5 再白得 300 期内桶 = 二次赠送。
--
-- 决策:对"迁移引入前就已存在的 v3 存量用户"抑制该发放;只对真·新注册用户发。
--
-- 实现(single authority per user):
--   users.free_bootstrap_settled —— 免费档 bootstrap 已结算标记。
--     TRUE  = 已发放或已被抑制(终态),ensureFreeSubscription 不再发放。
--     FALSE = 尚未结算,ensureFreeSubscription 发放 300 后置 TRUE(默认,新注册用户走此)。
--   本迁移把所有【当前已存在】的用户一次性置 TRUE(视作已结算 → 抑制)。
--   本迁移之后新注册的用户列默认 FALSE → 正常拿 300。
--
-- 消费方:仅 v5 树 billing/subscription.ts:ensureFreeSubscription。v3 树建列但不读。
-- 现网零影响:纯加一 BOOLEAN 列(NOT NULL DEFAULT FALSE,PG11+ 非 volatile 默认不重写表)
--   + 一次性 backfill UPDATE(小用户量、ACCESS EXCLUSIVE 锁短暂)。v3 代码不读此列。
-- 一次性(one-shot):migrate runner 以 schema_migrations 主键保证本版本仅执行一次,
--   backfill UPDATE 不会重跑误伤新注册用户的 FALSE。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS free_bootstrap_settled BOOLEAN NOT NULL DEFAULT FALSE;

-- backfill:迁移执行瞬间已存在的行全部视作"存量 v3 用户 → 已结算(抑制)"。
-- 本迁移在事务内原子执行:ALTER 加列(既有行默认 FALSE)→ UPDATE 全置 TRUE → COMMIT。
-- ALTER 的 ACCESS EXCLUSIVE 锁串行化并发注册:迁移提交后新注册以默认 FALSE 落库。
UPDATE users SET free_bootstrap_settled = TRUE WHERE free_bootstrap_settled = FALSE;

COMMENT ON COLUMN users.free_bootstrap_settled IS
  '免费档首期 300 bootstrap 已结算标记(TRUE=已发放或已抑制,不再发放)。迁移把存量用户置 TRUE 抑制二次赠送;新注册默认 FALSE 正常发放。仅 v5 ensureFreeSubscription 读写。';
