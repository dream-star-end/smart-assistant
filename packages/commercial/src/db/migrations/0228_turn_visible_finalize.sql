-- 0228 — visible finalize decoupling (docs/design/2026-08-19-turn-finalize-decoupling.md rev2)
-- Additive. Does NOT change client_session_turn_tapes.status CHECK (blocker 5).
-- Does NOT write production data beyond backfill of already-finalized rows.

ALTER TABLE client_session_turn_tapes
  ADD COLUMN IF NOT EXISTS visible_at bigint,
  ADD COLUMN IF NOT EXISTS visible_head jsonb,
  ADD COLUMN IF NOT EXISTS materialization_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS materialization_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS materialization_error text,
  ADD COLUMN IF NOT EXISTS materialization_next_attempt_at timestamptz;

ALTER TABLE client_session_turn_tapes
  DROP CONSTRAINT IF EXISTS cstt_materialization_status_chk;
ALTER TABLE client_session_turn_tapes
  ADD CONSTRAINT cstt_materialization_status_chk
  CHECK (materialization_status = ANY (ARRAY['pending','running','complete','failed']));

UPDATE client_session_turn_tapes
   SET visible_at = finalized_at,
       materialization_status = 'complete'
 WHERE finalized_at IS NOT NULL
   AND visible_at IS NULL;

ALTER TABLE turn_dispatches
  ADD COLUMN IF NOT EXISTS visible_head jsonb,
  ADD COLUMN IF NOT EXISTS visible_at bigint,
  ADD COLUMN IF NOT EXISTS producer_fenced_at timestamptz;

CREATE TABLE IF NOT EXISTS turn_tape_materialization_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  user_id text NOT NULL,
  tape_id text NOT NULL,
  dispatch_id uuid,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status = ANY (ARRAY['queued','leased','complete','failed'])),
  attempt integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id, tape_id)
);

CREATE INDEX IF NOT EXISTS idx_tape_mat_due
  ON turn_tape_materialization_jobs (next_attempt_at, created_at)
  WHERE status IN ('queued','leased');

CREATE TABLE IF NOT EXISTS turn_tape_settlement_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  user_id text NOT NULL,
  tape_id text NOT NULL,
  dispatch_id uuid,
  kind text NOT NULL CHECK (kind = ANY (ARRAY['billing','waiver'])),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_anchor_id text,
  request_id text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status = ANY (ARRAY['queued','leased','complete','failed','held'])),
  attempt integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id, tape_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_tape_settle_due
  ON turn_tape_settlement_jobs (next_attempt_at, created_at)
  WHERE status IN ('queued','leased');

-- Blocker 2: record INSERT may only canonicalize its own payload.
-- Parts are deleted solely by application publish after a complete manifest.
CREATE OR REPLACE FUNCTION canonicalize_legacy_lossless_agent_group()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  body JSONB;
  canonical JSONB;
BEGIN
  IF NEW.role<>'agent-group' THEN RETURN NEW; END IF;
  body := convert_from(NEW.payload,'UTF8')::jsonb;
  IF jsonb_typeof(body->'engineBillings') IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'oc_0151_canonicalize_billing_array'
  ) THEN
    RETURN NEW;
  END IF;
  canonical := oc_0151_canonicalize_billing_array(body->'engineBillings');
  IF canonical IS NOT DISTINCT FROM body->'engineBillings' THEN RETURN NEW; END IF;

  body := jsonb_set(body,'{engineBillings}',canonical);
  NEW.payload := convert_to(body::text,'UTF8');
  NEW.content_sha256 := encode(public.digest(NEW.payload,'sha256'),'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_canonicalize_legacy_lossless_agent_group
  ON client_session_turn_tape_records;
CREATE TRIGGER trg_canonicalize_legacy_lossless_agent_group
BEFORE INSERT OR UPDATE OF payload, role ON client_session_turn_tape_records
FOR EACH ROW EXECUTE FUNCTION canonicalize_legacy_lossless_agent_group();
