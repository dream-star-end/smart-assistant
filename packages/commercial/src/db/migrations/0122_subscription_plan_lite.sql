-- 0122_subscription_plan_lite.sql
-- 订阅套餐新增入门档 Lite(¥38/月 → 4000 积分/月),并撤回 0120 误加的一次性充值 plan-38。
--
-- 背景更正:boss 原话「个人充值新增38元档,可获得4000积分」,0120 误解为一次性充值
-- (topup_plans),实为**订阅套餐**新增一档 Lite。本迁移做正解 + 回滚误解。
--
-- 权威源:subscription_plans(0096 建表,0115 加 scope/min_seats)。个人档枚举
-- listSubscriptionPlans 每请求直读(WHERE enabled=TRUE AND scope='user',无缓存)+
-- 前端 SubscriptionDialog 数据驱动竖列表,故本迁移 apply 即生效,无需改代码/重启。
--
-- tier 语义(0096:tier 越大越高,升档只能升到 tier 更大档;tier 0=free):Lite 介于
-- free(0) 与 pro(1) 之间,整数无空位 → 个人档腾位:pro/max/ultra 各 +1(free 不动)。
-- **仅 scope='user' 重排;org 档(scope='org')自成阶梯不与个人交叉(0115),保持 1/2/3 不动。**
-- 重排用「按 code 显式赋值」而非 tier+1 → 幂等可重跑。tier 无唯一约束,重排安全;
-- user_subscriptions 不快照 tier(靠 plan_code JOIN 派生),重排对存量订阅零影响。
--
-- 落桶:monthly_credits=4000 每周期发进 user_subscriptions.period_credits 期内桶
-- (到期清零重置),与其它订阅档一致。min_seats 个人档留 NULL(仅 org 用)。
--
-- 排序:sort_order=95 使列表(sort_order DESC)显示 free(100)→lite(95)→pro(90)→max(80)→ultra(70)。
--
-- 运维注:v5 AUTO_MIGRATE=0,须人工 apply;runner 自带 BEGIN/COMMIT + schema_migrations 记账。

-- ① 个人档腾位(显式赋值,幂等;free=0 与 org 档不动)
UPDATE subscription_plans SET tier = 2, updated_at = NOW() WHERE code = 'pro'   AND scope = 'user';
UPDATE subscription_plans SET tier = 3, updated_at = NOW() WHERE code = 'max'   AND scope = 'user';
UPDATE subscription_plans SET tier = 4, updated_at = NOW() WHERE code = 'ultra' AND scope = 'user';

-- ② 插入 Lite 档(个人,¥38/月,4000 积分/月,tier=1 介于 free 与 pro)
INSERT INTO subscription_plans (code, name, price_cents, monthly_credits, period_days, tier, sort_order, enabled, scope)
VALUES ('lite', 'Lite', 3800, 4000, 30, 1, 95, TRUE, 'user')
ON CONFLICT (code) DO UPDATE
   SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents,
       monthly_credits = EXCLUDED.monthly_credits, period_days = EXCLUDED.period_days,
       tier = EXCLUDED.tier, sort_order = EXCLUDED.sort_order,
       enabled = TRUE, scope = 'user', updated_at = NOW();

-- ③ 撤回 0120 误加的一次性充值 plan-38(¥38 是订阅 Lite,不是 topup;0 订单,安全 disable)
UPDATE topup_plans SET enabled = FALSE, updated_at = NOW() WHERE code = 'plan-38';
