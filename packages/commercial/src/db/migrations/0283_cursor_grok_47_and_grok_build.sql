-- 0283_cursor_grok_47_and_grok_build.sql
-- order-dependency: 0281_cursor_sand_usable_families
-- Onboard Grok 4.7 (xAI 2026-09-21):
--   1. Official grok-build catalog: upstream grok-4.6 → grok-4.7, display Grok 4.7.
--      Live grok-relay GET /v1/models already lists grok-4.7 (and grok-4.7-build-fast).
--      Adapter still passes --model <upstream>; pinned CLI 1.0.5 forwards the id.
--      grok-4.7-build-fast is intentionally not catalogued (Grok Build Fast SKU stays off).
--   2. Cursor family grok-4.7: 8 rows (low/medium/high/xhigh × Fast).
--      Upstream ids are the pinned CLI --list-models literals (2026-09-22,
--      cursor-agent 2026.08.25-3e8eec8): grok-4.7-{low,medium,high,xhigh}[-fast]
--      — no `cursor-` prefix, unlike grok-4.6.
--      Canonical ids stay cursor-grok-4.7-*. Pricing/visibility/min_plan clone
--      the matching grok-4.6 sibling (Fast multiplier=2). sort_order=143 sits
--      between grok-build (142) and grok-4.6 (144).
--
-- New cursor rows born staged then activated. Fork convergence: reuse only a
-- complete, semantic-equivalent family; partial/drifted rows fail-closed.
--
-- The audit CHECK swap (DROP + ADD CONSTRAINT) trips the selfhost breaking
-- DDL gate: deploy with OC_V5_ALLOW_BREAKING_MIGRATION=1.

DO $$
DECLARE
  rec RECORD;
  actual INTEGER;
  existing INTEGER;
  grok_build_upstream TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-grok-4.6-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0283 requires active enabled cursor-grok-4.6-high floor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'grok-build' AND c.engine = 'grok' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0283 requires active enabled grok-build floor';
  END IF;

  -- ── 1. grok-build upstream 4.6 → 4.7 ────────────────────────────────
  SELECT upstream_model_id INTO grok_build_upstream
    FROM model_catalog WHERE model_id = 'grok-build' AND engine = 'grok';
  IF grok_build_upstream IS DISTINCT FROM 'grok-4.7' THEN
    IF grok_build_upstream IS DISTINCT FROM 'grok-4.6' THEN
      RAISE EXCEPTION '0283 grok-build upstream is %, expected grok-4.6 or grok-4.7', grok_build_upstream;
    END IF;
    UPDATE model_catalog
       SET upstream_model_id = 'grok-4.7'
     WHERE model_id = 'grok-build' AND engine = 'grok' AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0283 failed to retarget grok-build upstream to grok-4.7';
    END IF;
  END IF;

  UPDATE model_pricing
     SET display_name = 'Grok 4.7',
         lock_version = lock_version + 1
   WHERE model_id = 'grok-build'
     AND display_name IS DISTINCT FROM 'Grok 4.7';

  -- ── 2. Cursor Grok 4.7 family ───────────────────────────────────────
  SELECT COUNT(*) INTO existing
    FROM model_catalog
   WHERE model_id LIKE 'cursor-grok-4.7-%';
  SELECT COUNT(*) INTO actual
    FROM model_pricing
   WHERE model_id LIKE 'cursor-grok-4.7-%';
  IF existing NOT IN (0, 8) OR actual <> existing THEN
    RAISE EXCEPTION
      '0283 refuses partial imported Grok 4.7 family (catalog %, pricing %)',
      existing, actual;
  END IF;

  IF existing = 0 THEN
    FOR rec IN
      SELECT * FROM (VALUES
        ('cursor-grok-4.7-low',        'grok-4.7-low',        'Grok 4.7 Low',              'cursor-grok-4.6-low'),
        ('cursor-grok-4.7-low-fast',   'grok-4.7-low-fast',   'Grok 4.7 Low Fast',         'cursor-grok-4.6-low-fast'),
        ('cursor-grok-4.7-medium',     'grok-4.7-medium',     'Grok 4.7 Medium',           'cursor-grok-4.6-medium'),
        ('cursor-grok-4.7-medium-fast','grok-4.7-medium-fast','Grok 4.7 Medium Fast',      'cursor-grok-4.6-medium-fast'),
        ('cursor-grok-4.7-high',       'grok-4.7-high',       'Grok 4.7 High',             'cursor-grok-4.6-high'),
        ('cursor-grok-4.7-high-fast',  'grok-4.7-high-fast',  'Grok 4.7 High Fast',        'cursor-grok-4.6-high-fast'),
        ('cursor-grok-4.7-xhigh',      'grok-4.7-xhigh',      'Grok 4.7 Extra High',       'cursor-grok-4.6-xhigh'),
        ('cursor-grok-4.7-xhigh-fast', 'grok-4.7-xhigh-fast', 'Grok 4.7 Extra High Fast',  'cursor-grok-4.6-xhigh-fast')
      ) AS t(model_id, upstream_model_id, display_name, clone_from)
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
        context_window,
        capability_profile,
        capability_schema_version,
        'staged'
      FROM model_catalog
      WHERE model_id = rec.clone_from AND state = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0283 failed to clone catalog from % for %', rec.clone_from, rec.model_id;
      END IF;

      INSERT INTO model_pricing (
        model_id, display_name,
        input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
        multiplier, enabled, sort_order, visibility, extra_system_prompt,
        default_effort, lock_version, min_plan_code
      )
      SELECT
        rec.model_id,
        rec.display_name,
        input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
        multiplier, FALSE, 143, visibility, extra_system_prompt,
        default_effort, 0, min_plan_code
      FROM model_pricing
      WHERE model_id = rec.clone_from;
      IF NOT FOUND THEN
        RAISE EXCEPTION '0283 failed to clone pricing from % for %', rec.clone_from, rec.model_id;
      END IF;

      UPDATE model_catalog
         SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0283 failed to activate catalog %', rec.model_id;
      END IF;

      UPDATE model_pricing AS neu
         SET enabled = TRUE,
             visibility = baseline.visibility,
             min_plan_code = baseline.min_plan_code,
             multiplier = baseline.multiplier,
             lock_version = neu.lock_version + 1
        FROM model_pricing AS baseline
       WHERE neu.model_id = rec.model_id
         AND baseline.model_id = rec.clone_from;
      IF NOT FOUND THEN
        RAISE EXCEPTION '0283 failed to enable pricing %', rec.model_id;
      END IF;
    END LOOP;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM (VALUES
          ('cursor-grok-4.7-low',        'grok-4.7-low',        1),
          ('cursor-grok-4.7-low-fast',   'grok-4.7-low-fast',   2),
          ('cursor-grok-4.7-medium',     'grok-4.7-medium',     1),
          ('cursor-grok-4.7-medium-fast','grok-4.7-medium-fast',2),
          ('cursor-grok-4.7-high',       'grok-4.7-high',       1),
          ('cursor-grok-4.7-high-fast',  'grok-4.7-high-fast',  2),
          ('cursor-grok-4.7-xhigh',      'grok-4.7-xhigh',      1),
          ('cursor-grok-4.7-xhigh-fast', 'grok-4.7-xhigh-fast', 2)
        ) AS expected(model_id, upstream_model_id, multiplier)
        LEFT JOIN model_catalog c USING (model_id)
        LEFT JOIN model_pricing p USING (model_id)
       WHERE c.engine IS DISTINCT FROM 'cursor'
          OR c.upstream_model_id IS DISTINCT FROM expected.upstream_model_id
          OR c.state IS DISTINCT FROM 'active'
          OR p.enabled IS DISTINCT FROM TRUE
          OR p.multiplier IS DISTINCT FROM expected.multiplier::numeric
    ) THEN
      RAISE EXCEPTION '0283 refuses drifted imported Grok 4.7 family';
    END IF;
  END IF;

  -- ── 3. audit CHECK ──────────────────────────────────────────────────
  ALTER TABLE cursor_external_usage_audit
    DROP CONSTRAINT IF EXISTS cursor_external_usage_audit_model_id_check;
  ALTER TABLE cursor_external_usage_audit
    ADD CONSTRAINT cursor_external_usage_audit_model_id_check CHECK (model_id IN (
      'cursor-auto',
      'cursor-grok-4.6-low', 'cursor-grok-4.6-low-fast',
      'cursor-grok-4.6-medium', 'cursor-grok-4.6-medium-fast',
      'cursor-grok-4.6-high', 'cursor-grok-4.6-high-fast',
      'cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh-fast',
      'cursor-grok-4.7-low', 'cursor-grok-4.7-low-fast',
      'cursor-grok-4.7-medium', 'cursor-grok-4.7-medium-fast',
      'cursor-grok-4.7-high', 'cursor-grok-4.7-high-fast',
      'cursor-grok-4.7-xhigh', 'cursor-grok-4.7-xhigh-fast',
      'cursor-composer-2.5', 'cursor-composer-2.5-fast',
      'cursor-opus-4.8-low', 'cursor-opus-4.8-low-fast',
      'cursor-opus-4.8-medium', 'cursor-opus-4.8-medium-fast',
      'cursor-opus-4.8-high', 'cursor-opus-4.8-high-fast',
      'cursor-opus-4.8-xhigh', 'cursor-opus-4.8-xhigh-fast',
      'cursor-opus-4.8-max', 'cursor-opus-4.8-max-fast',
      'cursor-opus-5-low', 'cursor-opus-5-low-fast',
      'cursor-opus-5-medium', 'cursor-opus-5-medium-fast',
      'cursor-opus-5-high', 'cursor-opus-5-high-fast',
      'cursor-opus-5-xhigh', 'cursor-opus-5-xhigh-fast',
      'cursor-opus-5-max', 'cursor-opus-5-max-fast',
      'cursor-fable-5-low', 'cursor-fable-5-medium', 'cursor-fable-5-high',
      'cursor-fable-5-xhigh', 'cursor-fable-5-max',
      'cursor-fable-5.1-low', 'cursor-fable-5.1-medium', 'cursor-fable-5.1-high',
      'cursor-fable-5.1-xhigh', 'cursor-fable-5.1-max',
      'cursor-sonnet-5-low', 'cursor-sonnet-5-medium', 'cursor-sonnet-5-high',
      'cursor-sonnet-5-xhigh', 'cursor-sonnet-5-max',
      'cursor-gemini-3.8-flash-low', 'cursor-gemini-3.8-flash-medium', 'cursor-gemini-3.8-flash-high',
      'cursor-gemini-3.1-pro',
      'cursor-grok-4.5-high',
      'cursor-haiku-4.5',
      'cursor-gpt-5.6-luna-low', 'cursor-gpt-5.6-luna-low-fast',
      'cursor-gpt-5.6-luna-medium', 'cursor-gpt-5.6-luna-medium-fast',
      'cursor-gpt-5.6-luna-high', 'cursor-gpt-5.6-luna-high-fast',
      'cursor-gpt-5.6-luna-xhigh', 'cursor-gpt-5.6-luna-xhigh-fast',
      'cursor-gpt-5.6-luna-max', 'cursor-gpt-5.6-luna-max-fast'
    ));

  -- ── postconditions ────────────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'grok-build' AND c.engine = 'grok' AND c.state = 'active'
       AND c.upstream_model_id = 'grok-4.7' AND p.enabled IS TRUE
       AND p.display_name = 'Grok 4.7'
  ) THEN
    RAISE EXCEPTION '0283 grok-build must be active grok-4.7 / display Grok 4.7';
  END IF;

  SELECT COUNT(*) INTO actual
    FROM model_catalog c JOIN model_pricing p USING (model_id)
   WHERE c.model_id LIKE 'cursor-grok-4.7-%'
     AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE AND p.visibility = 'public';
  IF actual <> 8 THEN
    RAISE EXCEPTION '0283 expected 8 active public Grok 4.7 rows, got %', actual;
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = ANY(ARRAY[
       'cursor-grok-4.7-low-fast','cursor-grok-4.7-medium-fast',
       'cursor-grok-4.7-high-fast','cursor-grok-4.7-xhigh-fast'
     ]) AND multiplier <> 2
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = ANY(ARRAY[
       'cursor-grok-4.7-low','cursor-grok-4.7-medium',
       'cursor-grok-4.7-high','cursor-grok-4.7-xhigh'
     ]) AND multiplier <> 1
  ) THEN
    RAISE EXCEPTION '0283 Grok 4.7 Fast rows must keep multiplier=2, non-Fast multiplier=1';
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id LIKE 'cursor-grok-4.7-%'
  ) THEN
    RAISE EXCEPTION '0283 must not create Grok 4.7 visibility grants';
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id IN ('grok-4.7-build-fast', 'grok-build-fast')
  ) THEN
    RAISE EXCEPTION '0283 must not catalogue Grok Build Fast';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
