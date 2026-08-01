-- 0194_deepseek_1m_context.sql
-- Correct the DeepSeek V4 Flash / Pro context window from the historical 200K
-- fallback to the provider's 1M window.  context_window is an immutable active
-- execution field, so this migration must create a new version through
-- fn_model_switch_version(); never UPDATE the active catalog row in place.
--
-- Manual rollback (do not delete the 0194 schema_migrations ledger row): run the
-- tested block below under V5_DEV_PLAYBOOK.md §4.5's advisory lock + transaction
-- + SET LOCAL ROLE openclaude discipline.  It accepts only the exact post-state
-- produced by this migration, restores the derivation helper first, then creates
-- fresh active 200K versions through the same catalog state machine.  Re-publish
-- after rollback with a new migration; do not re-run 0194.
--
-- BEGIN TESTED MANUAL ROLLBACK 0194
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
--   v_count INTEGER;
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
--     RAISE EXCEPTION '0194 rollback: DeepSeek pricing drifted; refusing rollback';
--   END IF;
--
--   FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
--     SELECT * INTO v_current
--       FROM model_catalog WHERE model_id = v_model_id AND state = 'active'
--       FOR UPDATE;
--     IF NOT FOUND THEN
--       RAISE EXCEPTION '0194 rollback: % has no active row', v_model_id;
--     END IF;
--     IF v_current.engine <> 'ccb'
--        OR v_current.provider_id <> 'deepseek'
--        OR v_current.upstream_model_id IS NOT NULL
--        OR v_current.context_window <> 1000000
--        OR v_current.capability_profile IS DISTINCT FROM v_expected_profile
--        OR v_current.capability_schema_version <> 1 THEN
--       RAISE EXCEPTION '0194 rollback: % active 1M execution descriptor drifted', v_model_id;
--     END IF;
--
--     SELECT COUNT(*) INTO v_count FROM model_catalog WHERE model_id = v_model_id;
--     IF v_count <> 2 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'retired'
--            AND engine = 'ccb' AND provider_id = 'deepseek'
--            AND upstream_model_id IS NULL AND context_window = 200000
--            AND capability_profile = v_expected_profile
--            AND capability_schema_version = 1) <> 1 OR
--        EXISTS (SELECT 1 FROM model_catalog
--                 WHERE model_id = v_model_id AND state IN ('staged', 'disabled')) THEN
--       RAISE EXCEPTION '0194 rollback: % is not in the exact 0194 post-state', v_model_id;
--     END IF;
--
--     SELECT fn_model_switch_version(
--       v_model_id, v_current.engine, v_current.provider_id,
--       v_current.upstream_model_id, 200000, v_current.capability_profile,
--       v_current.capability_schema_version, NULL, v_current.lock_version
--     ) INTO v_new_entry;
--
--     IF NOT EXISTS (SELECT 1 FROM model_catalog
--                     WHERE entry_id = v_new_entry AND model_id = v_model_id
--                       AND state = 'active' AND context_window = 200000) THEN
--       RAISE EXCEPTION '0194 rollback: % failed to activate the new 200K entry', v_model_id;
--     END IF;
--   END LOOP;
--
--   FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
--     IF (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) <> 3 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'active'
--            AND engine = 'ccb' AND provider_id = 'deepseek'
--            AND upstream_model_id IS NULL AND context_window = 200000
--            AND capability_profile = v_expected_profile
--            AND capability_schema_version = 1) <> 1 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'retired'
--            AND context_window = 1000000) <> 1 OR
--        (SELECT COUNT(*) FROM model_catalog
--          WHERE model_id = v_model_id AND state = 'retired'
--            AND context_window = 200000) <> 1 OR
--        EXISTS (SELECT 1 FROM model_catalog
--                 WHERE model_id = v_model_id AND state IN ('staged', 'disabled')) THEN
--       RAISE EXCEPTION '0194 rollback: % postcondition failed', v_model_id;
--     END IF;
--   END LOOP;
--
--   IF fn_model_catalog_context_window('deepseek-v4-flash') <> 200000
--      OR fn_model_catalog_context_window('deepseek-v4-pro') <> 200000 THEN
--     RAISE EXCEPTION '0194 rollback: DeepSeek derivation helper was not restored to 200K';
--   END IF;
--
--   SELECT jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id)
--     INTO v_pricing_after FROM model_pricing p
--    WHERE p.model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro');
--   IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
--     RAISE EXCEPTION '0194 rollback: DeepSeek pricing changed during rollback';
--   END IF;
-- END
-- $rollback$;
-- END TESTED MANUAL ROLLBACK 0194

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
  v_count INTEGER;
  v_new_entry BIGINT;
  v_pricing_before JSONB;
  v_pricing_after JSONB;
  v_expected_profile JSONB := '{"supports_vision": false, "reasoning": {"supported": ["low","medium","high","xhigh","max"], "codex_model_default": null}, "ccb": {"capability_zero": false, "supports_thinking": true}}'::jsonb;
BEGIN
  -- Pricing is not part of this change.  Pin the exact pre/post values so a
  -- context-only migration cannot silently absorb a concurrent pricing edit.
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
    RAISE EXCEPTION '0194: DeepSeek pricing precondition failed';
  END IF;

  FOREACH v_model_id IN ARRAY ARRAY['deepseek-v4-flash', 'deepseek-v4-pro'] LOOP
    SELECT * INTO v_current
      FROM model_catalog WHERE model_id = v_model_id AND state = 'active'
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0194: % has no active row', v_model_id;
    END IF;
    IF v_current.engine <> 'ccb'
       OR v_current.provider_id <> 'deepseek'
       OR v_current.upstream_model_id IS NOT NULL
       OR v_current.capability_profile IS DISTINCT FROM v_expected_profile
       OR v_current.capability_schema_version <> 1 THEN
      RAISE EXCEPTION '0194: % execution descriptor precondition failed', v_model_id;
    END IF;

    IF v_current.context_window = 200000 THEN
      SELECT COUNT(*) INTO v_count FROM model_catalog WHERE model_id = v_model_id;
      IF v_count <> 1 THEN
        RAISE EXCEPTION '0194: % expected one pristine 200K row, got % total rows', v_model_id, v_count;
      END IF;

      SELECT fn_model_switch_version(
        v_model_id, v_current.engine, v_current.provider_id,
        v_current.upstream_model_id, 1000000, v_current.capability_profile,
        v_current.capability_schema_version, NULL, v_current.lock_version
      ) INTO v_new_entry;

      IF NOT EXISTS (SELECT 1 FROM model_catalog
                     WHERE entry_id = v_new_entry AND model_id = v_model_id
                       AND state = 'active' AND context_window = 1000000) THEN
        RAISE EXCEPTION '0194: % failed to activate the new 1M entry', v_model_id;
      END IF;
    ELSIF v_current.context_window <> 1000000 THEN
      RAISE EXCEPTION '0194: % has unexpected active context_window %',
        v_model_id, v_current.context_window;
    END IF;

    -- This also makes direct SQL re-execution idempotent while refusing any
    -- history other than the exact one produced above.
    IF (SELECT COUNT(*) FROM model_catalog WHERE model_id = v_model_id) <> 2 OR
       (SELECT COUNT(*) FROM model_catalog
         WHERE model_id = v_model_id AND state = 'active'
           AND engine = 'ccb' AND provider_id = 'deepseek'
           AND upstream_model_id IS NULL AND context_window = 1000000
           AND capability_profile = v_expected_profile
           AND capability_schema_version = 1) <> 1 OR
       (SELECT COUNT(*) FROM model_catalog
         WHERE model_id = v_model_id AND state = 'retired'
           AND engine = 'ccb' AND provider_id = 'deepseek'
           AND upstream_model_id IS NULL AND context_window = 200000
           AND capability_profile = v_expected_profile
           AND capability_schema_version = 1) <> 1 OR
       EXISTS (SELECT 1 FROM model_catalog
               WHERE model_id = v_model_id AND state IN ('staged', 'disabled')) THEN
      RAISE EXCEPTION '0194: % postcondition failed', v_model_id;
    END IF;
  END LOOP;

  IF fn_model_catalog_context_window('deepseek-v4-flash') <> 1000000
     OR fn_model_catalog_context_window(' DEEPSEEK-V4-PRO ') <> 1000000
     OR fn_model_catalog_context_window('deepseek-v4-preview') <> 200000 THEN
    RAISE EXCEPTION '0194: DeepSeek context derivation helper mismatch';
  END IF;

  SELECT jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id)
    INTO v_pricing_after FROM model_pricing p
   WHERE p.model_id IN ('deepseek-v4-flash', 'deepseek-v4-pro');
  IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
    RAISE EXCEPTION '0194: DeepSeek pricing changed during context migration';
  END IF;
END
$migration$;
