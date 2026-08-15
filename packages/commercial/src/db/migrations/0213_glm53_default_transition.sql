-- 0213 — move executable defaults and persisted live selections to GLM-5.3.
--
-- This migration is applied before the C1 code release. The old stable release still
-- defaults to glm-5.2 during that window, so the two temporary BEFORE triggers are a
-- deliberate write fence: every stale old-model write is normalized to glm-5.3 and
-- recorded in a permanent, tiny before-image ledger. C2 removes the fence only after
-- its catalog-disable transaction has proved that no live old-model reference remains.
--
-- Historical usage/audit rows and deleted sessions are intentionally untouched.

-- BEGIN TESTED MANUAL ROLLBACK 0213
-- DO $rollback_preflight$
-- BEGIN
--   IF NOT EXISTS (
--     SELECT 1 FROM pg_trigger
--      WHERE tgrelid = 'user_preferences'::regclass
--        AND tgname = 'trg_0213_normalize_user_default_model'
--        AND NOT tgisinternal
--   ) OR NOT EXISTS (
--     SELECT 1 FROM pg_trigger
--      WHERE tgrelid = 'client_sessions'::regclass
--        AND tgname = 'trg_0213_normalize_client_session_model'
--        AND NOT tgisinternal
--   ) THEN
--     RAISE EXCEPTION '0213 rollback requires both transition write fences';
--   END IF;
-- END
-- $rollback_preflight$;
--
-- DROP TRIGGER trg_0213_normalize_user_default_model ON user_preferences;
-- DROP TRIGGER trg_0213_normalize_client_session_model ON client_sessions;
--
-- UPDATE user_preferences AS p
--    SET prefs = jsonb_set(p.prefs, '{default_model}', to_jsonb(s.original_model_id), true),
--        updated_at = clock_timestamp()
--   FROM model_default_transition_snapshots AS s
--  WHERE s.subject_kind = 'user_preferences'
--    AND s.subject_key = p.user_id::text
--    AND p.prefs->>'default_model' = 'glm-5.3'
--    AND p.updated_at = s.normalized_at;
--
-- UPDATE client_sessions AS c
--    SET model_id = s.original_model_id,
--        updated_at = GREATEST(
--          c.updated_at + 1,
--          floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
--        )
--   FROM model_default_transition_snapshots AS s
--  WHERE s.subject_kind = 'client_sessions'
--    AND s.subject_key = c.id
--    AND c.model_id = 'glm-5.3'
--    AND c.updated_at = s.normalized_at_ms;
--
-- DROP FUNCTION fn_0213_normalize_user_default_model();
-- DROP FUNCTION fn_0213_normalize_client_session_model();
-- END TESTED MANUAL ROLLBACK 0213

DO $preflight$
BEGIN
  PERFORM 1
    FROM model_catalog
   WHERE model_id = 'glm-5.3'
     FOR SHARE;
  PERFORM 1
    FROM model_pricing
   WHERE model_id = 'glm-5.3'
     FOR SHARE;

  IF (SELECT count(*) FROM model_catalog WHERE model_id = 'glm-5.3') <> 1
     OR (SELECT count(*) FROM model_catalog
          WHERE model_id = 'glm-5.3' AND state = 'active') <> 1 THEN
    RAISE EXCEPTION '0213 requires exactly one active glm-5.3 catalog row';
  END IF;
  IF (SELECT count(*) FROM model_pricing WHERE model_id = 'glm-5.3') <> 1
     OR (SELECT count(*) FROM model_pricing
          WHERE model_id = 'glm-5.3' AND enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0213 requires enabled glm-5.3 pricing';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS model_default_transition_snapshots (
  subject_kind       TEXT NOT NULL
                     CHECK (subject_kind IN ('user_preferences', 'client_sessions')),
  subject_key        TEXT NOT NULL CHECK (subject_key <> ''),
  original_model_id  TEXT NOT NULL
                     CHECK (original_model_id IN (
                       'qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2'
                     )),
  normalized_at      TIMESTAMPTZ,
  normalized_at_ms   BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subject_kind, subject_key),
  CHECK (
    (subject_kind = 'user_preferences'
      AND normalized_at IS NOT NULL AND normalized_at_ms IS NULL)
    OR
    (subject_kind = 'client_sessions'
      AND normalized_at IS NULL AND normalized_at_ms IS NOT NULL)
  )
);

COMMENT ON TABLE model_default_transition_snapshots IS
  'Permanent ops ledger for the 0213 GLM-5.3 default transition. Stores only rows normalized by the temporary write fences; conditional compensation compares the exact normalization marker so later user choices win.';

CREATE OR REPLACE FUNCTION fn_0213_normalize_user_default_model()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_requested TEXT;
  v_marker TIMESTAMPTZ;
BEGIN
  v_requested := NEW.prefs->>'default_model';
  IF v_requested = ANY(ARRAY['qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2']) THEN
    v_marker := clock_timestamp();
    INSERT INTO public.model_default_transition_snapshots(
      subject_kind, subject_key, original_model_id, normalized_at, normalized_at_ms
    ) VALUES (
      'user_preferences', NEW.user_id::text, v_requested, v_marker, NULL
    )
    ON CONFLICT (subject_kind, subject_key) DO UPDATE
      SET original_model_id = EXCLUDED.original_model_id,
          normalized_at = EXCLUDED.normalized_at,
          normalized_at_ms = NULL;

    NEW.prefs := jsonb_set(NEW.prefs, '{default_model}', to_jsonb('glm-5.3'::text), true);
    NEW.updated_at := v_marker;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION fn_0213_normalize_client_session_model()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_requested TEXT;
  v_marker BIGINT;
BEGIN
  v_requested := NEW.model_id;
  IF v_requested = ANY(ARRAY['qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2']) THEN
    v_marker := floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
    IF TG_OP = 'UPDATE' THEN
      v_marker := GREATEST(v_marker, COALESCE(OLD.updated_at, 0) + 1, COALESCE(NEW.updated_at, 0));
    ELSE
      v_marker := GREATEST(v_marker, COALESCE(NEW.updated_at, 0));
    END IF;

    INSERT INTO public.model_default_transition_snapshots(
      subject_kind, subject_key, original_model_id, normalized_at, normalized_at_ms
    ) VALUES (
      'client_sessions', NEW.id, v_requested, NULL, v_marker
    )
    ON CONFLICT (subject_kind, subject_key) DO UPDATE
      SET original_model_id = EXCLUDED.original_model_id,
          normalized_at = NULL,
          normalized_at_ms = EXCLUDED.normalized_at_ms;

    NEW.model_id := 'glm-5.3';
    NEW.updated_at := v_marker;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION fn_0213_normalize_user_default_model() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_0213_normalize_client_session_model() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_0213_normalize_user_default_model ON user_preferences;
CREATE TRIGGER trg_0213_normalize_user_default_model
BEFORE INSERT OR UPDATE OF prefs ON user_preferences
FOR EACH ROW EXECUTE FUNCTION fn_0213_normalize_user_default_model();

DROP TRIGGER IF EXISTS trg_0213_normalize_client_session_model ON client_sessions;
CREATE TRIGGER trg_0213_normalize_client_session_model
BEFORE INSERT OR UPDATE OF model_id ON client_sessions
FOR EACH ROW EXECUTE FUNCTION fn_0213_normalize_client_session_model();

-- Fire the same write-fence path for the pre-existing rows, so snapshot and marker
-- semantics are identical for the initial backfill and for writes in the deploy gap.
UPDATE user_preferences
   SET prefs = prefs
 WHERE prefs->>'default_model' IN (
   'qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2'
 );

UPDATE client_sessions
   SET model_id = model_id
 WHERE deleted_at IS NULL
   AND model_id IN ('qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2');

DO $postcondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_preferences
     WHERE prefs->>'default_model' IN (
       'qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2'
     )
  ) THEN
    RAISE EXCEPTION '0213 left a stale user default model';
  END IF;
  IF EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL
       AND model_id IN ('qwen3.7-max', 'qwen3.7-plus', 'glm-5.1', 'glm-5.2')
  ) THEN
    RAISE EXCEPTION '0213 left a stale live client-session model';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN (
         'trg_0213_normalize_user_default_model',
         'trg_0213_normalize_client_session_model'
       ) AND NOT tgisinternal AND tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION '0213 transition write fences are not both enabled';
  END IF;
END
$postcondition$;
