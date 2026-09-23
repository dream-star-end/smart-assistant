-- order-dependency: 0287_claude_opus_55_context_1m
-- 0288_gpt6_sol_luna_retire_gpt56.sql
-- Codex CLI 0.155.1 (published 2026-09-18, dist-tag latest) `debug models`
-- lists gpt-6-sol and gpt-6-luna as visibility=list, supported_in_api.
-- Official API prices (developers.openai.com/api/docs/pricing, 2026-09-22),
-- short context, per 1M tokens:
--   gpt-6-sol  $2 / $0.20 cached / $2.50 cache write / $10 output
--   gpt-6-luna $0.10 / $0.01 cached / $0.125 cache write / $0.50 output
-- Selfhost fen follows 0286: floor(official_usd * 100 / 2). Luna cached input
-- is $0.01, which floors to 0 fen; store 1 so a real cache read is not free.
-- 1M twins use the 0238 contract (std*3+1)/2 on every dimension, not the
-- official long-context split (2x input, 1.5x output). cliModel stays the
-- standard id. 1M rows are not account-group keys.
--
-- GPT-5.6 Codex rows (standard + 1M) are disabled after live sessions and
-- codex route contexts are remapped. There is no GPT-6 Terra; terra goes to
-- Sol. default_codex_engine moves to gpt-6-astra, which the protocol constant
-- already names. Cursor gpt-5.6-luna-* is a different engine and stays.
--
-- Idempotent: a hot apply may insert the new rows before schema_migrations
-- records this file. Replay accepts the expected rows. A partial active
-- subset of the six Codex GPT-5.6 ids is retired too (commercial had
-- already disabled five of them). Any other shape raises.

DO $$
DECLARE
  rec RECORD;
  n INTEGER;
  astra_groups INTEGER;
  active_56 INTEGER;
  sol_prompt TEXT;
  sol_plan TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-6-astra' AND c.engine = 'codex' AND c.provider_id = 'codex'
       AND c.state = 'active' AND p.enabled IS TRUE AND p.multiplier = 1
  ) THEN
    RAISE EXCEPTION '0288 requires active enabled multiplier=1 gpt-6-astra';
  END IF;

  SELECT extra_system_prompt, min_plan_code INTO sol_prompt, sol_plan
    FROM model_pricing WHERE model_id = 'gpt-5.6-sol';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0288 requires the gpt-5.6-sol pricing row as the prompt/plan donor';
  END IF;

  -- ── Sol + Luna, standard then 1M ────────────────────────────────────────
  FOR rec IN
    SELECT * FROM (VALUES
      ('gpt-6-sol',     NULL::TEXT,    NULL::INTEGER, 'GPT-6-Sol',  100::BIGINT, 500::BIGINT, 10::BIGINT, 125::BIGINT, 110),
      ('gpt-6-sol-1m',  'gpt-6-sol',   1000000,       'GPT-6-Sol',  150::BIGINT, 750::BIGINT, 15::BIGINT, 188::BIGINT, 110),
      ('gpt-6-luna',    NULL::TEXT,    NULL::INTEGER, 'GPT-6-Luna', 5::BIGINT,   25::BIGINT,  1::BIGINT,  6::BIGINT,   111),
      ('gpt-6-luna-1m', 'gpt-6-luna',  1000000,       'GPT-6-Luna', 8::BIGINT,   38::BIGINT,  2::BIGINT,  9::BIGINT,   111)
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
      ) THEN
        RAISE EXCEPTION '0288 refuses drifted % row', rec.model_id;
      END IF;
    ELSE
      INSERT INTO model_catalog (
        model_id, engine, provider_id, upstream_model_id, context_window,
        capability_profile, capability_schema_version, state
      )
      SELECT
        rec.model_id, engine, provider_id, rec.upstream_model_id, rec.context_window,
        jsonb_build_object(
          'ccb', jsonb_build_object('capability_zero', false, 'supports_thinking', false),
          'reasoning', jsonb_build_object(
            'supported', jsonb_build_array('low', 'medium', 'high', 'xhigh', 'max'),
            'codex_model_default', 'medium'
          ),
          'supports_vision', true
        ),
        capability_schema_version,
        'staged'
      FROM model_catalog
      WHERE model_id = 'gpt-6-astra' AND state = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0288 failed to clone catalog for %', rec.model_id;
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
        RAISE EXCEPTION '0288 failed to activate %', rec.model_id;
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
    RAISE EXCEPTION '0288 requires gpt-6-astra bound to at least one codex account group';
  END IF;
  INSERT INTO account_group_models (group_id, model_id)
  SELECT gm.group_id, new_id
    FROM account_group_models gm
    JOIN account_groups g ON g.id = gm.group_id
    CROSS JOIN (VALUES ('gpt-6-sol'), ('gpt-6-luna')) AS n(new_id)
   WHERE gm.model_id = 'gpt-6-astra' AND g.provider = 'codex'
  ON CONFLICT DO NOTHING;

  -- ── runtime requirement follows the protocol default ────────────────────
  IF EXISTS (
    SELECT 1 FROM model_runtime_requirements
     WHERE requirement = 'default_codex_engine' AND model_id IS DISTINCT FROM 'gpt-6-astra'
  ) THEN
    DELETE FROM model_runtime_requirements WHERE requirement = 'default_codex_engine';
  END IF;
  INSERT INTO model_runtime_requirements(model_id, requirement)
  VALUES ('gpt-6-astra', 'default_codex_engine')
  ON CONFLICT DO NOTHING;

  -- ── remap live pointers, then disable GPT-5.6 Codex rows ───────────────
  UPDATE client_sessions
     SET model_id = CASE model_id
          WHEN 'gpt-5.6-sol' THEN 'gpt-6-sol'
          WHEN 'gpt-5.6-sol-1m' THEN 'gpt-6-sol-1m'
          WHEN 'gpt-5.6-luna' THEN 'gpt-6-luna'
          WHEN 'gpt-5.6-luna-1m' THEN 'gpt-6-luna-1m'
          WHEN 'gpt-5.6-terra' THEN 'gpt-6-sol'
          WHEN 'gpt-5.6-terra-1m' THEN 'gpt-6-sol-1m'
        END
   WHERE deleted_at IS NULL
     AND model_id IN (
       'gpt-5.6-sol', 'gpt-5.6-sol-1m',
       'gpt-5.6-luna', 'gpt-5.6-luna-1m',
       'gpt-5.6-terra', 'gpt-5.6-terra-1m'
     );

  UPDATE codex_route_contexts
     SET model_id = CASE model_id
          WHEN 'gpt-5.6-sol' THEN 'gpt-6-sol'
          WHEN 'gpt-5.6-sol-1m' THEN 'gpt-6-sol-1m'
          WHEN 'gpt-5.6-luna' THEN 'gpt-6-luna'
          WHEN 'gpt-5.6-luna-1m' THEN 'gpt-6-luna-1m'
          WHEN 'gpt-5.6-terra' THEN 'gpt-6-sol'
          WHEN 'gpt-5.6-terra-1m' THEN 'gpt-6-sol-1m'
        END
   WHERE model_id IN (
     'gpt-5.6-sol', 'gpt-5.6-sol-1m',
     'gpt-5.6-luna', 'gpt-5.6-luna-1m',
     'gpt-5.6-terra', 'gpt-5.6-terra-1m'
   );

  SELECT count(*) INTO active_56
    FROM model_catalog
   WHERE state = 'active'
     AND model_id IN (
       'gpt-5.6-sol', 'gpt-5.6-sol-1m',
       'gpt-5.6-luna', 'gpt-5.6-luna-1m',
       'gpt-5.6-terra', 'gpt-5.6-terra-1m'
     );
  -- Commercial already disabled some of these six (only gpt-5.6-sol stayed
  -- active, and it is default_codex_engine). Retire whatever subset is still
  -- active, and hide pricing that is still public. An active Codex gpt-5.6
  -- id outside this set still fails. Selfhost applied the earlier all-six
  -- text; schema_migrations does not re-run this file there.
  IF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE state = 'active'
       AND engine = 'codex'
       AND model_id LIKE 'gpt-5.6-%'
       AND model_id NOT IN (
         'gpt-5.6-sol', 'gpt-5.6-sol-1m',
         'gpt-5.6-luna', 'gpt-5.6-luna-1m',
         'gpt-5.6-terra', 'gpt-5.6-terra-1m'
       )
  ) THEN
    RAISE EXCEPTION '0288 refuses an active Codex gpt-5.6 row outside Sol/Terra/Luna';
  END IF;
  IF active_56 > 0 OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id IN (
       'gpt-5.6-sol', 'gpt-5.6-sol-1m',
       'gpt-5.6-luna', 'gpt-5.6-luna-1m',
       'gpt-5.6-terra', 'gpt-5.6-terra-1m'
     )
       AND (enabled IS TRUE OR visibility <> 'hidden')
  ) THEN
    DELETE FROM account_group_models
     WHERE model_id IN (
       'gpt-5.6-sol', 'gpt-5.6-sol-1m',
       'gpt-5.6-luna', 'gpt-5.6-luna-1m',
       'gpt-5.6-terra', 'gpt-5.6-terra-1m'
     );
    FOR rec IN
      SELECT entry_id, lock_version FROM model_catalog
       WHERE state = 'active'
         AND model_id IN (
           'gpt-5.6-sol', 'gpt-5.6-sol-1m',
           'gpt-5.6-luna', 'gpt-5.6-luna-1m',
           'gpt-5.6-terra', 'gpt-5.6-terra-1m'
         )
       ORDER BY model_id
    LOOP
      PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
    END LOOP;
    UPDATE model_pricing
       SET enabled = FALSE, visibility = 'hidden', promo_label = NULL,
           lock_version = lock_version + 1, updated_at = clock_timestamp()
     WHERE model_id IN (
       'gpt-5.6-sol', 'gpt-5.6-sol-1m',
       'gpt-5.6-luna', 'gpt-5.6-luna-1m',
       'gpt-5.6-terra', 'gpt-5.6-terra-1m'
     )
       AND (enabled IS TRUE OR visibility <> 'hidden');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n < 1 THEN
      RAISE EXCEPTION '0288 expected to hide at least one GPT-5.6 pricing row, updated %', n;
    END IF;
  END IF;

  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('gpt-6-sol', 'gpt-6-sol-1m', 'gpt-6-luna', 'gpt-6-luna-1m')
         AND c.state = 'active' AND p.enabled IS TRUE AND p.visibility = 'public'
         AND p.default_effort = 'medium') <> 4 THEN
    RAISE EXCEPTION '0288 expected 4 active public GPT-6 Sol/Luna rows';
  END IF;
  IF (SELECT count(*) FROM model_catalog
       WHERE state = 'active' AND model_id LIKE 'gpt-5.6-%' AND engine = 'codex') <> 0
     OR EXISTS (
       SELECT 1 FROM model_pricing
        WHERE model_id IN (
            'gpt-5.6-sol', 'gpt-5.6-sol-1m',
            'gpt-5.6-luna', 'gpt-5.6-luna-1m',
            'gpt-5.6-terra', 'gpt-5.6-terra-1m'
          )
          AND (enabled OR visibility <> 'hidden')
     )
     OR EXISTS (
       SELECT 1 FROM client_sessions
        WHERE deleted_at IS NULL AND model_id LIKE 'gpt-5.6-%' AND model_id NOT LIKE 'cursor-%'
     )
     OR EXISTS (
       SELECT 1 FROM account_group_models
        WHERE model_id IN (
          'gpt-5.6-sol', 'gpt-5.6-sol-1m',
          'gpt-5.6-luna', 'gpt-5.6-luna-1m',
          'gpt-5.6-terra', 'gpt-5.6-terra-1m'
        )
     )
     OR NOT EXISTS (
       SELECT 1 FROM model_runtime_requirements
        WHERE model_id = 'gpt-6-astra' AND requirement = 'default_codex_engine'
     ) THEN
    RAISE EXCEPTION '0288 GPT-6 onboard / GPT-5.6 retirement postcondition failed';
  END IF;
  IF (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6-sol') <> astra_groups
     OR (SELECT count(*) FROM account_group_models WHERE model_id = 'gpt-6-luna') <> astra_groups THEN
    RAISE EXCEPTION '0288 sol/luna group bindings must match astra (%)', astra_groups;
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
