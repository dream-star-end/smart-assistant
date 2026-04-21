-- 0022_first_topup_and_plan_reshape.sql
-- boss 决策(2026-04-21):
--   1) ¥10 套餐改为「新用户首充」,只允许已无 paid 订单的用户充值 1 次
--      —— DB 不强约束(用 enabled=true 让它对外可见),约束在应用层
--      (orders.createPendingOrder + payment.handleListPlans)
--   2) ¥50 / ¥1000 套餐淘汰 → enabled = false(保留行,旧订单 / 对账可追溯)
--   3) ¥200 套餐赠送从 +20% 调整为 +10%
--   4) 新增 ¥100 / ¥500 套餐(赠 5% / 赠 15%)
--
-- 单位:1 元 = 100 积分(amount_cents 与 credits 都是「分」)
--   plan-10:  ¥10  → 1000 积分(无赠送,首充优惠是「门槛低」)
--   plan-100: ¥100 → 10500 积分(赠 500 = 5%)
--   plan-200: ¥200 → 22000 积分(赠 2000 = 10%)— 从 24000 调到 22000
--   plan-500: ¥500 → 57500 积分(赠 7500 = 15%)
--
-- 安全:
--   - DELETE 会被 orders.plan_code FK 阻止吗? orders 表无 plan_code 列(只复制 amount_cents / credits)
--     —— 所以技术上能 DELETE。但用 enabled=false 更保守,旧 admin 报表与 export 仍能 join 出 label
--   - INSERT 用 ON CONFLICT 重跑幂等
--   - sort_order 决定 landing/billing 卡片顺序(DESC):plan-10 (100) → plan-100 (95) → plan-200 (90) → plan-500 (75)

-- 1) 淘汰 plan-50 / plan-1000
UPDATE topup_plans SET enabled = FALSE
 WHERE code IN ('plan-50', 'plan-1000');

-- 2) plan-10:label 标注首充
UPDATE topup_plans
   SET label = '¥10 新用户首充(限 1 次)',
       sort_order = 100,
       enabled = TRUE
 WHERE code = 'plan-10';

-- 3) plan-200:24000 → 22000(从 +20% 调整为 +10%)
UPDATE topup_plans
   SET label = '¥200 充值(赠 10%)',
       credits = 22000,
       sort_order = 90,
       enabled = TRUE
 WHERE code = 'plan-200';

-- 4) plan-100 新增(¥100 → 10500 积分,赠 5%)
INSERT INTO topup_plans (code, label, amount_cents, credits, sort_order, enabled)
VALUES ('plan-100', '¥100 充值(赠 5%)', 10000, 10500, 95, TRUE)
ON CONFLICT (code) DO UPDATE
   SET label = EXCLUDED.label,
       amount_cents = EXCLUDED.amount_cents,
       credits = EXCLUDED.credits,
       sort_order = EXCLUDED.sort_order,
       enabled = TRUE;

-- 5) plan-500 新增(¥500 → 57500 积分,赠 15%)
INSERT INTO topup_plans (code, label, amount_cents, credits, sort_order, enabled)
VALUES ('plan-500', '¥500 充值(赠 15%)', 50000, 57500, 75, TRUE)
ON CONFLICT (code) DO UPDATE
   SET label = EXCLUDED.label,
       amount_cents = EXCLUDED.amount_cents,
       credits = EXCLUDED.credits,
       sort_order = EXCLUDED.sort_order,
       enabled = TRUE;
