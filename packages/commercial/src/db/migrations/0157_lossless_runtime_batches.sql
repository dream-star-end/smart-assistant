-- 0157_lossless_runtime_batches — distinguish compressed physical tape rows.
--
-- Existing and rolling writers remain format 2. A new master sets format 3
-- only when it materialises `_runtimeEventBatch` records. Deploy/rollback
-- tooling uses this durable marker (together with the opt-in env flag) to keep
-- masters that cannot hydrate format 3 behind an irreversible compatibility
-- floor.

ALTER TABLE client_session_turn_tapes
  ADD COLUMN record_storage_format SMALLINT NOT NULL DEFAULT 2;

ALTER TABLE client_session_turn_tapes
  ADD CONSTRAINT cstt_record_storage_format_chk
  CHECK (record_storage_format IN (2, 3));

CREATE INDEX idx_cstt_finalized_storage_format
  ON client_session_turn_tapes(record_storage_format)
  WHERE finalized_at IS NOT NULL AND record_storage_format >= 3;
