-- order-dependency: 0258_cursor_opus_fable_context_1m
-- 0259_cursor_gemini_38_flash.sql
-- Add Cursor Gemini 3.8 Flash as a picker family, cloned from live Grok 4.6.
-- Upstream ids are the pinned CLI variants from `cursor-agent --list-models`
-- (2026-09-04):
--   gemini-3.8-flash-{low,medium,high}
-- Canonical ids stay composed (effort only). The CLI exposes no Fast, xhigh
-- or max variant for Gemini 3.8 Flash, so none are catalogued. Other Gemini
-- generations in the CLI (3.7 / 3.6 / 3.5 / 3 Flash, 3.1 Pro) are out of scope.
--
-- Pricing / visibility / min_plan / context_window clone cursor-grok-4.6-high
-- (product decision 2026-09-04: same fen tier as Cursor Grok 4.6, public,
-- ungated). multiplier stays 1 (no Fast rows). Selfhost profile inserts no
-- grants; visibility comes from the clone.
--
-- New rows are born staged then activated (catalog trigger contract).
--
-- Fork convergence: a sibling fork may already have created the exact
-- Gemini 3.8 Flash family. Reuse only a complete, semantic-equivalent family;
-- partial/drifted rows remain fail-closed.
--
-- The audit CHECK swap (DROP + ADD CONSTRAINT) trips the selfhost breaking
-- DDL gate: deploy with OC_V5_ALLOW_BREAKING_MIGRATION=1.

DO $$
DECLARE
  rec RECORD;
  actual INTEGER;
  existing INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-grok-4.6-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0259 requires active enabled cursor-grok-4.6-high floor';
  END IF;

  SELECT COUNT(*) INTO existing
    FROM model_catalog
   WHERE model_id LIKE 'cursor-gemini-3.8-flash-%';
  SELECT COUNT(*) INTO actual
    FROM model_pricing
   WHERE model_id LIKE 'cursor-gemini-3.8-flash-%';
  IF existing NOT IN (0, 3) OR actual <> existing THEN
    RAISE EXCEPTION
      '0259 cursor fork refuses partial imported Gemini 3.8 Flash family (catalog %, pricing %)',
      existing, actual;
  END IF;

  IF existing = 0 THEN
    FOR rec IN
      SELECT * FROM (VALUES
        ('cursor-gemini-3.8-flash-low', 'gemini-3.8-flash-low', 'Gemini 3.8 Flash Low'),
        ('cursor-gemini-3.8-flash-medium', 'gemini-3.8-flash-medium', 'Gemini 3.8 Flash Medium'),
        ('cursor-gemini-3.8-flash-high', 'gemini-3.8-flash-high', 'Gemini 3.8 Flash High')
      ) AS t(model_id, upstream_model_id, display_name)
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
      WHERE model_id = 'cursor-grok-4.6-high' AND state = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0259 failed to clone catalog from cursor-grok-4.6-high for %', rec.model_id;
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
        1, FALSE, sort_order, visibility, extra_system_prompt,
        default_effort, 0, min_plan_code
      FROM model_pricing
      WHERE model_id = 'cursor-grok-4.6-high';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0259 failed to clone pricing from cursor-grok-4.6-high for %', rec.model_id;
      END IF;

      UPDATE model_catalog
         SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0259 failed to activate catalog %', rec.model_id;
      END IF;

      UPDATE model_pricing AS neu
         SET enabled = TRUE,
             visibility = baseline.visibility,
             min_plan_code = baseline.min_plan_code,
             lock_version = neu.lock_version + 1
        FROM model_pricing AS baseline
       WHERE neu.model_id = rec.model_id
         AND baseline.model_id = 'cursor-grok-4.6-high';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0259 failed to enable pricing %', rec.model_id;
      END IF;
    END LOOP;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM (VALUES
          ('cursor-gemini-3.8-flash-low', 'gemini-3.8-flash-low'),
          ('cursor-gemini-3.8-flash-medium', 'gemini-3.8-flash-medium'),
          ('cursor-gemini-3.8-flash-high', 'gemini-3.8-flash-high')
        ) AS expected(model_id, upstream_model_id)
        LEFT JOIN model_catalog c USING (model_id)
        LEFT JOIN model_pricing p USING (model_id)
       WHERE c.engine IS DISTINCT FROM 'cursor'
          OR c.upstream_model_id IS DISTINCT FROM expected.upstream_model_id
          OR c.state IS DISTINCT FROM 'active'
          OR p.enabled IS DISTINCT FROM TRUE
          OR p.multiplier IS DISTINCT FROM 1::numeric
    ) THEN
      RAISE EXCEPTION '0259 cursor fork refuses drifted imported Gemini 3.8 Flash family';
    END IF;
  END IF;

  ALTER TABLE cursor_external_usage_audit
    DROP CONSTRAINT IF EXISTS cursor_external_usage_audit_model_id_check;
  ALTER TABLE cursor_external_usage_audit
    ADD CONSTRAINT cursor_external_usage_audit_model_id_check CHECK (model_id IN (
      'cursor-auto',
      'cursor-grok-4.6-low',
      'cursor-grok-4.6-low-fast',
      'cursor-grok-4.6-medium',
      'cursor-grok-4.6-medium-fast',
      'cursor-grok-4.6-high',
      'cursor-grok-4.6-high-fast',
      'cursor-grok-4.6-xhigh',
      'cursor-grok-4.6-xhigh-fast',
      'cursor-composer-2.5',
      'cursor-composer-2.5-fast',
      'cursor-opus-4.8-low',
      'cursor-opus-4.8-low-fast',
      'cursor-opus-4.8-medium',
      'cursor-opus-4.8-medium-fast',
      'cursor-opus-4.8-high',
      'cursor-opus-4.8-high-fast',
      'cursor-opus-4.8-xhigh',
      'cursor-opus-4.8-xhigh-fast',
      'cursor-opus-4.8-max',
      'cursor-opus-4.8-max-fast',
      'cursor-opus-5-low',
      'cursor-opus-5-low-fast',
      'cursor-opus-5-medium',
      'cursor-opus-5-medium-fast',
      'cursor-opus-5-high',
      'cursor-opus-5-high-fast',
      'cursor-opus-5-xhigh',
      'cursor-opus-5-xhigh-fast',
      'cursor-opus-5-max',
      'cursor-opus-5-max-fast',
      'cursor-fable-5-low',
      'cursor-fable-5-medium',
      'cursor-fable-5-high',
      'cursor-fable-5-xhigh',
      'cursor-fable-5-max',
      'cursor-fable-5.1-low',
      'cursor-fable-5.1-medium',
      'cursor-fable-5.1-high',
      'cursor-fable-5.1-xhigh',
      'cursor-fable-5.1-max',
      'cursor-gemini-3.8-flash-low',
      'cursor-gemini-3.8-flash-medium',
      'cursor-gemini-3.8-flash-high',
      'cursor-grok-4.5-high'
    ));

  SELECT COUNT(*) INTO actual
    FROM model_catalog c
    JOIN model_pricing p USING (model_id)
   WHERE c.model_id IN (
     'cursor-gemini-3.8-flash-low', 'cursor-gemini-3.8-flash-medium', 'cursor-gemini-3.8-flash-high'
   )
     AND c.engine = 'cursor'
     AND c.state = 'active'
     AND p.enabled IS TRUE;
  IF actual <> 3 THEN
    RAISE EXCEPTION '0259 expected 3 new active enabled cursor rows, got %', actual;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id LIKE 'cursor-gemini-3.8-flash-%' AND multiplier <> 1
  ) THEN
    RAISE EXCEPTION '0259 Gemini 3.8 Flash must keep baseline multiplier=1 (no Fast rows)';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing neu
      JOIN model_pricing baseline ON baseline.model_id = 'cursor-grok-4.6-high'
     WHERE neu.model_id LIKE 'cursor-gemini-3.8-flash-%'
       AND (neu.min_plan_code IS DISTINCT FROM baseline.min_plan_code
            OR neu.visibility IS DISTINCT FROM baseline.visibility
            OR neu.input_per_mtok IS DISTINCT FROM baseline.input_per_mtok
            OR neu.output_per_mtok IS DISTINCT FROM baseline.output_per_mtok
            OR neu.cache_read_per_mtok IS DISTINCT FROM baseline.cache_read_per_mtok
            OR neu.cache_write_per_mtok IS DISTINCT FROM baseline.cache_write_per_mtok)
  ) THEN
    RAISE EXCEPTION '0259 pricing/visibility/min_plan_code must clone cursor-grok-4.6-high';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id LIKE 'cursor-gemini-3.8-flash-%'
  ) THEN
    RAISE EXCEPTION '0259 must not create Gemini 3.8 Flash grants (family is clone-visible)';
  END IF;
END $$;
