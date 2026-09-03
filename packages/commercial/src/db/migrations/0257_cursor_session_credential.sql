-- order-dependency: 0256_cursor_picker_plan_gate_half_price
-- 0257_cursor_session_credential.sql
-- Cursor account-pool rows may now hold a Cursor *account session*
-- (accessToken + refreshToken obtained through the cursor.com
-- loginDeepControl PKCE flow) instead of a crsr_ API key. Session rows are
-- Sand-only: the Sand relay sends the session accessToken directly as the
-- Bearer token (no /auth/exchange_user_api_key round trip) and renews it
-- with the refresh token. Each session is bound to a stable machine id that
-- feeds x-cursor-checksum; regenerating it per request trips Cursor's
-- "Too many computers" guard, so it is persisted with the row.
--
-- ADD COLUMN only. The oauth_principal_* pair stays grok-only (0207 CHECK),
-- hence the dedicated cursor_auth_id column.

ALTER TABLE claude_accounts
  ADD COLUMN IF NOT EXISTS cursor_credential_kind TEXT NOT NULL DEFAULT 'api_key',
  ADD COLUMN IF NOT EXISTS cursor_machine_id TEXT,
  ADD COLUMN IF NOT EXISTS cursor_auth_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'claude_accounts'::regclass
       AND conname = 'claude_accounts_cursor_credential_kind_check'
  ) THEN
    ALTER TABLE claude_accounts
      ADD CONSTRAINT claude_accounts_cursor_credential_kind_check CHECK (
        cursor_credential_kind IN ('api_key', 'session')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'claude_accounts'::regclass
       AND conname = 'claude_accounts_cursor_session_shape_check'
  ) THEN
    -- A session row must carry its machine id and be Sand-enabled; API-key
    -- rows never carry session-only metadata.
    ALTER TABLE claude_accounts
      ADD CONSTRAINT claude_accounts_cursor_session_shape_check CHECK (
        (cursor_credential_kind = 'api_key'
          AND cursor_machine_id IS NULL
          AND cursor_auth_id IS NULL)
        OR
        (cursor_credential_kind = 'session'
          AND provider = 'cursor'
          AND cursor_sand_enabled IS TRUE
          AND cursor_machine_id IS NOT NULL
          AND cursor_machine_id <> '')
      );
  END IF;
END $$;

COMMENT ON COLUMN claude_accounts.cursor_credential_kind IS
  'cursor rows only: api_key (crsr_ key exchanged upstream) or session (Cursor account session token from loginDeepControl PKCE; Sand-only).';
COMMENT ON COLUMN claude_accounts.cursor_machine_id IS
  'cursor session rows: stable machine id appended to x-cursor-checksum. Never rotated per request.';
COMMENT ON COLUMN claude_accounts.cursor_auth_id IS
  'cursor session rows: authId returned by /auth/poll (Cursor account identity, not a secret).';
