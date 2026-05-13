-- 0064_account_subscription_end_at.sql
-- 给 claude_accounts 加 subscription_end_at 列,管理员手动维护账号 Anthropic 订阅周期到期日。
--
-- 背景:
--   现有 oauth_expires_at 是 OAuth access token 的 1h 刷新到期(由 refresh actor 维护),
--   跟订阅周期完全无关。Anthropic 也没在 OAuth / API 上暴露月订阅 / 年订阅的结束日。
--   调度器(scheduler.ts)的 WRH 权重函数想用"距订阅到期天数"做因子,需要本字段。
--
-- 维护方式:
--   管理员在 admin UI 录账号时手填(或后续编辑);可不填,留空(NULL)。
--
-- 不填策略:
--   NULL = 未知,scheduler 权重函数按"中性 1.0"看待 — 不让"字段未维护"成为
--   隐式降权,避免新加因子把老账号自动踢出池子(KISS + 渐进维护友好)。
--
-- 不加索引:
--   全表 < 1000 行,WHERE 不会用此列做大筛;后台前端"订阅 N 天内到期"chip
--   是 row-by-row 渲染时算的,SQL 也只 SELECT 不 WHERE。

ALTER TABLE claude_accounts
  ADD COLUMN subscription_end_at TIMESTAMPTZ;

COMMENT ON COLUMN claude_accounts.subscription_end_at IS
  'Anthropic 订阅周期到期日(管理员手填;Anthropic OAuth/API 不暴露此值)。NULL = 未知,调度器按中性优先级看待。';
