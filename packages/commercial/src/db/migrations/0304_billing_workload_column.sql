-- 0304 OCV5-392: tag memory consolidation (Auto-Dream) billing rows.
-- order-dependency: none (adds nullable workload columns + an audit table only; 0303 is a selfhost-only catalog migration)
--
-- Auto-Dream calls carry cc_workload=auto-dream in the CCB billing header, and the
-- finalize journal records it as ctx.workload (OCV5-392). Settlement now also writes
-- workload='auto_dream' on the usage_records row and on every credit_ledger debit row
-- for such a call. mode / reason stay 'chat' (amount, admission and pricing are the
-- same as a chat call); NULL means an ordinary row.
--
-- Additive only: two nullable columns with a CHECK each, no change to existing CHECKs.
-- Backfill: usage_records rows the journal proves were Auto-Dream (committed journal
-- row, ctx.workload='auto-dream', linked by usage_id). The touched ids are kept in
-- billing_workload_0304_backup (the old value was NULL by construction).
-- credit_ledger is append-only (rules cl_no_update / cl_no_delete): existing ledger
-- rows keep workload NULL; only new debits are tagged.
-- Rollback: db/rollbacks/0304_billing_workload_column.sql.

ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS workload TEXT
  CONSTRAINT usage_records_workload_check CHECK (workload = 'auto_dream');

ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS workload TEXT
  CONSTRAINT credit_ledger_workload_check CHECK (workload = 'auto_dream');

CREATE TABLE IF NOT EXISTS billing_workload_0304_backup (
  usage_id BIGINT PRIMARY KEY,
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO billing_workload_0304_backup (usage_id)
SELECT u.id
  FROM usage_records u
  JOIN request_finalize_journal j ON j.usage_id = u.id AND j.user_id = u.user_id
 WHERE j.state = 'committed'
   AND j.ctx->>'workload' = 'auto-dream'
   AND u.workload IS NULL
ON CONFLICT (usage_id) DO NOTHING;

UPDATE usage_records u
   SET workload = 'auto_dream'
  FROM billing_workload_0304_backup b
 WHERE u.id = b.usage_id
   AND u.workload IS NULL;
