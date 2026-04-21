-- 0021_disable_haiku.sql
-- 关闭 Claude Haiku 4.5 对外可见 / 可调:
--   - 营销定位是"满血 Opus / Sonnet",Haiku 与品牌叙事不符
--   - boss 决策(2026-04-21):首页不再列 Haiku,容器内也不应再可调
--
-- 实现:
--   model_pricing.enabled = false → /api/public/models 与 /api/models handler
--   都按 enabled 过滤,Haiku 自动从模型选择器消失。
--   trigger trg_model_pricing_notify 会 NOTIFY pricing_changed,
--   PricingCache 立刻 reload,无需重启。
--
-- 安全:UPDATE 是幂等的,可重复执行;不删行,后续若决定再开
-- 只需 enabled = true 即可。

UPDATE model_pricing
SET enabled = false
WHERE model_id = 'claude-haiku-4-5';
