-- order-dependency: 0261_research_fetch_attempts
-- 0262_cursor_sand_usage_columns.sql
-- Cursor account rows learn their Sand (Grok Bot) pool usage on an hourly
-- schedule (cursorUsageSweeper) instead of only when an admin opens the
-- "Cursor 额度 / 用量" modal. The materializer turns these columns into a
-- secret-free `.slot-weight` sidecar so the container wrapper can send new
-- users to the account with the most headroom / the soonest reset / the
-- soonest plan expiry (use it before it is wasted).
--
-- ADD COLUMN only. The CCB quota_5h_*/quota_7d_* columns keep their Anthropic
-- rolling-window semantics; Sand is a weekly bucket and gets its own columns.
-- `cursor_usage_snapshot` is the full CursorUsageSnapshot JSON (no tokens,
-- no cookies) so the modal can render from the DB when the live fetch fails.

ALTER TABLE claude_accounts
  ADD COLUMN IF NOT EXISTS cursor_sand_usage_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS cursor_sand_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cursor_sand_next_reset_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cursor_sand_access_state TEXT,
  ADD COLUMN IF NOT EXISTS cursor_plan_membership TEXT,
  ADD COLUMN IF NOT EXISTS cursor_billing_cycle_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cursor_usage_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cursor_usage_error TEXT,
  ADD COLUMN IF NOT EXISTS cursor_usage_snapshot JSONB;

COMMENT ON COLUMN claude_accounts.cursor_sand_usage_pct IS
  'cursor session rows: Sand / Grok Bot pool percent used (cursor.com get-sand-usage-status.usagePercent). Hourly sweeper.';
COMMENT ON COLUMN claude_accounts.cursor_sand_period_start IS
  'cursor session rows: current Sand period start (currentPeriodStart).';
COMMENT ON COLUMN claude_accounts.cursor_sand_next_reset_at IS
  'cursor session rows: when the Sand pool resets (nextResetTimestampUtc, weekly).';
COMMENT ON COLUMN claude_accounts.cursor_sand_access_state IS
  'cursor session rows: SAND_ACCESS_STATE_* from get-sand-access-status.';
COMMENT ON COLUMN claude_accounts.cursor_plan_membership IS
  'cursor session rows: membershipType (pro / ultra / free ...).';
COMMENT ON COLUMN claude_accounts.cursor_billing_cycle_end IS
  'cursor session rows: billingCycleEnd of the current Cursor plan period.';
COMMENT ON COLUMN claude_accounts.cursor_usage_updated_at IS
  'cursor session rows: last successful usage refresh (sweeper or manual).';
COMMENT ON COLUMN claude_accounts.cursor_usage_error IS
  'cursor session rows: short reason of the last failed refresh; NULL after a success.';
COMMENT ON COLUMN claude_accounts.cursor_usage_snapshot IS
  'cursor session rows: last CursorUsageSnapshot (secret-free) for the admin modal fallback.';
