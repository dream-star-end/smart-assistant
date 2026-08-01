-- 0195_deepseek_1m_reactivate.sql
-- Re-activate the DeepSeek V4 Flash / Pro 1M context after the tested 0194
-- production rollback.  A clean database reaches the 0194-forward 1M state,
-- so this migration must also accept that lineage as a no-op.
--
-- Manual rollback (do not delete either migration ledger row): run the tested
-- block below under V5_DEV_PLAYBOOK.md §4.5's advisory lock + transaction +
-- SET LOCAL ROLE openclaude discipline.  It applies only to the exact four-row
-- lineage created when this migration re-activates an 0194-rolled-back database.
-- On a clean install 0195 is a no-op; use the 0194 rollback to undo that lineage.
-- Publish any later retry as a new migration.
--
-- BEGIN TESTED MANUAL ROLLBACK 0195
-- CREATE OR REPLACE FUNCTION fn_model_catalog_context_window(p_model_id TEXT) RETURNS INTEGER AS $$
--   SELECT CASE
--     WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')   THEN NULL
--     WHEN lower(btrim(p_model_id)) = 'minimax-m3'                          THEN 512000
--     WHEN lower(btrim(p_model_id)) = 'glm-5.2'                             THEN 1000000
--     WHEN lower(btrim(p_model_id)) = 'glm-5.1'                             THEN 200000
--     WHEN lower(btrim(p_model_id)) IN ('qwen3.7-max', 'qwen3.7-plus')      THEN 1000000
--     WHEN lower(btrim(p_model_id)) = 'kimi-k2.7-code'                      THEN 256000
--     ELSE 200000
--   END
-- $$ LANGUAGE sql IMMUTABLE;
--
-- DO $rollback$
-- DECLARE
--   v_model_id TEXT;
--   v_current model_catalog%ROWTYPE;
--   v_new_entry BIGINT;
--   v_pricing_before JSONB;
--   v_pricing_after JSONB;
--   v_expected_profile JSONB := '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb;
-- BEGIN
--   PERFORM 1 FROM model_pricing
--    WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
--    ORDER BY model_id FOR UPDATE;
--   SELECT jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id)
--     INTO v_pricing_before FROM model_pricing p
--    WHERE p.model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro');
--   IF (SELECT COUNT(*) FROM model_pricing
--        WHERE (model_id = 'deepseek-v4-flash' AND display_name = 'DeepSeek V4 Flash (1M)'
--               AND enabled IS TRUE AND visibility = 'public')
--           OR (model_id = 'deepseek-v4-pro' AND display_name = 'DeepSeek V4 Pro (1M)'
--               AND enabled IS TRUE AND visibility = 'public')) <> 2 THEN
--     RAISE EXCEPTION '0195 rollback: DeepSeek pricing drifted; refusing rollback';
--   END IF;
--
--   PERFORM 1 FROM model_catalog
--    WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
--    ORDER BY model_id, entry_id FOR UPDATE;
--   FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
--     IF EXISTS (SELECT 1 FROM model_catalog
--                 WHERE model_id = v_model_id
--                   AND (engine <> 'ccb' OR provider_id <> 'deepseek'
--                        OR upstream_model_id IS NOT NULL
--                        OR capability_profile IS DISTINCT FROM v_expected_profile
--                        OR capability_schema_version <> 1)) OR
--        (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) <> 4 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'active' AND context_window = 1000000) <> 1 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'retired' AND context_window = 1000000) <> 1 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'retired' AND context_window = 200000) <> 2 THEN
--       RAISE EXCEPTION '0195 rollback: % is not in the exact reactivated state', v_model_id;
--     END IF;
--   END LOOP;
--
--   FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
--     SELECT * INTO STRICT v_current
--       FROM model_catalog WHERE model_id = v_model_id AND state = 'active'
--       FOR UPDATE;
--     SELECT fn_model_switch_version(
--       v_model_id, v_current.engine, v_current.provider_id,
--       v_current.upstream_model_id, 200000, v_current.capability_profile,
--       v_current.capability_schema_version, NULL, v_current.lock_version
--     ) INTO v_new_entry;
--     IF NOT EXISTS (SELECT 1 FROM model_catalog
--                     WHERE entry_id = v_new_entry AND model_id = v_model_id
--                       AND state = 'active' AND context_window = 200000) THEN
--       RAISE EXCEPTION '0195 rollback: % failed to activate the new 200K entry', v_model_id;
--     END IF;
--   END LOOP;
--
--   FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
--     IF (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) <> 5 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'active' AND context_window = 200000) <> 1 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'retired' AND context_window = 1000000) <> 2 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'retired' AND context_window = 200000) <> 2 THEN
--       RAISE EXCEPTION '0195 rollback: % postcondition failed', v_model_id;
--     END IF;
--   END LOOP;
--
--   IF fn_model_catalog_context_window('deepseek-v4-flash') <> 200000
--      OR fn_model_catalog_context_window('deepseek-v4-pro') <> 200000 THEN
--     RAISE EXCEPTION '0195 rollback: DeepSeek derivation helper was not restored to 200K';
--   END IF;
--   SELECT jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id)
--     INTO v_pricing_after FROM model_pricing p
--    WHERE p.model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro');
--   IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
--     RAISE EXCEPTION '0195 rollback: DeepSeek pricing changed during rollback';
--   END IF;
-- END
-- $rollback$;
-- END TESTED MANUAL ROLLBACK 0195

CREATE OR REPLACE FUNCTION fn_model_catalog_context_window(p_model_id TEXT) RETURNS INTEGER AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')   THEN NULL
    WHEN lower(btrim(p_model_id)) = 'minimax-m3'                          THEN 512000
    WHEN lower(btrim(p_model_id)) IN ('deepseek-v4-flash', 'deepseek-v4-pro') THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'glm-5.2'                             THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'glm-5.1'                             THEN 200000
    WHEN lower(btrim(p_model_id)) IN ('qwen3.7-max', 'qwen3.7-plus')      THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'kimi-k2.7-code'                      THEN 256000
    ELSE 200000
  END
$$ LANGUAGE sql IMMUTABLE;

DO $migration$
DECLARE
  v_model_id TEXT;
  v_current model_catalog%ROWTYPE;
  v_new_entry BIGINT;
  v_scenario TEXT;
  v_model_scenario TEXT;
  v_pricing_before JSONB;
  v_pricing_after JSONB;
  v_expected_profile JSONB := '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb;
BEGIN
  PERFORM 1 FROM model_pricing
   WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
   ORDER BY model_id FOR UPDATE;
  SELECT jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id)
    INTO v_pricing_before FROM model_pricing p
   WHERE p.model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro');
  IF (SELECT COUNT(*) FROM model_pricing
       WHERE (model_id = 'deepseek-v4-flash' AND display_name = 'DeepSeek V4 Flash (1M)'
              AND enabled IS TRUE AND visibility = 'public')
          OR (model_id = 'deepseek-v4-pro' AND display_name = 'DeepSeek V4 Pro (1M)'
              AND enabled IS TRUE AND visibility = 'public')) <> 2 THEN
    RAISE EXCEPTION '0195: DeepSeek pricing precondition failed';
  END IF;

  -- Lock and classify both models before the first state transition.  A mixed
  -- clean/rollback/reactivated pair must fail atomically rather than leave a
  -- half-reactivated catalog.
  PERFORM 1 FROM model_catalog
   WHERE model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro')
   ORDER BY model_id, entry_id FOR UPDATE;
  FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
    IF EXISTS (SELECT 1 FROM model_catalog
               WHERE model_id = v_model_id
                 AND (engine <> 'ccb' OR provider_id <> 'deepseek'
                      OR upstream_model_id IS NOT NULL
                      OR capability_profile IS DISTINCT FROM v_expected_profile
                      OR capability_schema_version <> 1)) THEN
      RAISE EXCEPTION '0195: % execution descriptor history drifted', v_model_id;
    END IF;

    IF (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) = 2 AND
       (SELECT COUNT(*) FROM model_catalog
         WHERE model_id = v_model_id AND state = 'active' AND context_window = 1000000) = 1 AND
       (SELECT COUNT(*) FROM model_catalog
         WHERE model_id = v_model_id AND state = 'retired' AND context_window = 200000) = 1 THEN
      v_model_scenario := '0194-forward';
    ELSIF (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) = 3 AND
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'active' AND context_window = 200000) = 1 AND
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'retired' AND context_window = 1000000) = 1 AND
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'retired' AND context_window = 200000) = 1 THEN
      v_model_scenario := '0194-rollback';
    ELSIF (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) = 4 AND
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'active' AND context_window = 1000000) = 1 AND
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'retired' AND context_window = 1000000) = 1 AND
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'retired' AND context_window = 200000) = 2 THEN
      v_model_scenario := '0195-reactivated';
    ELSE
      RAISE EXCEPTION '0195: % catalog lineage is not a supported exact state', v_model_id;
    END IF;

    IF v_scenario IS NULL THEN
      v_scenario := v_model_scenario;
    ELSIF v_scenario <> v_model_scenario THEN
      RAISE EXCEPTION '0195: DeepSeek models are in mixed lineage states (% vs %)',
        v_scenario, v_model_scenario;
    END IF;
  END LOOP;

  IF v_scenario = '0194-rollback' THEN
    FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
      SELECT * INTO STRICT v_current
        FROM model_catalog WHERE model_id = v_model_id AND state = 'active'
        FOR UPDATE;
      SELECT fn_model_switch_version(
        v_model_id, v_current.engine, v_current.provider_id,
        v_current.upstream_model_id, 1000000, v_current.capability_profile,
        v_current.capability_schema_version, NULL, v_current.lock_version
      ) INTO v_new_entry;
      IF NOT EXISTS (SELECT 1 FROM model_catalog
                      WHERE entry_id = v_new_entry AND model_id = v_model_id
                        AND state = 'active' AND context_window = 1000000) THEN
        RAISE EXCEPTION '0195: % failed to activate the new 1M entry', v_model_id;
      END IF;
    END LOOP;
    v_scenario := '0195-reactivated';
  END IF;

  FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
    IF v_scenario = '0194-forward' THEN
      IF (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) <> 2 OR
         (SELECT COUNT(*) FROM model_catalog
           WHERE model_id = v_model_id AND state = 'active' AND context_window = 1000000) <> 1 OR
         (SELECT COUNT(*) FROM model_catalog
           WHERE model_id = v_model_id AND state = 'retired' AND context_window = 200000) <> 1 THEN
        RAISE EXCEPTION '0195: % clean-install postcondition failed', v_model_id;
      END IF;
    ELSIF (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) <> 4 OR
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'active' AND context_window = 1000000) <> 1 OR
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'retired' AND context_window = 1000000) <> 1 OR
          (SELECT COUNT(*) FROM model_catalog
            WHERE model_id = v_model_id AND state = 'retired' AND context_window = 200000) <> 2 THEN
      RAISE EXCEPTION '0195: % reactivation postcondition failed', v_model_id;
    END IF;
  END LOOP;

  IF fn_model_catalog_context_window('deepseek-v4-flash') <> 1000000
     OR fn_model_catalog_context_window(' DEEPSEEK-V4-PRO ') <> 1000000
     OR fn_model_catalog_context_window('deepseek-v4-preview') <> 200000 THEN
    RAISE EXCEPTION '0195: DeepSeek context derivation helper mismatch';
  END IF;
  SELECT jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id)
    INTO v_pricing_after FROM model_pricing p
   WHERE p.model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro');
  IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
    RAISE EXCEPTION '0195: DeepSeek pricing changed during context reactivation';
  END IF;
END
$migration$;
