-- OCV5-576: keep OC_MUSE_BRIDGE_ENABLED off before rollback. Old code ignores the additive tables.
-- This destructive rollback refuses retained jobs or credentials; export audit history first.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE muse_media_jobs, muse_bridge_credentials IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0317_commercial_muse_media') THEN
    RAISE EXCEPTION '0317_commercial_muse_media is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0317_commercial_muse_media') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM muse_media_jobs) OR EXISTS (SELECT 1 FROM muse_bridge_credentials) THEN
    RAISE EXCEPTION 'retained Muse jobs or bridge credentials prevent destructive rollback';
  END IF;
END $$;
DROP TABLE muse_media_jobs;
DROP TABLE muse_bridge_credentials;
DELETE FROM schema_migrations WHERE version = '0317_commercial_muse_media';
COMMIT;
