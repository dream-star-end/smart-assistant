-- order-dependency: 0279_api_key_message_audit
-- R0 readers precede R1 writers. Old finalized-tape rows retain their meaning.
ALTER TABLE turn_recovery_jobs ADD COLUMN IF NOT EXISTS job_origin TEXT NOT NULL DEFAULT 'finalized_tape';
ALTER TABLE turn_recovery_jobs ADD COLUMN IF NOT EXISTS source_dispatch_id UUID;
ALTER TABLE turn_recovery_jobs ADD COLUMN IF NOT EXISTS source_dispatch_attempt INTEGER;
ALTER TABLE turn_recovery_jobs ADD COLUMN IF NOT EXISTS preparation_retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turn_recovery_jobs ADD COLUMN IF NOT EXISTS preparation_send_intent_at TIMESTAMPTZ;
ALTER TABLE turn_recovery_jobs ALTER COLUMN source_turn_key DROP NOT NULL;
ALTER TABLE turn_recovery_jobs ALTER COLUMN tape_sha256 DROP NOT NULL;
ALTER TABLE turn_recovery_jobs DROP CONSTRAINT IF EXISTS turn_recovery_jobs_origin_check;
ALTER TABLE turn_recovery_jobs ADD CONSTRAINT turn_recovery_jobs_origin_check CHECK (
  (job_origin='finalized_tape' AND source_turn_key IS NOT NULL AND tape_sha256 IS NOT NULL
   AND source_dispatch_id IS NULL AND source_dispatch_attempt IS NULL
   AND preparation_retry_count=0 AND preparation_send_intent_at IS NULL)
  OR
  (job_origin='pre_transfer_enrichment' AND source_turn_key IS NULL AND tape_sha256 IS NULL
   AND source_dispatch_id IS NOT NULL AND source_dispatch_attempt IS NOT NULL AND source_dispatch_attempt=1
   AND recovery_mode='replay' AND semantic_recovery_attempt=1
   AND preparation_retry_count BETWEEN 0 AND 2)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_preparation_recovery_source
  ON turn_recovery_jobs(source_dispatch_id,source_dispatch_attempt)
  WHERE job_origin='pre_transfer_enrichment';
ALTER TABLE turn_dispatches ADD COLUMN IF NOT EXISTS preparation_request_json JSONB;
ALTER TABLE turn_dispatches ADD COLUMN IF NOT EXISTS preparation_request_sha256 TEXT;
ALTER TABLE turn_dispatches DROP CONSTRAINT IF EXISTS turn_dispatches_preparation_snapshot_check;
ALTER TABLE turn_dispatches ADD CONSTRAINT turn_dispatches_preparation_snapshot_check CHECK (
  (preparation_request_json IS NULL AND preparation_request_sha256 IS NULL) OR
  (preparation_request_json IS NOT NULL AND preparation_request_sha256 IS NOT NULL AND preparation_request_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE OR REPLACE FUNCTION fn_0280_preparation_intent_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.preparation_send_intent_at IS NOT NULL AND
     NEW.preparation_send_intent_at IS DISTINCT FROM OLD.preparation_send_intent_at THEN
    RAISE EXCEPTION '0280 preparation send intent is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_0280_preparation_intent_monotonic ON turn_recovery_jobs;
CREATE TRIGGER trg_0280_preparation_intent_monotonic BEFORE UPDATE ON turn_recovery_jobs
  FOR EACH ROW EXECUTE FUNCTION fn_0280_preparation_intent_monotonic();
