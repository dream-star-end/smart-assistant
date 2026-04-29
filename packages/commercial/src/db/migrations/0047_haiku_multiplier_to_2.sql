-- 0047_haiku_multiplier_to_2.sql
-- 把 Claude Haiku 4.5 的消耗倍率从 1.5 调到 2.0,与 opus-4-7 / sonnet-4-6
-- 对齐(boss 决策 2026-04-29:landing 文案"消耗倍率"统一叙事 = 2 倍)。
--
-- 背景:
--   - opus-4-7 / sonnet-4-6 早就是 2.0(0007 种子默认值)
--   - haiku-4-5 在生产被 boss 手工 INSERT 后默认沿用 1.5,与统一叙事不符
--   - haiku 已在 v1.0.44(commit e0a2709)对前台 UI 隐藏,但 anthropicProxy
--     仍接受调用(WebFetch 容器内部摘要),所以倍率会改变内部成本计算
--
-- 影响:
--   - 计费层 WebFetch 摘要每次贵 33%(1.5→2.0),流量很小可忽略
--   - trigger trg_model_pricing_notify 自动 NOTIFY pricing_changed,
--     运行中进程 PricingCache 立即 reload,无需重启
--
-- 已知漂移(本 migration 不解决):
--   haiku 行不在 0007 种子里,是 prod 手工 INSERT 的;空库 fresh deploy
--   时本 UPDATE 影响 0 行,WebFetch 路径在新环境会 400 UNKNOWN_MODEL,
--   届时需要单独补一个 INSERT migration。
--
-- 安全:UPDATE 是幂等的,可重复执行;只动 multiplier,不动 enabled。

UPDATE model_pricing
SET multiplier = 2.0
WHERE model_id = 'claude-haiku-4-5';
