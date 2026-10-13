-- Rollback for 0304_billing_workload_column (OCV5-392).
-- Re-release code older than 0304 first: it does not read or write the workload
-- columns, so they can stay. This clears the usage_records backfill and unregisters
-- the migration; re-applying 0304 is idempotent (IF NOT EXISTS / ON CONFLICT).
-- credit_ledger.workload values stay (append-only table; rules forbid UPDATE).
-- billing_workload_0304_backup is kept for audit.
BEGIN;
LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0304_billing_workload_column') THEN
    RAISE EXCEPTION '0304_billing_workload_column is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '0304_billing_workload_column') THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
END $$;
UPDATE usage_records SET workload = NULL WHERE workload = 'auto_dream';
DELETE FROM schema_migrations WHERE version = '0304_billing_workload_column';
COMMIT;
