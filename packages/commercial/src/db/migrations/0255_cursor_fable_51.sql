-- 0255_cursor_fable_51.sql
-- Add Cursor Fable 5.1 as a picker family, cloned from live Fable 5.
-- Upstream ids are the pinned CLI thinking variants from
-- `cursor-agent --list-models` (2026-09-02):
--   claude-fable-5-1-thinking-{low,medium,high,xhigh,max}
-- Canonical ids stay composed (effort only — the CLI exposes no Fast
-- variant for Fable 5.1, so no Fast rows are catalogued, matching Fable 5).
-- Non-thinking CLI ids (claude-fable-5-1-{low,...}) are not catalogued,
-- matching the Claude-family policy (thinking upstreams only).
-- Prices / visibility / min_plan clone cursor-fable-5-high.
--
-- New rows are born staged then activated. Selfhost profile must not
-- insert grants; no per-user grants are created on any profile because the
-- Fable family is public-by-baseline (clone decides).
--
-- Fork convergence: a sibling fork may already have created the exact
-- Fable 5.1 family. Reuse only a complete, semantic-equivalent family;
-- partial/drifted rows remain fail-closed.

DO $$
DECLARE
  rec RECORD;
  actual INTEGER;
  existing INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-fable-5-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0255 requires active enabled cursor-fable-5-high floor';
  END IF;

  SELECT COUNT(*) INTO existing
    FROM model_catalog
   WHERE model_id LIKE 'cursor-fable-5.1-%';
  SELECT COUNT(*) INTO actual
    FROM model_pricing
   WHERE model_id LIKE 'cursor-fable-5.1-%';
  IF existing NOT IN (0, 5) OR actual <> existing THEN
    RAISE EXCEPTION
      '0255 cursor fork refuses partial imported Fable 5.1 family (catalog %, pricing %)',
      existing, actual;
  END IF;

  IF existing = 0 THEN
    FOR rec IN
      SELECT * FROM (VALUES
        ('cursor-fable-5.1-low', 'claude-fable-5-1-thinking-low', 'Cursor Fable 5.1 Low (Non-ZDR)'),
        ('cursor-fable-5.1-medium', 'claude-fable-5-1-thinking-medium', 'Cursor Fable 5.1 Medium (Non-ZDR)'),
        ('cursor-fable-5.1-high', 'claude-fable-5-1-thinking-high', 'Cursor Fable 5.1 High (Non-ZDR)'),
        ('cursor-fable-5.1-xhigh', 'claude-fable-5-1-thinking-xhigh', 'Cursor Fable 5.1 Extra High (Non-ZDR)'),
        ('cursor-fable-5.1-max', 'claude-fable-5-1-thinking-max', 'Cursor Fable 5.1 Max (Non-ZDR)')
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
      WHERE model_id = 'cursor-fable-5-high' AND state = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0255 failed to clone catalog from cursor-fable-5-high for %', rec.model_id;
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
        multiplier, FALSE, sort_order, visibility, extra_system_prompt,
        default_effort, 0, min_plan_code
      FROM model_pricing
      WHERE model_id = 'cursor-fable-5-high';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0255 failed to clone pricing from cursor-fable-5-high for %', rec.model_id;
      END IF;

      UPDATE model_catalog
         SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0255 failed to activate catalog %', rec.model_id;
      END IF;

      UPDATE model_pricing AS neu
         SET enabled = TRUE,
             visibility = baseline.visibility,
             min_plan_code = baseline.min_plan_code,
             lock_version = neu.lock_version + 1
        FROM model_pricing AS baseline
       WHERE neu.model_id = rec.model_id
         AND baseline.model_id = 'cursor-fable-5-high';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0255 failed to enable pricing %', rec.model_id;
      END IF;
    END LOOP;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM (VALUES
          ('cursor-fable-5.1-low', 'claude-fable-5-1-thinking-low'),
          ('cursor-fable-5.1-medium', 'claude-fable-5-1-thinking-medium'),
          ('cursor-fable-5.1-high', 'claude-fable-5-1-thinking-high'),
          ('cursor-fable-5.1-xhigh', 'claude-fable-5-1-thinking-xhigh'),
          ('cursor-fable-5.1-max', 'claude-fable-5-1-thinking-max')
        ) AS expected(model_id, upstream_model_id)
        LEFT JOIN model_catalog c USING (model_id)
        LEFT JOIN model_pricing p USING (model_id)
       WHERE c.engine IS DISTINCT FROM 'cursor'
          OR c.upstream_model_id IS DISTINCT FROM expected.upstream_model_id
          OR c.state IS DISTINCT FROM 'active'
          OR p.enabled IS DISTINCT FROM TRUE
          OR p.multiplier IS DISTINCT FROM 1::numeric
    ) THEN
      RAISE EXCEPTION '0255 cursor fork refuses drifted imported Fable 5.1 family';
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
      'cursor-grok-4.5-high'
    ));

  SELECT COUNT(*) INTO actual
    FROM model_catalog c
    JOIN model_pricing p USING (model_id)
   WHERE c.model_id IN (
     'cursor-fable-5.1-low', 'cursor-fable-5.1-medium', 'cursor-fable-5.1-high',
     'cursor-fable-5.1-xhigh', 'cursor-fable-5.1-max'
   )
     AND c.engine = 'cursor'
     AND c.state = 'active'
     AND p.enabled IS TRUE;
  IF actual <> 5 THEN
    RAISE EXCEPTION '0255 expected 5 new active enabled cursor rows, got %', actual;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id LIKE 'cursor-fable-5.1-%' AND multiplier <> 1
  ) THEN
    RAISE EXCEPTION '0255 Fable 5.1 must keep baseline multiplier=1 (no Fast rows)';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_pricing neu
      JOIN model_pricing baseline ON baseline.model_id = 'cursor-fable-5-high'
     WHERE neu.model_id = 'cursor-fable-5.1-high'
       AND (neu.min_plan_code IS DISTINCT FROM baseline.min_plan_code
            OR neu.visibility IS DISTINCT FROM baseline.visibility)
  ) THEN
    RAISE EXCEPTION '0255 visibility/min_plan_code must clone cursor-fable-5-high';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id LIKE 'cursor-fable-5.1-%'
  ) THEN
    RAISE EXCEPTION '0255 must not create Fable 5.1 grants (family is clone-visible)';
  END IF;
END $$;
