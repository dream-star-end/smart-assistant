-- OCV5-574: set OC_MUSE_PRICE_*_CREDITS unset (or the bridge off) before rollback. Refuses once any
-- Muse charge exists: the ledger rows and their job rows are billing history, export them first.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE muse_media_jobs, credit_ledger IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0319_commercial_muse_billing') THEN
    RAISE EXCEPTION '0319_commercial_muse_billing is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0319_commercial_muse_billing') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
  IF EXISTS (SELECT 1 FROM credit_ledger WHERE reason = 'muse_media')
     OR EXISTS (SELECT 1 FROM muse_media_jobs WHERE cost_credits IS NOT NULL) THEN
    RAISE EXCEPTION 'retained Muse charges prevent rollback';
  END IF;
END $$;
ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
  'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
  'minimax_media','image_generation','subscription','subscription_expire','pack'
));
DROP INDEX IF EXISTS muse_media_jobs_kind_queued_idx;
ALTER TABLE muse_media_jobs DROP CONSTRAINT IF EXISTS muse_media_jobs_charge_only_succeeded;
ALTER TABLE muse_media_jobs
  DROP COLUMN IF EXISTS ledger_id,
  DROP COLUMN IF EXISTS price_snapshot,
  DROP COLUMN IF EXISTS debited_credits,
  DROP COLUMN IF EXISTS cost_credits;
DELETE FROM schema_migrations WHERE version = '0319_commercial_muse_billing';
COMMIT;
