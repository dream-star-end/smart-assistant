-- order-dependency: 0345_user_sites
-- 0346_selfhost_gpt62_sol_astra_retire_legacy.sql
--
-- Onboard GPT-6.2 Astra (`gpt-6.2-astra`, `gpt-6.2-astra-1m`) and GPT-6.2 Sol
-- (`gpt-6.2-sol`, `gpt-6.2-sol-1m`) at the exact prices and reasoning defaults of
-- their predecessors, remap live pointers, and take `gpt-6-astra*`,
-- `gpt-6.1-sol*`, and their `-remote` pool counterparts offline.
--
-- Pricing (unchanged from 0263/0292; stored in fen/MTok, multiplier=1):
--   gpt-6.2-astra    : 598 / 3598 / 60 /   0, default_effort=xhigh
--   gpt-6.2-astra-1m : 897 / 5397 / 90 /   0, default_effort=xhigh,  ctx=1000000
--   gpt-6.2-sol      : 100 /  500 /  5 / 125, default_effort=medium
--   gpt-6.2-sol-1m   : 150 /  750 /  8 / 188, default_effort=medium, ctx=1000000
--
-- Pre-existing `codex` CLI 0.169.0 in runtime image accepts both `gpt-6.2-astra`
-- and `gpt-6.2-sol` (verified via app-server `thread/start` and live remote pool
-- `model/list`). 1M twins stay billing-only tiers (`cliModel` -> standard slug)
-- and are never bound into `account_group_models`.

-- compat: serialize catalog, pricing, group bindings, and runtime requirements inside the migration transaction without schema DDL.
LOCK TABLE model_catalog, model_pricing, account_group_models, model_runtime_requirements IN SHARE ROW EXCLUSIVE MODE;

-- compat: additive onboarding of GPT-6.2 Astra/Sol (+1m) at unchanged pricing, remapping live session/route/preference/requirement pointers before disabling retired GPT-6 Astra and GPT-6.1 Sol rows; no schema DDL or billing rate changes.
DO $$
DECLARE
  rec RECORD;
  n INTEGER;
  codex_groups INTEGER;
  astra_prompt TEXT;
  astra_plan TEXT;
  sol_prompt TEXT;
  sol_plan TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-6-astra' AND c.engine = 'codex' AND c.provider_id = 'codex'
       AND c.state IN ('active', 'disabled') AND p.multiplier = 1
  ) THEN
    RAISE EXCEPTION '0346 requires the gpt-6-astra catalog/pricing row as the donor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-6.1-sol' AND c.engine = 'codex' AND c.provider_id = 'codex'
       AND c.state IN ('active', 'disabled') AND p.multiplier = 1
  ) THEN
    RAISE EXCEPTION '0346 requires the gpt-6.1-sol catalog/pricing row as the donor';
  END IF;

  SELECT extra_system_prompt, min_plan_code INTO astra_prompt, astra_plan
    FROM model_pricing WHERE model_id = 'gpt-6-astra';
  SELECT extra_system_prompt, min_plan_code INTO sol_prompt, sol_plan
    FROM model_pricing WHERE model_id = 'gpt-6.1-sol';

  -- ── 1. Onboard GPT-6.2 Astra / Sol (+1m twins) ─────────────────────────
  FOR rec IN
    SELECT * FROM (VALUES
      ('gpt-6.2-astra',    NULL::TEXT,      NULL::INTEGER, 'GPT-6.2-Astra', 598::BIGINT, 3598::BIGINT, 60::BIGINT,   0::BIGINT, 109, 'xhigh',  astra_prompt, astra_plan),
      ('gpt-6.2-astra-1m', 'gpt-6.2-astra', 1000000,       'GPT-6.2-Astra', 897::BIGINT, 5397::BIGINT, 90::BIGINT,   0::BIGINT, 109, 'xhigh',  astra_prompt, astra_plan),
      ('gpt-6.2-sol',      NULL::TEXT,      NULL::INTEGER, 'GPT-6.2-Sol',   100::BIGINT,  500::BIGINT,  5::BIGINT, 125::BIGINT, 109, 'medium', sol_prompt,   sol_plan),
      ('gpt-6.2-sol-1m',   'gpt-6.2-sol',   1000000,       'GPT-6.2-Sol',   150::BIGINT,  750::BIGINT,  8::BIGINT, 188::BIGINT, 109, 'medium', sol_prompt,   sol_plan)
    ) AS t(
      model_id, upstream_model_id, context_window, display_name,
      input_fen, output_fen, cache_read_fen, cache_write_fen,
      sort_order, default_effort, extra_prompt, min_plan
    )
  LOOP
    IF EXISTS (SELECT 1 FROM model_pricing WHERE model_id = rec.model_id) THEN
      IF NOT EXISTS (
        SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
         WHERE c.model_id = rec.model_id AND c.engine = 'codex' AND c.provider_id = 'codex'
           AND c.state = 'active'
           AND c.upstream_model_id IS NOT DISTINCT FROM rec.upstream_model_id
           AND c.context_window IS NOT DISTINCT FROM rec.context_window
           AND p.enabled IS TRUE AND p.multiplier = 1 AND p.visibility = 'public'
           AND p.display_name = rec.display_name AND p.default_effort = rec.default_effort
           AND p.sort_order = rec.sort_order
           AND p.input_per_mtok = rec.input_fen AND p.output_per_mtok = rec.output_fen
           AND p.cache_read_per_mtok = rec.cache_read_fen
           AND p.cache_write_per_mtok = rec.cache_write_fen
           AND c.capability_profile #>> '{reasoning,codex_model_default}' = rec.default_effort
           AND COALESCE((c.capability_profile ->> 'supports_vision')::boolean, FALSE) IS TRUE
      ) THEN
        RAISE EXCEPTION '0346 refuses drifted % row', rec.model_id;
      END IF;
    ELSE
      INSERT INTO model_catalog (
        model_id, engine, provider_id, upstream_model_id, context_window,
        capability_profile, capability_schema_version, state
      )
      SELECT
        rec.model_id,
        'codex',
        'codex',
        rec.upstream_model_id,
        rec.context_window,
        jsonb_build_object(
          'ccb', jsonb_build_object('capability_zero', false, 'supports_thinking', false),
          'reasoning', jsonb_build_object(
            'supported', jsonb_build_array('low', 'medium', 'high', 'xhigh', 'max'),
            'codex_model_default', rec.default_effort
          ),
          'supports_vision', true
        ),
        1,
        'staged';

      INSERT INTO model_pricing (
        model_id, display_name,
        input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
        multiplier, enabled, sort_order, visibility, extra_system_prompt,
        default_effort, lock_version, min_plan_code
      ) VALUES (
        rec.model_id, rec.display_name,
        rec.input_fen, rec.output_fen, rec.cache_read_fen, rec.cache_write_fen,
        1, FALSE, rec.sort_order, 'public', rec.extra_prompt,
        rec.default_effort, 0, rec.min_plan
      );

      UPDATE model_catalog SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0346 failed to activate %', rec.model_id;
      END IF;
      UPDATE model_pricing
         SET enabled = TRUE, lock_version = lock_version + 1
       WHERE model_id = rec.model_id;
    END IF;
  END LOOP;

  -- ── 2. Bind standard IDs into active/existing codex account groups ─────
  SELECT count(DISTINCT gm.group_id) INTO codex_groups
    FROM account_group_models gm
    JOIN account_groups g ON g.id = gm.group_id
   WHERE g.provider = 'codex'
     AND gm.model_id IN ('gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.2-astra', 'gpt-6.2-sol');
  IF codex_groups < 1 THEN
    RAISE EXCEPTION '0346 requires at least one codex account group';
  END IF;

  INSERT INTO account_group_models (group_id, model_id)
  SELECT DISTINCT gm.group_id, n.new_id
    FROM account_group_models gm
    JOIN account_groups g ON g.id = gm.group_id
    CROSS JOIN (VALUES ('gpt-6.2-astra'), ('gpt-6.2-sol')) AS n(new_id)
   WHERE g.provider = 'codex'
     AND gm.model_id IN ('gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.2-astra', 'gpt-6.2-sol')
  ON CONFLICT DO NOTHING;

  -- ── 3. Move default_codex_engine requirement before disabling gpt-6-astra ─
  DELETE FROM model_runtime_requirements
   WHERE requirement = 'default_codex_engine'
     AND model_id IS DISTINCT FROM 'gpt-6.2-astra';
  INSERT INTO model_runtime_requirements (model_id, requirement)
  VALUES ('gpt-6.2-astra', 'default_codex_engine')
  ON CONFLICT DO NOTHING;

  -- ── 4. Remap live sessions, route contexts, and user preferences ─────────
  UPDATE client_sessions
     SET model_id = CASE model_id
          WHEN 'gpt-6-astra'        THEN 'gpt-6.2-astra'
          WHEN 'gpt-6-astra-1m'     THEN 'gpt-6.2-astra-1m'
          WHEN 'gpt-6.1-sol'        THEN 'gpt-6.2-sol'
          WHEN 'gpt-6.1-sol-1m'     THEN 'gpt-6.2-sol-1m'
          WHEN 'gpt-6-astra-remote' THEN 'gpt-6.2-astra'
          WHEN 'gpt-6.1-sol-remote' THEN 'gpt-6.2-sol'
        END
   WHERE deleted_at IS NULL
     AND model_id IN (
       'gpt-6-astra', 'gpt-6-astra-1m',
       'gpt-6.1-sol', 'gpt-6.1-sol-1m',
       'gpt-6-astra-remote', 'gpt-6.1-sol-remote'
     );

  UPDATE codex_route_contexts
     SET model_id = CASE model_id
          WHEN 'gpt-6-astra'        THEN 'gpt-6.2-astra'
          WHEN 'gpt-6-astra-1m'     THEN 'gpt-6.2-astra-1m'
          WHEN 'gpt-6.1-sol'        THEN 'gpt-6.2-sol'
          WHEN 'gpt-6.1-sol-1m'     THEN 'gpt-6.2-sol-1m'
          WHEN 'gpt-6-astra-remote' THEN 'gpt-6.2-astra'
          WHEN 'gpt-6.1-sol-remote' THEN 'gpt-6.2-sol'
        END
   WHERE model_id IN (
     'gpt-6-astra', 'gpt-6-astra-1m',
     'gpt-6.1-sol', 'gpt-6.1-sol-1m',
     'gpt-6-astra-remote', 'gpt-6.1-sol-remote'
   );

  UPDATE user_preferences
     SET prefs = jsonb_set(
           prefs,
           '{default_model}',
           to_jsonb(
             CASE prefs->>'default_model'
               WHEN 'gpt-6-astra'        THEN 'gpt-6.2-astra'
               WHEN 'gpt-6-astra-1m'     THEN 'gpt-6.2-astra-1m'
               WHEN 'gpt-6.1-sol'        THEN 'gpt-6.2-sol'
               WHEN 'gpt-6.1-sol-1m'     THEN 'gpt-6.2-sol-1m'
               WHEN 'gpt-6-astra-remote' THEN 'gpt-6.2-astra'
               WHEN 'gpt-6.1-sol-remote' THEN 'gpt-6.2-sol'
             END
           ),
           true
         ),
         updated_at = clock_timestamp()
   WHERE prefs->>'default_model' IN (
     'gpt-6-astra', 'gpt-6-astra-1m',
     'gpt-6.1-sol', 'gpt-6.1-sol-1m',
     'gpt-6-astra-remote', 'gpt-6.1-sol-remote'
   );

  -- ── 5. Disable retired remote-pool offers/rows if present ──────────────
  IF to_regclass('public.remote_model_offers') IS NOT NULL THEN
    UPDATE remote_model_offers
       SET enabled = FALSE,
           updated_at = clock_timestamp()
     WHERE canonical_model_id IN ('gpt-6-astra-remote', 'gpt-6.1-sol-remote')
       AND enabled IS TRUE;
  END IF;

  FOR rec IN
    SELECT entry_id, lock_version FROM model_catalog
     WHERE state = 'active'
       AND model_id IN ('gpt-6-astra-remote', 'gpt-6.1-sol-remote')
     ORDER BY model_id
  LOOP
    PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
  END LOOP;

  UPDATE model_catalog
     SET pool_auto_disabled = FALSE
   WHERE state <> 'retired'
     AND pool_auto_disabled IS TRUE
     AND model_id IN ('gpt-6-astra-remote', 'gpt-6.1-sol-remote');

  UPDATE model_pricing
     SET enabled = FALSE, visibility = 'hidden', promo_label = NULL,
         lock_version = lock_version + 1, updated_at = clock_timestamp()
   WHERE model_id IN ('gpt-6-astra-remote', 'gpt-6.1-sol-remote')
     AND (enabled IS TRUE OR visibility <> 'hidden');

  -- ── 6. Remove retired group bindings & disable local legacy rows ───────
  DELETE FROM account_group_models
   WHERE model_id IN ('gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m');

  IF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE state = 'active'
       AND model_id IN ('gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m')
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id IN ('gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m')
       AND (enabled IS TRUE OR visibility <> 'hidden')
  ) THEN
    FOR rec IN
      SELECT entry_id, lock_version FROM model_catalog
       WHERE state = 'active'
         AND model_id IN ('gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m')
       ORDER BY model_id
    LOOP
      PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
    END LOOP;
    UPDATE model_pricing
       SET enabled = FALSE, visibility = 'hidden', promo_label = NULL,
           lock_version = lock_version + 1, updated_at = clock_timestamp()
     WHERE model_id IN ('gpt-6-astra', 'gpt-6-astra-1m', 'gpt-6.1-sol', 'gpt-6.1-sol-1m')
       AND (enabled IS TRUE OR visibility <> 'hidden');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n < 1 THEN
      RAISE EXCEPTION '0346 expected to hide at least one retired GPT-6 Astra / GPT-6.1 Sol pricing row, updated %', n;
    END IF;
  END IF;

  -- ── 7. Postconditions ──────────────────────────────────────────────────
  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('gpt-6.2-astra', 'gpt-6.2-astra-1m', 'gpt-6.2-sol', 'gpt-6.2-sol-1m')
         AND c.state = 'active' AND p.enabled IS TRUE AND p.visibility = 'public'
         AND (
           (c.model_id = 'gpt-6.2-astra'    AND p.default_effort = 'xhigh'  AND p.input_per_mtok = 598 AND p.output_per_mtok = 3598 AND p.cache_read_per_mtok = 60 AND p.cache_write_per_mtok = 0)
           OR (c.model_id = 'gpt-6.2-astra-1m' AND p.default_effort = 'xhigh'  AND p.input_per_mtok = 897 AND p.output_per_mtok = 5397 AND p.cache_read_per_mtok = 90 AND p.cache_write_per_mtok = 0)
           OR (c.model_id = 'gpt-6.2-sol'      AND p.default_effort = 'medium' AND p.input_per_mtok = 100 AND p.output_per_mtok =  500 AND p.cache_read_per_mtok =  5 AND p.cache_write_per_mtok = 125)
           OR (c.model_id = 'gpt-6.2-sol-1m'   AND p.default_effort = 'medium' AND p.input_per_mtok = 150 AND p.output_per_mtok =  750 AND p.cache_read_per_mtok =  8 AND p.cache_write_per_mtok = 188)
         )) <> 4 THEN
    RAISE EXCEPTION '0346 expected 4 active public GPT-6.2 Astra/Sol rows with exact pricing';
  END IF;

  IF EXISTS (
       SELECT 1 FROM model_catalog
        WHERE state = 'active'
          AND model_id IN (
            'gpt-6-astra', 'gpt-6-astra-1m',
            'gpt-6.1-sol', 'gpt-6.1-sol-1m',
            'gpt-6-astra-remote', 'gpt-6.1-sol-remote'
          )
     )
     OR EXISTS (
       SELECT 1 FROM model_pricing
        WHERE model_id IN (
            'gpt-6-astra', 'gpt-6-astra-1m',
            'gpt-6.1-sol', 'gpt-6.1-sol-1m',
            'gpt-6-astra-remote', 'gpt-6.1-sol-remote'
          )
          AND (enabled OR visibility <> 'hidden')
     )
     OR EXISTS (
       SELECT 1 FROM client_sessions
        WHERE deleted_at IS NULL
          AND model_id IN (
            'gpt-6-astra', 'gpt-6-astra-1m',
            'gpt-6.1-sol', 'gpt-6.1-sol-1m',
            'gpt-6-astra-remote', 'gpt-6.1-sol-remote'
          )
     )
     OR EXISTS (
       SELECT 1 FROM codex_route_contexts
        WHERE model_id IN (
            'gpt-6-astra', 'gpt-6-astra-1m',
            'gpt-6.1-sol', 'gpt-6.1-sol-1m',
            'gpt-6-astra-remote', 'gpt-6.1-sol-remote'
          )
     )
     OR EXISTS (
       SELECT 1 FROM user_preferences
        WHERE prefs->>'default_model' IN (
            'gpt-6-astra', 'gpt-6-astra-1m',
            'gpt-6.1-sol', 'gpt-6.1-sol-1m',
            'gpt-6-astra-remote', 'gpt-6.1-sol-remote'
          )
     )
     OR EXISTS (
       SELECT 1 FROM account_group_models
        WHERE model_id IN (
          'gpt-6-astra', 'gpt-6-astra-1m',
          'gpt-6.1-sol', 'gpt-6.1-sol-1m',
          'gpt-6.2-astra-1m', 'gpt-6.2-sol-1m'
        )
     )
     OR (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6.2-astra') <> codex_groups
     OR (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6.2-sol') <> codex_groups
     OR NOT EXISTS (
       SELECT 1 FROM model_runtime_requirements
        WHERE model_id = 'gpt-6.2-astra' AND requirement = 'default_codex_engine'
     )
     OR EXISTS (
       SELECT 1 FROM model_runtime_requirements
        WHERE requirement = 'default_codex_engine' AND model_id <> 'gpt-6.2-astra'
     )
     OR EXISTS (
       SELECT 1 FROM model_catalog
        WHERE model_id IN ('gpt-6-astra-remote', 'gpt-6.1-sol-remote')
          AND state <> 'retired'
          AND pool_auto_disabled IS TRUE
     )
     OR (
       to_regclass('public.remote_model_offers') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM remote_model_offers
          WHERE canonical_model_id IN ('gpt-6-astra-remote', 'gpt-6.1-sol-remote')
            AND enabled IS TRUE
       )
     )
  THEN
    RAISE EXCEPTION '0346 GPT-6.2 onboard / GPT-6 Astra & GPT-6.1 Sol retirement postcondition failed';
  END IF;
END $$;

-- compat: bump model_security_epoch so running masters/egress invalidate cached catalog snapshots.
SELECT fn_model_security_epoch_bump();
