-- 0247_cursor_opus_48.sql
-- Add Cursor Opus 4.8 as a picker family, cloned from live Opus 5.
-- Upstream ids are the pinned CLI thinking variants from
-- `cursor-agent --list-models` (2026.08.11-e8db854):
--   claude-opus-4-8-thinking-{low,medium,high,xhigh,max}{,-fast}
-- Canonical ids stay composed (effort × Fast). Non-thinking CLI ids are
-- not catalogued, matching Opus 5. Prices / visibility / min_plan clone
-- cursor-opus-5-high; Fast rows use multiplier=2.
--
-- New rows are born staged then activated. Selfhost profile must not
-- insert grants; commercial profile grants users 1/4 when both exist.

DO $$
DECLARE
  present_users INTEGER;
  selfhost_profile BOOLEAN := current_setting('openclaude.migration_profile', true) = 'v5-selfhost';
  rec RECORD;
  actual INTEGER;
  grant_count INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-opus-5-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0247 requires active enabled cursor-opus-5-high floor';
  END IF;

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
    IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = rec.model_id)
       OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id = rec.model_id) THEN
      RAISE EXCEPTION '0247 refuses pre-existing %', rec.model_id;
    END IF;

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

  IF selfhost_profile THEN
    present_users := 0;
  ELSE
    SELECT COUNT(*) INTO present_users FROM users WHERE id IN (1, 4);
    IF present_users NOT IN (0, 2) THEN
      RAISE EXCEPTION '0247 requires users 1 and 4 together when either exists';
    END IF;
  END IF;

  IF present_users = 2 THEN
    IF NOT EXISTS (
      SELECT 1 FROM users WHERE id = 1 AND role = 'admin' AND status = 'active'
    ) OR NOT EXISTS (
      SELECT 1 FROM users WHERE id = 4 AND status = 'active'
    ) THEN
      RAISE EXCEPTION '0247 requires active admin user 1 and active user 4';
    END IF;

    FOR rec IN
      SELECT u.id AS user_id, m.model_id
        FROM users u
        CROSS JOIN (VALUES
          ('cursor-opus-4.8-low'),
          ('cursor-opus-4.8-low-fast'),
          ('cursor-opus-4.8-medium'),
          ('cursor-opus-4.8-medium-fast'),
          ('cursor-opus-4.8-high'),
          ('cursor-opus-4.8-high-fast'),
          ('cursor-opus-4.8-xhigh'),
          ('cursor-opus-4.8-xhigh-fast'),
          ('cursor-opus-4.8-max'),
          ('cursor-opus-4.8-max-fast')
        ) AS m(model_id)
       WHERE u.id IN (1, 4)
       ORDER BY u.id, m.model_id
    LOOP
      INSERT INTO model_visibility_grants(user_id, model_id, granted_by)
      VALUES (rec.user_id, rec.model_id, 1)
      ON CONFLICT (user_id, model_id) DO NOTHING;
      IF FOUND THEN
        grant_count := grant_count + 1;
        INSERT INTO admin_audit(admin_id, action, target, before, after)
        VALUES (
          1,
          'model_grant.add',
          'user:' || rec.user_id::text || '/model:' || rec.model_id,
          NULL,
          jsonb_build_object(
            'user_id', rec.user_id::text,
            'model_id', rec.model_id,
            'granted_by', '1',
            'source', 'migration:0247'
          )
        );
      END IF;
    END LOOP;
  END IF;

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

  IF EXISTS (
    SELECT 1
      FROM model_pricing neu
      JOIN model_pricing baseline ON baseline.model_id = 'cursor-opus-5-high'
     WHERE neu.model_id = 'cursor-opus-4.8-high'
       AND neu.min_plan_code IS DISTINCT FROM baseline.min_plan_code
  ) THEN
    RAISE EXCEPTION '0247 min_plan_code must clone cursor-opus-5-high';
  END IF;

  IF present_users = 2 AND (
    SELECT COUNT(*)
      FROM model_visibility_grants
     WHERE user_id IN (1, 4)
       AND model_id IN (
         'cursor-opus-4.8-low', 'cursor-opus-4.8-low-fast',
         'cursor-opus-4.8-medium', 'cursor-opus-4.8-medium-fast',
         'cursor-opus-4.8-high', 'cursor-opus-4.8-high-fast',
         'cursor-opus-4.8-xhigh', 'cursor-opus-4.8-xhigh-fast',
         'cursor-opus-4.8-max', 'cursor-opus-4.8-max-fast'
       )
  ) <> 20 THEN
    RAISE EXCEPTION '0247 expected exact Cursor Opus 4.8 grants for users 1/4';
  END IF;

  IF selfhost_profile AND EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id IN (
       'cursor-opus-4.8-low', 'cursor-opus-4.8-low-fast',
       'cursor-opus-4.8-medium', 'cursor-opus-4.8-medium-fast',
       'cursor-opus-4.8-high', 'cursor-opus-4.8-high-fast',
       'cursor-opus-4.8-xhigh', 'cursor-opus-4.8-xhigh-fast',
       'cursor-opus-4.8-max', 'cursor-opus-4.8-max-fast'
     )
  ) THEN
    RAISE EXCEPTION '0247 selfhost profile must not grant new Cursor Opus 4.8 rows';
  END IF;
END $$;
