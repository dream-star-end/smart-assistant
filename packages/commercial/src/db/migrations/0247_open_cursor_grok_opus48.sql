-- 0247_open_cursor_grok_opus48.sql
-- order-dependency: 0246_ungate_cursor_opus_fable_picker
--
-- Commercial public opening + Cursor Opus 4.8:
--   1. Add the Opus 4.8 thinking×Fast family (clone live Opus 5).
--   2. Publish every active+enabled Cursor SKU except retired auto / Grok 4.5,
--      plus official grok-build. Clear leftover min_plan_code.
--   3. Expand cursor_external_usage_audit CHECK.
--
-- 0246 already cleared Opus 5 / Fable 5 min_plan=max. This file must apply
-- after that version (same tree). No per-uid grants: public visibility is
-- the picker contract. Cursor execution still needs OC_V5_CURSOR_CREDENTIAL_UIDS
-- (set to * / all for every valid uid). The Grok admin role hard-gate is
-- removed in modelCatalog.ts, not here.
--
-- New catalog rows are born staged then activated. CHECK expansion uses
-- DROP CONSTRAINT (breaking-DDL door; deploy with OC_V5_ALLOW_BREAKING_MIGRATION=1).
--
-- Fork convergence: selfhost shipped 0247_cursor_opus_48 before this commercial
-- migration existed. A merged tree therefore may already contain the exact ten
-- Opus 4.8 rows. Accept only that complete, semantic-equivalent family;
-- partial or drifted pre-existing rows remain fail-closed.

DO $$
DECLARE
  rec RECORD;
  actual INTEGER;
  existing INTEGER;
  opened INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-opus-5-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0247 requires active enabled cursor-opus-5-high floor';
  END IF;

  SELECT COUNT(*) INTO existing
    FROM model_catalog
   WHERE model_id LIKE 'cursor-opus-4.8-%';
  SELECT COUNT(*) INTO actual
    FROM model_pricing
   WHERE model_id LIKE 'cursor-opus-4.8-%';
  IF existing NOT IN (0, 10) OR actual <> existing THEN
    RAISE EXCEPTION
      '0247 refuses partial imported Opus 4.8 family (catalog %, pricing %)',
      existing, actual;
  END IF;

  IF existing = 0 THEN
    FOR rec IN
      SELECT * FROM (VALUES
        ('cursor-opus-4.8-low', 'claude-opus-4-8-thinking-low', 'Cursor Opus 4.8 Low', 1),
        ('cursor-opus-4.8-low-fast', 'claude-opus-4-8-thinking-low-fast', 'Cursor Opus 4.8 Low Fast', 2),
        ('cursor-opus-4.8-medium', 'claude-opus-4-8-thinking-medium', 'Cursor Opus 4.8 Medium', 1),
        ('cursor-opus-4.8-medium-fast', 'claude-opus-4-8-thinking-medium-fast', 'Cursor Opus 4.8 Medium Fast', 2),
        ('cursor-opus-4.8-high', 'claude-opus-4-8-thinking-high', 'Cursor Opus 4.8 High', 1),
        ('cursor-opus-4.8-high-fast', 'claude-opus-4-8-thinking-high-fast', 'Cursor Opus 4.8 High Fast', 2),
        ('cursor-opus-4.8-xhigh', 'claude-opus-4-8-thinking-xhigh', 'Cursor Opus 4.8 Extra High', 1),
        ('cursor-opus-4.8-xhigh-fast', 'claude-opus-4-8-thinking-xhigh-fast', 'Cursor Opus 4.8 Extra High Fast', 2),
        ('cursor-opus-4.8-max', 'claude-opus-4-8-thinking-max', 'Cursor Opus 4.8 Max', 1),
        ('cursor-opus-4.8-max-fast', 'claude-opus-4-8-thinking-max-fast', 'Cursor Opus 4.8 Max Fast', 2)
      ) AS t(model_id, upstream_model_id, display_name, multiplier)
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
      WHERE model_id = 'cursor-opus-5-high' AND state = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0247 failed to clone catalog from cursor-opus-5-high for %', rec.model_id;
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
        rec.multiplier, FALSE, sort_order, visibility, extra_system_prompt,
        default_effort, 0, min_plan_code
      FROM model_pricing
      WHERE model_id = 'cursor-opus-5-high';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0247 failed to clone pricing from cursor-opus-5-high for %', rec.model_id;
      END IF;

      UPDATE model_catalog
         SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0247 failed to activate catalog %', rec.model_id;
      END IF;

      UPDATE model_pricing AS neu
         SET enabled = TRUE,
             visibility = baseline.visibility,
             min_plan_code = baseline.min_plan_code,
             multiplier = rec.multiplier,
             lock_version = neu.lock_version + 1
        FROM model_pricing AS baseline
       WHERE neu.model_id = rec.model_id
         AND baseline.model_id = 'cursor-opus-5-high';
      IF NOT FOUND THEN
        RAISE EXCEPTION '0247 failed to enable pricing %', rec.model_id;
      END IF;
    END LOOP;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM (VALUES
          ('cursor-opus-4.8-low', 'claude-opus-4-8-thinking-low', 1),
          ('cursor-opus-4.8-low-fast', 'claude-opus-4-8-thinking-low-fast', 2),
          ('cursor-opus-4.8-medium', 'claude-opus-4-8-thinking-medium', 1),
          ('cursor-opus-4.8-medium-fast', 'claude-opus-4-8-thinking-medium-fast', 2),
          ('cursor-opus-4.8-high', 'claude-opus-4-8-thinking-high', 1),
          ('cursor-opus-4.8-high-fast', 'claude-opus-4-8-thinking-high-fast', 2),
          ('cursor-opus-4.8-xhigh', 'claude-opus-4-8-thinking-xhigh', 1),
          ('cursor-opus-4.8-xhigh-fast', 'claude-opus-4-8-thinking-xhigh-fast', 2),
          ('cursor-opus-4.8-max', 'claude-opus-4-8-thinking-max', 1),
          ('cursor-opus-4.8-max-fast', 'claude-opus-4-8-thinking-max-fast', 2)
        ) AS expected(model_id, upstream_model_id, multiplier)
        LEFT JOIN model_catalog c USING (model_id)
        LEFT JOIN model_pricing p USING (model_id)
       WHERE c.engine IS DISTINCT FROM 'cursor'
          OR c.upstream_model_id IS DISTINCT FROM expected.upstream_model_id
          OR c.state IS DISTINCT FROM 'active'
          OR p.enabled IS DISTINCT FROM TRUE
          OR p.multiplier IS DISTINCT FROM expected.multiplier
    ) THEN
      RAISE EXCEPTION '0247 refuses drifted imported Opus 4.8 family';
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
      'cursor-grok-4.5-high'
    ));

  SELECT COUNT(*) INTO actual
    FROM model_catalog c
    JOIN model_pricing p USING (model_id)
   WHERE c.model_id IN (
     'cursor-opus-4.8-low', 'cursor-opus-4.8-low-fast',
     'cursor-opus-4.8-medium', 'cursor-opus-4.8-medium-fast',
     'cursor-opus-4.8-high', 'cursor-opus-4.8-high-fast',
     'cursor-opus-4.8-xhigh', 'cursor-opus-4.8-xhigh-fast',
     'cursor-opus-4.8-max', 'cursor-opus-4.8-max-fast'
   )
     AND c.engine = 'cursor'
     AND c.state = 'active'
     AND p.enabled IS TRUE;
  IF actual <> 10 THEN
    RAISE EXCEPTION '0247 expected 10 new active enabled cursor rows, got %', actual;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'cursor-opus-4.8-high' AND multiplier <> 1
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'cursor-opus-4.8-high-fast' AND multiplier <> 2
  ) THEN
    RAISE EXCEPTION '0247 Fast/baseline multiplier mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog WHERE model_id = 'grok-build' AND engine = 'grok'
  ) THEN
    RAISE EXCEPTION '0247 requires grok-build catalog row';
  END IF;

  UPDATE model_catalog
     SET state = 'active'
   WHERE model_id = 'grok-build' AND state = 'staged';

  UPDATE model_pricing
     SET enabled = TRUE,
         lock_version = lock_version + 1
   WHERE model_id = 'grok-build' AND enabled IS DISTINCT FROM TRUE;

  UPDATE model_pricing AS p
     SET visibility = 'public',
         min_plan_code = NULL,
         lock_version = p.lock_version + 1
    FROM model_catalog AS c
   WHERE c.model_id = p.model_id
     AND c.state = 'active'
     AND p.enabled IS TRUE
     AND (
       (c.engine = 'cursor'
        AND c.model_id NOT IN ('cursor-auto', 'cursor-grok-4.5-high'))
       OR c.model_id = 'grok-build'
     );
  GET DIAGNOSTICS opened = ROW_COUNT;
  IF opened <> 36 THEN
    RAISE EXCEPTION '0247 expected 36 public opens (35 cursor + grok-build), got %', opened;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_catalog c
      JOIN model_pricing p USING (model_id)
     WHERE c.state = 'active'
       AND p.enabled IS TRUE
       AND (
         (c.engine = 'cursor' AND c.model_id NOT IN ('cursor-auto', 'cursor-grok-4.5-high'))
         OR c.model_id = 'grok-build'
       )
       AND (p.visibility IS DISTINCT FROM 'public' OR p.min_plan_code IS NOT NULL)
  ) THEN
    RAISE EXCEPTION '0247 leftover hidden/min_plan on opened models';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id LIKE 'cursor-opus-4.8-%'
  ) THEN
    RAISE EXCEPTION '0247 must not insert Opus 4.8 grants';
  END IF;
END $$;

SELECT fn_model_security_epoch_bump();
