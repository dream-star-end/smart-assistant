-- Manual rollback for 0304_auto_dream_billing_workload.
--
-- Order: first re-release a code SHA that never writes 'auto_dream' (any SHA before
-- this migration). Running this while new code is live would make the next
-- Auto-Dream settle fail the restored usage_records CHECK.
--
-- usage_records: every 'auto_dream' row (backfilled or written after the release) goes
-- back to 'chat' and the CHECK is restored.
-- credit_ledger is append-only (rules cl_no_update / cl_no_delete): its 'auto_dream'
-- rows cannot be relabelled, so its CHECK keeps 'auto_dream' while any such row exists
-- (older code never writes it and is unaffected). With none, the old CHECK is restored.
-- Amounts and links are untouched. The backup table is kept as evidence. Removing the
-- schema_migrations row lets a later release re-apply 0304.

BEGIN;

LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '0304_auto_dream_billing_workload'
  ) THEN
    RAISE EXCEPTION '0304 is not applied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM schema_migrations WHERE version > '0304_auto_dream_billing_workload'
  ) THEN
    RAISE EXCEPTION 'a later migration is applied; roll that back first';
  END IF;
END $$;

UPDATE usage_records SET mode = 'chat' WHERE mode = 'auto_dream';

ALTER TABLE usage_records DROP CONSTRAINT usage_records_mode_check;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_mode_check
  CHECK (mode IN ('chat', 'agent', 'delegate'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM credit_ledger WHERE reason = 'auto_dream') THEN
    RAISE NOTICE '0304 rollback: credit_ledger has append-only auto_dream rows; its CHECK keeps auto_dream';
  ELSE
    ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_reason_check;
    ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
      'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
      'minimax_media','image_generation','subscription','subscription_expire','pack'
    ));
  END IF;
END $$;

DELETE FROM schema_migrations WHERE version = '0304_auto_dream_billing_workload';

COMMIT;
