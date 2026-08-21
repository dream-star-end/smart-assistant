-- 0229 — settlement immutability + job FK/GC
-- docs/design/2026-08-19-turn-finalize-decoupling.md rev3
-- Additive. Does not write production data.

ALTER TABLE client_session_turn_tapes
  ADD COLUMN IF NOT EXISTS settlement_hash text,
  ADD COLUMN IF NOT EXISTS settlement_verified_at timestamptz;

ALTER TABLE turn_tape_settlement_jobs
  ADD COLUMN IF NOT EXISTS settlement_hash text,
  ADD COLUMN IF NOT EXISTS cold_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE turn_tape_materialization_jobs
  DROP CONSTRAINT IF EXISTS turn_tape_materialization_jobs_tape_fk;
ALTER TABLE turn_tape_materialization_jobs
  ADD CONSTRAINT turn_tape_materialization_jobs_tape_fk
  FOREIGN KEY (session_id, user_id, tape_id)
  REFERENCES client_session_turn_tapes (session_id, user_id, tape_id)
  ON DELETE CASCADE;

ALTER TABLE turn_tape_settlement_jobs
  DROP CONSTRAINT IF EXISTS turn_tape_settlement_jobs_tape_fk;
ALTER TABLE turn_tape_settlement_jobs
  ADD CONSTRAINT turn_tape_settlement_jobs_tape_fk
  FOREIGN KEY (session_id, user_id, tape_id)
  REFERENCES client_session_turn_tapes (session_id, user_id, tape_id)
  ON DELETE CASCADE;
