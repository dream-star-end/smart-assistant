-- Rollback for 0309_box_profile_quota_windows (OCV5-424).
-- Re-release code older than 0309 first: it neither reads nor writes these columns.
-- The columns are kept (additive) unless the TESTED MANUAL ROLLBACK block in the
-- migration is run by hand.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0309_box_profile_quota_windows') THEN
    RAISE EXCEPTION '0309_box_profile_quota_windows is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0309_box_profile_quota_windows') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
END $$;
DELETE FROM schema_migrations WHERE version = '0309_box_profile_quota_windows';
COMMIT;
