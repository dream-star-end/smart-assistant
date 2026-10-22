-- OCV5-591: deploy a release without media-studio/ first. Old code never touches these tables.
-- Destructive: refuses while any studio project or 'media_studio' ledger row exists (user-owned data
-- and billing history must be exported / reconciled first).
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE studio_projects, studio_blobs, studio_charges IN ACCESS EXCLUSIVE MODE;
LOCK TABLE credit_ledger IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0323_media_studio') THEN
    RAISE EXCEPTION '0323_media_studio is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0323_media_studio') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM studio_projects) OR EXISTS (SELECT 1 FROM studio_blobs)
     OR EXISTS (SELECT 1 FROM studio_charges) THEN
    RAISE EXCEPTION '0323 rollback refused: studio tables have rows';
  END IF;
  IF EXISTS (SELECT 1 FROM credit_ledger WHERE reason = 'media_studio') THEN
    RAISE EXCEPTION '0323 rollback refused: credit_ledger has media_studio rows';
  END IF;
END $$;
DROP TABLE studio_charges, studio_step_results, studio_quota_holds, studio_quota, studio_blob_refs, studio_blobs,
  studio_tasks, studio_events, studio_annotations, studio_takes, studio_lines, studio_shots,
  studio_assets, studio_projects;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
  'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
  'minimax_media','image_generation','subscription','subscription_expire','pack','muse_media'
)) NOT VALID;
ALTER TABLE credit_ledger VALIDATE CONSTRAINT credit_ledger_reason_check;
DELETE FROM schema_migrations WHERE version = '0323_media_studio';
COMMIT;
