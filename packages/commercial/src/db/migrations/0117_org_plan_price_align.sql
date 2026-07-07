-- 0117_org_plan_price_align.sql
-- 企业版三期 — 企业档每席位价与个人版对齐(boss 2026-07-07 裁决,取消二期 9 折)。
-- org-pro 7800→8800 / org-max 26800→29800 / org-ultra 44800→49800(与 pro/max/ultra 同价);
-- monthly_credits/min_seats 不变。0115 已 apply,不改历史 seed,数据修正走本迁移。
-- 已有 active org 订阅不受影响(订阅行只存 plan_code,价格在建单时读取)。
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0116 惯例)。

UPDATE subscription_plans SET price_cents = 8800,  updated_at = NOW() WHERE code = 'org-pro'   AND scope = 'org';
UPDATE subscription_plans SET price_cents = 29800, updated_at = NOW() WHERE code = 'org-max'   AND scope = 'org';
UPDATE subscription_plans SET price_cents = 49800, updated_at = NOW() WHERE code = 'org-ultra' AND scope = 'org';
