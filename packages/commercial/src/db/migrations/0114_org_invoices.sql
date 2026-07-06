-- 0114_org_invoices.sql
-- 企业版(P3.1)批次 D — 发票:抬头 profile + 按已付订单发起开票申请(平台人工处理 V1)
-- 依赖:0001(users)、0111(orgs)。orders.org_id 由批次 B 的 0112 打戳(本迁移不建该列)。
--
-- 方案权威源:docs/plans/v5-enterprise-edition-2026-07-06.md §5 §2(0114)。
--
-- 建表:
--   org_invoice_profiles — 每 org 一行抬头(PK=org_id);发起申请时快照进 request,
--                          抬头改动不追溯已提交申请(profile_snapshot 落库即冻结)。
--   org_invoice_requests — 一次开票申请:order_ids[] 圈定已付订单,amount_cents=合计,
--                          profile_snapshot=当时抬头,status pending→issued|rejected 由
--                          平台超管处理(admin_note 备注,线下寄送/邮箱送达)。
--
-- 单一权威源纪律:org_invoice_requests.org_id 与 order_ids 均在申请事务内校验
--   (orders.org_id=本 org + status='paid' + 未被其它未拒绝申请占用),SQL 直接写
--   orders.org_id(批次 B 列)。amount_cents 由服务端合计,绝不接受客户端金额。
--
-- 幂等性:由 migrate.ts schema_migrations 保证;新表**不** IF NOT EXISTS(破坏 DDL 早暴露,
--   同 0111 惯例)。金额一律 BIGINT cents;枚举一律 TEXT+CHECK 禁 ENUM。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0111 惯例)。
-- 全部为 CREATE TABLE / CREATE INDEX,migration runner 在事务内执行,新表建索引无锁竞争。

-- ─── org_invoice_profiles ─────────────────────────────────────────────
-- 每 org 至多一行抬头(PK=org_id)。ON DELETE RESTRICT:抬头是财务凭证元数据,
-- 不随 org 硬删静默丢失(orgs 走 status='deleted' 软删,本约束是结构防线)。
CREATE TABLE org_invoice_profiles (
  org_id      BIGINT PRIMARY KEY REFERENCES orgs(id) ON DELETE RESTRICT,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),  -- 发票抬头(单位名称)
  tax_id      TEXT,                                                        -- 纳税人识别号(增值税专票必填,普票可空)
  address     TEXT,                                                        -- 单位地址 + 电话(可空)
  email       TEXT,                                                        -- 电子发票接收邮箱(可空)
  updated_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,             -- 最后维护该抬头的成员
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── org_invoice_requests ─────────────────────────────────────────────
-- 一次开票申请。order_ids 圈定的订单在申请事务内校验属本 org + 已付 + 未占用;
-- profile_snapshot 冻结当时抬头(抬头后续变更不改历史申请)。
CREATE TABLE org_invoice_requests (
  id               BIGSERIAL PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  order_ids        BIGINT[] NOT NULL,                       -- 本次开票覆盖的已付订单 id 集(非空)
  amount_cents     BIGINT NOT NULL CHECK (amount_cents >= 0),  -- 服务端合计(所选订单 amount_cents 之和)
  profile_snapshot JSONB NOT NULL,                          -- 申请时的抬头快照(title/tax_id/address/email)
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','issued','rejected')),
  requested_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- 发起申请的成员
  admin_note       TEXT,                                    -- 平台处理备注(寄送单号 / 拒绝理由)
  processed_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- 处理该申请的平台超管
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- org 发票列表(某 org 的申请按时间倒序)
CREATE INDEX idx_org_invoice_requests_org ON org_invoice_requests(org_id, created_at DESC);
-- 平台待处理队列(partial:只索引 pending,处理后自动离开索引)
CREATE INDEX idx_org_invoice_requests_pending
  ON org_invoice_requests(created_at DESC)
  WHERE status = 'pending';

COMMENT ON TABLE org_invoice_profiles IS
  'v5 企业版(P3.1)org 发票抬头(每 org 一行)。发起申请时快照进 org_invoice_requests。';
COMMENT ON TABLE org_invoice_requests IS
  'v5 企业版开票申请。order_ids 圈定已付订单,amount_cents 服务端合计;status pending→issued|rejected 平台人工处理。';
