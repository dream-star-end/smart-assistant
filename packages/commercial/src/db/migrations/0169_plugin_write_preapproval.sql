-- 0169 — managed-browser Plugin account preapproval for writes.
--
-- The master write switch remains the prerequisite and keeps its existing
-- disclaimer. Preapproval is a second, default-off consent that removes only
-- the per-operation confirmation UI; writes still use the encrypted ledger,
-- contract/account pins and the external-dispatch fence.

ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS plugin_write_preapproval_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS plugin_write_preapproval_disclaimer_version INTEGER,
  ADD COLUMN IF NOT EXISTS plugin_write_preapproval_accepted_at TIMESTAMPTZ;

ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_plugin_write_preapproval_consent;
ALTER TABLE connections
  ADD CONSTRAINT connections_plugin_write_preapproval_consent CHECK (
    plugin_write_preapproval_enabled = FALSE
    OR (
      plugin_write_enabled = TRUE
      AND plugin_write_preapproval_disclaimer_version IS NOT NULL
      AND plugin_write_preapproval_disclaimer_version > 0
      AND plugin_write_preapproval_accepted_at IS NOT NULL
    )
  );

ALTER TABLE connector_write_ledger
  ADD COLUMN IF NOT EXISTS approval_source VARCHAR(32) NOT NULL DEFAULT 'user_confirmation',
  ADD COLUMN IF NOT EXISTS approval_policy_version INTEGER;

ALTER TABLE connector_write_ledger
  DROP CONSTRAINT IF EXISTS connector_write_ledger_approval_source_shape;
ALTER TABLE connector_write_ledger
  ADD CONSTRAINT connector_write_ledger_approval_source_shape CHECK (
    (
      approval_source = 'user_confirmation'
      AND approval_policy_version IS NULL
    )
    OR (
      approval_source = 'account_preapproval'
      AND approval_policy_version IS NOT NULL
      AND approval_policy_version > 0
      AND approved_at IS NOT NULL
    )
  );

COMMENT ON COLUMN connections.plugin_write_preapproval_enabled IS
  'Independent account-level opt-in that removes per-write confirmation; master write consent remains required';
COMMENT ON COLUMN connections.plugin_write_preapproval_disclaimer_version IS
  'Last explicitly accepted server-owned account preapproval disclaimer version';
COMMENT ON COLUMN connections.plugin_write_preapproval_accepted_at IS
  'Audit timestamp for the last explicit account preapproval acceptance';
COMMENT ON COLUMN connector_write_ledger.approval_source IS
  'Write authorization source: explicit per-operation confirmation or account preapproval';
COMMENT ON COLUMN connector_write_ledger.approval_policy_version IS
  'Server-owned account preapproval policy version captured when the ledger row was created';
