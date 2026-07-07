-- 0118_org_billing_controls.sql
-- 企业版(P3.1 三期 · 批次 H) — org 商业化收尾:billing 委派伪角色 + 成员月度限额 + 低水位预警去重。
-- 依赖:0111(orgs / org_memberships)、0112(credit_ledger.org_id + idx_cl_org_time)、
--       0115(credit_ledger.bucket 扩 org_period)。
-- 注:方案原编号 0116,因并行改价迁移 0117(920aa28a)先落分支,本迁移顺延为 0118 以保迁移单调
--     (migrate.ts verifyIntegrity:新增版本必须 > max(已 applied),避免 0116<0117 被拒)。
--
-- 方案权威源:docs/plans/v5-enterprise-edition-2026-07-06.md §17.2 §17.3 §17.4。
--
-- 变更(全部 additive;遵循 0111-0115 惯例:改存量表用 ADD COLUMN IF NOT EXISTS 幂等,
-- 引用新列的 index 一律排在对应 ADD COLUMN 之后 —— sessionsDb 事故的 PG 版红线):
--   org_memberships + billing_delegate(财务委派伪角色;授予/回收 owner-only,数据层判)
--                   + monthly_org_budget(成员自然月 org 支出上限;NULL=不限,默认宽松)
--   orgs            + low_balance_notified_at(低水位预警去重戳;充值/续费/调额清空以再次触发)
--   credit_ledger   + partial index (org_id, user_id, created_at) WHERE org_id IS NOT NULL
--                   (成员月度 org 支出求和;既有 idx_cl_org_time 无 user_id 维度,per-member
--                    SUM 会全表扫该 org,新增复合索引让 spendTwoBucket 预算钳制 + listMembers
--                    month_org_spent 两处 SUM 走索引)
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0117 惯例);migration runner
-- 单事务跑整个文件,ADD COLUMN(元数据级)+ CREATE INDEX 原子提交。

-- ─── org_memberships:billing_delegate + monthly_org_budget ────────────────
-- 财务委派(§17.3):owner ∥ billing_delegate 满足路由伪角色 minRole='billing'(计费写面)。
-- 授予/回收仅 owner(数据层事务内按 org_role 判,同 org_role 变更纪律);默认 FALSE(收紧)。
ALTER TABLE org_memberships
  ADD COLUMN IF NOT EXISTS billing_delegate BOOLEAN NOT NULL DEFAULT FALSE;

-- 成员月度 org 预算(§17.4):该成员自然月(Asia/Shanghai)内可花的 org 资金上限(分/积分)。
-- NULL=不限(默认宽松,UX 铁律);正整数上限。CHECK 对 NULL 恒真,不约束"不限"的成员。
-- 支出策略(非动钱),设置权限=admin(路由层)。
ALTER TABLE org_memberships
  ADD COLUMN IF NOT EXISTS monthly_org_budget BIGINT
  CHECK (monthly_org_budget IS NULL OR monthly_org_budget > 0);

-- ─── orgs:low_balance_notified_at(低水位预警去重戳)────────────────────────
-- sweeper 检测 org 总可用(钱包+期内池)低于阈值时给 owner 发站内信+邮件后打戳;
-- 充值/续费/加席/正向调额 fulfill 时清空(=NULL)以允许再次触发(方案 §17.2)。NULL=未预警。
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS low_balance_notified_at TIMESTAMPTZ;

-- ─── credit_ledger:成员月度 org 支出求和索引 ─────────────────────────────────
-- **必须排在 0112 ADD COLUMN org_id 之后**(引用 org_id;0112 已建列,本迁移只加索引)。
-- (org_id, user_id, created_at):spendTwoBucket 预算钳制与 listMembers month_org_spent
-- 均按 (org_id=$1, user_id=$2, created_at >= 月初) 过滤后 SUM(-delta),此复合前缀命中。
CREATE INDEX IF NOT EXISTS idx_cl_org_user_time
  ON credit_ledger(org_id, user_id, created_at) WHERE org_id IS NOT NULL;

COMMENT ON COLUMN org_memberships.billing_delegate IS
  'v5 企业版(P3.1 三期):财务委派伪角色。TRUE 的成员满足计费写面 minRole=billing(owner ∥ delegate);授予/回收 owner-only。';
COMMENT ON COLUMN org_memberships.monthly_org_budget IS
  'v5 企业版(P3.1 三期):成员自然月(Asia/Shanghai)org 资金支出上限;NULL=不限。超限 org 桶出 0 静默落个人桶。';
COMMENT ON COLUMN orgs.low_balance_notified_at IS
  'v5 企业版(P3.1 三期):低水位预警去重戳;发通知后打戳,充值/续费/调额清空以再次触发。NULL=未预警。';
