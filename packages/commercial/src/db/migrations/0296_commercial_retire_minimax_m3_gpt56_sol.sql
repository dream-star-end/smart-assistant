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
-- Every rewritten value is recorded in model_0296_transition_snapshots (first write wins).
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
--    SET value = to_jsonb(s.original_model_id), updated_at = NOW()
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
  'Ops ledger of 0296 (OCV5-322): values rewritten when the platform moved off MiniMax-M3 and gpt-5.6-sol. replacement_model_id is NULL for a requirement that was removed without a successor.';

DO $transition$
DECLARE
  v_pair   RECORD;
  v_now    TIMESTAMPTZ := clock_timestamp();
  v_now_ms BIGINT := floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
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
    VALUES ('runtime_requirement', 'default_codex_engine', 'gpt-5.6-sol', 'gpt-6-astra')
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

  IF v_flash_ready AND EXISTS (SELECT 1 FROM system_settings
       WHERE key = 'auto_dream_model' AND value #>> '{}' = 'MiniMax-M3') THEN
    INSERT INTO model_0296_transition_snapshots(subject_kind, subject_key, original_model_id, replacement_model_id)
    VALUES ('system_setting', 'auto_dream_model', 'MiniMax-M3', 'deepseek-v4-flash')
    ON CONFLICT (subject_kind, subject_key) DO NOTHING;
    UPDATE system_settings
       SET value = '"deepseek-v4-flash"'::jsonb,
           description = 'Auto-Dream 整理与全面优化模型（DeepSeek V4 Flash；0296 自 MiniMax M3 迁出）',
           updated_at = NOW()
     WHERE key = 'auto_dream_model';
  END IF;

  FOR v_pair IN
    SELECT * FROM (VALUES ('gpt-5.6-sol', 'gpt-6.1-sol'), ('MiniMax-M3', 'deepseek-v4-flash')) AS t(old_id, new_id)
  LOOP
    -- a user-facing replacement must be one every user may pick: active, priced, public, no plan gate
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id = v_pair.new_id AND c.state = 'active' AND p.enabled IS TRUE
         AND p.visibility = 'public' AND p.min_plan_code IS NULL);

    INSERT INTO model_0296_transition_snapshots(
      subject_kind, subject_key, original_model_id, replacement_model_id, normalized_at)
    SELECT 'user_preferences', user_id::text, v_pair.old_id, v_pair.new_id, v_now
      FROM user_preferences WHERE prefs->>'default_model' = v_pair.old_id
    ON CONFLICT (subject_kind, subject_key) DO NOTHING;
    UPDATE user_preferences
       SET prefs = jsonb_set(prefs, '{default_model}', to_jsonb(v_pair.new_id::text), true),
           updated_at = v_now
     WHERE prefs->>'default_model' = v_pair.old_id;

    INSERT INTO model_0296_transition_snapshots(
      subject_kind, subject_key, original_model_id, replacement_model_id, normalized_at_ms)
    SELECT 'client_sessions', id, v_pair.old_id, v_pair.new_id, GREATEST(v_now_ms, COALESCE(updated_at, 0) + 1)
      FROM client_sessions WHERE deleted_at IS NULL AND model_id = v_pair.old_id
    ON CONFLICT (subject_kind, subject_key) DO NOTHING;
    UPDATE client_sessions
       SET model_id = v_pair.new_id,
           updated_at = GREATEST(v_now_ms, COALESCE(updated_at, 0) + 1)
     WHERE deleted_at IS NULL AND model_id = v_pair.old_id;
  END LOOP;
END
$transition$;
