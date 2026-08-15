-- 0219 — disable and hide DeepSeek V4 Pro after the Flash cutover.
--
-- This is intentionally a disable transition, never a retirement transition.
-- Historical catalog rows and usage remain addressable for audit while every
-- executable/discovery surface is closed. Migration 0218's temporary write
-- fences are removed only after the catalog state, pricing state, runtime
-- requirement, and persisted-reference postconditions are all true in the
-- same transaction.
--
-- Manual compensation keeps the 0219 schema_migrations ledger row. Run the
-- tested block below under V5_DEV_PLAYBOOK.md §4.5's production mutation
-- lease, advisory lock, transaction, and SET LOCAL ROLE openclaude discipline.
-- It restores semantic availability from the immutable before-image ledger but
-- deliberately does not recreate 0218's obsolete deploy-gap fences. Publishing
-- this disable again after compensation requires a new migration.

-- BEGIN TESTED MANUAL COMPENSATION 0219
-- LOCK TABLE model_catalog, model_pricing, model_runtime_requirements,
--   user_preferences, client_sessions, model_visibility_grants,
--   account_group_models, model_aliases, model_dsv4pro_disable_snapshots
--   IN SHARE ROW EXCLUSIVE MODE;
--
-- DO $compensation$
-- DECLARE
--   v_target RECORD;
-- BEGIN
--   IF (SELECT count(*) FROM model_dsv4pro_disable_snapshots) <> 1 THEN
--     RAISE EXCEPTION '0219 compensation requires exactly one before-image';
--   END IF;
--
--   IF (SELECT count(*)
--         FROM model_dsv4pro_disable_snapshots s
--         JOIN model_catalog c ON c.entry_id = s.entry_id AND c.model_id = s.model_id
--         JOIN model_pricing p ON p.model_id = s.model_id
--        WHERE c.state = 'disabled'
--          AND p.enabled IS FALSE
--          AND p.visibility = 'hidden'
--          AND c.lock_version = s.catalog_lock_version
--              + CASE WHEN s.catalog_state = 'active' THEN 1 ELSE 0 END
--          AND p.lock_version = s.pricing_lock_version
--              + CASE WHEN s.pricing_visibility <> 'hidden' THEN 1 ELSE 0 END
--          AND c.updated_by IS NOT DISTINCT FROM s.catalog_updated_by
--          AND p.updated_by IS NOT DISTINCT FROM s.pricing_updated_by
--          AND (to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by']) = s.catalog_frozen
--          AND (to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by']) = s.pricing_frozen
--       ) <> 1 THEN
--     RAISE EXCEPTION '0219 compensation refuses catalog/pricing drift after disable';
--   END IF;
--
--   IF EXISTS (
--     SELECT 1 FROM user_preferences
--      WHERE prefs->>'default_model' = 'deepseek-v4-pro'
--   ) OR EXISTS (
--     SELECT 1 FROM client_sessions
--      WHERE deleted_at IS NULL
--        AND model_id = 'deepseek-v4-pro'
--   ) THEN
--     RAISE EXCEPTION '0219 compensation refuses Pro persisted references';
--   END IF;
--
--   IF EXISTS (
--     SELECT 1 FROM model_visibility_grants
--      WHERE model_id = 'deepseek-v4-pro'
--   ) OR EXISTS (
--     SELECT 1 FROM account_group_models
--      WHERE model_id = 'deepseek-v4-pro'
--   ) OR EXISTS (
--     SELECT 1
--       FROM model_aliases a
--       JOIN model_catalog c ON c.entry_id = a.entry_id
--      WHERE c.model_id = 'deepseek-v4-pro'
--   ) THEN
--     RAISE EXCEPTION '0219 compensation refuses Pro grants/group mappings/aliases';
--   END IF;
--
--   IF (SELECT count(*) FROM model_runtime_requirements
--        WHERE model_id = 'deepseek-v4-flash'
--          AND requirement = 'official_seed_agent') <> 1
--      OR (SELECT count(*) FROM model_runtime_requirements
--           WHERE model_id = 'deepseek-v4-flash'
--             AND requirement = 'ccb_secondary_utility') <> 1
--      OR EXISTS (
--        SELECT 1 FROM model_runtime_requirements
--         WHERE model_id = 'deepseek-v4-pro'
--           AND requirement = 'official_seed_agent'
--      ) THEN
--     RAISE EXCEPTION '0219 compensation requires the exact Flash runtime requirements';
--   END IF;
--
--   FOR v_target IN
--     SELECT s.entry_id, c.lock_version
--       FROM model_dsv4pro_disable_snapshots s
--       JOIN model_catalog c ON c.entry_id = s.entry_id
--      WHERE s.catalog_state = 'active'
--   LOOP
--     PERFORM fn_model_activate_entry(v_target.entry_id, v_target.lock_version, NULL);
--   END LOOP;
--
--   UPDATE model_pricing p
--      SET visibility = s.pricing_visibility,
--          updated_by = s.pricing_updated_by,
--          lock_version = p.lock_version + 1,
--          updated_at = now()
--     FROM model_dsv4pro_disable_snapshots s
--    WHERE p.model_id = s.model_id
--      AND p.visibility IS DISTINCT FROM s.pricing_visibility;
--
--   IF (SELECT count(*)
--         FROM model_dsv4pro_disable_snapshots s
--         JOIN model_catalog c ON c.entry_id = s.entry_id AND c.model_id = s.model_id
--         JOIN model_pricing p ON p.model_id = s.model_id
--        WHERE c.state = s.catalog_state
--          AND p.enabled = s.pricing_enabled
--          AND p.visibility = s.pricing_visibility
--          AND c.updated_by IS NOT DISTINCT FROM s.catalog_updated_by
--          AND p.updated_by IS NOT DISTINCT FROM s.pricing_updated_by
--          AND (to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by']) = s.catalog_frozen
--          AND (to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by']) = s.pricing_frozen
--       ) <> 1
--      OR EXISTS (
--        SELECT 1
--          FROM model_dsv4pro_disable_snapshots s
--          JOIN model_catalog c ON c.entry_id = s.entry_id
--         WHERE c.state = 'retired'
--      ) THEN
--     RAISE EXCEPTION '0219 compensation semantic restore failed';
--   END IF;
-- END
-- $compensation$;
-- END TESTED MANUAL COMPENSATION 0219

LOCK TABLE model_catalog, model_pricing, model_runtime_requirements,
  user_preferences, client_sessions, model_visibility_grants,
  account_group_models, model_aliases, model_dsv4pro_transition_snapshots
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE model_dsv4pro_disable_snapshots (
  model_id              TEXT PRIMARY KEY CHECK (model_id = 'deepseek-v4-pro'),
  entry_id               BIGINT NOT NULL UNIQUE,
  catalog_state          TEXT NOT NULL CHECK (catalog_state IN ('active','disabled')),
  catalog_lock_version   INTEGER NOT NULL,
  catalog_updated_by     BIGINT,
  catalog_frozen         JSONB NOT NULL,
  pricing_enabled        BOOLEAN NOT NULL,
  pricing_visibility     TEXT NOT NULL,
  pricing_lock_version   INTEGER NOT NULL,
  pricing_updated_by     BIGINT,
  pricing_frozen         JSONB NOT NULL,
  captured_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (pricing_enabled = (catalog_state = 'active'))
);

COMMENT ON TABLE model_dsv4pro_disable_snapshots IS
  'Permanent ops ledger for 0219. Exact catalog/pricing before-images prove that DeepSeek V4 Pro was disabled rather than retired and fence conditional compensation against later admin intent.';

DO $migration$
DECLARE
  v_target RECORD;
  v_affected INTEGER;
BEGIN
  IF (SELECT count(*) FROM model_catalog
       WHERE model_id = 'deepseek-v4-pro'
         AND state IN ('active','disabled')) <> 1 THEN
    RAISE EXCEPTION '0219 requires exactly one active/disabled deepseek-v4-pro catalog row';
  END IF;

  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'deepseek-v4-pro'
         AND c.state IN ('active','disabled')
         AND p.enabled = (c.state = 'active')) <> 1 THEN
    RAISE EXCEPTION '0219 requires exact catalog/pricing parity for deepseek-v4-pro';
  END IF;

  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'deepseek-v4-flash'
         AND c.state = 'active'
         AND p.enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0219 requires active and enabled deepseek-v4-flash';
  END IF;

  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'deepseek-v4-flash'
         AND requirement = 'official_seed_agent') <> 1
     OR (SELECT count(*) FROM model_runtime_requirements
          WHERE model_id = 'deepseek-v4-flash'
            AND requirement = 'ccb_secondary_utility') <> 1
     OR EXISTS (
       SELECT 1 FROM model_runtime_requirements
        WHERE model_id = 'deepseek-v4-pro'
          AND requirement = 'official_seed_agent'
     ) THEN
    RAISE EXCEPTION '0219 requires official_seed_agent and ccb_secondary_utility on Flash';
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_preferences
     WHERE prefs->>'default_model' = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL
       AND model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0219 requires zero Pro user/session references';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1 FROM account_group_models
     WHERE model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1
      FROM model_aliases a
      JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0219 requires zero Pro grants/group mappings/aliases';
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN (
         'trg_0218_normalize_user_default_model',
         'trg_0218_normalize_client_session_model',
         'trg_0218_normalize_visibility_grant'
       ) AND NOT tgisinternal AND tgenabled = 'O') <> 3
     OR (SELECT count(*) FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN (
              'fn_0218_normalize_user_default_model',
              'fn_0218_normalize_client_session_model',
              'fn_0218_normalize_visibility_grant'
            )) <> 3 THEN
    RAISE EXCEPTION '0219 requires all enabled 0218 write fences and functions';
  END IF;

  INSERT INTO model_dsv4pro_disable_snapshots(
    model_id, entry_id, catalog_state, catalog_lock_version, catalog_updated_by,
    catalog_frozen, pricing_enabled, pricing_visibility, pricing_lock_version,
    pricing_updated_by, pricing_frozen
  )
  SELECT c.model_id, c.entry_id, c.state, c.lock_version, c.updated_by,
         to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by'],
         p.enabled, p.visibility, p.lock_version, p.updated_by,
         to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by']
    FROM model_catalog c
    JOIN model_pricing p USING (model_id)
   WHERE c.model_id = 'deepseek-v4-pro'
     AND c.state IN ('active','disabled');
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION '0219 expected one catalog snapshot, got %', v_affected;
  END IF;

  FOR v_target IN
    SELECT entry_id, lock_version, state
      FROM model_catalog
     WHERE model_id = 'deepseek-v4-pro'
       AND state IN ('active','disabled')
  LOOP
    IF v_target.state = 'active' THEN
      PERFORM fn_model_disable_entry(v_target.entry_id, v_target.lock_version, NULL);
    END IF;
  END LOOP;

  UPDATE model_pricing
     SET visibility = 'hidden',
         lock_version = lock_version + 1,
         updated_at = now()
   WHERE model_id = 'deepseek-v4-pro'
     AND visibility IS DISTINCT FROM 'hidden';
END
$migration$;

DROP TRIGGER trg_0218_normalize_user_default_model ON user_preferences;
DROP TRIGGER trg_0218_normalize_client_session_model ON client_sessions;
DROP TRIGGER trg_0218_normalize_visibility_grant ON model_visibility_grants;
DROP FUNCTION fn_0218_normalize_user_default_model();
DROP FUNCTION fn_0218_normalize_client_session_model();
DROP FUNCTION fn_0218_normalize_visibility_grant();

DO $postcondition$
BEGIN
  IF (SELECT count(*) FROM model_dsv4pro_disable_snapshots) <> 1
     OR (SELECT count(*)
           FROM model_dsv4pro_disable_snapshots s
           JOIN model_catalog c ON c.entry_id = s.entry_id AND c.model_id = s.model_id
           JOIN model_pricing p ON p.model_id = s.model_id
          WHERE c.state = 'disabled'
            AND p.enabled IS FALSE
            AND p.visibility = 'hidden'
            AND c.lock_version = s.catalog_lock_version
                + CASE WHEN s.catalog_state = 'active' THEN 1 ELSE 0 END
            AND p.lock_version = s.pricing_lock_version
                + CASE WHEN s.pricing_visibility <> 'hidden' THEN 1 ELSE 0 END
            AND c.updated_by IS NOT DISTINCT FROM s.catalog_updated_by
            AND p.updated_by IS NOT DISTINCT FROM s.pricing_updated_by
            AND (to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by']) = s.catalog_frozen
            AND (to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by']) = s.pricing_frozen
        ) <> 1 THEN
    RAISE EXCEPTION '0219 catalog snapshot/post-state verification failed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM model_dsv4pro_disable_snapshots s
      JOIN model_catalog c ON c.entry_id = s.entry_id
     WHERE c.state = 'retired'
  ) THEN
    RAISE EXCEPTION '0219 must never retire the live deepseek-v4-pro entry';
  END IF;

  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'deepseek-v4-flash'
         AND requirement = 'official_seed_agent') <> 1
     OR (SELECT count(*) FROM model_runtime_requirements
          WHERE model_id = 'deepseek-v4-flash'
            AND requirement = 'ccb_secondary_utility') <> 1
     OR EXISTS (
       SELECT 1 FROM model_runtime_requirements
        WHERE model_id = 'deepseek-v4-pro'
          AND requirement = 'official_seed_agent'
     ) THEN
    RAISE EXCEPTION '0219 runtime requirement postcondition failed';
  END IF;

  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'deepseek-v4-flash'
         AND c.state = 'active'
         AND p.enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0219 left deepseek-v4-flash unavailable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_preferences
     WHERE prefs->>'default_model' = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL
       AND model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1 FROM account_group_models
     WHERE model_id = 'deepseek-v4-pro'
  ) OR EXISTS (
    SELECT 1 FROM model_aliases a JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id = 'deepseek-v4-pro'
  ) THEN
    RAISE EXCEPTION '0219 left a Pro reference or visibility binding';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname IN (
       'trg_0218_normalize_user_default_model',
       'trg_0218_normalize_client_session_model',
       'trg_0218_normalize_visibility_grant'
     ) AND NOT tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN (
         'fn_0218_normalize_user_default_model',
         'fn_0218_normalize_client_session_model',
         'fn_0218_normalize_visibility_grant'
       )
  ) OR to_regclass('public.model_dsv4pro_transition_snapshots') IS NULL THEN
    RAISE EXCEPTION '0219 temporary-fence cleanup or permanent-ledger preservation failed';
  END IF;
END
$postcondition$;
