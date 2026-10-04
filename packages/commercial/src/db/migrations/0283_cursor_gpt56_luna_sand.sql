-- order-dependency: 0282_scnet_glm53_flash
-- Commercial historical 0283, represented for the normal migration runner.
-- Original operator: ops/ocv5-308/history/0283_cursor_gpt56_luna_sand.operator.sql
-- Same catalog/pricing initialization; runner owns transaction, advisory lock
-- and schema_migrations INSERT. Production apply is protected by the official
-- mutation lease and stable-state preflight, not by an admin-1 fixture.
-- Personal flavor must NOT import this execution file/metadata.
-- No old model is disabled, repriced or re-bound.

DO $op$
DECLARE
  rec RECORD;
  existing integer;
  actual integer;
  luna model_pricing%ROWTYPE;
  v_epoch bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-gemini-3.8-flash-high'
       AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION 'OCV5-249 luna: requires active cursor-gemini-3.8-flash-high floor';
  END IF;

  SELECT * INTO STRICT luna FROM model_pricing WHERE model_id = 'gpt-5.6-luna';
  IF luna.input_per_mtok IS DISTINCT FROM 74
     OR luna.output_per_mtok IS DISTINCT FROM 444
     OR luna.cache_read_per_mtok IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'OCV5-249 luna: unexpected Codex luna floor prices';
  END IF;

  SELECT COUNT(*) INTO existing FROM model_catalog WHERE model_id LIKE 'cursor-gpt-5.6-luna-%';
  SELECT COUNT(*) INTO actual FROM model_pricing WHERE model_id LIKE 'cursor-gpt-5.6-luna-%';
  IF existing NOT IN (0, 10) OR actual <> existing THEN
    RAISE EXCEPTION 'OCV5-249 luna: partial family catalog=% pricing=%', existing, actual;
  END IF;

  IF existing = 0 THEN
    FOR rec IN
      SELECT * FROM (VALUES
        ('cursor-gpt-5.6-luna-low',        'gpt-5.6-luna-low',        'GPT-5.6 Luna Low',        1::numeric),
        ('cursor-gpt-5.6-luna-low-fast',   'gpt-5.6-luna-low-fast',   'GPT-5.6 Luna Low Fast',   2::numeric),
        ('cursor-gpt-5.6-luna-medium',     'gpt-5.6-luna-medium',     'GPT-5.6 Luna Medium',     1::numeric),
        ('cursor-gpt-5.6-luna-medium-fast','gpt-5.6-luna-medium-fast','GPT-5.6 Luna Medium Fast',2::numeric),
        ('cursor-gpt-5.6-luna-high',       'gpt-5.6-luna-high',       'GPT-5.6 Luna High',       1::numeric),
        ('cursor-gpt-5.6-luna-high-fast',  'gpt-5.6-luna-high-fast',  'GPT-5.6 Luna High Fast',  2::numeric),
        ('cursor-gpt-5.6-luna-xhigh',      'gpt-5.6-luna-xhigh',      'GPT-5.6 Luna Extra High', 1::numeric),
        ('cursor-gpt-5.6-luna-xhigh-fast', 'gpt-5.6-luna-xhigh-fast', 'GPT-5.6 Luna Extra High Fast', 2::numeric),
        ('cursor-gpt-5.6-luna-max',        'gpt-5.6-luna-max',        'GPT-5.6 Luna Max',        1::numeric),
        ('cursor-gpt-5.6-luna-max-fast',   'gpt-5.6-luna-max-fast',   'GPT-5.6 Luna Max Fast',   2::numeric)
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
      WHERE model_id = 'cursor-gemini-3.8-flash-high' AND state = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'OCV5-249 luna: failed catalog clone for %', rec.model_id;
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
        luna.input_per_mtok,
        luna.output_per_mtok,
        luna.cache_read_per_mtok,
        luna.cache_write_per_mtok,
        rec.multiplier,
        FALSE,
        10002,
        'public',
        extra_system_prompt,
        NULL,
        0,
        NULL
      FROM model_pricing
      WHERE model_id = 'cursor-gemini-3.8-flash-high';

      UPDATE model_catalog
         SET state = 'active'
       WHERE model_id = rec.model_id AND state = 'staged';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'OCV5-249 luna: failed to activate %', rec.model_id;
      END IF;

      UPDATE model_pricing
         SET enabled = TRUE,
             lock_version = lock_version + 1
       WHERE model_id = rec.model_id;
    END LOOP;
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
      'cursor-sonnet-5-low',
      'cursor-sonnet-5-medium',
      'cursor-sonnet-5-high',
      'cursor-sonnet-5-xhigh',
      'cursor-sonnet-5-max',
      'cursor-gemini-3.8-flash-low',
      'cursor-gemini-3.8-flash-medium',
      'cursor-gemini-3.8-flash-high',
      'cursor-grok-4.5-high',
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
    ));

  SELECT COUNT(*) INTO actual
    FROM model_catalog c JOIN model_pricing p USING (model_id)
   WHERE c.model_id LIKE 'cursor-gpt-5.6-luna-%'
     AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE;
  IF actual <> 10 THEN
    RAISE EXCEPTION 'OCV5-249 luna: expected 10 active enabled rows, got %', actual;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id LIKE 'cursor-gpt-5.6-luna-%'
       AND (input_per_mtok, output_per_mtok, cache_read_per_mtok)
           IS DISTINCT FROM (74, 444, 7)
  ) THEN
    RAISE EXCEPTION 'OCV5-249 luna: prices must be Codex luna x0.5 floor 74/444/7';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id LIKE 'cursor-gpt-5.6-luna-%-fast' AND multiplier <> 2
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id LIKE 'cursor-gpt-5.6-luna-%'
       AND model_id NOT LIKE '%-fast'
       AND multiplier <> 1
  ) THEN
    RAISE EXCEPTION 'OCV5-249 luna: Fast must be multiplier=2, baseline 1';
  END IF;


  -- Reuse a complete pre-existing family only when execution semantics match.
  IF EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
      CROSS JOIN (SELECT * FROM model_catalog
        WHERE model_id='cursor-gemini-3.8-flash-high' AND state='active') donor
     WHERE c.model_id LIKE 'cursor-gpt-5.6-luna-%'
       AND (c.model_id NOT IN (
         'cursor-gpt-5.6-luna-low','cursor-gpt-5.6-luna-low-fast',
         'cursor-gpt-5.6-luna-medium','cursor-gpt-5.6-luna-medium-fast',
         'cursor-gpt-5.6-luna-high','cursor-gpt-5.6-luna-high-fast',
         'cursor-gpt-5.6-luna-xhigh','cursor-gpt-5.6-luna-xhigh-fast',
         'cursor-gpt-5.6-luna-max','cursor-gpt-5.6-luna-max-fast')
         OR c.engine IS DISTINCT FROM 'cursor'
         OR c.provider_id IS DISTINCT FROM donor.provider_id
         OR c.upstream_model_id IS DISTINCT FROM substring(c.model_id FROM 8)
         OR c.context_window IS DISTINCT FROM donor.context_window
         OR c.capability_profile IS DISTINCT FROM donor.capability_profile
         OR c.capability_schema_version IS DISTINCT FROM donor.capability_schema_version
         OR c.state IS DISTINCT FROM 'active'
         OR p.enabled IS DISTINCT FROM TRUE
         OR p.visibility IS DISTINCT FROM 'public'
         OR p.min_plan_code IS NOT NULL
         OR p.default_effort IS NOT NULL
         OR p.sort_order IS DISTINCT FROM 10002
         OR p.extra_system_prompt IS DISTINCT FROM (
           SELECT extra_system_prompt FROM model_pricing
            WHERE model_id='cursor-gemini-3.8-flash-high')
         OR p.cache_write_per_mtok IS DISTINCT FROM luna.cache_write_per_mtok)
  ) THEN
    RAISE EXCEPTION '0283 refuses semantic drift in existing Cursor Luna family';
  END IF;
  IF EXISTS (
    SELECT 1 FROM model_visibility_grants WHERE model_id LIKE 'cursor-gpt-5.6-luna-%'
  ) THEN
    RAISE EXCEPTION 'OCV5-249 luna: must not create grants (public clone-visible)';
  END IF;

  SELECT epoch INTO v_epoch FROM model_security_epoch;
  RAISE NOTICE 'OCV5-249 luna family=10 epoch=%', v_epoch;
END
$op$;
