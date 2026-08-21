-- 0231 — keep visible turns readable while Phase B materialization is pending,
-- and stop the legacy agent-group compatibility trigger from parsing modern
-- format-3 payloads through PostgreSQL jsonb.
--
-- JSON permits an escaped NUL (\u0000), but PostgreSQL jsonb rejects it with
-- SQLSTATE 22P05. Format 3 is produced and hash-verified by the application,
-- so the rolling format-2 billing scrub must not reinterpret those bytes.

CREATE OR REPLACE FUNCTION canonicalize_legacy_lossless_agent_group()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  body JSONB;
  canonical JSONB;
BEGIN
  IF NEW.role<>'agent-group' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1
      FROM client_session_turn_tapes t
     WHERE t.session_id=NEW.session_id
       AND t.user_id=NEW.user_id
       AND t.tape_id=NEW.tape_id
       AND t.record_storage_format=3
  ) THEN
    RETURN NEW;
  END IF;

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
