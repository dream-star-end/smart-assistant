-- 0296 — commercial: move what the platform itself needs off MiniMax-M3 and gpt-5.6-sol (OCV5-322),
-- so both models can afterwards be disabled through the catalog admin path. This migration disables
-- nothing and changes no catalog or pricing row; the 0144 runtime-requirements guard stays as it is.
--
-- Replacements (each must be active with enabled pricing, otherwise that part is left untouched and
-- the guard keeps protecting the old model):
--   default_codex_engine requirement   gpt-5.6-sol → gpt-6-astra   (already DEFAULT_CODEX_ENGINE_MODEL
--                                                                   and the seed codex agent's model)
--   official_seed_agent on MiniMax-M3  removed, when deepseek-v4-flash holds that requirement
--                                      (office-assistant 1.0.2 runs on deepseek-v4-flash)
--   system_settings.auto_dream_model   MiniMax-M3 → deepseek-v4-flash
--   user_preferences default_model     gpt-5.6-sol → gpt-6.1-sol, MiniMax-M3 → deepseek-v4-flash
--   live client_sessions.model_id      same two pairs (same engine on both sides of each pair)
--
-- Visibility grants and account-group bindings are not touched (same reasoning as 0219). Usage,
-- audit and deleted sessions are not touched. The old release keeps working between this migration
-- and the code release: both old models stay active, and the old code accepts deepseek-v4-flash as
-- auto-dream model.
--
-- User defaults and live sessions are rewritten by fn_0296_normalize_retired_model_refs(). The
-- migration calls it once. The old release keeps serving between this migration and the catalog
-- disable, so a user can still pick one of the two models in that window: the operator calls the
-- function again right after disabling them (a disabled model can no longer be chosen), and checks
-- that no default or live session names either model. A pair whose replacement users cannot pick
-- is reported with skipped_reason and left as it is; do not disable that model then.
--
-- Not handled here: an installed marketplace agent pinned to a version whose manifest names one of
-- the two models. A version is pinned by artifact hash and is not rewritten. Installing does not
-- look at the model catalog, so the operator checks twice: before disabling (no active listing's
-- current approved version and no live install names either model) and again after disabling; if
-- an install appeared in between, the disable of that model is undone through the catalog admin
-- path until the install is dealt with.
--
-- Every rewritten value is recorded in model_0296_transition_snapshots. original_model_id is the
-- first value seen for that subject (what it was before 0296); a later rewrite of the same subject
-- refreshes the replacement and the marker the rollback compares against. For a moved
-- requirement, replacement_model_id is NULL when the successor row already existed, so the rollback
-- does not remove a row this migration did not add.
--
-- BEGIN MANUAL ROLLBACK 0296 (exercised by migration0296RetireMinimaxSol.integ.test.ts)
-- UPDATE user_preferences AS p
--    SET prefs = jsonb_set(p.prefs, '{default_model}', to_jsonb(s.original_model_id), true),
--        updated_at = clock_timestamp()
--   FROM model_0296_transition_snapshots AS s
--  WHERE s.subject_kind = 'user_preferences' AND s.subject_key = p.user_id::text
--    AND p.prefs->>'default_model' = s.replacement_model_id AND p.updated_at = s.normalized_at;
-- UPDATE client_sessions AS c
--    SET model_id = s.original_model_id,
--        updated_at = GREATEST(c.updated_at + 1, floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
--   FROM model_0296_transition_snapshots AS s
--  WHERE s.subject_kind = 'client_sessions' AND s.subject_key = c.id
--    AND c.model_id = s.replacement_model_id AND c.updated_at = s.normalized_at_ms;
-- UPDATE system_settings AS t
--    SET value = to_jsonb(s.original_model_id)
--   FROM model_0296_transition_snapshots AS s
--  WHERE s.subject_kind = 'system_setting' AND s.subject_key = t.key
--    AND t.value #>> '{}' = s.replacement_model_id;
-- DELETE FROM model_runtime_requirements r USING model_0296_transition_snapshots s
--  WHERE s.subject_kind = 'runtime_requirement' AND s.subject_key = r.requirement
--    AND s.replacement_model_id IS NOT NULL AND r.model_id = s.replacement_model_id;
-- INSERT INTO model_runtime_requirements(model_id, requirement)
-- SELECT s.original_model_id, s.subject_key FROM model_0296_transition_snapshots s
--  WHERE s.subject_kind = 'runtime_requirement'
-- ON CONFLICT DO NOTHING;
-- DROP FUNCTION fn_0296_normalize_retired_model_refs();
-- END MANUAL ROLLBACK 0296

LOCK TABLE model_catalog, model_pricing, model_runtime_requirements,
  user_preferences, client_sessions, system_settings
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS model_0296_transition_snapshots (
  subject_kind         TEXT NOT NULL CHECK (subject_kind IN
                         ('user_preferences', 'client_sessions', 'system_setting', 'runtime_requirement')),
  subject_key          TEXT NOT NULL,
  original_model_id    TEXT NOT NULL CHECK (original_model_id IN ('MiniMax-M3', 'gpt-5.6-sol')),
  replacement_model_id TEXT,
  normalized_at        TIMESTAMPTZ,
  normalized_at_ms     BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subject_kind, subject_key)
);

COMMENT ON TABLE model_0296_transition_snapshots IS
  'Ops ledger of 0296 (OCV5-322): values rewritten when the platform moved off MiniMax-M3 and gpt-5.6-sol. For a runtime_requirement row, replacement_model_id is NULL when no successor row was added by 0296.';

CREATE OR REPLACE FUNCTION fn_0296_normalize_retired_model_refs()
RETURNS TABLE(subject_kind TEXT, old_model_id TEXT, new_model_id TEXT, rewritten BIGINT, skipped_reason TEXT)
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_pair   RECORD;
  v_now    TIMESTAMPTZ := clock_timestamp();
  v_now_ms BIGINT := floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  v_n      BIGINT;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES ('gpt-5.6-sol', 'gpt-6.1-sol'), ('MiniMax-M3', 'deepseek-v4-flash')) AS t(old_id, new_id)
  LOOP
    -- a user-facing replacement must be one every user may pick: active, priced, public, no plan gate
    IF NOT EXISTS (
      SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id = v_pair.new_id AND c.state = 'active' AND p.enabled IS TRUE
         AND p.visibility = 'public' AND p.min_plan_code IS NULL) THEN
      RETURN QUERY SELECT 'user_preferences'::text, v_pair.old_id::text, v_pair.new_id::text, 0::bigint, 'replacement_not_selectable'::text;
      RETURN QUERY SELECT 'client_sessions'::text, v_pair.old_id::text, v_pair.new_id::text, 0::bigint, 'replacement_not_selectable'::text;
      CONTINUE;
    END IF;

    INSERT INTO model_0296_transition_snapshots AS s(
      subject_kind, subject_key, original_model_id, replacement_model_id, normalized_at)
    SELECT 'user_preferences', p.user_id::text, v_pair.old_id, v_pair.new_id, v_now
      FROM user_preferences p WHERE p.prefs->>'default_model' = v_pair.old_id
    ON CONFLICT ON CONSTRAINT model_0296_transition_snapshots_pkey DO UPDATE
      SET normalized_at = EXCLUDED.normalized_at,
          replacement_model_id = EXCLUDED.replacement_model_id;
    UPDATE user_preferences p
       SET prefs = jsonb_set(p.prefs, '{default_model}', to_jsonb(v_pair.new_id::text), true),
           updated_at = v_now
     WHERE p.prefs->>'default_model' = v_pair.old_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN QUERY SELECT 'user_preferences'::text, v_pair.old_id::text, v_pair.new_id::text, v_n, NULL::text;

    INSERT INTO model_0296_transition_snapshots AS s(
      subject_kind, subject_key, original_model_id, replacement_model_id, normalized_at_ms)
    SELECT 'client_sessions', c.id, v_pair.old_id, v_pair.new_id, GREATEST(v_now_ms, COALESCE(c.updated_at, 0) + 1)
      FROM client_sessions c WHERE c.deleted_at IS NULL AND c.model_id = v_pair.old_id
    ON CONFLICT ON CONSTRAINT model_0296_transition_snapshots_pkey DO UPDATE
      SET normalized_at_ms = EXCLUDED.normalized_at_ms,
          replacement_model_id = EXCLUDED.replacement_model_id;
    UPDATE client_sessions c
       SET model_id = v_pair.new_id,
           updated_at = GREATEST(v_now_ms, COALESCE(c.updated_at, 0) + 1)
     WHERE c.deleted_at IS NULL AND c.model_id = v_pair.old_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN QUERY SELECT 'client_sessions'::text, v_pair.old_id::text, v_pair.new_id::text, v_n, NULL::text;
  END LOOP;
END
$function$;

REVOKE ALL ON FUNCTION fn_0296_normalize_retired_model_refs() FROM PUBLIC;

DO $transition$
DECLARE
  v_astra_ready BOOLEAN;
  v_flash_ready BOOLEAN;
BEGIN
  -- "ready" is the condition the 0144 guard itself enforces for a required model
  SELECT EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'gpt-6-astra' AND state = 'active')
     AND EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'gpt-6-astra' AND enabled IS TRUE)
    INTO v_astra_ready;
  SELECT EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'deepseek-v4-flash' AND state = 'active')
     AND EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'deepseek-v4-flash' AND enabled IS TRUE)
    INTO v_flash_ready;

  IF v_astra_ready AND EXISTS (SELECT 1 FROM model_runtime_requirements
       WHERE model_id = 'gpt-5.6-sol' AND requirement = 'default_codex_engine') THEN
    INSERT INTO model_0296_transition_snapshots(subject_kind, subject_key, original_model_id, replacement_model_id)
    SELECT 'runtime_requirement', 'default_codex_engine', 'gpt-5.6-sol',
           CASE WHEN EXISTS (SELECT 1 FROM model_runtime_requirements
                              WHERE model_id = 'gpt-6-astra' AND requirement = 'default_codex_engine')
                THEN NULL ELSE 'gpt-6-astra' END
    ON CONFLICT (subject_kind, subject_key) DO NOTHING;
    DELETE FROM model_runtime_requirements
     WHERE model_id = 'gpt-5.6-sol' AND requirement = 'default_codex_engine';
    INSERT INTO model_runtime_requirements(model_id, requirement)
    VALUES ('gpt-6-astra', 'default_codex_engine')
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_flash_ready
     AND EXISTS (SELECT 1 FROM model_runtime_requirements
                  WHERE model_id = 'deepseek-v4-flash' AND requirement = 'official_seed_agent')
     AND EXISTS (SELECT 1 FROM model_runtime_requirements
                  WHERE model_id = 'MiniMax-M3' AND requirement = 'official_seed_agent') THEN
    INSERT INTO model_0296_transition_snapshots(subject_kind, subject_key, original_model_id, replacement_model_id)
    VALUES ('runtime_requirement', 'official_seed_agent', 'MiniMax-M3', NULL)
    ON CONFLICT (subject_kind, subject_key) DO NOTHING;
    DELETE FROM model_runtime_requirements
     WHERE model_id = 'MiniMax-M3' AND requirement = 'official_seed_agent';
  END IF;

  -- value only: the row's description is left alone so the rollback restores the row exactly
  IF v_flash_ready AND EXISTS (SELECT 1 FROM system_settings
       WHERE key = 'auto_dream_model' AND value #>> '{}' = 'MiniMax-M3') THEN
    INSERT INTO model_0296_transition_snapshots(subject_kind, subject_key, original_model_id, replacement_model_id)
    VALUES ('system_setting', 'auto_dream_model', 'MiniMax-M3', 'deepseek-v4-flash')
    ON CONFLICT (subject_kind, subject_key) DO NOTHING;
    UPDATE system_settings
       SET value = '"deepseek-v4-flash"'::jsonb
     WHERE key = 'auto_dream_model';
  END IF;

  PERFORM * FROM fn_0296_normalize_retired_model_refs();
END
$transition$;
