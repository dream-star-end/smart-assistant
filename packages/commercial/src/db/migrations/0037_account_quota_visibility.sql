-- M9 / 账号配额可见性 — 把 Anthropic 在 chat 响应头里返的 5h/7d 利用率落到
-- claude_accounts 行上,admin UI 直接展示。
--
-- 数据来源:`packages/commercial/src/account-pool/quota.ts::maybeUpdateAccountQuota`
-- 在 anthropicProxy.ts upstream 2xx 之后,从 upstream.headers 抽 4 个 header:
--   anthropic-ratelimit-unified-5h-utilization  (fraction 0-1, 容错 percent)
--   anthropic-ratelimit-unified-5h-reset        (unix epoch seconds)
--   anthropic-ratelimit-unified-7d-utilization
--   anthropic-ratelimit-unified-7d-reset
--
-- 写入限频 = SQL WHERE quota_updated_at IS NULL OR NOW() - quota_updated_at > 30s
-- + 进程内 per-account throttle Map(quota.ts) — 双层防护。
--
-- 不动旧的 quota_remaining(死字段,无生产代码写入)— 留作历史遗留,本次不清理。

ALTER TABLE claude_accounts
  ADD COLUMN quota_5h_pct          NUMERIC(5,2),
  ADD COLUMN quota_5h_resets_at    TIMESTAMPTZ,
  ADD COLUMN quota_7d_pct          NUMERIC(5,2),
  ADD COLUMN quota_7d_resets_at    TIMESTAMPTZ,
  ADD COLUMN quota_updated_at      TIMESTAMPTZ;
