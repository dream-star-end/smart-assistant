-- OCV5-591 M1: deploy a release without the music sources first. Old code never touches these tables.
-- Destructive: refuses while any catalog row or user track exists (licence evidence and user-owned
-- music must be exported first). Catalog / track blobs are left to the studio GC once unreferenced.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE studio_music_catalog, studio_user_tracks IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0329_media_studio_music') THEN
    RAISE EXCEPTION '0329_media_studio_music is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0329_media_studio_music') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM studio_music_catalog) OR EXISTS (SELECT 1 FROM studio_user_tracks) THEN
    RAISE EXCEPTION '0329 rollback refused: music catalog or user tracks have rows';
  END IF;
END $$;
DROP TABLE studio_user_tracks;
DROP TABLE studio_music_catalog;
DELETE FROM schema_migrations WHERE version = '0329_media_studio_music';
COMMIT;
