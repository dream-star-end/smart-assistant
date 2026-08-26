-- order-dependency: 0250_ccb_egress_region_one_proxy
-- 0251_cursor_sand_mode.sql
-- Add cursor_sand_enabled switch for Cursor API key accounts in account pool.
-- Allows administrators to toggle Sand client mode (x-cursor-client-type: sand)
-- on/off per cursor account.

ALTER TABLE claude_accounts
  ADD COLUMN IF NOT EXISTS cursor_sand_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN claude_accounts.cursor_sand_enabled IS
  'Whether this Cursor API key uses Sand client mode (x-cursor-client-type: sand).';
