-- Rollback for 0306_pool_policy (OCV5-424).
-- Re-release code older than 0306 first: it does not read the new columns or tables.
-- Rows the policy put into cooldown go back to the old half-open behaviour (status
-- 'cooldown' + cooldown_until are understood by old code). The new columns are left
-- in place (additive); pool_api_keys / pool_events are kept for audit unless the
-- TESTED MANUAL ROLLBACK block in the migration is run by hand.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0306_pool_policy') THEN
    RAISE EXCEPTION '0306_pool_policy is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0306_pool_policy') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
END $$;
-- Old code only half-opens cooldown rows that have cooldown_until; auth/credential
-- cooldowns always carry one, so nothing is left stuck.
UPDATE claude_accounts SET cooldown_until = COALESCE(cooldown_until, NOW())
 WHERE status = 'cooldown';
DELETE FROM schema_migrations WHERE version = '0306_pool_policy';
COMMIT;
