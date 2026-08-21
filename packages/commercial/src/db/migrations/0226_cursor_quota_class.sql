-- 0226_cursor_quota_class.sql
-- Passive learning for Cursor's two usage pools:
--   cursor_models = Grok 4.5/4.6 + Composer 2.5
--   other_models  = Opus and the rest of the allowlist
-- unknown = not observed; other_ok = Other Models succeeded;
-- cursor_only = Other Models failed with auth/quota (still fine for Cursor Models).

ALTER TABLE claude_accounts
  ADD COLUMN IF NOT EXISTS cursor_quota_class TEXT NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'claude_accounts'::regclass
       AND conname = 'claude_accounts_cursor_quota_class_check'
  ) THEN
    ALTER TABLE claude_accounts
      ADD CONSTRAINT claude_accounts_cursor_quota_class_check
      CHECK (cursor_quota_class IN ('unknown', 'other_ok', 'cursor_only'));
  END IF;
END $$;

COMMENT ON COLUMN claude_accounts.cursor_quota_class IS
  'Cursor usage-pool class from passive learning: unknown, other_ok, or cursor_only.';
