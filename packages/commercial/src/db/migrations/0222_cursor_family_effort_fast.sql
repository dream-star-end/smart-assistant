-- 0222_cursor_family_effort_fast.sql
-- Expand currently public Cursor families to the pinned CLI's real
-- effort × Fast combinations (2026-08-18 cursor-agent --list-models).
-- Canonical ids stay composed; the picker groups by family.
-- Prices clone the 0221 family baseline; Fast rows use multiplier=2.
-- Grok 4.5 stays the existing hidden High-only row (not expanded).
-- Fable 5 has no Fast variants on the CLI.
--
-- New rows are born staged then activated. Visibility is cloned from the
-- family baseline so live public/hidden drift does not fail the floor.

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
     WHERE c.model_id = 'cursor-grok-4.6-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0222 requires active enabled cursor-grok-4.6-high floor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-composer-2.5-fast' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0222 requires active enabled cursor-composer-2.5-fast floor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-opus-5-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0222 requires active enabled cursor-opus-5-high floor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-fable-5-high' AND c.engine = 'cursor' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0222 requires active enabled cursor-fable-5-high floor';
  END IF;

  FOR rec IN
    SELECT * FROM (VALUES
      ('cursor-grok-4.6-low', 'cursor-grok-4.6-low', 'Cursor Grok 4.6 Low', 'cursor-grok-4.6-high', 1),
      ('cursor-grok-4.6-low-fast', 'cursor-grok-4.6-low-fast', 'Cursor Grok 4.6 Low Fast', 'cursor-grok-4.6-high', 2),
      ('cursor-grok-4.6-medium', 'cursor-grok-4.6-medium', 'Cursor Grok 4.6 Medium', 'cursor-grok-4.6-high', 1),
      ('cursor-grok-4.6-medium-fast', 'cursor-grok-4.6-medium-fast', 'Cursor Grok 4.6 Medium Fast', 'cursor-grok-4.6-high', 2),
      ('cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh', 'Cursor Grok 4.6 Extra High', 'cursor-grok-4.6-high', 1),
      ('cursor-grok-4.6-xhigh-fast', 'cursor-grok-4.6-xhigh-fast', 'Cursor Grok 4.6 Extra High Fast', 'cursor-grok-4.6-high', 2),
      ('cursor-composer-2.5', 'composer-2.5', 'Cursor Composer 2.5', 'cursor-composer-2.5-fast', 1),
      ('cursor-opus-5-low', 'claude-opus-5-thinking-low', 'Cursor Opus 5 Low', 'cursor-opus-5-high', 1),
      ('cursor-opus-5-low-fast', 'claude-opus-5-thinking-low-fast', 'Cursor Opus 5 Low Fast', 'cursor-opus-5-high', 2),
      ('cursor-opus-5-medium', 'claude-opus-5-thinking-medium', 'Cursor Opus 5 Medium', 'cursor-opus-5-high', 1),
      ('cursor-opus-5-medium-fast', 'claude-opus-5-thinking-medium-fast', 'Cursor Opus 5 Medium Fast', 'cursor-opus-5-high', 2),
      ('cursor-opus-5-high-fast', 'claude-opus-5-thinking-high-fast', 'Cursor Opus 5 High Fast', 'cursor-opus-5-high', 2),
      ('cursor-opus-5-xhigh', 'claude-opus-5-thinking-xhigh', 'Cursor Opus 5 Extra High', 'cursor-opus-5-high', 1),
      ('cursor-opus-5-xhigh-fast', 'claude-opus-5-thinking-xhigh-fast', 'Cursor Opus 5 Extra High Fast', 'cursor-opus-5-high', 2),
      ('cursor-opus-5-max', 'claude-opus-5-thinking-max', 'Cursor Opus 5 Max', 'cursor-opus-5-high', 1),
      ('cursor-opus-5-max-fast', 'claude-opus-5-thinking-max-fast', 'Cursor Opus 5 Max Fast', 'cursor-opus-5-high', 2),
      ('cursor-fable-5-low', 'claude-fable-5-thinking-low', 'Cursor Fable 5 Low (Non-ZDR)', 'cursor-fable-5-high', 1),
      ('cursor-fable-5-medium', 'claude-fable-5-thinking-medium', 'Cursor Fable 5 Medium (Non-ZDR)', 'cursor-fable-5-high', 1),
      ('cursor-fable-5-xhigh', 'claude-fable-5-thinking-xhigh', 'Cursor Fable 5 Extra High (Non-ZDR)', 'cursor-fable-5-high', 1),
      ('cursor-fable-5-max', 'claude-fable-5-thinking-max', 'Cursor Fable 5 Max (Non-ZDR)', 'cursor-fable-5-high', 1)
    ) AS t(model_id, upstream_model_id, display_name, baseline_id, multiplier)
  LOOP
    IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = rec.model_id)
       OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id = rec.model_id) THEN
      RAISE EXCEPTION '0222 refuses pre-existing %', rec.model_id;
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
    WHERE model_id = rec.baseline_id AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0222 failed to clone catalog from % for %', rec.baseline_id, rec.model_id;
    END IF;

    INSERT INTO model_pricing (
      model_id, display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier, enabled, sort_order, visibility, extra_system_prompt,
      default_effort, lock_version
    )
    SELECT
      rec.model_id,
      rec.display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      rec.multiplier, FALSE, sort_order, visibility, extra_system_prompt,
      default_effort, 0
    FROM model_pricing
    WHERE model_id = rec.baseline_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0222 failed to clone pricing from % for %', rec.baseline_id, rec.model_id;
    END IF;

    UPDATE model_catalog
       SET state = 'active'
     WHERE model_id = rec.model_id AND state = 'staged';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0222 failed to activate catalog %', rec.model_id;
    END IF;

    UPDATE model_pricing AS neu
       SET enabled = TRUE,
           visibility = baseline.visibility,
           multiplier = rec.multiplier,
           lock_version = neu.lock_version + 1
      FROM model_pricing AS baseline
     WHERE neu.model_id = rec.model_id
       AND baseline.model_id = rec.baseline_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0222 failed to enable pricing %', rec.model_id;
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
      RAISE EXCEPTION '0222 requires users 1 and 4 together when either exists';
    END IF;
  END IF;

  IF present_users = 2 THEN
    IF NOT EXISTS (
      SELECT 1 FROM users WHERE id = 1 AND role = 'admin' AND status = 'active'
    ) OR NOT EXISTS (
      SELECT 1 FROM users WHERE id = 4 AND status = 'active'
    ) THEN
      RAISE EXCEPTION '0222 requires active admin user 1 and active user 4';
    END IF;

    FOR rec IN
      SELECT u.id AS user_id, m.model_id
        FROM users u
        CROSS JOIN (VALUES
          ('cursor-grok-4.6-low'),
          ('cursor-grok-4.6-low-fast'),
          ('cursor-grok-4.6-medium'),
          ('cursor-grok-4.6-medium-fast'),
          ('cursor-grok-4.6-xhigh'),
          ('cursor-grok-4.6-xhigh-fast'),
          ('cursor-composer-2.5'),
          ('cursor-opus-5-low'),
          ('cursor-opus-5-low-fast'),
          ('cursor-opus-5-medium'),
          ('cursor-opus-5-medium-fast'),
          ('cursor-opus-5-high-fast'),
          ('cursor-opus-5-xhigh'),
          ('cursor-opus-5-xhigh-fast'),
          ('cursor-opus-5-max'),
          ('cursor-opus-5-max-fast'),
          ('cursor-fable-5-low'),
          ('cursor-fable-5-medium'),
          ('cursor-fable-5-xhigh'),
          ('cursor-fable-5-max')
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
            'source', 'migration:0222'
          )
        );
      END IF;
    END LOOP;
  END IF;

  SELECT COUNT(*) INTO actual
    FROM model_catalog c
    JOIN model_pricing p USING (model_id)
   WHERE c.model_id IN (
     'cursor-grok-4.6-low', 'cursor-grok-4.6-low-fast',
     'cursor-grok-4.6-medium', 'cursor-grok-4.6-medium-fast',
     'cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh-fast',
     'cursor-composer-2.5',
     'cursor-opus-5-low', 'cursor-opus-5-low-fast',
     'cursor-opus-5-medium', 'cursor-opus-5-medium-fast',
     'cursor-opus-5-high-fast',
     'cursor-opus-5-xhigh', 'cursor-opus-5-xhigh-fast',
     'cursor-opus-5-max', 'cursor-opus-5-max-fast',
     'cursor-fable-5-low', 'cursor-fable-5-medium',
     'cursor-fable-5-xhigh', 'cursor-fable-5-max'
   )
     AND c.engine = 'cursor'
     AND c.state = 'active'
     AND p.enabled IS TRUE;
  IF actual <> 20 THEN
    RAISE EXCEPTION '0222 expected 20 new active enabled cursor rows, got %', actual;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'cursor-grok-4.6-low-fast' AND multiplier <> 2
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'cursor-composer-2.5' AND multiplier <> 1
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'cursor-opus-5-high-fast' AND multiplier <> 2
  ) THEN
    RAISE EXCEPTION '0222 Fast/baseline multiplier mismatch';
  END IF;

  IF present_users = 2 AND (
    SELECT COUNT(*)
      FROM model_visibility_grants
     WHERE user_id IN (1, 4)
       AND model_id IN (
         'cursor-grok-4.6-low', 'cursor-grok-4.6-low-fast',
         'cursor-grok-4.6-medium', 'cursor-grok-4.6-medium-fast',
         'cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh-fast',
         'cursor-composer-2.5',
         'cursor-opus-5-low', 'cursor-opus-5-low-fast',
         'cursor-opus-5-medium', 'cursor-opus-5-medium-fast',
         'cursor-opus-5-high-fast',
         'cursor-opus-5-xhigh', 'cursor-opus-5-xhigh-fast',
         'cursor-opus-5-max', 'cursor-opus-5-max-fast',
         'cursor-fable-5-low', 'cursor-fable-5-medium',
         'cursor-fable-5-xhigh', 'cursor-fable-5-max'
       )
  ) <> 40 THEN
    RAISE EXCEPTION '0222 expected exact Cursor family grants for users 1/4';
  END IF;

  IF selfhost_profile AND EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id IN (
       'cursor-grok-4.6-low', 'cursor-grok-4.6-low-fast',
       'cursor-grok-4.6-medium', 'cursor-grok-4.6-medium-fast',
       'cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh-fast',
       'cursor-composer-2.5',
       'cursor-opus-5-low', 'cursor-opus-5-low-fast',
       'cursor-opus-5-medium', 'cursor-opus-5-medium-fast',
       'cursor-opus-5-high-fast',
       'cursor-opus-5-xhigh', 'cursor-opus-5-xhigh-fast',
       'cursor-opus-5-max', 'cursor-opus-5-max-fast',
       'cursor-fable-5-low', 'cursor-fable-5-medium',
       'cursor-fable-5-xhigh', 'cursor-fable-5-max'
     )
  ) THEN
    RAISE EXCEPTION '0222 selfhost profile must not grant new Cursor family rows';
  END IF;
END $$;
