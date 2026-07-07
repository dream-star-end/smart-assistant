-- 0115_org_subscriptions.sql
-- 企业版(P3.1 二期 · 批次 E) — org 席位订阅(期内桶池化) + 四桶扣费的 schema 扩展。
-- 依赖:0096(subscription_plans / user_subscriptions / credit_ledger.bucket)、
--       0111(orgs)、0112(credit_ledger.org_id / orders.org_id / bucket 扩 org_wallet)。
--
-- 方案权威源:docs/plans/v5-enterprise-edition-2026-07-06.md §11 §12 §13。
--
-- 变更(全部 additive;遵循 0111/0112 惯例:改存量表用 ADD/DROP IF EXISTS 幂等,
-- 新表用裸 CREATE TABLE 让 DDL 破坏及时暴露):
--   subscription_plans + scope(user/org 单一 plans 权威,不建第二张 plans 表)+ min_seats
--                      + seed 三个 org 档(org-pro/org-max/org-ultra)
--   org_subscriptions  新表(结构镜像 user_subscriptions,org_id UNIQUE + seats + 期内桶)
--   credit_ledger      bucket CHECK 重建扩 'org_period';完整性 CHECK 扩为
--                      "org 桶(org_wallet/org_period)必须带 org_id"
--   orders             kind CHECK 重建扩 'org_provision';+ org_name / plan_seats(自助开通落列)
--
-- 计费四桶(spend.ts):org_period → org_wallet → user_period → user_wallet;
-- 锁序全局单向扩展:orgs → org_subscriptions → users → user_subscriptions。
--
-- **sessionsDb 事故的 PG 版对应**:引用新列的 index / seed 一律排在对应 ADD COLUMN 之后。
-- reason 白名单**不扩**:org 期内桶发放/清零复用 0096 已有的 'subscription' /
-- 'subscription_expire'(见 0096:149-153,billing/ledger.ts LEDGER_REASONS)。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0114 惯例);migration runner
-- 单事务跑整个文件,ADD COLUMN(元数据级)+ CREATE TABLE/INDEX + seed 原子提交。

-- ─── subscription_plans:scope + min_seats(单一 plans 权威,scope 分区)─────
-- scope 区分个人档(user)/企业档(org)。存量四档(free/pro/max/ultra)默认 'user';
-- 个人档枚举器 listSubscriptionPlans 加 WHERE scope='user' 防 org 档泄漏到个人页。
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'
  CHECK (scope IN ('user', 'org'));
-- 企业档最低席位(org 专用,个人档 NULL)。CHECK 对 NULL 恒真,不约束个人档。
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS min_seats INTEGER CHECK (min_seats > 0);

-- seed 三个 org 档:每席价 ≈ 个人档 9 折,每席积分同个人档,全部入 org 期内池(池化)。
-- period 30 天;sort_order 排在个人档之后(个人 ultra=70 → org 用 69/68/67,DESC 列于其后);
-- tier 1/2/3(org scope 内自成阶梯,scope 列消歧,不与个人档 upgrade 路径交叉)。
-- ON CONFLICT DO NOTHING:不覆盖 admin 在库内的调价(镜像 0096 seed 但改 DO NOTHING,
-- 因企业定价 boss 可能后续在库微调,迁移重跑不应回卷)。
INSERT INTO subscription_plans
  (code, name, price_cents, monthly_credits, period_days, tier, sort_order, enabled, scope, min_seats)
VALUES
  ('org-pro',   '企业标准', 7800,  10000, 30, 1, 69, TRUE, 'org', 2),
  ('org-max',   '企业专业', 26800, 35000, 30, 2, 68, TRUE, 'org', 2),
  ('org-ultra', '企业旗舰', 44800, 60000, 30, 3, 67, TRUE, 'org', 2)
ON CONFLICT (code) DO NOTHING;

-- ─── org_subscriptions(每 org 当前订阅 + 席位 + 期内池)──────────────────
-- 结构镜像 user_subscriptions(0096:56-71):org_id UNIQUE(每 org 一行)、plan_code FK、
-- seats、period_start/end、period_credits(池化=席位×每席积分,扣费优先、轮转清零重置)。
-- status active/expired(org 无 free 档:到期置 expired、清零池、不踢成员、不动 org 钱包)。
-- 新表裸 CREATE(不 IF NOT EXISTS),同 0111 惯例:DDL 破坏及时暴露。
CREATE TABLE org_subscriptions (
  id             BIGSERIAL PRIMARY KEY,
  org_id         BIGINT NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE RESTRICT,
  plan_code      TEXT NOT NULL REFERENCES subscription_plans(code) ON DELETE RESTRICT,
  seats          INTEGER NOT NULL CHECK (seats > 0),
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'expired')),
  period_start   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_end     TIMESTAMPTZ NOT NULL,
  -- org 期内池余额(>=0)。扣费先于 org 钱包消耗,轮转清零。
  period_credits BIGINT NOT NULL DEFAULT 0 CHECK (period_credits >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- rollover sweeper 扫 period_end < now 的 active 行(镜像 idx_us_period_end)。
CREATE INDEX idx_org_subs_period_end ON org_subscriptions(period_end);

-- ─── credit_ledger:bucket 扩 org_period + 完整性 CHECK 扩 org_period ───────
-- 0096/0112 建的稳定命名约束,直接按名 DROP IF EXISTS + 重建(不必走 attnum 扫描)。
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_bucket_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_bucket_check
  CHECK (bucket IN ('wallet', 'period', 'org_wallet', 'org_period'));

-- org 桶流水完整性:org_wallet / org_period 均必须带 org_id,否则 org ledger 查询
-- (WHERE org_id=$1)漏掉、审计对不上账(0112 Codex 审计 P2 同款红线,扩到 org_period)。
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS ck_cl_org_wallet_has_org;
ALTER TABLE credit_ledger ADD CONSTRAINT ck_cl_org_wallet_has_org
  CHECK (bucket NOT IN ('org_wallet', 'org_period') OR org_id IS NOT NULL);

-- ─── orders:kind 扩 org_provision + org_name / plan_seats ─────────────────
-- kind:
--   'org_provision' → 自助开通(一个事务建 org+owner membership+org 订阅,§13);
--   'subscription'  → org_id 非空复用为 org 续费/加席(plan_code + plan_seats 落单)。
-- 0096 建的稳定命名约束,DROP IF EXISTS + 重建扩入 'org_provision'。
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check
  CHECK (kind IN ('topup', 'pack', 'subscription', 'upgrade', 'org_provision'));

-- 自助开通/订阅单参数落列(批次 F 消费,本迁移只建 schema)。nullable。
ALTER TABLE orders ADD COLUMN IF NOT EXISTS org_name TEXT;      -- 自助开通时新建 org 的名称
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plan_seats INTEGER; -- org 订阅/开通/加席的席位数

COMMENT ON TABLE org_subscriptions IS
  'v5 企业版(P3.1 二期)org 席位订阅 + 期内池(池化)。每 org 一行;到期置 expired 清零池,不踢成员/不动钱包。';
COMMENT ON COLUMN subscription_plans.scope IS
  'v5 企业版:user=个人档(free/pro/max/ultra) / org=企业席位档。单一 plans 权威,枚举按 scope 分区。';
COMMENT ON COLUMN subscription_plans.min_seats IS
  'v5 企业版:org 档最低席位(个人档 NULL)。开通/加席闸校验 seats >= min_seats。';
COMMENT ON COLUMN orders.org_name IS
  'v5 企业版:自助开通单(kind=org_provision)新建 org 的名称快照;非开通单 NULL。';
COMMENT ON COLUMN orders.plan_seats IS
  'v5 企业版:org 订阅/开通/加席的席位数;个人单 NULL。';
