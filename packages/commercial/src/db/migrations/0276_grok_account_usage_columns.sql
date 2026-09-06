-- 0276_grok_account_usage_columns.sql
-- order-dependency: 0275_restore_ccb_provider_check
-- Grok (provider='grok') account rows learn their xAI credit / Grok Build
-- usage on an hourly schedule (grokUsageSweeper) instead of only when an
-- admin opens the "Grok 额度 / 用量" modal. Display only — not a billing
-- source of truth. No slot-weight sidecar (Grok has none).
--
-- ADD COLUMN only. Cursor's cursor_sand_* columns stay on session rows;
-- Grok gets its own grok_* columns because the upstream shape is different
-- (weekly credit pool + GrokBuild product percent + subscription tier).
-- `grok_usage_snapshot` is the full GrokUsageSnapshot JSON (no tokens,
-- masked email only) so the modal can render from the DB when the live
-- fetch fails.

ALTER TABLE claude_accounts
  ADD COLUMN IF NOT EXISTS grok_credit_usage_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS grok_build_usage_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS grok_credit_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grok_credit_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grok_subscription_tier TEXT,
  ADD COLUMN IF NOT EXISTS grok_usage_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grok_usage_error TEXT,
  ADD COLUMN IF NOT EXISTS grok_usage_snapshot JSONB;

COMMENT ON COLUMN claude_accounts.grok_credit_usage_pct IS
  'grok rows: weekly credit pool percent used (cli-chat-proxy /billing?format=credits creditUsagePercent). Hourly sweeper.';
COMMENT ON COLUMN claude_accounts.grok_build_usage_pct IS
  'grok rows: GrokBuild product percent used (productUsage[GrokBuild].usagePercent).';
COMMENT ON COLUMN claude_accounts.grok_credit_period_start IS
  'grok rows: current credit period start (currentPeriod.start).';
COMMENT ON COLUMN claude_accounts.grok_credit_period_end IS
  'grok rows: when the credit pool resets (currentPeriod.end).';
COMMENT ON COLUMN claude_accounts.grok_subscription_tier IS
  'grok rows: subscriptionTier from /user?include=subscription (SuperGrokPro / SuperGrok / …).';
COMMENT ON COLUMN claude_accounts.grok_usage_updated_at IS
  'grok rows: last successful usage refresh (sweeper or manual).';
COMMENT ON COLUMN claude_accounts.grok_usage_error IS
  'grok rows: short reason of the last failed refresh; NULL after a success.';
COMMENT ON COLUMN claude_accounts.grok_usage_snapshot IS
  'grok rows: last GrokUsageSnapshot (secret-free, email masked) for the admin modal fallback.';
