-- 0304_auto_dream_billing_workload.sql (OCV5-392, personal edition)
-- Auto-Dream (background memory consolidation) is billed to the user through the
-- same CCB proxy settle path as a chat turn, so it was recorded as
-- usage_records.mode='chat' and credit_ledger.reason='chat'. Users and admins could
-- not tell a consolidation charge from a conversation.
--
-- From this release the proxy writes mode='auto_dream' / reason='auto_dream' when the
-- request carries CCB's `cc_workload=auto-dream;` billing-header tag (journal
-- ctx.workload, recorded since 0995a0542).
--
-- This migration:
--   1. widens both CHECK lists with 'auto_dream';
--   2. relabels usage_records rows the journal proves were Auto-Dream (committed journal
--      row with ctx.workload='auto-dream' → its usage row). Older Auto-Dream rows have
--      no proof and stay 'chat';
--   3. keeps every relabelled row's old value in billing_workload_0304_backup.
-- credit_ledger is append-only (0002 rules cl_no_update / cl_no_delete), so existing
-- ledger rows keep 'chat'; new Auto-Dream debits are inserted as 'auto_dream'.
-- Amounts, balances and links are not touched: only usage_records.mode changes.
--
-- Rollback: db/rollbacks/0304_auto_dream_billing_workload.sql (re-release code without
-- auto_dream first; the widened CHECKs are harmless to older code).

CREATE TABLE IF NOT EXISTS billing_workload_0304_backup (
  table_name   TEXT NOT NULL CHECK (table_name IN ('usage_records')),
  row_id       BIGINT NOT NULL,
  old_value    TEXT NOT NULL,
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (table_name, row_id)
);

ALTER TABLE usage_records DROP CONSTRAINT usage_records_mode_check;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_mode_check
  CHECK (mode IN ('chat', 'agent', 'delegate', 'auto_dream'));

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check CHECK (reason IN (
  'topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
  'minimax_media','image_generation','subscription','subscription_expire','pack',
  'auto_dream'
)) NOT VALID;
ALTER TABLE credit_ledger VALIDATE CONSTRAINT credit_ledger_reason_check;

INSERT INTO billing_workload_0304_backup (table_name, row_id, old_value)
SELECT 'usage_records', ur.id, ur.mode
  FROM usage_records ur
  JOIN request_finalize_journal j
    ON j.usage_id = ur.id AND j.user_id = ur.user_id
 WHERE j.state = 'committed'
   AND j.ctx->>'workload' = 'auto-dream'
   AND ur.mode = 'chat'
ON CONFLICT (table_name, row_id) DO NOTHING;

UPDATE usage_records ur
   SET mode = 'auto_dream'
  FROM billing_workload_0304_backup b
 WHERE b.table_name = 'usage_records' AND b.row_id = ur.id AND ur.mode = 'chat';
