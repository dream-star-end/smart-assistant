-- 0096_subscription_billing.sql
-- 月度订阅计费（双钱包模型）。boss 决策(2026-06-30):
--   付费套餐 = 4 档包月（免费300 / Pro¥88·10000 / Max¥298·35000 / Ultra¥498·60000），
--   可升档(补差价·周期不变·积分补到新额度) + 积分加量包(¥50/5000，仅套餐期内有效)。
--
-- ── 双钱包模型（架构决策，根治"不跨期结转 vs 误删存量真金余额"的冲突）──
--   存量用户已有"永不过期"的 users.credits（真金充值/欢迎金）。纯单一余额"重置"会把它们
--   误清零。故拆两桶：
--     · users.credits          = 持久钱包：旧充值/欢迎金/加量包(非期内)…… 永不自动过期/重置。
--     · user_subscriptions.period_credits = 套餐期内桶：当期套餐额度 + 期内加量包，扣费优先
--       消耗、周期轮转时清零重置。
--   扣费收口 spendTwoBucket() 先扣 period_credits 再扣 users.credits（见 billing/spend.ts）。
--   credit_ledger 新增 bucket 列区分两桶，balance_after 始终是"该桶扣/加之后"的值。
--
-- 单位沿用：amount_cents = 分（¥1=100分）；credits/period_credits = 积分（套餐档按 boss 定额，
-- 非严格 1元=100积分，已含赠送）。一律 BIGINT，禁止 Number 化。

-- ─── subscription_plans（套餐档配置，唯一权威源）──────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  -- 价格（分）。免费档 0。
  price_cents     BIGINT NOT NULL CHECK (price_cents >= 0),
  -- 每个计费周期发放的积分额度（进 period_credits 桶）。
  monthly_credits BIGINT NOT NULL CHECK (monthly_credits >= 0),
  -- 周期天数（默认 30）。
  period_days     INTEGER NOT NULL DEFAULT 30 CHECK (period_days > 0 AND period_days <= 366),
  -- 档位高低排序：tier 越高数字越大（升档判定：只能升到 tier 更大的档）。
  tier            INTEGER NOT NULL,
  -- landing/账户卡片展示顺序（DESC）。
  sort_order      INTEGER NOT NULL DEFAULT 100,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO subscription_plans (code, name, price_cents, monthly_credits, period_days, tier, sort_order, enabled)
VALUES
  ('free',  '免费版', 0,     300,   30, 0, 100, TRUE),
  ('pro',   'Pro',    8800,  10000, 30, 1, 90,  TRUE),
  ('max',   'Max',    29800, 35000, 30, 2, 80,  TRUE),
  ('ultra', 'Ultra',  49800, 60000, 30, 3, 70,  TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  price_cents = EXCLUDED.price_cents,
  monthly_credits = EXCLUDED.monthly_credits,
  period_days = EXCLUDED.period_days,
  tier = EXCLUDED.tier,
  sort_order = EXCLUDED.sort_order,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

-- ─── user_subscriptions（每用户当前订阅状态 + 期内桶）─────────────────────
-- 每用户一行（UNIQUE user_id）。默认 free，付费购买/续费/升档时就地更新；到期未续由
-- rollover sweeper 降级回 free。period_credits 是套餐期内桶（扣费优先消耗、轮转清零重置）。
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  plan_code       TEXT NOT NULL REFERENCES subscription_plans(code) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','expired')),
  period_start    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_end      TIMESTAMPTZ NOT NULL,
  -- 套餐期内积分桶余额（>=0）。扣费先扣此桶，轮转时清零并重置为新档 monthly_credits。
  period_credits  BIGINT NOT NULL DEFAULT 0 CHECK (period_credits >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- rollover sweeper 扫 period_end < now 的行（含 free 月度重置 + 付费到期降级）。
CREATE INDEX IF NOT EXISTS idx_us_period_end ON user_subscriptions(period_end);

-- ─── orders 扩展：区分订单种类 + 目标套餐 code ───────────────────────────
-- kind:
--   'topup'        → 进 users.credits 钱包（存量充值套餐，行为不变）
--   'pack'         → 进 period_credits 期内桶（加量包，仅套餐期内有效）
--   'subscription' → 购买/续费包月套餐：period 桶重置为档额度 + 周期顺延
--   'upgrade'      → 升档：补差价，period 桶补到新档额度，周期不变
-- plan_code：subscription/upgrade 的目标档；pack/topup 为 NULL（金额/积分已快照进 orders）。
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'topup';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check
  CHECK (kind IN ('topup','pack','subscription','upgrade'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS plan_code TEXT;
-- upgrade 单的**源套餐快照**：差价 = target.price - from.price 只在用户付款时仍处于 from_plan
-- 才成立。履约时校验当前订阅 plan_code == from_plan_code，否则退款（防到期降级后用旧差价单
-- 把低档周期升到高档）。仅 upgrade 单非 NULL。
ALTER TABLE orders ADD COLUMN IF NOT EXISTS from_plan_code TEXT;

-- ─── topup_plans 扩展：period_scoped 标记 + 加量包 ──────────────────────────
-- period_scoped=TRUE → 该充值套餐进 period_credits 桶（加量包），随订阅周期清零；
-- FALSE（默认，存量充值套餐）→ 进 users.credits 钱包，永不过期。
ALTER TABLE topup_plans ADD COLUMN IF NOT EXISTS period_scoped BOOLEAN NOT NULL DEFAULT FALSE;

-- 加量包 pack-50（¥50/5000，进期内桶）。**enabled=FALSE 是 v3 现网隔离的关键**：
-- v3/v5 共享同一 topup_plans 表，v3 的 /api/payment/plans 用 `WHERE enabled=TRUE` 列表，
-- 故 enabled=FALSE 让 pack-50 对 v3 现网充值页**完全不可见**。v5 的加量包不走公开 plans 列表，
-- 而是 v5 专属端点 POST /api/subscription/pack 按 code 读它（getPlanByCode 不过滤 enabled），
-- 既隔离 v3、又保留 admin 在 DB 调价的能力。
INSERT INTO topup_plans (code, label, amount_cents, credits, sort_order, enabled, period_scoped)
VALUES ('pack-50', '积分加量包(套餐期内有效)', 5000, 5000, 60, FALSE, TRUE)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  amount_cents = EXCLUDED.amount_cents,
  credits = EXCLUDED.credits,
  sort_order = EXCLUDED.sort_order,
  -- **必须**强制 enabled=FALSE：若共享库已存在 pack-50(enabled=TRUE)或迁移重跑，也要关掉，
  -- 这正是 v3 隔离要防的状态（v5 按 code 直读，不依赖 enabled）。
  enabled = FALSE,
  period_scoped = TRUE,
  updated_at = NOW();

-- ─── credit_ledger 扩展：bucket 列 + reason 白名单 ─────────────────────────
-- bucket 区分本行作用于哪个桶：'wallet'(users.credits) | 'period'(period_credits)。
-- 历史行默认 'wallet'（语义不变）。balance_after 始终 = 该桶扣/加之后的值。
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS bucket TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_bucket_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_bucket_check
  CHECK (bucket IN ('wallet','period'));

-- 扩展 reason 白名单：新增 'subscription'(期内桶发放) / 'subscription_expire'(轮转清零负值) /
-- 'pack'(加量包进期内桶)。沿用 0077 的"按 attnum 找并 DROP 所有 reason CHECK 再重建"模式
-- （PG 可能把 IN 反显为 = ANY(ARRAY[...])，不能靠文本匹配找旧约束）。
DO $$
DECLARE
  constraint_name TEXT;
  reason_attnum SMALLINT;
BEGIN
  ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;

  SELECT attnum INTO reason_attnum
    FROM pg_attribute
   WHERE attrelid = 'credit_ledger'::regclass
     AND attname = 'reason'
     AND NOT attisdropped;

  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'credit_ledger'::regclass
       AND contype = 'c'
       AND reason_attnum = ANY (conkey)
  LOOP
    EXECUTE format('ALTER TABLE credit_ledger DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  ALTER TABLE credit_ledger
    ADD CONSTRAINT credit_ledger_reason_check
    CHECK (reason IN (
      'topup','chat','agent_chat','agent_subscription',
      'refund','admin_adjust','promotion','minimax_media',
      'subscription','subscription_expire','pack'
    ));
END $$;
