-- 0212_public_glm53_opencode_flash.sql
-- Release B: activate the 0211 rollback floor and expose GLM-5.3 (Ark Coding Plan)
-- plus DeepSeek V4 Flash (OpenCode Go) to every user. Defaults and legacy model
-- retirement remain a separate Release C.
--
-- Manual rollback: keep the 0212 schema_migrations ledger row. Under the same
-- production mutation lease + migration advisory lock + transaction + SET LOCAL
-- ROLE openclaude discipline used by V5_DEV_PLAYBOOK.md §4.5, execute the tested
-- block below. Re-publishing after compensation requires a new migration.
--
-- BEGIN TESTED MANUAL ROLLBACK 0212
-- DO $rollback$
-- DECLARE
--   v_target RECORD;
--   v_affected INTEGER;
--   v_pricing_before JSONB;
--   v_pricing_after JSONB;
--   v_catalog_before JSONB;
--   v_catalog_after JSONB;
-- BEGIN
--   PERFORM 1
--     FROM model_catalog
--    WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
--    ORDER BY model_id, entry_id
--      FOR UPDATE;
--   PERFORM 1
--     FROM model_pricing
--    WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
--    ORDER BY model_id
--      FOR UPDATE;
--
--   IF (SELECT count(*) FROM model_catalog
--        WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')) <> 2
--      OR (SELECT count(*)
--            FROM model_catalog
--           WHERE (
--             model_id = 'glm-5.3'
--             AND engine = 'ccb'
--             AND provider_id = 'ark'
--             AND upstream_model_id = 'glm-5.3'
--             AND context_window = 1000000
--             AND capability_schema_version = 1
--             AND capability_profile = '{
--               "supports_vision": false,
--               "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
--               "ccb": { "capability_zero": true, "supports_thinking": true }
--             }'::jsonb
--             AND ((lock_version = 3 AND updated_by IS NULL)
--                  OR (lock_version = 5 AND updated_by = 1))
--             AND state = 'active'
--           ) OR (
--             model_id = 'deepseek-v4-flash-opencode-go'
--             AND engine = 'ccb'
--             AND provider_id = 'opencodego'
--             AND upstream_model_id = 'deepseek-v4-flash'
--             AND context_window = 1000000
--             AND capability_schema_version = 1
--             AND capability_profile = '{
--               "supports_vision": false,
--               "reasoning": { "supported": [], "codex_model_default": null },
--               "ccb": { "capability_zero": true, "supports_thinking": true }
--             }'::jsonb
--             AND ((lock_version = 3 AND updated_by IS NULL)
--                  OR (lock_version = 5 AND updated_by = 1))
--             AND state = 'active'
--           )) <> 2 THEN
--     RAISE EXCEPTION '0212 rollback requires the exact active catalog post-state';
--   END IF;
--   IF NOT (
--     (SELECT count(*) FROM model_catalog
--       WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
--         AND lock_version = 3 AND updated_by IS NULL) = 2
--     OR
--     (SELECT count(*) FROM model_catalog
--       WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
--         AND lock_version = 5 AND updated_by = 1) = 2
--   ) THEN
--     RAISE EXCEPTION '0212 rollback requires one exact catalog lineage';
--   END IF;
--
--   IF (SELECT count(*) FROM model_pricing
--        WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')) <> 2
--      OR NOT EXISTS (
--        SELECT 1
--          FROM model_pricing target
--          JOIN model_pricing source ON source.model_id = 'glm-5.2'
--         WHERE target.model_id = 'glm-5.3'
--           AND target.display_name = 'GLM-5.3'
--           AND target.input_per_mtok = source.input_per_mtok
--           AND target.output_per_mtok = source.output_per_mtok
--           AND target.cache_read_per_mtok = source.cache_read_per_mtok
--           AND target.cache_write_per_mtok = source.cache_write_per_mtok
--           AND target.multiplier = source.multiplier
--           AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
--           AND target.default_effort IS NOT DISTINCT FROM source.default_effort
--           AND target.enabled IS TRUE
--           AND target.sort_order = 83
--           AND target.visibility = 'public'
--           AND target.lock_version = 1
--           AND target.updated_by IS NULL
--      )
--      OR NOT EXISTS (
--        SELECT 1
--          FROM model_pricing target
--          JOIN model_pricing source ON source.model_id = 'deepseek-v4-flash'
--         WHERE target.model_id = 'deepseek-v4-flash-opencode-go'
--           AND target.display_name = 'DeepSeek V4 Flash (OpenCode Go)'
--           AND target.input_per_mtok = source.input_per_mtok
--           AND target.output_per_mtok = source.output_per_mtok
--           AND target.cache_read_per_mtok = source.cache_read_per_mtok
--           AND target.cache_write_per_mtok = source.cache_write_per_mtok
--           AND target.multiplier = source.multiplier
--           AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
--           AND target.default_effort IS NOT DISTINCT FROM source.default_effort
--           AND target.enabled IS TRUE
--           AND target.sort_order = 121
--           AND target.visibility = 'public'
--           AND target.lock_version = 1
--           AND target.updated_by IS NULL
--      ) THEN
--     RAISE EXCEPTION '0212 rollback requires the exact public pricing post-state';
--   END IF;
--
--   IF EXISTS (
--     SELECT 1 FROM model_visibility_grants
--      WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
--   ) THEN
--     RAISE EXCEPTION '0212 rollback refuses target grants';
--   END IF;
--
--   SELECT jsonb_agg(
--            to_jsonb(p) - ARRAY['enabled', 'visibility', 'lock_version', 'updated_at']
--            ORDER BY p.model_id
--          )
--     INTO v_pricing_before
--     FROM model_pricing p
--    WHERE p.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go');
--   SELECT jsonb_agg(
--            to_jsonb(c) - ARRAY['state', 'lock_version', 'updated_at']
--            ORDER BY c.model_id, c.entry_id
--          )
--     INTO v_catalog_before
--     FROM model_catalog c
--    WHERE c.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go');
--
--   FOR v_target IN
--     SELECT entry_id, lock_version
--       FROM model_catalog
--      WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
--        AND state = 'active'
--      ORDER BY model_id
--   LOOP
--     PERFORM fn_model_disable_entry(v_target.entry_id, v_target.lock_version, NULL);
--   END LOOP;
--
--   UPDATE model_pricing
--      SET visibility = 'hidden',
--          lock_version = lock_version + 1,
--          updated_at = now()
--    WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
--      AND visibility = 'public';
--   GET DIAGNOSTICS v_affected = ROW_COUNT;
--   IF v_affected <> 2 THEN
--     RAISE EXCEPTION '0212 rollback expected two public pricing rows, got %', v_affected;
--   END IF;
--
--   SELECT jsonb_agg(
--            to_jsonb(p) - ARRAY['enabled', 'visibility', 'lock_version', 'updated_at']
--            ORDER BY p.model_id
--          )
--     INTO v_pricing_after
--     FROM model_pricing p
--    WHERE p.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go');
--   SELECT jsonb_agg(
--            to_jsonb(c) - ARRAY['state', 'lock_version', 'updated_at']
--            ORDER BY c.model_id, c.entry_id
--          )
--     INTO v_catalog_after
--     FROM model_catalog c
--    WHERE c.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go');
--
--   IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
--     RAISE EXCEPTION '0212 rollback changed frozen pricing columns';
--   END IF;
--   IF v_catalog_after IS DISTINCT FROM v_catalog_before THEN
--     RAISE EXCEPTION '0212 rollback changed catalog identity or descriptors';
--   END IF;
--   IF (SELECT count(*)
--         FROM model_catalog c
--         JOIN model_pricing p USING (model_id)
--        WHERE c.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
--          AND c.state = 'disabled'
--          AND p.enabled IS FALSE
--          AND p.visibility = 'hidden') <> 2 THEN
--     RAISE EXCEPTION '0212 rollback postcondition failed';
--   END IF;
-- END
-- $rollback$;
-- END TESTED MANUAL ROLLBACK 0212

DO $migration$
DECLARE
  v_target RECORD;
  v_affected INTEGER;
  v_pricing_before JSONB;
  v_pricing_after JSONB;
  v_catalog_before JSONB;
  v_catalog_after JSONB;
BEGIN
  -- Lock both authority surfaces before classifying either row. A mixed or
  -- partially changed pair must fail atomically before the first transition.
  PERFORM 1
    FROM model_catalog
   WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
   ORDER BY model_id, entry_id
     FOR UPDATE;
  PERFORM 1
    FROM model_pricing
   WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
   ORDER BY model_id
     FOR UPDATE;

  IF (SELECT count(*) FROM model_catalog
       WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')) <> 2
     OR (SELECT count(*)
           FROM model_catalog
          WHERE (
            model_id = 'glm-5.3'
            AND engine = 'ccb'
            AND provider_id = 'ark'
            AND upstream_model_id = 'glm-5.3'
            AND context_window = 1000000
            AND capability_schema_version = 1
            AND capability_profile = '{
              "supports_vision": false,
              "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
              "ccb": { "capability_zero": true, "supports_thinking": true }
            }'::jsonb
            AND ((lock_version = 2 AND updated_by IS NULL)
                 OR (lock_version = 4 AND updated_by = 1))
            AND state = 'disabled'
          ) OR (
            model_id = 'deepseek-v4-flash-opencode-go'
            AND engine = 'ccb'
            AND provider_id = 'opencodego'
            AND upstream_model_id = 'deepseek-v4-flash'
            AND context_window = 1000000
            AND capability_schema_version = 1
            AND capability_profile = '{
              "supports_vision": false,
              "reasoning": { "supported": [], "codex_model_default": null },
              "ccb": { "capability_zero": true, "supports_thinking": true }
            }'::jsonb
            AND ((lock_version = 2 AND updated_by IS NULL)
                 OR (lock_version = 4 AND updated_by = 1))
            AND state = 'disabled'
          )) <> 2 THEN
    RAISE EXCEPTION '0212 requires the exact disabled 0211 catalog floor';
  END IF;
  IF NOT (
    (SELECT count(*) FROM model_catalog
      WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
        AND lock_version = 2 AND updated_by IS NULL) = 2
    OR
    (SELECT count(*) FROM model_catalog
      WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
        AND lock_version = 4 AND updated_by = 1) = 2
  ) THEN
    RAISE EXCEPTION '0212 requires one exact 0211 catalog lineage';
  END IF;

  IF (SELECT count(*) FROM model_pricing
       WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')) <> 2
     OR NOT EXISTS (
       SELECT 1
         FROM model_pricing target
         JOIN model_pricing source ON source.model_id = 'glm-5.2'
        WHERE target.model_id = 'glm-5.3'
          AND target.display_name = 'GLM-5.3'
          AND target.input_per_mtok = source.input_per_mtok
          AND target.output_per_mtok = source.output_per_mtok
          AND target.cache_read_per_mtok = source.cache_read_per_mtok
          AND target.cache_write_per_mtok = source.cache_write_per_mtok
          AND target.multiplier = source.multiplier
          AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
          AND target.default_effort IS NOT DISTINCT FROM source.default_effort
          AND target.enabled IS FALSE
          AND target.sort_order = 83
          AND target.visibility = 'hidden'
          AND target.lock_version = 0
          AND target.updated_by IS NULL
     )
     OR NOT EXISTS (
       SELECT 1
         FROM model_pricing target
         JOIN model_pricing source ON source.model_id = 'deepseek-v4-flash'
        WHERE target.model_id = 'deepseek-v4-flash-opencode-go'
          AND target.display_name = 'DeepSeek V4 Flash (OpenCode Go)'
          AND target.input_per_mtok = source.input_per_mtok
          AND target.output_per_mtok = source.output_per_mtok
          AND target.cache_read_per_mtok = source.cache_read_per_mtok
          AND target.cache_write_per_mtok = source.cache_write_per_mtok
          AND target.multiplier = source.multiplier
          AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
          AND target.default_effort IS NOT DISTINCT FROM source.default_effort
          AND target.enabled IS FALSE
          AND target.sort_order = 121
          AND target.visibility = 'hidden'
          AND target.lock_version = 0
          AND target.updated_by IS NULL
     ) THEN
    RAISE EXCEPTION '0212 requires the exact hidden pricing floor';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
  ) THEN
    RAISE EXCEPTION '0212 refuses target grants before public activation';
  END IF;

  SELECT jsonb_agg(
           to_jsonb(p) - ARRAY['enabled', 'visibility', 'lock_version', 'updated_at']
           ORDER BY p.model_id
         )
    INTO v_pricing_before
    FROM model_pricing p
   WHERE p.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go');
  SELECT jsonb_agg(
           to_jsonb(c) - ARRAY['state', 'lock_version', 'updated_at']
           ORDER BY c.model_id, c.entry_id
         )
    INTO v_catalog_before
    FROM model_catalog c
   WHERE c.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go');

  FOR v_target IN
    SELECT entry_id, lock_version
      FROM model_catalog
     WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
       AND state = 'disabled'
     ORDER BY model_id
  LOOP
    PERFORM fn_model_activate_entry(v_target.entry_id, v_target.lock_version, NULL);
  END LOOP;

  -- enabled is a catalog-derived mirror. Change only visibility explicitly.
  UPDATE model_pricing
     SET visibility = 'public',
         lock_version = lock_version + 1,
         updated_at = now()
   WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
     AND visibility = 'hidden';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 2 THEN
    RAISE EXCEPTION '0212 expected two hidden pricing rows, got %', v_affected;
  END IF;

  SELECT jsonb_agg(
           to_jsonb(p) - ARRAY['enabled', 'visibility', 'lock_version', 'updated_at']
           ORDER BY p.model_id
         )
    INTO v_pricing_after
    FROM model_pricing p
   WHERE p.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go');
  SELECT jsonb_agg(
           to_jsonb(c) - ARRAY['state', 'lock_version', 'updated_at']
           ORDER BY c.model_id, c.entry_id
         )
    INTO v_catalog_after
    FROM model_catalog c
   WHERE c.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go');

  IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
    RAISE EXCEPTION '0212 changed frozen pricing columns';
  END IF;
  IF v_catalog_after IS DISTINCT FROM v_catalog_before THEN
    RAISE EXCEPTION '0212 changed catalog identity or descriptors';
  END IF;
  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
         AND c.state = 'active'
         AND p.enabled IS TRUE
         AND p.visibility = 'public') <> 2 THEN
    RAISE EXCEPTION '0212 public activation postcondition failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id IN ('glm-5.3', 'deepseek-v4-flash-opencode-go')
  ) THEN
    RAISE EXCEPTION '0212 must not add target grants';
  END IF;
END
$migration$;
