-- 0284_grok_build_fast_retire_grok_46.sql
-- order-dependency: 0283_cursor_grok_47_and_grok_build
-- 1. Official Grok Build Fast: catalog id grok-build-fast, upstream
--    grok-4.7-build-fast (relay model list). Same per-MTok as grok-build,
--    multiplier = grok-build.multiplier * 2 (official Fast is 2x token rates;
--    grok-build already carries multiplier 2).
-- 2. Retire Cursor Grok 4.6. Live sessions remap onto the 4.7 twin
--    (cursor-grok-4.6-high-fast → cursor-grok-4.7-high-fast). Catalog
--    disabled, pricing hidden. Cursor Grok 4.7 stays.

DO $$
DECLARE
  rec RECORD;
  n INTEGER;
  fast_existing INTEGER;
  active_46 INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'grok-build' AND c.engine = 'grok' AND c.state = 'active'
       AND c.upstream_model_id = 'grok-4.7' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0284 requires active enabled grok-build on grok-4.7';
  END IF;
  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id LIKE 'cursor-grok-4.7-%' AND c.state = 'active' AND p.enabled IS TRUE) <> 8 THEN
    RAISE EXCEPTION '0284 requires 8 active enabled Cursor Grok 4.7 rows';
  END IF;

  SELECT count(*) INTO fast_existing FROM model_catalog WHERE model_id = 'grok-build-fast';
  IF fast_existing = 0 THEN
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT
      'grok-build-fast', engine, provider_id, 'grok-4.7-build-fast', context_window,
      capability_profile, capability_schema_version, 'staged'
    FROM model_catalog
    WHERE model_id = 'grok-build' AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0284 failed to clone grok-build catalog';
    END IF;

    INSERT INTO model_pricing (
      model_id, display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier, enabled, sort_order, visibility, extra_system_prompt,
      default_effort, lock_version, min_plan_code
    )
    SELECT
      'grok-build-fast', 'Grok 4.7 Fast',
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier * 2, FALSE, 141, visibility, extra_system_prompt,
      default_effort, 0, min_plan_code
    FROM model_pricing
    WHERE model_id = 'grok-build';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0284 failed to clone grok-build pricing';
    END IF;

    UPDATE model_catalog SET state = 'active'
     WHERE model_id = 'grok-build-fast' AND state = 'staged';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0284 failed to activate grok-build-fast';
    END IF;

    UPDATE model_pricing
       SET enabled = TRUE, lock_version = lock_version + 1
     WHERE model_id = 'grok-build-fast';

    INSERT INTO account_group_models(group_id, model_id)
    SELECT group_id, 'grok-build-fast'
      FROM account_group_models
     WHERE model_id = 'grok-build'
    ON CONFLICT DO NOTHING;
  ELSIF EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'grok-build-fast'
       AND (c.engine IS DISTINCT FROM 'grok'
         OR c.upstream_model_id IS DISTINCT FROM 'grok-4.7-build-fast'
         OR c.state IS DISTINCT FROM 'active'
         OR p.enabled IS DISTINCT FROM TRUE
         OR p.display_name IS DISTINCT FROM 'Grok 4.7 Fast')
  ) THEN
    RAISE EXCEPTION '0284 refuses drifted grok-build-fast row';
  END IF;

  SELECT count(*) INTO active_46
    FROM model_catalog
   WHERE model_id LIKE 'cursor-grok-4.6-%' AND state = 'active';

  IF active_46 = 8 THEN
    IF EXISTS (
      SELECT 1 FROM client_sessions
       WHERE deleted_at IS NULL AND model_id LIKE 'cursor-grok-4.6-%'
         AND replace(model_id, 'cursor-grok-4.6-', 'cursor-grok-4.7-') NOT IN (
           SELECT model_id FROM model_catalog
            WHERE model_id LIKE 'cursor-grok-4.7-%' AND state = 'active'
         )
    ) THEN
      RAISE EXCEPTION '0284 refuses: a pinned Grok 4.6 session has no active 4.7 twin';
    END IF;

    UPDATE client_sessions
       SET model_id = replace(model_id, 'cursor-grok-4.6-', 'cursor-grok-4.7-')
     WHERE deleted_at IS NULL AND model_id LIKE 'cursor-grok-4.6-%';

    DELETE FROM account_group_models WHERE model_id LIKE 'cursor-grok-4.6-%';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 8 THEN
      RAISE EXCEPTION '0284 expected to drop 8 Grok 4.6 group bindings, dropped %', n;
    END IF;

    FOR rec IN
      SELECT entry_id, lock_version FROM model_catalog
       WHERE model_id LIKE 'cursor-grok-4.6-%' AND state = 'active'
       ORDER BY model_id
    LOOP
      PERFORM fn_model_disable_entry(rec.entry_id, rec.lock_version, NULL);
    END LOOP;

    UPDATE model_pricing
       SET enabled = FALSE, visibility = 'hidden', promo_label = NULL,
           lock_version = lock_version + 1, updated_at = clock_timestamp()
     WHERE model_id LIKE 'cursor-grok-4.6-%';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 8 THEN
      RAISE EXCEPTION '0284 expected to hide 8 Grok 4.6 pricing rows, updated %', n;
    END IF;
  ELSIF active_46 <> 0 THEN
    RAISE EXCEPTION '0284 refuses partial Grok 4.6 retirement (active %)', active_46;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'grok-build-fast' AND c.state = 'active'
       AND c.upstream_model_id = 'grok-4.7-build-fast' AND p.enabled IS TRUE
       AND p.multiplier = (
         SELECT multiplier * 2 FROM model_pricing WHERE model_id = 'grok-build'
       )
  ) THEN
    RAISE EXCEPTION '0284 grok-build-fast must be active at 2x grok-build multiplier';
  END IF;
  IF (SELECT count(*) FROM model_catalog WHERE model_id LIKE 'cursor-grok-4.6-%' AND state = 'active') <> 0
     OR (SELECT count(*) FROM model_pricing WHERE model_id LIKE 'cursor-grok-4.6-%' AND (enabled OR visibility <> 'hidden')) <> 0
     OR EXISTS (SELECT 1 FROM client_sessions WHERE deleted_at IS NULL AND model_id LIKE 'cursor-grok-4.6-%')
     OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id LIKE 'cursor-grok-4.6-%') THEN
    RAISE EXCEPTION '0284 Grok 4.6 retirement postcondition failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM account_group_models WHERE model_id = 'grok-build-fast'
  ) THEN
    RAISE EXCEPTION '0284 grok-build-fast must join the grok account group';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
