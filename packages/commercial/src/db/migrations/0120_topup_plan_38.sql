-- 0120_topup_plan_38.sql
-- 个人充值新增 ¥38 档 → 4000 积分（boss 指定 2026-07-08）。
--
-- 权威源:topup_plans 表(0003 建表 / 0022 档位重塑 / 0096 加 period_scoped)。
-- 个人充值档位是纯数据驱动 —— 后端 orders.ts:listPlans() 每请求直读、无进程内缓存
-- (admin/plans.ts 注释),前端 TopupDialog 全数据驱动,故本迁移 apply 即时生效,
-- 无需改后端常量 / 前端 / NOTIFY / 重启。
--
-- 落桶:period_scoped=FALSE → kind='topup' → fulfillWalletTopupTx() → users.credits
--       持久钱包(永不过期),与 boss「充值进持久钱包」语义一致。
--
-- 定价:基准 ¥1 = 100 积分(amount_cents == 基准 credits)。¥38 基准 3800,boss 指定
--       到账 4000 → 赠 200 积分(≈5.26%)。注:略高于 plan-100 的 5% 赠送率,轻微破坏
--       「金额越大赠送率越高」阶梯单调性;按 boss 明确要求的 4000 落值,此处仅存档说明。
--
-- 排序:sort_order=97 使充值卡按金额升序显示(DESC 渲染):
--       plan-10(100) → plan-38(97) → plan-100(95) → plan-200(90) → plan-500(75)。
--
-- 幂等:ON CONFLICT(code) DO UPDATE,可安全重跑;若曾禁用则重新启用。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0119 惯例);migration
-- runner 自带 BEGIN/COMMIT + schema_migrations 记账,本文件不写事务控制。
-- v3/v5 共享库:enabled=TRUE 的 plan-38 会同时出现在 v3 的 /api/payment/plans;鉴于
-- v3 已全量 cutover 退役,实际无影响(同 plan-100/200/500 既有惯例)。

INSERT INTO topup_plans (code, label, amount_cents, credits, sort_order, enabled, period_scoped)
VALUES ('plan-38', '¥38 充值(赠 200 积分)', 3800, 4000, 97, TRUE, FALSE)
ON CONFLICT (code) DO UPDATE
   SET label        = EXCLUDED.label,
       amount_cents = EXCLUDED.amount_cents,
       credits      = EXCLUDED.credits,
       sort_order   = EXCLUDED.sort_order,
       enabled      = TRUE,
       period_scoped = FALSE,
       updated_at   = NOW();
