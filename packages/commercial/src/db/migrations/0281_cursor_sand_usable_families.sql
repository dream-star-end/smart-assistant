-- 0281_cursor_sand_usable_families.sql
-- order-dependency: 0280_cursor_haiku_45
-- Wire Cursor Sand families that probed PASS on 2026-09-17 (account 15, Box
-- InferenceService/Stream, evidence generated/cursor-sand-model-matrix-20260917.md):
--   * Grok 4.6 — already active; flip visibility admin → public so the picker
--     is not admin-gated.
--   * Composer 2.5 — re-enable disabled+hidden rows as public.
--   * Haiku 4.5 — already public/active; 0280 deferred the web-chat audit CHECK.
--   * GPT-5.6 Luna Sand — new family (10 rows, low..max × fast). Canonical ids
--     are cursor-gpt-5.6-luna-*; family id gpt-5.6-luna-sand so family-level
--     public ids cannot collide with Codex gpt-5.6-luna.
--   * Gemini 3.1 Pro — new single-tier row (no effort/Fast).
--
-- Pricing: Luna clones Grok 4.6 High / High Fast (0269 fitted USD); Gemini 3.1
-- Pro clones Gemini 3.8 Flash High. Fast multiplier stays 2. No 1M twins.
-- Visibility/min_plan clone the public Gemini 3.8 Flash High floor.
--
-- New catalog rows are born staged then activated. The audit CHECK swap
-- (DROP + ADD CONSTRAINT) trips the selfhost breaking DDL gate: deploy with
-- OC_V5_ALLOW_BREAKING_MIGRATION=1.

DO $$
DECLARE
  rec RECORD;
  actual INTEGER;
  existing INTEGER;
  luna_ids TEXT[] := ARRAY[
    'cursor-gpt-5.6-luna-low',
    'cursor-gpt-5.6-luna-low-fast',
    'cursor-gpt-5.6-luna-medium',
    'cursor-gpt-5.6-luna-medium-fast',
    'cursor-gpt-5.6-luna-high',
    'cursor-gpt-5.6-luna-high-fast',
    'cursor-gpt-5.6-luna-xhigh',
    'cursor-gpt-5.6-luna-xhigh-fast',
    'cursor-gpt-5.6-luna-max',
    'cursor-gpt-5.6-luna-max-fast'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-grok-4.6-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0281 requires active enabled cursor-grok-4.6-high floor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-gemini-3.8-flash-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0281 requires active enabled cursor-gemini-3.8-flash-high floor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-haiku-4.5' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0281 requires active enabled cursor-haiku-4.5 (0280)';
  END IF;

  -- ── 1. Grok 4.6: public picker ────────────────────────────────────────
  UPDATE model_pricing
     SET visibility = 'public',
         lock_version = lock_version + 1
   WHERE model_id LIKE 'cursor-grok-4.6-%'
     AND visibility IS DISTINCT FROM 'public';

  -- ── 2. Composer 2.5: re-enable ────────────────────────────────────────
  UPDATE model_catalog
     SET state = 'active'
   WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
     AND state = 'disabled';
  UPDATE model_pricing
     SET enabled = TRUE,
         visibility = 'public',
         lock_version = lock_version + 1
   WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast')
     AND (enabled IS DISTINCT FROM TRUE OR visibility IS DISTINCT FROM 'public');

  -- ── 3. GPT-5.6 Luna Sand ──────────────────────────────────────────────
  SELECT COUNT(*) INTO existing FROM model_catalog WHERE model_id = ANY(luna_ids);
  SELECT COUNT(*) INTO actual FROM model_pricing WHERE model_id = ANY(luna_ids);
  IF existing NOT IN (0, 10) OR actual <> existing THEN
    RAISE EXCEPTION
      '0281 refuses partial imported Luna Sand family (catalog %, pricing %)',
      existing, actual;
  END IF;

  IF existing = 0 THEN
    FOR rec IN
      SELECT * FROM (VALUES
        ('cursor-gpt-5.6-luna-low',        'gpt-5.6-luna-low',        'GPT-5.6 Luna Low',              'cursor-grok-4.6-high',      161),
        ('cursor-gpt-5.6-luna-low-fast',   'gpt-5.6-luna-low-fast',   'GPT-5.6 Luna Low Fast',         'cursor-grok-4.6-high-fast', 161),
        ('cursor-gpt-5.6-luna-medium',     'gpt-5.6-luna-medium',     'GPT-5.6 Luna Medium',           'cursor-grok-4.6-high',      161),
        ('cursor-gpt-5.6-luna-medium-fast','gpt-5.6-luna-medium-fast','GPT-5.6 Luna Medium Fast',      'cursor-grok-4.6-high-fast', 161),
        ('cursor-gpt-5.6-luna-high',       'gpt-5.6-luna-high',       'GPT-5.6 Luna High',             'cursor-grok-4.6-high',      161),
        ('cursor-gpt-5.6-luna-high-fast',  'gpt-5.6-luna-high-fast',  'GPT-5.6 Luna High Fast',        'cursor-grok-4.6-high-fast', 161),
        ('cursor-gpt-5.6-luna-xhigh',      'gpt-5.6-luna-xhigh',      'GPT-5.6 Luna Extra High',       'cursor-grok-4.6-high',      161),
        ('cursor-gpt-5.6-luna-xhigh-fast', 'gpt-5.6-luna-xhigh-fast', 'GPT-5.6 Luna Extra High Fast',  'cursor-grok-4.6-high-fast', 161),
        ('cursor-gpt-5.6-luna-max',        'gpt-5.6-luna-max',        'GPT-5.6 Luna Max',              'cursor-grok-4.6-high',      161),
        ('cursor-gpt-5.6-luna-max-fast',   'gpt-5.6-luna-max-fast',   'GPT-5.6 Luna Max Fast',         'cursor-grok-4.6-high-fast', 161)
      ) AS t(model_id, upstream_model_id, display_name, price_src, sort_order)
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
      WHERE model_id = rec.price_src AND state = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0281 failed to clone catalog from % for %', rec.price_src, rec.model_id;
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
        multiplier, FALSE, rec.sort_order, 'public', extra_system_prompt,
        default_effort, 0, min_plan_code
      FROM model_pricing
      WHERE model_id = rec.price_src;
      IF NOT FOUND THEN
        RAISE EXCEPTION '0281 failed to clone pricing from % for %', rec.price_src, rec.model_id;
      END IF;

      UPDATE model_catalog SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0281 failed to activate catalog %', rec.model_id;
      END IF;

      UPDATE model_pricing
         SET enabled = TRUE, visibility = 'public', lock_version = lock_version + 1
       WHERE model_id = rec.model_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION '0281 failed to enable pricing %', rec.model_id;
      END IF;
    END LOOP;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM (VALUES
          ('cursor-gpt-5.6-luna-low', 'gpt-5.6-luna-low', 1),
          ('cursor-gpt-5.6-luna-low-fast', 'gpt-5.6-luna-low-fast', 2),
          ('cursor-gpt-5.6-luna-medium', 'gpt-5.6-luna-medium', 1),
          ('cursor-gpt-5.6-luna-medium-fast', 'gpt-5.6-luna-medium-fast', 2),
          ('cursor-gpt-5.6-luna-high', 'gpt-5.6-luna-high', 1),
          ('cursor-gpt-5.6-luna-high-fast', 'gpt-5.6-luna-high-fast', 2),
          ('cursor-gpt-5.6-luna-xhigh', 'gpt-5.6-luna-xhigh', 1),
          ('cursor-gpt-5.6-luna-xhigh-fast', 'gpt-5.6-luna-xhigh-fast', 2),
          ('cursor-gpt-5.6-luna-max', 'gpt-5.6-luna-max', 1),
          ('cursor-gpt-5.6-luna-max-fast', 'gpt-5.6-luna-max-fast', 2)
        ) AS expected(model_id, upstream_model_id, multiplier)
        LEFT JOIN model_catalog c USING (model_id)
        LEFT JOIN model_pricing p USING (model_id)
       WHERE c.engine IS DISTINCT FROM 'cursor'
          OR c.upstream_model_id IS DISTINCT FROM expected.upstream_model_id
          OR c.state IS DISTINCT FROM 'active'
          OR p.enabled IS DISTINCT FROM TRUE
          OR p.multiplier IS DISTINCT FROM expected.multiplier::numeric
    ) THEN
      RAISE EXCEPTION '0281 refuses drifted imported Luna Sand family';
    END IF;
  END IF;

  -- ── 4. Gemini 3.1 Pro ─────────────────────────────────────────────────
  SELECT COUNT(*) INTO existing FROM model_catalog WHERE model_id = 'cursor-gemini-3.1-pro';
  IF existing = 0 THEN
    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT
      'cursor-gemini-3.1-pro',
      engine,
      provider_id,
      'gemini-3.1-pro',
      context_window,
      capability_profile,
      capability_schema_version,
      'staged'
    FROM model_catalog
    WHERE model_id = 'cursor-gemini-3.8-flash-high' AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0281 failed to clone catalog from cursor-gemini-3.8-flash-high';
    END IF;

    INSERT INTO model_pricing (
      model_id, display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier, enabled, sort_order, visibility, extra_system_prompt,
      default_effort, lock_version, min_plan_code
    )
    SELECT
      'cursor-gemini-3.1-pro',
      'Gemini 3.1 Pro',
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      1, FALSE, 162, 'public', extra_system_prompt,
      default_effort, 0, min_plan_code
    FROM model_pricing
    WHERE model_id = 'cursor-gemini-3.8-flash-high';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0281 failed to clone pricing from cursor-gemini-3.8-flash-high';
    END IF;

    UPDATE model_catalog SET state = 'active'
     WHERE model_id = 'cursor-gemini-3.1-pro' AND state = 'staged';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0281 failed to activate catalog cursor-gemini-3.1-pro';
    END IF;

    UPDATE model_pricing
       SET enabled = TRUE, visibility = 'public', lock_version = lock_version + 1
     WHERE model_id = 'cursor-gemini-3.1-pro';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0281 failed to enable pricing cursor-gemini-3.1-pro';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM model_catalog c
        LEFT JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'cursor-gemini-3.1-pro'
         AND (c.engine IS DISTINCT FROM 'cursor'
           OR c.upstream_model_id IS DISTINCT FROM 'gemini-3.1-pro'
           OR c.state IS DISTINCT FROM 'active'
           OR p.enabled IS DISTINCT FROM TRUE
           OR p.multiplier IS DISTINCT FROM 1::numeric)
    ) THEN
      RAISE EXCEPTION '0281 refuses drifted pre-existing cursor-gemini-3.1-pro row';
    END IF;
  END IF;

  -- ── 5. audit CHECK (includes 0280 Haiku, previously deferred) ─────────
  ALTER TABLE cursor_external_usage_audit
    DROP CONSTRAINT IF EXISTS cursor_external_usage_audit_model_id_check;
  ALTER TABLE cursor_external_usage_audit
    ADD CONSTRAINT cursor_external_usage_audit_model_id_check CHECK (model_id IN (
      'cursor-auto',
      'cursor-grok-4.6-low', 'cursor-grok-4.6-low-fast',
      'cursor-grok-4.6-medium', 'cursor-grok-4.6-medium-fast',
      'cursor-grok-4.6-high', 'cursor-grok-4.6-high-fast',
      'cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh-fast',
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
  SELECT COUNT(*) INTO actual
    FROM model_catalog c JOIN model_pricing p USING (model_id)
   WHERE c.model_id = ANY(luna_ids)
     AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE AND p.visibility = 'public';
  IF actual <> 10 THEN
    RAISE EXCEPTION '0281 expected 10 active public Luna Sand rows, got %', actual;
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = ANY(ARRAY[
       'cursor-gpt-5.6-luna-low-fast','cursor-gpt-5.6-luna-medium-fast',
       'cursor-gpt-5.6-luna-high-fast','cursor-gpt-5.6-luna-xhigh-fast',
       'cursor-gpt-5.6-luna-max-fast'
     ]) AND multiplier <> 2
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = ANY(ARRAY[
       'cursor-gpt-5.6-luna-low','cursor-gpt-5.6-luna-medium',
       'cursor-gpt-5.6-luna-high','cursor-gpt-5.6-luna-xhigh',
       'cursor-gpt-5.6-luna-max'
     ]) AND multiplier <> 1
  ) THEN
    RAISE EXCEPTION '0281 Luna Fast rows must keep multiplier=2, non-Fast multiplier=1';
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id = ANY(luna_ids) OR model_id = 'cursor-gemini-3.1-pro'
  ) THEN
    RAISE EXCEPTION '0281 must not create visibility grants';
  END IF;
  IF (SELECT COUNT(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('cursor-composer-2.5','cursor-composer-2.5-fast')
         AND c.state = 'active' AND p.enabled IS TRUE AND p.visibility = 'public') <> 2 THEN
    RAISE EXCEPTION '0281 Composer 2.5 must be active public enabled';
  END IF;
  IF (SELECT COUNT(*) FROM model_pricing
       WHERE model_id LIKE 'cursor-grok-4.6-%' AND visibility = 'public') <> 8 THEN
    RAISE EXCEPTION '0281 Grok 4.6 family must be public';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-gemini-3.1-pro' AND c.state = 'active'
       AND p.enabled IS TRUE AND p.visibility = 'public' AND p.multiplier = 1
  ) THEN
    RAISE EXCEPTION '0281 Gemini 3.1 Pro must be active public enabled';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
