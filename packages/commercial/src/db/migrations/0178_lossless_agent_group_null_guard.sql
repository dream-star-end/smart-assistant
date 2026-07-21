-- 0178 — do not rewrite lossless agent-group rows which have no billing array.
--
-- The 0151 rolling-compatibility trigger used `<> 'array'`.  PostgreSQL
-- returns NULL for jsonb_typeof() on a missing key, and PL/pgSQL treats that
-- NULL condition as false.  The trigger therefore fell through and added an
-- empty engineBillings array, changing otherwise canonical derived bytes.
-- Keep the legacy raw-reason scrub for real arrays, but leave missing, JSON
-- null and non-array values untouched for the application validator.
CREATE OR REPLACE FUNCTION canonicalize_legacy_lossless_agent_group()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  body JSONB;
  canonical JSONB;
BEGIN
  IF NEW.role<>'agent-group' THEN RETURN NEW; END IF;
  body := convert_from(NEW.payload,'UTF8')::jsonb;
  IF jsonb_typeof(body->'engineBillings') IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
  canonical := oc_0151_canonicalize_billing_array(body->'engineBillings');
  IF canonical IS NOT DISTINCT FROM body->'engineBillings' THEN RETURN NEW; END IF;

  body := jsonb_set(body,'{engineBillings}',canonical);
  NEW.payload := convert_to(body::text,'UTF8');
  NEW.content_sha256 := encode(public.digest(NEW.payload,'sha256'),'hex');

  DELETE FROM client_session_turn_tape_parts
   WHERE session_id=NEW.session_id AND user_id=NEW.user_id AND tape_id=NEW.tape_id;
  RETURN NEW;
END $$;
