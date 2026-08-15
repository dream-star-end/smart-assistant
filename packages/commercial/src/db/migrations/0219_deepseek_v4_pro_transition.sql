-- 0219 — move persisted DeepSeek V4 Pro selections to DeepSeek V4 Flash.
--
-- This migration is applied before the code release that stops hardcoding
-- deepseek-v4-pro. The old stable release can still execute Pro during that
-- window. Temporary BEFORE triggers fence user_preferences.default_model and
-- live client_sessions.model_id so stale Pro writes cannot reappear.
--
-- Visibility grants are intentionally NOT remapped or fenced here. The old
-- admin addGrant/removeGrant contract keys on the caller-supplied model_id;
-- rewriting Pro→Flash (or swallowing the INSERT) makes revoke return
-- deleted=false while a Flash grant remains. Grants stay on Pro until a
-- later release applies 0219 after this code is already deployed.
--
-- official_seed_agent moves to Flash when it is still on Pro. The source is
-- snapshotted so compensation restores that exact source (Pro or already-Flash).
-- Flash already carries ccb_secondary_utility; 0144's primary key is
-- (model_id, requirement), so both requirements coexist.
--
-- deploy-v5 requiredMigrations is an exact listing of this tree's migration
-- files, so 0219 cannot be registered in the same release as this code.
-- Historical usage/audit rows and deleted sessions are intentionally untouched.

-- BEGIN TESTED MANUAL ROLLBACK 0219
-- DO $rollback_preflight$
-- BEGIN
--   IF NOT EXISTS (
--     SELECT 1 FROM pg_trigger
--      WHERE tgrelid = 'user_preferences'::regclass
--        AND tgname = 'trg_0219_normalize_user_default_model'
--        AND NOT tgisinternal
--   ) OR NOT EXISTS (
--     SELECT 1 FROM pg_trigger
--      WHERE tgrelid = 'client_sessions'::regclass
--        AND tgname = 'trg_0219_normalize_client_session_model'
--        AND NOT tgisinternal
--   ) THEN
--     RAISE EXCEPTION '0219 rollback requires both transition write fences';
--   END IF;
-- END
-- $rollback_preflight$;
--
-- DROP TRIGGER trg_0219_normalize_user_default_model ON user_preferences;
-- DROP TRIGGER trg_0219_normalize_client_session_model ON client_sessions;
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
-- DELETE FROM model_runtime_requirements
--  WHERE requirement = 'official_seed_agent'
--    AND model_id IN ('deepseek-v4-pro', 'deepseek-v4-flash');
-- INSERT INTO model_runtime_requirements(model_id, requirement)
-- SELECT s.original_model_id, 'official_seed_agent'
--   FROM model_dsv4pro_transition_snapshots AS s
--  WHERE s.subject_kind = 'runtime_requirement'
--    AND s.subject_key = 'official_seed_agent';
--
-- DROP FUNCTION fn_0219_normalize_user_default_model();
-- DROP FUNCTION fn_0219_normalize_client_session_model();
-- END TESTED MANUAL ROLLBACK 0219

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
    RAISE EXCEPTION '0219 requires exactly one active deepseek-v4-flash catalog row';
  END IF;
  IF (SELECT count(*) FROM model_pricing
       WHERE model_id = 'deepseek-v4-flash' AND enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0219 requires enabled deepseek-v4-flash pricing';
  END IF;
  IF (SELECT count(*) FROM model_catalog
       WHERE model_id = 'deepseek-v4-pro' AND state = 'active') <> 1 THEN
    RAISE EXCEPTION '0219 requires exactly one active deepseek-v4-pro catalog row';
  END IF;
  IF (SELECT count(*) FROM model_pricing
       WHERE model_id = 'deepseek-v4-pro' AND enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0219 requires enabled deepseek-v4-pro pricing';
  END IF;

  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'deepseek-v4-flash'
         AND requirement = 'ccb_secondary_utility') <> 1 THEN
    RAISE EXCEPTION '0219 requires deepseek-v4-flash to keep ccb_secondary_utility';
  END IF;
  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE requirement = 'official_seed_agent'
         AND model_id IN ('deepseek-v4-pro', 'deepseek-v4-flash')) <> 1 THEN
    RAISE EXCEPTION '0219 requires official_seed_agent on Pro or already on Flash';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_group_models WHERE model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1
      FROM model_aliases a
      JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0219 requires zero Pro group mappings/aliases';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS model_dsv4pro_transition_snapshots (
  subject_kind         TEXT NOT NULL
                       CHECK (subject_kind IN (
                         'user_preferences',
                         'client_sessions',
                         'runtime_requirement'
                       )),
  subject_key          TEXT NOT NULL CHECK (subject_key <> ''),
  original_model_id    TEXT NOT NULL
                       CHECK (original_model_id IN ('deepseek-v4-pro', 'deepseek-v4-flash')),
  normalized_at        TIMESTAMPTZ,
  normalized_at_ms     BIGINT,
  grant_before         JSONB,
  grant_flash_existed  BOOLEAN,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subject_kind, subject_key),
  CHECK (
    (subject_kind = 'user_preferences'
      AND original_model_id = 'deepseek-v4-pro'
      AND normalized_at IS NOT NULL
      AND normalized_at_ms IS NULL
      AND grant_before IS NULL
      AND grant_flash_existed IS NULL)
    OR
    (subject_kind = 'client_sessions'
      AND original_model_id = 'deepseek-v4-pro'
      AND normalized_at IS NULL
      AND normalized_at_ms IS NOT NULL
      AND grant_before IS NULL
      AND grant_flash_existed IS NULL)
    OR
    (subject_kind = 'runtime_requirement'
      AND subject_key = 'official_seed_agent'
      AND normalized_at IS NULL
      AND normalized_at_ms IS NULL
      AND grant_before IS NULL
      AND grant_flash_existed IS NULL)
  )
);

COMMENT ON TABLE model_dsv4pro_transition_snapshots IS
  'Permanent ops ledger for the 0219 DeepSeek V4 Pro → Flash transition. Stores fence before-images and the official_seed_agent source. original_model_id is first-write-wins; fence repeats may refresh only the compensation marker.';

CREATE OR REPLACE FUNCTION fn_0219_normalize_user_default_model()
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
      SET normalized_at = EXCLUDED.normalized_at
      WHERE model_dsv4pro_transition_snapshots.original_model_id = EXCLUDED.original_model_id;

    NEW.prefs := jsonb_set(NEW.prefs, '{default_model}', to_jsonb('deepseek-v4-flash'::text), true);
    NEW.updated_at := v_marker;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION fn_0219_normalize_client_session_model()
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
      SET normalized_at_ms = EXCLUDED.normalized_at_ms
      WHERE model_dsv4pro_transition_snapshots.original_model_id = EXCLUDED.original_model_id;

    NEW.model_id := 'deepseek-v4-flash';
    NEW.updated_at := v_marker;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION fn_0219_normalize_user_default_model() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_0219_normalize_client_session_model() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_0219_normalize_user_default_model ON user_preferences;
CREATE TRIGGER trg_0219_normalize_user_default_model
BEFORE INSERT OR UPDATE OF prefs ON user_preferences
FOR EACH ROW EXECUTE FUNCTION fn_0219_normalize_user_default_model();

DROP TRIGGER IF EXISTS trg_0219_normalize_client_session_model ON client_sessions;
CREATE TRIGGER trg_0219_normalize_client_session_model
BEFORE INSERT OR UPDATE OF model_id ON client_sessions
FOR EACH ROW EXECUTE FUNCTION fn_0219_normalize_client_session_model();


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
SELECT 'runtime_requirement',
       'official_seed_agent',
       r.model_id,
       NULL,
       NULL,
       NULL,
       NULL
  FROM model_runtime_requirements r
 WHERE r.requirement = 'official_seed_agent'
   AND r.model_id IN ('deepseek-v4-pro', 'deepseek-v4-flash')
ON CONFLICT (subject_kind, subject_key) DO NOTHING;

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
    RAISE EXCEPTION '0219 official_seed_agent is missing from both Pro and Flash';
  END IF;
END
$requirements$;

DO $postcondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_preferences
     WHERE prefs->>'default_model' = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0219 left a stale user default model';
  END IF;
  IF EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL
       AND model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0219 left a stale live client-session model';
  END IF;
  IF EXISTS (
    SELECT 1 FROM account_group_models WHERE model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1
      FROM model_aliases a
      JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0219 left a Pro group mapping or alias';
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
    RAISE EXCEPTION '0219 runtime requirement transition failed';
  END IF;
  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'deepseek-v4-pro'
         AND c.state = 'active'
         AND p.enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0219 must keep deepseek-v4-pro executable until a later disable release';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN (
         'trg_0219_normalize_user_default_model',
         'trg_0219_normalize_client_session_model'
       ) AND NOT tgisinternal AND tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION '0219 transition write fences are not all enabled';
  END IF;
END
$postcondition$;
