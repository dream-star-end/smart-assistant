-- 0220_cursor_grok_46_high_fast.sql
-- Add Cursor Grok 4.6 High Fast as a sibling of cursor-grok-4.6-high.
-- Upstream CLI id (pinned 2026.08.11-e8db854 --list-models): cursor-grok-4.6-high-fast.
-- Same zero-price subscription billing, shared Cursor credential pool, and
-- env UID gate as High. Visibility is cloned from High so live public/hidden
-- drift does not fail the floor.
--
-- 0219_deepseek_v4_pro_transition exists on commercial aurora / the pending
-- selfhost-backmerge worktree but is not on this selfhost tree yet. 0220 avoids
-- colliding with that backmerge. Selfhost has no migration-order gap lint.

DO $$
DECLARE
  present_users INTEGER;
  selfhost_profile BOOLEAN := current_setting('openclaude.migration_profile', true) = 'v5-selfhost';
  target RECORD;
  actual INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM model_catalog c
      JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-grok-4.6-high'
       AND c.engine = 'cursor'
       AND c.provider_id = 'cursor'
       AND c.upstream_model_id = 'cursor-grok-4.6-high'
       AND c.state = 'active'
       AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0220 requires active enabled cursor-grok-4.6-high floor';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_catalog WHERE model_id = 'cursor-grok-4.6-high-fast'
  ) OR EXISTS (
    SELECT 1 FROM model_pricing WHERE model_id = 'cursor-grok-4.6-high-fast'
  ) THEN
    RAISE EXCEPTION '0220 refuses pre-existing cursor-grok-4.6-high-fast';
  END IF;

  INSERT INTO model_catalog (
    model_id, engine, provider_id, upstream_model_id, context_window,
    capability_profile, capability_schema_version, state
  )
  SELECT
    'cursor-grok-4.6-high-fast',
    engine,
    provider_id,
    'cursor-grok-4.6-high-fast',
    context_window,
    capability_profile,
    capability_schema_version,
    'staged'
  FROM model_catalog
  WHERE model_id = 'cursor-grok-4.6-high'
    AND state = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION '0220 failed to clone cursor-grok-4.6-high catalog';
  END IF;

  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility, extra_system_prompt,
    default_effort, lock_version
  )
  SELECT
    'cursor-grok-4.6-high-fast',
    'Cursor Grok 4.6 High Fast',
    input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
    multiplier, FALSE, sort_order, visibility, extra_system_prompt,
    default_effort, 0
  FROM model_pricing
  WHERE model_id = 'cursor-grok-4.6-high';

  IF NOT FOUND THEN
    RAISE EXCEPTION '0220 failed to clone cursor-grok-4.6-high pricing';
  END IF;

  UPDATE model_catalog
     SET state = 'active'
   WHERE model_id = 'cursor-grok-4.6-high-fast'
     AND state = 'staged';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0220 failed to activate cursor-grok-4.6-high-fast catalog';
  END IF;

  UPDATE model_pricing AS fast
     SET enabled = TRUE,
         visibility = high.visibility,
         lock_version = fast.lock_version + 1
    FROM model_pricing AS high
   WHERE fast.model_id = 'cursor-grok-4.6-high-fast'
     AND high.model_id = 'cursor-grok-4.6-high';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0220 failed to enable cursor-grok-4.6-high-fast pricing';
  END IF;

  ALTER TABLE cursor_external_usage_audit
    DROP CONSTRAINT IF EXISTS cursor_external_usage_audit_model_id_check;
  ALTER TABLE cursor_external_usage_audit
    ADD CONSTRAINT cursor_external_usage_audit_model_id_check CHECK (model_id IN (
      'cursor-auto',
      'cursor-grok-4.6-high',
      'cursor-grok-4.6-high-fast',
      'cursor-composer-2.5-fast',
      'cursor-opus-5-high',
      'cursor-fable-5-high',
      'cursor-grok-4.5-high'
    ));

  IF selfhost_profile THEN
    present_users := 0;
  ELSE
    SELECT COUNT(*) INTO present_users FROM users WHERE id IN (1, 4);
    IF present_users NOT IN (0, 2) THEN
      RAISE EXCEPTION '0220 requires users 1 and 4 together when either exists';
    END IF;
  END IF;

  IF present_users = 2 THEN
    IF NOT EXISTS (
      SELECT 1 FROM users WHERE id = 1 AND role = 'admin' AND status = 'active'
    ) OR NOT EXISTS (
      SELECT 1 FROM users WHERE id = 4 AND status = 'active'
    ) THEN
      RAISE EXCEPTION '0220 requires active admin user 1 and active user 4';
    END IF;

    FOR target IN
      SELECT u.id AS user_id
        FROM users u
       WHERE u.id IN (1, 4)
       ORDER BY u.id
    LOOP
      INSERT INTO model_visibility_grants(user_id, model_id, granted_by)
      VALUES (target.user_id, 'cursor-grok-4.6-high-fast', 1)
      ON CONFLICT (user_id, model_id) DO NOTHING;

      IF FOUND THEN
        INSERT INTO admin_audit(admin_id, action, target, before, after)
        VALUES (
          1,
          'model_grant.add',
          'user:' || target.user_id::text || '/model:cursor-grok-4.6-high-fast',
          NULL,
          jsonb_build_object(
            'user_id', target.user_id::text,
            'model_id', 'cursor-grok-4.6-high-fast',
            'granted_by', '1',
            'source', 'migration:0220'
          )
        );
      END IF;
    END LOOP;
  END IF;

  SELECT COUNT(*) INTO actual
    FROM model_catalog c
    JOIN model_pricing p USING (model_id)
   WHERE c.model_id = 'cursor-grok-4.6-high-fast'
     AND c.engine = 'cursor'
     AND c.provider_id = 'cursor'
     AND c.upstream_model_id = 'cursor-grok-4.6-high-fast'
     AND c.state = 'active'
     AND p.enabled IS TRUE
     AND p.visibility = (SELECT visibility FROM model_pricing WHERE model_id = 'cursor-grok-4.6-high')
     AND p.display_name = 'Cursor Grok 4.6 High Fast';
  IF actual <> 1 THEN
    RAISE EXCEPTION '0220 expected one active cursor-grok-4.6-high-fast row matching High visibility, got %', actual;
  END IF;

  IF present_users = 2 AND (
    SELECT COUNT(*)
      FROM model_visibility_grants
     WHERE user_id IN (1, 4)
       AND model_id = 'cursor-grok-4.6-high-fast'
  ) <> 2 THEN
    RAISE EXCEPTION '0220 expected exact Cursor Fast grants for users 1/4';
  END IF;

  IF selfhost_profile AND EXISTS (
    SELECT 1 FROM model_visibility_grants WHERE model_id = 'cursor-grok-4.6-high-fast'
  ) THEN
    RAISE EXCEPTION '0220 selfhost profile must not grant cursor-grok-4.6-high-fast';
  END IF;
END $$;
