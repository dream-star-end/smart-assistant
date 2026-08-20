-- Manual compensation for 0240_client_session_last_read_at.
ALTER TABLE client_sessions DROP COLUMN IF EXISTS last_read_at;
