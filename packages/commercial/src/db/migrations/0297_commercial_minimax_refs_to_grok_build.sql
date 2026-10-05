-- 0297 — commercial: what 0296 moved from MiniMax-M3 to deepseek-v4-flash now goes to grok-build
-- (Grok 4.7) wherever the product can run that model (OCV5-326). This migration disables nothing
-- and changes no catalog or pricing row; the 0144 runtime-requirements guard stays as it is.
--
--   official_seed_agent requirement    added for grok-build (office-assistant 1.0.3 runs on it);
--                                      deepseek-v4-flash keeps its own (research-assistant)
--   user_preferences default_model     MiniMax-M3 → grok-build, including the defaults 0296 had
--   live client_sessions.model_id      moved to deepseek-v4-flash, when they are still exactly as
--                                      0296 left them
--   the 0296 write fence               a stale client that sends MiniMax-M3 now gets grok-build
--
-- Left on deepseek-v4-flash on purpose: system_settings.auto_dream_model. Auto-dream runs a model
-- without tools on the ccb or codex engine; grok-build is the grok engine, which has no such mode.
-- (The vision backend stays on k3-256k for the same kind of reason: grok-build takes text only.)
--
-- A moved default or session changes engine (ccb → grok). That is the same state a user produces
-- by picking Grok 4.7 in an existing conversation.
--
-- grok-build must be a model every user may pick (active, priced, public, no plan gate) for the
-- user-facing part, and active and priced for the requirement; otherwise that part is left as it
-- is and fn_0296_normalize_retired_model_refs() keeps reporting replacement_not_selectable.
--
-- A default or session is moved only when the 0296 ledger shows 0296 put deepseek-v4-flash there
-- and the row has not been written since (same marker the 0296 rollback compares). A user who
-- chose deepseek-v4-flash themselves, or changed anything afterwards, keeps what they have.
-- The ledger row of a moved subject is refreshed (replacement and marker), so the 0296 rollback
-- still restores the pre-0296 value. For the requirement, the ledger row 0296 wrote with a NULL
-- replacement now names grok-build, so that rollback also removes the row added here.
--
-- BEGIN MANUAL ROLLBACK 0297 (exercised by migration0297MinimaxRefsToGrokBuild.integ.test.ts; afterwards
-- apply 0296_commercial_retire_minimax_m3_gpt56_sol.sql again: it is idempotent and puts the 0296
-- bodies of the two functions replaced here back)
-- WITH moved AS (
--   UPDATE user_preferences AS p
--      SET prefs = jsonb_set(p.prefs, '{default_model}', '"deepseek-v4-flash"'::jsonb, true),
--          updated_at = clock_timestamp()
--     FROM model_0296_transition_snapshots AS s
--    WHERE s.subject_kind = 'user_preferences' AND s.subject_key = p.user_id::text
--      AND s.replacement_model_id = 'grok-build'
--      AND p.prefs->>'default_model' = 'grok-build' AND p.updated_at = s.normalized_at
--   RETURNING p.user_id, p.updated_at)
-- UPDATE model_0296_transition_snapshots AS s
--    SET replacement_model_id = 'deepseek-v4-flash', normalized_at = m.updated_at
--   FROM moved AS m
--  WHERE s.subject_kind = 'user_preferences' AND s.subject_key = m.user_id::text;
-- WITH moved AS (
--   UPDATE client_sessions AS c
--      SET model_id = 'deepseek-v4-flash',
--          updated_at = GREATEST(c.updated_at + 1, floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
--     FROM model_0296_transition_snapshots AS s
--    WHERE s.subject_kind = 'client_sessions' AND s.subject_key = c.id
--      AND s.replacement_model_id = 'grok-build'
--      AND c.deleted_at IS NULL AND c.model_id = 'grok-build' AND c.updated_at = s.normalized_at_ms
--   RETURNING c.id, c.updated_at)
-- UPDATE model_0296_transition_snapshots AS s
--    SET replacement_model_id = 'deepseek-v4-flash', normalized_at_ms = m.updated_at
--   FROM moved AS m
--  WHERE s.subject_kind = 'client_sessions' AND s.subject_key = m.id;
-- DELETE FROM model_runtime_requirements r USING model_0296_transition_snapshots s
--  WHERE s.subject_kind = 'runtime_requirement' AND s.subject_key = 'official_seed_agent'
--    AND s.replacement_model_id = 'grok-build'
--    AND r.model_id = 'grok-build' AND r.requirement = 'official_seed_agent';
-- UPDATE model_0296_transition_snapshots
--    SET replacement_model_id = NULL
--  WHERE subject_kind = 'runtime_requirement' AND subject_key = 'official_seed_agent'
--    AND replacement_model_id = 'grok-build';
-- END MANUAL ROLLBACK 0297

LOCK TABLE model_catalog, model_pricing, model_runtime_requirements,
  user_preferences, client_sessions
  IN SHARE ROW EXCLUSIVE MODE;

-- Same body as in 0296 except for the MiniMax-M3 replacement.
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
    SELECT * FROM (VALUES ('gpt-5.6-sol', 'gpt-6.1-sol'), ('MiniMax-M3', 'grok-build')) AS t(old_id, new_id)
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

-- Same body as in 0296 except for the MiniMax-M3 replacement. The two fence triggers call it.
CREATE OR REPLACE FUNCTION fn_0296_retired_model_replacement(p_old TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT t.new_id
    FROM (VALUES ('gpt-5.6-sol', 'gpt-6.1-sol'), ('MiniMax-M3', 'grok-build')) AS t(old_id, new_id)
   WHERE t.old_id = p_old
     AND NOT EXISTS (SELECT 1 FROM public.model_catalog c WHERE c.model_id = t.old_id AND c.state = 'active')
     AND EXISTS (
       SELECT 1 FROM public.model_catalog c JOIN public.model_pricing p USING (model_id)
        WHERE c.model_id = t.new_id AND c.state = 'active' AND p.enabled IS TRUE
          AND p.visibility = 'public' AND p.min_plan_code IS NULL)
$function$;

REVOKE ALL ON FUNCTION fn_0296_retired_model_replacement(TEXT) FROM PUBLIC;

DO $transition$
DECLARE
  v_ready      BOOLEAN;
  v_selectable BOOLEAN;
  v_now        TIMESTAMPTZ := clock_timestamp();
  v_now_ms     BIGINT := floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  -- "ready" is the condition the 0144 guard itself enforces for a required model
  SELECT EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'grok-build' AND state = 'active')
     AND EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'grok-build' AND enabled IS TRUE)
    INTO v_ready;
  SELECT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'grok-build' AND c.state = 'active' AND p.enabled IS TRUE
       AND p.visibility = 'public' AND p.min_plan_code IS NULL)
    INTO v_selectable;

  IF v_ready AND NOT EXISTS (SELECT 1 FROM model_runtime_requirements
       WHERE model_id = 'grok-build' AND requirement = 'official_seed_agent') THEN
    INSERT INTO model_runtime_requirements(model_id, requirement)
    VALUES ('grok-build', 'official_seed_agent');
    UPDATE model_0296_transition_snapshots
       SET replacement_model_id = 'grok-build'
     WHERE subject_kind = 'runtime_requirement' AND subject_key = 'official_seed_agent'
       AND original_model_id = 'MiniMax-M3' AND replacement_model_id IS NULL;
  END IF;

  IF v_selectable THEN
    -- a ledger row whose replacement is deepseek-v4-flash can only come from MiniMax-M3
    WITH moved AS (
      UPDATE user_preferences AS p
         SET prefs = jsonb_set(p.prefs, '{default_model}', '"grok-build"'::jsonb, true),
             updated_at = v_now
        FROM model_0296_transition_snapshots AS s
       WHERE s.subject_kind = 'user_preferences' AND s.subject_key = p.user_id::text
         AND s.replacement_model_id = 'deepseek-v4-flash'
         AND p.prefs->>'default_model' = 'deepseek-v4-flash' AND p.updated_at = s.normalized_at
      RETURNING p.user_id)
    UPDATE model_0296_transition_snapshots AS s
       SET replacement_model_id = 'grok-build', normalized_at = v_now
      FROM moved AS m
     WHERE s.subject_kind = 'user_preferences' AND s.subject_key = m.user_id::text;

    WITH moved AS (
      UPDATE client_sessions AS c
         SET model_id = 'grok-build',
             updated_at = GREATEST(v_now_ms, COALESCE(c.updated_at, 0) + 1)
        FROM model_0296_transition_snapshots AS s
       WHERE s.subject_kind = 'client_sessions' AND s.subject_key = c.id
         AND s.replacement_model_id = 'deepseek-v4-flash'
         AND c.deleted_at IS NULL AND c.model_id = 'deepseek-v4-flash' AND c.updated_at = s.normalized_at_ms
      RETURNING c.id, c.updated_at)
    UPDATE model_0296_transition_snapshots AS s
       SET replacement_model_id = 'grok-build', normalized_at_ms = m.updated_at
      FROM moved AS m
     WHERE s.subject_kind = 'client_sessions' AND s.subject_key = m.id;
  END IF;

  -- picks up anything that still names MiniMax-M3 (nothing does where 0296 ran and the model is disabled)
  PERFORM * FROM fn_0296_normalize_retired_model_refs();
END
$transition$;
