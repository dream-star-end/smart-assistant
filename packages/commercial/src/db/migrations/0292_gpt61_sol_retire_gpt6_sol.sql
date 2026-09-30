-- order-dependency: 0291_box_claude_cursor_audit
-- 0292_gpt61_sol_retire_gpt6_sol.sql
-- Codex CLI 0.159.2 (dist-tag latest, published 2026-09-30T00:03:49Z)
-- `debug models` lists gpt-6.1-sol as visibility=list, supported_in_api.
-- 0.155.1 does not. Official short-context prices
-- (developers.openai.com/api/docs/pricing, 2026-09-30), per 1M tokens:
--   gpt-6.1-sol  $2 / $0.10 cached / $2.50 cache write / $10 output
-- Selfhost fen follows 0286: floor(official_usd * 100 / 2).
--   standard 100 / 500 / 5 / 125
-- 1M twins use the 0238 contract (std*3+1)/2, not the official long-context
-- split (2x input, 1.5x output above 272K). cliModel stays gpt-6.1-sol.
-- 1M rows are not account-group keys.
--
-- Platform default effort is medium: that is the API default
-- (developers.openai.com/api/docs/models/gpt-6.1-sol) and the predecessor
-- gpt-6-sol default. Codex 0.159.2 debug models reports
-- default_reasoning_level=low; the platform sends effort explicitly and
-- does not adopt that CLI default.
--
-- GPT-6 Sol standard + 1M are disabled after live sessions and codex route
-- contexts are remapped onto GPT-6.1 Sol. Historical usage rows are not
-- rewritten. Idempotent: replay accepts the expected rows and a Sol pair
-- that is already disabled.

DO $$
DECLARE
  rec RECORD;
  n INTEGER;
  astra_groups INTEGER;
  sol_prompt TEXT;
  sol_plan TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-6-sol' AND c.engine = 'codex' AND c.provider_id = 'codex'
       AND p.multiplier = 1
  ) THEN
    RAISE EXCEPTION '0292 requires the gpt-6-sol catalog/pricing row as the donor';
  END IF;

  SELECT extra_system_prompt, min_plan_code INTO sol_prompt, sol_plan
    FROM model_pricing WHERE model_id = 'gpt-6-sol';

  FOR rec IN
    SELECT * FROM (VALUES
      ('gpt-6.1-sol',    NULL::TEXT,      NULL::INTEGER, 'GPT-6.1-Sol', 100::BIGINT, 500::BIGINT, 5::BIGINT, 125::BIGINT, 109),
      ('gpt-6.1-sol-1m', 'gpt-6.1-sol',   1000000,       'GPT-6.1-Sol', 150::BIGINT, 750::BIGINT, 8::BIGINT, 188::BIGINT, 109)
    ) AS t(model_id, upstream_model_id, context_window, display_name, input_fen, output_fen, cache_read_fen, cache_write_fen, sort_order)
  LOOP
    IF EXISTS (SELECT 1 FROM model_pricing WHERE model_id = rec.model_id) THEN
      IF NOT EXISTS (
        SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
         WHERE c.model_id = rec.model_id AND c.engine = 'codex' AND c.provider_id = 'codex'
           AND c.state = 'active'
           AND c.upstream_model_id IS NOT DISTINCT FROM rec.upstream_model_id
           AND c.context_window IS NOT DISTINCT FROM rec.context_window
           AND p.enabled IS TRUE AND p.multiplier = 1 AND p.visibility = 'public'
           AND p.display_name = rec.display_name AND p.default_effort = 'medium'
           AND p.sort_order = rec.sort_order
           AND p.input_per_mtok = rec.input_fen AND p.output_per_mtok = rec.output_fen
           AND p.cache_read_per_mtok = rec.cache_read_fen
           AND p.cache_write_per_mtok = rec.cache_write_fen
           AND c.capability_profile #>> '{reasoning,codex_model_default}' = 'medium'
      ) THEN
        RAISE EXCEPTION '0292 refuses drifted % row', rec.model_id;
      END IF;
    ELSE
      INSERT INTO model_catalog (
        model_id, engine, provider_id, upstream_model_id, context_window,
        capability_profile, capability_schema_version, state
      )
      SELECT
        rec.model_id, engine, provider_id, rec.upstream_model_id, rec.context_window,
        jsonb_set(
          capability_profile,
          '{reasoning,codex_model_default}',
          '"medium"'::jsonb,
          true
        ),
        capability_schema_version,
        'staged'
      FROM model_catalog
      WHERE model_id = 'gpt-6-sol' AND state = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0292 failed to clone active gpt-6-sol catalog for %', rec.model_id;
      END IF;

      INSERT INTO model_pricing (
        model_id, display_name,
        input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
        multiplier, enabled, sort_order, visibility, extra_system_prompt,
        default_effort, lock_version, min_plan_code
      ) VALUES (
        rec.model_id, rec.display_name,
        rec.input_fen, rec.output_fen, rec.cache_read_fen, rec.cache_write_fen,
        1, FALSE, rec.sort_order, 'public', sol_prompt,
        'medium', 0, sol_plan
      );

      UPDATE model_catalog SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0292 failed to activate %', rec.model_id;
      END IF;
      UPDATE model_pricing
         SET enabled = TRUE, lock_version = lock_version + 1
       WHERE model_id = rec.model_id;
    END IF;
  END LOOP;

  SELECT count(*) INTO astra_groups
    FROM account_group_models gm JOIN account_groups g ON g.id = gm.group_id
   WHERE gm.model_id = 'gpt-6-astra' AND g.provider = 'codex';
  IF astra_groups < 1 THEN
    RAISE EXCEPTION '0292 requires gpt-6-astra bound to at least one codex account group';
  END IF;
  INSERT INTO account_group_models (group_id, model_id)
  SELECT gm.group_id, 'gpt-6.1-sol'
    FROM account_group_models gm
    JOIN account_groups g ON g.id = gm.group_id
   WHERE gm.model_id = 'gpt-6-astra' AND g.provider = 'codex'
  ON CONFLICT DO NOTHING;

  UPDATE client_sessions
     SET model_id = CASE model_id
          WHEN 'gpt-6-sol' THEN 'gpt-6.1-sol'
          WHEN 'gpt-6-sol-1m' THEN 'gpt-6.1-sol-1m'
        END
   WHERE deleted_at IS NULL
     AND model_id IN ('gpt-6-sol', 'gpt-6-sol-1m');

  UPDATE codex_route_contexts
     SET model_id = CASE model_id
          WHEN 'gpt-6-sol' THEN 'gpt-6.1-sol'
          WHEN 'gpt-6-sol-1m' THEN 'gpt-6.1-sol-1m'
        END
   WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m');

  DELETE FROM account_group_models
   WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m');

  IF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE state = 'active'
       AND model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
       AND (enabled IS TRUE OR visibility <> 'hidden')
  ) THEN
    FOR rec IN
      SELECT entry_id, lock_version FROM model_catalog
       WHERE state = 'active'
         AND model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
       ORDER BY model_id
    LOOP
      PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
    END LOOP;
    UPDATE model_pricing
       SET enabled = FALSE, visibility = 'hidden', promo_label = NULL,
           lock_version = lock_version + 1, updated_at = clock_timestamp()
     WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
       AND (enabled IS TRUE OR visibility <> 'hidden');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n < 1 THEN
      RAISE EXCEPTION '0292 expected to hide at least one GPT-6 Sol pricing row, updated %', n;
    END IF;
  END IF;

  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('gpt-6.1-sol', 'gpt-6.1-sol-1m')
         AND c.state = 'active' AND p.enabled IS TRUE AND p.visibility = 'public'
         AND p.default_effort = 'medium'
         AND p.input_per_mtok IN (100, 150)
         AND p.cache_read_per_mtok IN (5, 8)) <> 2 THEN
    RAISE EXCEPTION '0292 expected 2 active public GPT-6.1 Sol rows';
  END IF;
  IF (SELECT count(*) FROM model_catalog
       WHERE state = 'active' AND model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')) <> 0
     OR EXISTS (
       SELECT 1 FROM model_pricing
        WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
          AND (enabled OR visibility <> 'hidden')
     )
     OR EXISTS (
       SELECT 1 FROM client_sessions
        WHERE deleted_at IS NULL AND model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
     )
     OR EXISTS (
       SELECT 1 FROM codex_route_contexts
        WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m')
     )
     OR EXISTS (
       SELECT 1 FROM account_group_models
        WHERE model_id IN ('gpt-6-sol', 'gpt-6-sol-1m', 'gpt-6.1-sol-1m')
     )
     OR (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6.1-sol') <> astra_groups
  THEN
    RAISE EXCEPTION '0292 GPT-6.1 onboard / GPT-6 Sol retirement postcondition failed';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
