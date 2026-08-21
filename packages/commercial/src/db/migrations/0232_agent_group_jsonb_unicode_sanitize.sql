-- 0232 — sanitize jsonb-illegal JSON unicode escapes in the lossless
-- agent-group canonicalize trigger.
--
-- order-dependency: 0231_turn_tape_materialization_resilience
-- (0231 and 0232 apply in dictionary order on the same branch after rebase.
-- 0232 CREATE OR REPLACE must follow 0231 so the format-3 skip is not left
-- as the last writer. Dictionary order 0231_* < 0232_*.)
--
-- Lazy sanitize: first cast the original UTF-8 payload to jsonb. Only if that
-- cast fails do we run sanitize_json_text_for_jsonb (plpgsql; near-quadratic
-- on payloads with many backslashes because each strpos(substr(src, i), ...)
-- copies the remaining text) and retry. Sanitize stays off the hot path for
-- the vast majority of legal rows.
--
-- Never rewrite a sanitized payload: B2 requires original record BYTEA and
-- content_sha256 to be immutable. If body came from sanitize, skip billing
-- canonicalize rewrite (RAISE WARNING + RETURN NEW). Canonicalize may rewrite
-- payload/hash only when body was parsed from unsanitized original bytes.
--
-- Additive. CREATE OR REPLACE FUNCTION only: no DROP TABLE/TRIGGER, no ALTER.
-- JSON.stringify emits \u0000 for NUL bytes (e.g. SQLite dumps). PostgreSQL
-- jsonb rejects \u0000 and unpaired surrogates (SQLSTATE 22P05), which aborted
-- tape materialization. Replica-role bypass cannot run as a LOGIN role and
-- would disable every origin trigger; lazy sanitize + EXCEPTION instead.
--
-- Backslash parity: a \uXXXX is a real JSON escape only when the number of
-- consecutive backslashes immediately before "uXXXX" is odd. \\u0000 is a
-- literal backslash plus the four characters u0000 and must not be rewritten.

CREATE OR REPLACE FUNCTION sanitize_json_text_for_jsonb(src text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $fn$
DECLARE
  n int;
  i int;
  pieces text[] := '{}';
  bs_char text := chr(92);
  pos int;
  bs int;
  even int;
  after int;
  hex text;
  code int;
  nxt int;
  hex2 text;
  paired int;
BEGIN
  n := length(src);
  i := 1;
  WHILE i <= n LOOP
    pos := strpos(substr(src, i), bs_char);
    IF pos = 0 THEN
      pieces := array_append(pieces, substr(src, i));
      EXIT;
    END IF;
    IF pos > 1 THEN
      pieces := array_append(pieces, substr(src, i, pos - 1));
    END IF;
    i := i + pos - 1;
    bs := 0;
    WHILE i + bs <= n AND substr(src, i + bs, 1) = bs_char LOOP
      bs := bs + 1;
    END LOOP;
    even := (bs / 2) * 2;
    IF even > 0 THEN
      pieces := array_append(pieces, repeat(bs_char, even));
    END IF;
    IF (bs % 2) = 0 THEN
      i := i + bs;
      CONTINUE;
    END IF;
    after := i + bs;
    IF after <= n AND substr(src, after, 1) = 'u' AND after + 4 <= n THEN
      hex := substr(src, after + 1, 4);
      IF hex ~ '^[0-9A-Fa-f]{4}$' THEN
        code := ('x' || hex)::bit(16)::int;
        IF code = 0 THEN
          pieces := array_append(pieces, bs_char || 'ufffd');
          i := after + 5;
          CONTINUE;
        END IF;
        IF code >= 55296 AND code <= 56319 THEN
          nxt := after + 5;
          IF nxt <= n AND substr(src, nxt, 1) = bs_char
             AND nxt + 1 <= n AND substr(src, nxt + 1, 1) = 'u'
             AND nxt + 5 <= n THEN
            hex2 := substr(src, nxt + 2, 4);
            IF hex2 ~ '^[0-9A-Fa-f]{4}$' THEN
              paired := ('x' || hex2)::bit(16)::int;
              IF paired >= 56320 AND paired <= 57343 THEN
                pieces := array_append(pieces, substr(src, i + even, 12));
                i := nxt + 6;
                CONTINUE;
              END IF;
            END IF;
          END IF;
          pieces := array_append(pieces, bs_char || 'ufffd');
          i := after + 5;
          CONTINUE;
        END IF;
        IF code >= 56320 AND code <= 57343 THEN
          pieces := array_append(pieces, bs_char || 'ufffd');
          i := after + 5;
          CONTINUE;
        END IF;
        pieces := array_append(pieces, substr(src, i + even, 6));
        i := after + 5;
        CONTINUE;
      END IF;
    END IF;
    pieces := array_append(pieces, bs_char);
    i := i + even + 1;
  END LOOP;
  RETURN array_to_string(pieces, '');
END;
$fn$;

COMMENT ON FUNCTION sanitize_json_text_for_jsonb(text) IS
  'Rewrite JSON text so jsonb will accept it: replace \u0000 and unpaired surrogates with \ufffd, honoring odd/even backslash runs.';

-- Keep format-3 bytes untouched (0231_turn_tape_materialization_resilience).
-- Lazy-cast original payload; sanitize only after jsonb rejects it. Never
-- write sanitized bytes back onto NEW.payload / content_sha256.
CREATE OR REPLACE FUNCTION canonicalize_legacy_lossless_agent_group()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  body JSONB;
  canonical JSONB;
  payload_text TEXT;
  sanitized_used BOOLEAN := false;
BEGIN
  IF NEW.role<>'agent-group' THEN RETURN NEW; END IF;
  BEGIN
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
    payload_text := convert_from(NEW.payload, 'UTF8');
    sanitized_used := false;
    BEGIN
      body := payload_text::jsonb;
    EXCEPTION WHEN others THEN
      BEGIN
        body := sanitize_json_text_for_jsonb(payload_text)::jsonb;
        sanitized_used := true;
      EXCEPTION WHEN others THEN
        RAISE WARNING 'canonicalize_legacy_lossless_agent_group skipped session_id=% tape_id=% msg_id=% sqlstate=% sqlerrm=%',
          NEW.session_id, NEW.tape_id, NEW.msg_id, SQLSTATE, SQLERRM;
        RETURN NEW;
      END;
    END;
    IF jsonb_typeof(body->'engineBillings') IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'oc_0151_canonicalize_billing_array'
    ) THEN
      RETURN NEW;
    END IF;
    canonical := oc_0151_canonicalize_billing_array(body->'engineBillings');
    IF canonical IS NOT DISTINCT FROM body->'engineBillings' THEN RETURN NEW; END IF;

    IF sanitized_used THEN
      RAISE WARNING 'canonicalize_legacy_lossless_agent_group skipped billing canonicalize because payload contains jsonb-illegal escapes session_id=% tape_id=% msg_id=%',
        NEW.session_id, NEW.tape_id, NEW.msg_id;
      RETURN NEW;
    END IF;

    body := jsonb_set(body, '{engineBillings}', canonical);
    NEW.payload := convert_to(body::text, 'UTF8');
    NEW.content_sha256 := encode(public.digest(NEW.payload, 'sha256'), 'hex');
    RETURN NEW;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'canonicalize_legacy_lossless_agent_group skipped session_id=% tape_id=% msg_id=% sqlstate=% sqlerrm=%',
      NEW.session_id, NEW.tape_id, NEW.msg_id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;
END $$;
