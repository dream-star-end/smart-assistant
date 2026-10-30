-- 0330: retain the logical turn key while short execution leases keep rolling.
-- order-dependency: none (allocated by v5-migration-claim.sh; no in-flight migration).
-- Backward compatible online: old bindings and old writers keep NULL until the
-- authenticated renewal endpoint binds the key once under its dispatch lock.
-- No prompt, credential, financial record or balance is stored or changed.

ALTER TABLE authority_turn_dispatches
  ADD COLUMN turn_key TEXT,
  ADD CONSTRAINT authority_turn_dispatches_turn_key_check
    CHECK (turn_key IS NULL OR turn_key ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN authority_turn_dispatches.turn_key IS
  'Write-once logical turn key bound by authenticated active-dispatch lease renewal; NULL remains compatible with old writers.';
