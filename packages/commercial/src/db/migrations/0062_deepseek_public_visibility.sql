-- 0062_deepseek_public_visibility.sql
-- 把 DeepSeek 系列从 admin-only 开放给所有用户(boss 2026-05-10 决策)。
--
-- 0057 当时按"先小范围灰度"思路落 visibility='admin',只有 role=admin 或 grants
-- 命中能用。运营阶段稳定后开放给全量用户。
--
-- visibility='public' 后行为(pricing.ts listForUser/canUseModel/listPublic):
--   - 登录用户 modelPicker 列出 deepseek-v4-flash / deepseek-v4-pro
--   - canUseModel 直接 return true(不查 grants)
--   - /api/public/models 给匿名访客也会列出(无登录则无 chat 路径,接受此副作用)
--
-- pricing_changed NOTIFY trigger(0008)会在 UPDATE 时触发 PricingCache reload,
-- 重启后 cache 也会从 DB 重新装载,无需额外 invalidate。

UPDATE model_pricing
   SET visibility = 'public'
 WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro');
