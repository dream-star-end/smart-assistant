-- order-dependency: 0262_cursor_sand_usage_columns
-- 0263_gpt6_astra_and_luna_public.sql
-- (1) Add GPT-6-Astra (Codex CLI 0.153.3 embedded slug `gpt-6-astra`,
--     minimal_client_version 0.153.0) as a Codex engine model with a 1M twin,
--     cloned from live GPT-5.6 Sol. Product decision 2026-09-05:
--       * standard tier fen  = Sol standard tier × 2 (all four dimensions)
--       * 1M tier fen        = ceil(Astra standard × 1.5)  (0238 long-context contract)
--       * sort_order         = Sol sort_order - 1 (picker top; Sol keeps
--                              default_codex_engine / team-leader duty)
--       * default_effort     = xhigh (Sol parity; protocol CODEX_ENGINE_MODELS agrees)
--       * visibility / min_plan_code / extra_system_prompt clone Sol
--       * capability_profile clones Sol (reasoning five tiers + codex_model_default
--         xhigh); context_window NULL for standard (Codex self-managed), 1000000 for 1M
--     Codex account groups (api_relay / official_oauth, provider=codex) that bind
--     gpt-5.6-sol also bind gpt-6-astra — the OAuth route lookup keys on the
--     canonical standard id (the 1M twin is never a group key; see 0223).
-- (2) GPT-5.6 Luna: 0183 activated Luna hidden and deferred public visibility to a
--     later admin step. Product decision 2026-09-05: Luna (+1M twin) goes public
--     so it can live inside the picker's collapsed "更多 GPT 模型" group next to
--     Terra. Prices untouched.
--
-- New rows are born staged then activated (catalog trigger contract). No
-- visibility grants are created for Astra (visibility is inherited from Sol).
-- Historical usage_records snapshots are not rewritten.
--
-- Rollback: disable Astra rows via admin (soft retire; catalog rows are
-- append-only history) and set Luna visibility back to 'hidden'.
-- Replay is refused (pre-existing Astra rows raise).

DO $$
DECLARE
  rec RECORD;
  sol_pricing model_pricing%ROWTYPE;
  sol_sort INTEGER;
  group_expected INTEGER;
  group_actual INTEGER;
BEGIN
  -- ── preconditions (fail-closed) ─────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-5.6-sol' AND c.engine = 'codex' AND c.provider_id = 'codex'
       AND c.state = 'active' AND p.enabled IS TRUE AND p.multiplier = 1
  ) THEN
    RAISE EXCEPTION '0263 requires active enabled multiplier=1 gpt-5.6-sol floor';
  END IF;

  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id IN ('gpt-6-astra', 'gpt-6-astra-1m'))
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id IN ('gpt-6-astra', 'gpt-6-astra-1m')) THEN
    RAISE EXCEPTION '0263 refuses pre-existing gpt-6-astra rows (no replay)';
  END IF;

  IF (SELECT count(*) FROM model_pricing WHERE model_id IN ('gpt-5.6-luna', 'gpt-5.6-luna-1m')) <> 2 THEN
    RAISE EXCEPTION '0263 requires both gpt-5.6-luna pricing rows';
  END IF;

  SELECT * INTO STRICT sol_pricing FROM model_pricing WHERE model_id = 'gpt-5.6-sol';
  sol_sort := sol_pricing.sort_order;

  IF sol_pricing.input_per_mtok > 4611686018427387903
     OR sol_pricing.output_per_mtok > 4611686018427387903
     OR sol_pricing.cache_read_per_mtok > 4611686018427387903
     OR sol_pricing.cache_write_per_mtok > 4611686018427387903 THEN
    RAISE EXCEPTION '0263 refuses BIGINT overflow computing Sol x2';
  END IF;
  IF sol_pricing.input_per_mtok < 0 OR sol_pricing.output_per_mtok < 0
     OR sol_pricing.cache_read_per_mtok < 0 OR sol_pricing.cache_write_per_mtok < 0 THEN
    RAISE EXCEPTION '0263 refuses negative Sol prices';
  END IF;

  -- ── Astra standard + 1M ─────────────────────────────────────────────────
  FOR rec IN
    SELECT * FROM (VALUES
      ('gpt-6-astra',    NULL::TEXT,     NULL::INTEGER, FALSE),
      ('gpt-6-astra-1m', 'gpt-6-astra',  1000000,       TRUE)
    ) AS t(model_id, upstream_model_id, context_window, is_long)
  LOOP
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT
      rec.model_id,
      engine,
      provider_id,
      rec.upstream_model_id,
      rec.context_window,
      capability_profile,
      capability_schema_version,
      'staged'
    FROM model_catalog
    WHERE model_id = 'gpt-5.6-sol' AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0263 failed to clone catalog from gpt-5.6-sol for %', rec.model_id;
    END IF;

    INSERT INTO model_pricing (
      model_id, display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier, enabled, sort_order, visibility, extra_system_prompt,
      default_effort, lock_version, min_plan_code
    )
    VALUES (
      rec.model_id,
      'GPT-6-Astra',
      CASE WHEN rec.is_long
           THEN ((sol_pricing.input_per_mtok * 2) * 3 + 1) / 2
           ELSE sol_pricing.input_per_mtok * 2 END,
      CASE WHEN rec.is_long
           THEN ((sol_pricing.output_per_mtok * 2) * 3 + 1) / 2
           ELSE sol_pricing.output_per_mtok * 2 END,
      CASE WHEN rec.is_long
           THEN ((sol_pricing.cache_read_per_mtok * 2) * 3 + 1) / 2
           ELSE sol_pricing.cache_read_per_mtok * 2 END,
      CASE WHEN rec.is_long
           THEN ((sol_pricing.cache_write_per_mtok * 2) * 3 + 1) / 2
           ELSE sol_pricing.cache_write_per_mtok * 2 END,
      1, FALSE, sol_sort - 1, sol_pricing.visibility, sol_pricing.extra_system_prompt,
      'xhigh', 0, sol_pricing.min_plan_code
    );

    UPDATE model_catalog
       SET state = 'active'
     WHERE model_id = rec.model_id AND state = 'staged';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0263 failed to activate catalog %', rec.model_id;
    END IF;

    UPDATE model_pricing
       SET enabled = TRUE,
           lock_version = lock_version + 1
     WHERE model_id = rec.model_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0263 failed to enable pricing %', rec.model_id;
    END IF;
  END LOOP;

  -- Codex account groups: bind Astra wherever Sol is bound (standard id only).
  SELECT count(*) INTO group_expected
    FROM account_group_models gm JOIN account_groups g ON g.id = gm.group_id
   WHERE gm.model_id = 'gpt-5.6-sol' AND g.provider = 'codex';
  INSERT INTO account_group_models (group_id, model_id)
  SELECT gm.group_id, 'gpt-6-astra'
    FROM account_group_models gm JOIN account_groups g ON g.id = gm.group_id
   WHERE gm.model_id = 'gpt-5.6-sol' AND g.provider = 'codex'
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO group_actual
    FROM account_group_models WHERE model_id = 'gpt-6-astra';
  IF group_actual <> group_expected THEN
    RAISE EXCEPTION '0263 expected % codex group bindings for gpt-6-astra, got %',
      group_expected, group_actual;
  END IF;

  -- ── Luna public ─────────────────────────────────────────────────────────
  UPDATE model_pricing
     SET visibility = 'public',
         lock_version = lock_version + 1,
         updated_at = clock_timestamp()
   WHERE model_id IN ('gpt-5.6-luna', 'gpt-5.6-luna-1m')
     AND visibility IS DISTINCT FROM 'public';
  -- idempotent on visibility only; row presence already asserted above.

  -- ── postconditions ──────────────────────────────────────────────────────
  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('gpt-6-astra', 'gpt-6-astra-1m')
         AND c.engine = 'codex' AND c.provider_id = 'codex'
         AND c.state = 'active' AND p.enabled IS TRUE
         AND p.multiplier = 1 AND p.default_effort = 'xhigh'
         AND p.display_name = 'GPT-6-Astra'
         AND p.sort_order = sol_sort - 1
         AND p.visibility = sol_pricing.visibility
         AND p.min_plan_code IS NOT DISTINCT FROM sol_pricing.min_plan_code) <> 2 THEN
    RAISE EXCEPTION '0263 expected 2 active enabled Astra rows matching Sol policy';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'gpt-6-astra' AND state = 'active'
       AND upstream_model_id IS NULL AND context_window IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'gpt-6-astra-1m' AND state = 'active'
       AND upstream_model_id = 'gpt-6-astra' AND context_window = 1000000
  ) THEN
    RAISE EXCEPTION '0263 Astra catalog descriptor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_pricing a, model_pricing s
     WHERE a.model_id = 'gpt-6-astra' AND s.model_id = 'gpt-5.6-sol'
       AND a.input_per_mtok = s.input_per_mtok * 2
       AND a.output_per_mtok = s.output_per_mtok * 2
       AND a.cache_read_per_mtok = s.cache_read_per_mtok * 2
       AND a.cache_write_per_mtok = s.cache_write_per_mtok * 2
  ) THEN
    RAISE EXCEPTION '0263 Astra standard tier is not Sol x2';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_pricing l, model_pricing a
     WHERE l.model_id = 'gpt-6-astra-1m' AND a.model_id = 'gpt-6-astra'
       AND l.input_per_mtok = (a.input_per_mtok * 3 + 1) / 2
       AND l.output_per_mtok = (a.output_per_mtok * 3 + 1) / 2
       AND l.cache_read_per_mtok = (a.cache_read_per_mtok * 3 + 1) / 2
       AND l.cache_write_per_mtok = (a.cache_write_per_mtok * 3 + 1) / 2
  ) THEN
    RAISE EXCEPTION '0263 Astra 1M tier is not 1.5x of Astra standard';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing s
     WHERE s.model_id = 'gpt-5.6-sol'
       AND (s.input_per_mtok <> sol_pricing.input_per_mtok
            OR s.output_per_mtok <> sol_pricing.output_per_mtok
            OR s.cache_read_per_mtok <> sol_pricing.cache_read_per_mtok
            OR s.cache_write_per_mtok <> sol_pricing.cache_write_per_mtok
            OR s.sort_order <> sol_sort)
  ) THEN
    RAISE EXCEPTION '0263 Sol row drifted during migration';
  END IF;

  IF (SELECT count(*) FROM model_pricing
       WHERE model_id IN ('gpt-5.6-luna', 'gpt-5.6-luna-1m') AND visibility = 'public') <> 2 THEN
    RAISE EXCEPTION '0263 Luna rows must both be public';
  END IF;

  IF EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id LIKE 'gpt-6-astra%') THEN
    RAISE EXCEPTION '0263 must not create Astra grants (visibility clones Sol)';
  END IF;

  -- visibility flips live in model_pricing (no catalog state change) → bump explicitly.
  PERFORM fn_model_security_epoch_bump();
END $$;
