-- OCV5-589: deploy a release without minimax/voices.ts first. Old code never touches the table.
-- Destructive: refuses while voices exist (export them first; they are user-owned).
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE minimax_voices IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0322_minimax_voices') THEN
    RAISE EXCEPTION '0322_minimax_voices is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0322_minimax_voices') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM minimax_voices) THEN
    RAISE EXCEPTION '0322 rollback refused: minimax_voices has rows';
  END IF;
END $$;
DROP TABLE minimax_voices;
DELETE FROM schema_migrations WHERE version = '0322_minimax_voices';
COMMIT;
