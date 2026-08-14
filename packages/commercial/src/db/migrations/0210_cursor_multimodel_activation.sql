-- 0210_cursor_multimodel_activation.sql
-- Activate the staged Cursor compatibility floor and expose the exact Cursor
-- catalog only to the two operator-approved credential members (users 1/4).
-- The root-only credential remains controlled exclusively by host env/mounts.

DO $$
DECLARE
  present_users INTEGER;
  target RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM model_visibility_grants
     WHERE model_id IN (
       'cursor-auto',
       'cursor-grok-4.6-high',
       'cursor-composer-2.5-fast',
       'cursor-opus-5-high',
       'cursor-fable-5-high',
       'cursor-grok-4.5-high'
     )
       AND user_id NOT IN (1, 4)
  ) THEN
    RAISE EXCEPTION '0210 refuses pre-existing Cursor grants outside users 1/4';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM model_catalog c
      JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'cursor-auto'
       AND c.engine = 'cursor'
       AND c.provider_id = 'cursor'
       AND c.upstream_model_id IS NULL
       AND c.state IN ('staged', 'active')
       AND p.enabled IN (FALSE, TRUE)
  ) OR (
    SELECT COUNT(*)
      FROM model_catalog c
      JOIN model_pricing p USING (model_id)
     WHERE c.engine = 'cursor'
       AND c.provider_id = 'cursor'
       AND c.state = 'staged'
       AND p.enabled IS FALSE
       AND p.visibility = 'hidden'
       AND (c.model_id, c.upstream_model_id) IN (
         ('cursor-grok-4.6-high', 'cursor-grok-4.6-high'),
         ('cursor-composer-2.5-fast', 'composer-2.5-fast'),
         ('cursor-opus-5-high', 'claude-opus-5-thinking-high'),
         ('cursor-fable-5-high', 'claude-fable-5-thinking-high'),
         ('cursor-grok-4.5-high', 'cursor-grok-4.5-high')
       )
  ) <> 5 THEN
    RAISE EXCEPTION '0210 requires the exact 0208/0209 staged Cursor floor';
  END IF;

  UPDATE model_catalog
     SET state = 'active'
   WHERE model_id IN (
     'cursor-auto',
     'cursor-grok-4.6-high',
     'cursor-composer-2.5-fast',
     'cursor-opus-5-high',
     'cursor-fable-5-high',
     'cursor-grok-4.5-high'
   );

  UPDATE model_pricing
     SET enabled = TRUE,
         visibility = 'hidden',
         lock_version = lock_version + 1
   WHERE model_id IN (
     'cursor-auto',
     'cursor-grok-4.6-high',
     'cursor-composer-2.5-fast',
     'cursor-opus-5-high',
     'cursor-fable-5-high',
     'cursor-grok-4.5-high'
   );

  SELECT COUNT(*) INTO present_users FROM users WHERE id IN (1, 4);
  IF present_users NOT IN (0, 2) THEN
    RAISE EXCEPTION '0210 requires users 1 and 4 together when either exists';
  END IF;

  IF present_users = 2 THEN
    IF NOT EXISTS (
      SELECT 1 FROM users WHERE id = 1 AND role = 'admin' AND status = 'active'
    ) OR NOT EXISTS (
      SELECT 1 FROM users WHERE id = 4 AND status = 'active'
    ) THEN
      RAISE EXCEPTION '0210 requires active admin user 1 and active user 4';
    END IF;

    FOR target IN
      SELECT u.id AS user_id, m.model_id
        FROM users u
        CROSS JOIN (VALUES
          ('cursor-auto'),
          ('cursor-grok-4.6-high'),
          ('cursor-composer-2.5-fast'),
          ('cursor-opus-5-high'),
          ('cursor-fable-5-high'),
          ('cursor-grok-4.5-high')
        ) AS m(model_id)
       WHERE u.id IN (1, 4)
       ORDER BY u.id, m.model_id
    LOOP
      INSERT INTO model_visibility_grants(user_id, model_id, granted_by)
      VALUES (target.user_id, target.model_id, 1)
      ON CONFLICT (user_id, model_id) DO NOTHING;

      IF FOUND THEN
        INSERT INTO admin_audit(admin_id, action, target, before, after)
        VALUES (
          1,
          'model_grant.add',
          'user:' || target.user_id::text || '/model:' || target.model_id,
          NULL,
          jsonb_build_object(
            'user_id', target.user_id::text,
            'model_id', target.model_id,
            'granted_by', '1',
            'source', 'migration:0210'
          )
        );
      END IF;
    END LOOP;
  END IF;

  IF (
    SELECT COUNT(*)
      FROM model_catalog c
      JOIN model_pricing p USING (model_id)
     WHERE c.engine = 'cursor'
       AND c.provider_id = 'cursor'
       AND c.state = 'active'
       AND p.enabled IS TRUE
       AND p.visibility = 'hidden'
       AND c.model_id IN (
         'cursor-auto',
         'cursor-grok-4.6-high',
         'cursor-composer-2.5-fast',
         'cursor-opus-5-high',
         'cursor-fable-5-high',
         'cursor-grok-4.5-high'
       )
  ) <> 6 THEN
    RAISE EXCEPTION '0210 expected six active hidden Cursor catalog rows';
  END IF;

  IF present_users = 2 AND (
    SELECT COUNT(*)
      FROM model_visibility_grants
     WHERE user_id IN (1, 4)
       AND model_id IN (
         'cursor-auto',
         'cursor-grok-4.6-high',
         'cursor-composer-2.5-fast',
         'cursor-opus-5-high',
         'cursor-fable-5-high',
         'cursor-grok-4.5-high'
       )
  ) <> 12 THEN
    RAISE EXCEPTION '0210 expected exact Cursor grants for users 1/4';
  END IF;
END $$;
