-- Roll back 0331 before deploying a binary that does not know 'reissued'.
-- Refuses while any row still uses that reason (those sessions must be revoked first).
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE refresh_tokens IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '0331_refresh_reissue_client_ip'
  ) THEN
    RAISE EXCEPTION '0331_refresh_reissue_client_ip is not applied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM schema_migrations WHERE version > '0331_refresh_reissue_client_ip'
  ) THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM refresh_tokens WHERE revoked_reason = 'reissued') THEN
    RAISE EXCEPTION '0331 rollback refused: refresh_tokens has reissued rows';
  END IF;
END $$;
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_revoked_reason_check;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_revoked_reason_check
  CHECK (
    revoked_reason IS NULL
    OR revoked_reason IN ('logout', 'rotated', 'theft', 'password_reset', 'admin')
  );
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS client_ip;
DELETE FROM schema_migrations WHERE version = '0331_refresh_reissue_client_ip';
COMMIT;
