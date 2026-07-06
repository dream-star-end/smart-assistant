-- 0112_org_billing.sql
-- 企业版(P3.1)批次 B — 计费打戳:org 钱包流水 / 用量归属 / org 充值单。
-- 依赖:0002(credit_ledger, usage_records)、0003(orders)、0096(bucket CHECK)、0111(orgs)。
--
-- 方案权威源:docs/plans/v5-enterprise-edition-2026-07-06.md §1.4 §2(0112) §3。
--
-- 变更(全部 additive):
--   credit_ledger  + org_id(nullable, FK orgs ON DELETE RESTRICT)
--                  + bucket CHECK 重建扩 'org_wallet'(0096 建了 wallet/period)
--                  + partial index (org_id, created_at DESC) WHERE org_id IS NOT NULL
--   usage_records  + org_id(nullable, FK orgs ON DELETE RESTRICT)
--                  + partial index (org_id, created_at DESC) WHERE org_id IS NOT NULL
--   orders         + org_id(nullable, FK orgs ON DELETE RESTRICT)—— org 充值单
--                  + partial index (org_id, id DESC) WHERE org_id IS NOT NULL(org 充值单列表 keyset)
--
-- 语义:org 归属对计费/报表的权威 = **写时打戳**(settle 落 usage_records.org_id /
-- credit_ledger.org_id),不按"当前成员集"事后推导 —— 成员来去不改历史归属(§1.2)。
--
-- append-only RULE(0002 cl_no_update / cl_no_delete)**不碰**:仅 ADD COLUMN,DDL 不受
-- RULE 约束;org_wallet 流水走 INSERT(RULE 只拦 UPDATE/DELETE),照常可写。
--
-- **sessionsDb 事故的 PG 版对应**:引用新列的 index 一律排在对应 ADD COLUMN **之后**,
-- 否则存量表 migration 打开即抛(index 引用尚未存在的列)。
--
-- 幂等:ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS 重建 + CREATE INDEX IF NOT EXISTS
-- (同 0096/0104 改存量表手法)。金额一律 BIGINT;枚举一律 TEXT+CHECK。
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0111 惯例);migration runner
-- 在单事务内跑整个文件,ADD COLUMN(元数据级)+ CREATE INDEX 原子提交。

-- ─── credit_ledger:org_id + bucket 扩 org_wallet ──────────────────────
ALTER TABLE credit_ledger
  ADD COLUMN IF NOT EXISTS org_id BIGINT REFERENCES orgs(id) ON DELETE RESTRICT;

-- bucket CHECK 重建:0096 建了 credit_ledger_bucket_check('wallet','period'),扩入 'org_wallet'。
-- 0096 用的是稳定命名约束,故直接按名 DROP IF EXISTS + 重建即可(不必走 attnum 扫描)。
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_bucket_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_bucket_check
  CHECK (bucket IN ('wallet', 'period', 'org_wallet'));

-- org 钱包流水完整性:bucket='org_wallet' 必须带 org_id,否则该流水会被
-- org ledger 查询(WHERE org_id=$1)漏掉,审计对不上账(Codex 审计 P2)。
-- 应用写路径均传 org_id,此为 DB 层兜底防未来手写 SQL/新路径漏传。
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS ck_cl_org_wallet_has_org;
ALTER TABLE credit_ledger ADD CONSTRAINT ck_cl_org_wallet_has_org
  CHECK (bucket <> 'org_wallet' OR org_id IS NOT NULL);

-- org 桶流水按 org 时间线倒序查(GET /api/org/ledger);partial 谓词让索引不背个人流水。
-- **必须排在 ADD COLUMN org_id 之后**(引用新列)。
CREATE INDEX IF NOT EXISTS idx_cl_org_time
  ON credit_ledger(org_id, created_at DESC) WHERE org_id IS NOT NULL;

-- ─── usage_records:org_id ─────────────────────────────────────────────
ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS org_id BIGINT REFERENCES orgs(id) ON DELETE RESTRICT;

-- org 维度用量聚合(GET /api/org/usage);写时打戳为权威,partial 不背个人用量。
CREATE INDEX IF NOT EXISTS idx_ur_org_time
  ON usage_records(org_id, created_at DESC) WHERE org_id IS NOT NULL;

-- ─── orders:org_id ────────────────────────────────────────────────────
-- org 充值单(kind='topup' + org_id 非空);个人单 org_id NULL,语义零变。
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS org_id BIGINT REFERENCES orgs(id) ON DELETE RESTRICT;

-- org 充值单列表(GET /api/org/orders,keyset by id DESC)。
CREATE INDEX IF NOT EXISTS idx_orders_org
  ON orders(org_id, id DESC) WHERE org_id IS NOT NULL;

COMMENT ON COLUMN credit_ledger.org_id IS
  'v5 企业版:org 钱包流水归属(bucket=org_wallet);个人流水 NULL。写时打戳,不按当前成员集推导。';
COMMENT ON COLUMN usage_records.org_id IS
  'v5 企业版:成员在 org 语境下的用量归属(写时打戳,与扣费桶解耦——打戳只看成员是否在 org)。';
COMMENT ON COLUMN orders.org_id IS
  'v5 企业版:org 充值单归属(kind=topup);个人单 NULL。user_id 语义=经办人。';
