-- 0218 — move persisted DeepSeek V4 Pro selections to DeepSeek V4 Flash.
--
-- This migration is applied before the code release that stops hardcoding
-- deepseek-v4-pro. The old stable release can still execute Pro during that
-- window, so the temporary BEFORE triggers are a deliberate write fence: every
-- stale Pro write is normalized to deepseek-v4-flash and recorded in a
-- permanent, tiny before-image ledger. 0219 removes the fence only after its
-- catalog-disable transaction has proved that no live Pro reference remains.
--
-- official_seed_agent moves to deepseek-v4-flash in this migration. Flash already
-- carries ccb_secondary_utility; 0144's primary key is (model_id, requirement),
-- so both requirements coexist. The deferred runtime-requirements guard only
-- demands that every required model stay active+priced, and does not forbid a
-- model from satisfying more than one requirement.
--
-- Historical usage/audit rows and deleted sessions are intentionally untouched.

-- BEGIN TESTED MANUAL ROLLBACK 0218
-- DO $rollback_preflight$
-- BEGIN
--   IF NOT EXISTS (
--     SELECT 1 FROM pg_trigger
--      WHERE tgrelid = 'user_preferences'::regclass
--        AND tgname = 'trg_0218_normalize_user_default_model'
--        AND NOT tgisinternal
--   ) OR NOT EXISTS (
--     SELECT 1 FROM pg_trigger
--      WHERE tgrelid = 'client_sessions'::regclass
--        AND tgname = 'trg_0218_normalize_client_session_model'
--        AND NOT tgisinternal
--   ) OR NOT EXISTS (
--     SELECT 1 FROM pg_trigger
--      WHERE tgrelid = 'model_visibility_grants'::regclass
--        AND tgname = 'trg_0218_normalize_visibility_grant'
--        AND NOT tgisinternal
--   ) THEN
--     RAISE EXCEPTION '0218 rollback requires all three transition write fences';
--   END IF;
-- END
-- $rollback_preflight$;
--
-- DROP TRIGGER trg_0218_normalize_user_default_model ON user_preferences;
-- DROP TRIGGER trg_0218_normalize_client_session_model ON client_sessions;
-- DROP TRIGGER trg_0218_normalize_visibility_grant ON model_visibility_grants;
--
-- UPDATE user_preferences AS p
--    SET prefs = jsonb_set(p.prefs, '{default_model}', to_jsonb(s.original_model_id), true),
--        updated_at = clock_timestamp()
--   FROM model_dsv4pro_transition_snapshots AS s
--  WHERE s.subject_kind = 'user_preferences'
--    AND s.subject_key = p.user_id::text
--    AND p.prefs->>'default_model' = 'deepseek-v4-flash'
--    AND p.updated_at = s.normalized_at;
--
-- UPDATE client_sessions AS c
--    SET model_id = s.original_model_id,
--        updated_at = GREATEST(
--          c.updated_at + 1,
--          floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
--        )
--   FROM model_dsv4pro_transition_snapshots AS s
--  WHERE s.subject_kind = 'client_sessions'
--    AND s.subject_key = c.id
--    AND c.model_id = 'deepseek-v4-flash'
--    AND c.updated_at = s.normalized_at_ms;
--
-- INSERT INTO model_visibility_grants(user_id, model_id, granted_at, granted_by)
-- SELECT (s.grant_before->>'user_id')::bigint,
--        s.grant_before->>'model_id',
--        (s.grant_before->>'granted_at')::timestamptz,
--        (s.grant_before->>'granted_by')::bigint
--   FROM model_dsv4pro_transition_snapshots AS s
--  WHERE s.subject_kind = 'model_visibility_grants'
-- ON CONFLICT (user_id, model_id) DO NOTHING;
--
-- DELETE FROM model_visibility_grants AS g
--  USING model_dsv4pro_transition_snapshots AS s
--  WHERE s.subject_kind = 'model_visibility_grants'
--    AND s.grant_flash_existed IS FALSE
--    AND g.user_id::text = s.subject_key
--    AND g.model_id = 'deepseek-v4-flash'
--    AND g.granted_at IS NOT DISTINCT FROM (s.grant_before->>'granted_at')::timestamptz
--    AND g.granted_by IS NOT DISTINCT FROM (s.grant_before->>'granted_by')::bigint;
--
-- DELETE FROM model_runtime_requirements
--  WHERE model_id = 'deepseek-v4-flash'
--    AND requirement = 'official_seed_agent';
-- INSERT INTO model_runtime_requirements(model_id, requirement)
-- VALUES ('deepseek-v4-pro', 'official_seed_agent')
-- ON CONFLICT (model_id, requirement) DO NOTHING;
--
-- DROP FUNCTION fn_0218_normalize_user_default_model();
-- DROP FUNCTION fn_0218_normalize_client_session_model();
-- DROP FUNCTION fn_0218_normalize_visibility_grant();
-- END TESTED MANUAL ROLLBACK 0218

LOCK TABLE model_catalog, model_pricing, model_runtime_requirements,
  user_preferences, client_sessions, model_visibility_grants,
  account_group_models, model_aliases
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  PERFORM 1
    FROM model_catalog
   WHERE model_id = 'deepseek-v4-flash'
     AND state = 'active'
     FOR SHARE;
  PERFORM 1
    FROM model_pricing
   WHERE model_id = 'deepseek-v4-flash'
     FOR SHARE;
  PERFORM 1
    FROM model_catalog
   WHERE model_id = 'deepseek-v4-pro'
     AND state = 'active'
     FOR SHARE;
  PERFORM 1
    FROM model_pricing
   WHERE model_id = 'deepseek-v4-pro'
     FOR SHARE;

  IF (SELECT count(*) FROM model_catalog
       WHERE model_id = 'deepseek-v4-flash' AND state = 'active') <> 1 THEN
    RAISE EXCEPTION '0218 requires exactly one active deepseek-v4-flash catalog row';
  END IF;
  IF (SELECT count(*) FROM model_pricing
       WHERE model_id = 'deepseek-v4-flash' AND enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0218 requires enabled deepseek-v4-flash pricing';
  END IF;
  IF (SELECT count(*) FROM model_catalog
       WHERE model_id = 'deepseek-v4-pro' AND state = 'active') <> 1 THEN
    RAISE EXCEPTION '0218 requires exactly one active deepseek-v4-pro catalog row';
  END IF;
  IF (SELECT count(*) FROM model_pricing
       WHERE model_id = 'deepseek-v4-pro' AND enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0218 requires enabled deepseek-v4-pro pricing';
  END IF;

  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'deepseek-v4-flash'
         AND requirement = 'ccb_secondary_utility') <> 1 THEN
    RAISE EXCEPTION '0218 requires deepseek-v4-flash to keep ccb_secondary_utility';
  END IF;
  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE requirement = 'official_seed_agent'
         AND model_id IN ('deepseek-v4-pro', 'deepseek-v4-flash')) <> 1 THEN
    RAISE EXCEPTION '0218 requires official_seed_agent on Pro or already on Flash';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_group_models WHERE model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1
      FROM model_aliases a
      JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0218 requires zero Pro group mappings/aliases';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS model_dsv4pro_transition_snapshots (
  subject_kind         TEXT NOT NULL
                       CHECK (subject_kind IN (
                         'user_preferences',
                         'client_sessions',
                         'model_visibility_grants'
                       )),
  subject_key          TEXT NOT NULL CHECK (subject_key <> ''),
  original_model_id    TEXT NOT NULL CHECK (original_model_id = 'deepseek-v4-pro'),
  normalized_at        TIMESTAMPTZ,
  normalized_at_ms     BIGINT,
  grant_before         JSONB,
  grant_flash_existed  BOOLEAN,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subject_kind, subject_key),
  CHECK (
    (subject_kind = 'user_preferences'
      AND normalized_at IS NOT NULL
      AND normalized_at_ms IS NULL
      AND grant_before IS NULL
      AND grant_flash_existed IS NULL)
    OR
    (subject_kind = 'client_sessions'
      AND normalized_at IS NULL
      AND normalized_at_ms IS NOT NULL
      AND grant_before IS NULL
      AND grant_flash_existed IS NULL)
    OR
    (subject_kind = 'model_visibility_grants'
      AND normalized_at IS NULL
      AND normalized_at_ms IS NULL
      AND grant_before IS NOT NULL
      AND grant_flash_existed IS NOT NULL)
  )
);

COMMENT ON TABLE model_dsv4pro_transition_snapshots IS
  'Permanent ops ledger for the 0218 DeepSeek V4 Pro → Flash transition. Stores only rows normalized by the temporary write fences or the grant backfill; conditional compensation compares the exact normalization marker so later user choices win.';

CREATE OR REPLACE FUNCTION fn_0218_normalize_user_default_model()
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
  IF v_requested = 'deepseek-v4-pro' THEN
    v_marker := clock_timestamp();
    INSERT INTO public.model_dsv4pro_transition_snapshots(
      subject_kind, subject_key, original_model_id, normalized_at, normalized_at_ms,
      grant_before, grant_flash_existed
    ) VALUES (
      'user_preferences', NEW.user_id::text, v_requested, v_marker, NULL, NULL, NULL
    )
    ON CONFLICT (subject_kind, subject_key) DO UPDATE
      SET original_model_id = EXCLUDED.original_model_id,
          normalized_at = EXCLUDED.normalized_at,
          normalized_at_ms = NULL,
          grant_before = NULL,
          grant_flash_existed = NULL;

    NEW.prefs := jsonb_set(NEW.prefs, '{default_model}', to_jsonb('deepseek-v4-flash'::text), true);
    NEW.updated_at := v_marker;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION fn_0218_normalize_client_session_model()
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
  IF v_requested = 'deepseek-v4-pro' THEN
    v_marker := floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
    IF TG_OP = 'UPDATE' THEN
      v_marker := GREATEST(v_marker, COALESCE(OLD.updated_at, 0) + 1, COALESCE(NEW.updated_at, 0));
    ELSE
      v_marker := GREATEST(v_marker, COALESCE(NEW.updated_at, 0));
    END IF;

    INSERT INTO public.model_dsv4pro_transition_snapshots(
      subject_kind, subject_key, original_model_id, normalized_at, normalized_at_ms,
      grant_before, grant_flash_existed
    ) VALUES (
      'client_sessions', NEW.id, v_requested, NULL, v_marker, NULL, NULL
    )
    ON CONFLICT (subject_kind, subject_key) DO UPDATE
      SET original_model_id = EXCLUDED.original_model_id,
          normalized_at = NULL,
          normalized_at_ms = EXCLUDED.normalized_at_ms,
          grant_before = NULL,
          grant_flash_existed = NULL;

    NEW.model_id := 'deepseek-v4-flash';
    NEW.updated_at := v_marker;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION fn_0218_normalize_visibility_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_flash_existed BOOLEAN;
BEGIN
  IF NEW.model_id <> 'deepseek-v4-pro' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.model_visibility_grants
     WHERE user_id = NEW.user_id
       AND model_id = 'deepseek-v4-flash'
  ) INTO v_flash_existed;

  INSERT INTO public.model_dsv4pro_transition_snapshots(
    subject_kind, subject_key, original_model_id, normalized_at, normalized_at_ms,
    grant_before, grant_flash_existed
  ) VALUES (
    'model_visibility_grants',
    NEW.user_id::text,
    'deepseek-v4-pro',
    NULL,
    NULL,
    to_jsonb(NEW),
    v_flash_existed
  )
  ON CONFLICT (subject_kind, subject_key) DO UPDATE
    SET original_model_id = EXCLUDED.original_model_id,
        normalized_at = NULL,
        normalized_at_ms = NULL,
        grant_before = EXCLUDED.grant_before,
        grant_flash_existed = EXCLUDED.grant_flash_existed;

  IF v_flash_existed THEN
    RETURN NULL;
  END IF;

  NEW.model_id := 'deepseek-v4-flash';
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION fn_0218_normalize_user_default_model() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_0218_normalize_client_session_model() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_0218_normalize_visibility_grant() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_0218_normalize_user_default_model ON user_preferences;
CREATE TRIGGER trg_0218_normalize_user_default_model
BEFORE INSERT OR UPDATE OF prefs ON user_preferences
FOR EACH ROW EXECUTE FUNCTION fn_0218_normalize_user_default_model();

DROP TRIGGER IF EXISTS trg_0218_normalize_client_session_model ON client_sessions;
CREATE TRIGGER trg_0218_normalize_client_session_model
BEFORE INSERT OR UPDATE OF model_id ON client_sessions
FOR EACH ROW EXECUTE FUNCTION fn_0218_normalize_client_session_model();

DROP TRIGGER IF EXISTS trg_0218_normalize_visibility_grant ON model_visibility_grants;
CREATE TRIGGER trg_0218_normalize_visibility_grant
BEFORE INSERT OR UPDATE OF user_id, model_id ON model_visibility_grants
FOR EACH ROW EXECUTE FUNCTION fn_0218_normalize_visibility_grant();

UPDATE user_preferences
   SET prefs = prefs
 WHERE prefs->>'default_model' = 'deepseek-v4-pro';

UPDATE client_sessions
   SET model_id = model_id
 WHERE deleted_at IS NULL
   AND model_id = 'deepseek-v4-pro';

INSERT INTO model_dsv4pro_transition_snapshots(
  subject_kind, subject_key, original_model_id, normalized_at, normalized_at_ms,
  grant_before, grant_flash_existed
)
SELECT 'model_visibility_grants',
       g.user_id::text,
       'deepseek-v4-pro',
       NULL,
       NULL,
       to_jsonb(g),
       EXISTS (
         SELECT 1 FROM model_visibility_grants t
          WHERE t.user_id = g.user_id
            AND t.model_id = 'deepseek-v4-flash'
       )
  FROM model_visibility_grants g
 WHERE g.model_id = 'deepseek-v4-pro'
ON CONFLICT (subject_kind, subject_key) DO NOTHING;

INSERT INTO model_visibility_grants(user_id, model_id, granted_at, granted_by)
SELECT user_id, 'deepseek-v4-flash', granted_at, granted_by
  FROM model_visibility_grants
 WHERE model_id = 'deepseek-v4-pro'
ON CONFLICT (user_id, model_id) DO NOTHING;

DELETE FROM model_visibility_grants
 WHERE model_id = 'deepseek-v4-pro';

DO $requirements$
DECLARE
  v_affected INTEGER;
BEGIN
  DELETE FROM model_runtime_requirements
   WHERE model_id = 'deepseek-v4-pro'
     AND requirement = 'official_seed_agent';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 1 THEN
    INSERT INTO model_runtime_requirements(model_id, requirement)
    VALUES ('deepseek-v4-flash', 'official_seed_agent')
    ON CONFLICT (model_id, requirement) DO NOTHING;
  ELSIF NOT EXISTS (
    SELECT 1 FROM model_runtime_requirements
     WHERE model_id = 'deepseek-v4-flash'
       AND requirement = 'official_seed_agent'
  ) THEN
    RAISE EXCEPTION '0218 official_seed_agent is missing from both Pro and Flash';
  END IF;
END
$requirements$;

DO $postcondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_preferences
     WHERE prefs->>'default_model' = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0218 left a stale user default model';
  END IF;
  IF EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL
       AND model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0218 left a stale live client-session model';
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0218 left a stale visibility grant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM account_group_models WHERE model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1
      FROM model_aliases a
      JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0218 left a Pro group mapping or alias';
  END IF;
  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'deepseek-v4-flash'
         AND requirement = 'official_seed_agent') <> 1
     OR EXISTS (
       SELECT 1 FROM model_runtime_requirements
        WHERE model_id = 'deepseek-v4-pro'
          AND requirement = 'official_seed_agent'
     )
     OR (SELECT count(*) FROM model_runtime_requirements
          WHERE model_id = 'deepseek-v4-flash'
            AND requirement = 'ccb_secondary_utility') <> 1 THEN
    RAISE EXCEPTION '0218 runtime requirement transition failed';
  END IF;
  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'deepseek-v4-pro'
         AND c.state = 'active'
         AND p.enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0218 must keep deepseek-v4-pro executable until 0219';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN (
         'trg_0218_normalize_user_default_model',
         'trg_0218_normalize_client_session_model',
         'trg_0218_normalize_visibility_grant'
       ) AND NOT tgisinternal AND tgenabled = 'O') <> 3 THEN
    RAISE EXCEPTION '0218 transition write fences are not all enabled';
  END IF;
END
$postcondition$;
