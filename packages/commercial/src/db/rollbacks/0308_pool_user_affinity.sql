-- Rollback for 0308_pool_user_affinity (OCV5-424).
-- Re-release code older than 0308 first: it does not read pool_user_affinity, so
-- selection simply falls back to the per-pool rules. The table is kept (additive)
-- unless the TESTED MANUAL ROLLBACK block in the migration is run by hand.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0308_pool_user_affinity') THEN
    RAISE EXCEPTION '0308_pool_user_affinity is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0308_pool_user_affinity') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
END $$;
DELETE FROM schema_migrations WHERE version = '0308_pool_user_affinity';
COMMIT;
