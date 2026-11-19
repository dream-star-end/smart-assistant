-- OCV5-802: onboard GPT-6.2 Astra (`gpt-6.2-astra`, `gpt-6.2-astra-1m`) and
-- GPT-6.2 Sol (`gpt-6.2-sol`, `gpt-6.2-sol-1m`) into commercial catalog with
-- admin-only visibility while keeping legacy `gpt-6-astra*` and `gpt-6.1-sol*`
-- untouched during rollout so Slot B rollback stays safe.
-- order-dependency: 0342_commercial_user_sites
-- compat: serialize catalog, pricing, and group bindings inside the migration transaction without schema DDL; all four new models remain admin-only and do not alter legacy rows, runtime requirements, active sessions, or user preferences.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE model_catalog, model_pricing, account_group_models, model_runtime_requirements IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  rec RECORD;
  codex_groups INTEGER;
  astra_prompt TEXT;
  astra_plan TEXT;
  sol_prompt TEXT;
  sol_plan TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-6-astra' AND c.engine = 'codex' AND c.provider_id = 'codex'
       AND c.state IN ('staged', 'active', 'disabled') AND p.multiplier = 1
  ) THEN
    RAISE EXCEPTION '0343 requires the gpt-6-astra catalog/pricing row as the donor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-6.1-sol' AND c.engine = 'codex' AND c.provider_id = 'codex'
       AND c.state IN ('staged', 'active', 'disabled') AND p.multiplier = 1
  ) THEN
    RAISE EXCEPTION '0343 requires the gpt-6.1-sol catalog/pricing row as the donor';
  END IF;

  SELECT extra_system_prompt, min_plan_code INTO astra_prompt, astra_plan
    FROM model_pricing WHERE model_id = 'gpt-6-astra';
  SELECT extra_system_prompt, min_plan_code INTO sol_prompt, sol_plan
    FROM model_pricing WHERE model_id = 'gpt-6.1-sol';

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
    IF EXISTS (SELECT 1 FROM model_pricing WHERE model_id = rec.model_id)
       OR EXISTS (
         SELECT 1 FROM model_catalog
          WHERE model_id = rec.model_id AND state IN ('staged', 'active', 'disabled')
       )
    THEN
      IF NOT EXISTS (
        SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
         WHERE c.model_id = rec.model_id AND c.engine = 'codex' AND c.provider_id = 'codex'
           AND c.state = 'active'
           AND c.upstream_model_id IS NOT DISTINCT FROM rec.upstream_model_id
           AND c.context_window IS NOT DISTINCT FROM rec.context_window
           AND p.enabled IS TRUE AND p.multiplier = 1 AND p.visibility = 'admin'
           AND p.display_name = rec.display_name AND p.default_effort = rec.default_effort
           AND p.sort_order = rec.sort_order
           AND p.input_per_mtok = rec.input_fen AND p.output_per_mtok = rec.output_fen
           AND p.cache_read_per_mtok = rec.cache_read_fen
           AND p.cache_write_per_mtok = rec.cache_write_fen
           AND p.extra_system_prompt IS NOT DISTINCT FROM rec.extra_prompt
           AND p.min_plan_code IS NOT DISTINCT FROM rec.min_plan
           AND c.capability_schema_version = 1
           AND c.capability_profile -> 'ccb' = '{"capability_zero":false,"supports_thinking":false}'::jsonb
           AND c.capability_profile -> 'reasoning' -> 'supported' = '["low","medium","high","xhigh","max"]'::jsonb
           AND c.capability_profile #>> '{reasoning,codex_model_default}' = rec.default_effort
           AND COALESCE((c.capability_profile ->> 'supports_vision')::boolean, FALSE) IS TRUE
      ) THEN
        RAISE EXCEPTION '0343 refuses drifted % row', rec.model_id;
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
        1, FALSE, rec.sort_order, 'admin', rec.extra_prompt,
        rec.default_effort, 0, rec.min_plan
      );

      UPDATE model_catalog SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0343 failed to activate %', rec.model_id;
      END IF;
      UPDATE model_pricing
         SET enabled = TRUE, lock_version = lock_version + 1
       WHERE model_id = rec.model_id;
    END IF;
  END LOOP;

  SELECT count(DISTINCT gm.group_id) INTO codex_groups
    FROM account_group_models gm
    JOIN account_groups g ON g.id = gm.group_id
   WHERE g.provider = 'codex'
     AND gm.model_id IN ('gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.2-astra', 'gpt-6.2-sol');

  IF codex_groups >= 1 THEN
    INSERT INTO account_group_models (group_id, model_id)
    SELECT DISTINCT gm.group_id, n.new_id
      FROM account_group_models gm
      JOIN account_groups g ON g.id = gm.group_id
      CROSS JOIN (VALUES ('gpt-6.2-astra'), ('gpt-6.2-sol')) AS n(new_id)
     WHERE g.provider = 'codex'
       AND gm.model_id IN ('gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.2-astra', 'gpt-6.2-sol')
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO model_runtime_requirements (model_id, requirement)
  VALUES ('gpt-6.2-astra', 'default_codex_engine')
  ON CONFLICT DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM model_runtime_requirements
     WHERE model_id = 'gpt-6.2-astra' AND requirement = 'default_codex_engine'
  ) THEN
    RAISE EXCEPTION '0343 failed to register gpt-6.2-astra default_codex_engine requirement';
  END IF;

  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('gpt-6.2-astra', 'gpt-6.2-astra-1m', 'gpt-6.2-sol', 'gpt-6.2-sol-1m')
         AND c.state = 'active' AND p.enabled IS TRUE AND p.visibility = 'admin'
         AND (
           (c.model_id = 'gpt-6.2-astra'    AND p.default_effort = 'xhigh'  AND p.input_per_mtok = 598 AND p.output_per_mtok = 3598 AND p.cache_read_per_mtok = 60 AND p.cache_write_per_mtok = 0)
           OR (c.model_id = 'gpt-6.2-astra-1m' AND p.default_effort = 'xhigh'  AND p.input_per_mtok = 897 AND p.output_per_mtok = 5397 AND p.cache_read_per_mtok = 90 AND p.cache_write_per_mtok = 0)
           OR (c.model_id = 'gpt-6.2-sol'      AND p.default_effort = 'medium' AND p.input_per_mtok = 100 AND p.output_per_mtok =  500 AND p.cache_read_per_mtok =  5 AND p.cache_write_per_mtok = 125)
           OR (c.model_id = 'gpt-6.2-sol-1m'   AND p.default_effort = 'medium' AND p.input_per_mtok = 150 AND p.output_per_mtok =  750 AND p.cache_read_per_mtok =  8 AND p.cache_write_per_mtok = 188)
         )) <> 4 THEN
    RAISE EXCEPTION '0343 expected 4 active admin-only GPT-6.2 Astra/Sol rows with exact pricing';
  END IF;

  IF EXISTS (
       SELECT 1 FROM account_group_models
        WHERE model_id IN ('gpt-6.2-astra-1m', 'gpt-6.2-sol-1m')
     )
     OR (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6.2-astra') <> codex_groups
     OR (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6.2-sol') <> codex_groups
  THEN
    RAISE EXCEPTION '0343 GPT-6.2 group binding postcondition failed';
  END IF;
END $$;

-- compat: bump model_security_epoch so running masters/egress invalidate cached catalog snapshots.
SELECT fn_model_security_epoch_bump();
