-- 0214 — disable and hide the four legacy defaults after GLM-5.3 cutover.
--
-- This is intentionally a disable transition, never a retirement transition. Historical
-- catalog rows and usage remain addressable for audit while every executable/discovery
-- surface is closed. Migration 0213's temporary write fences are removed only after the
-- catalog state, pricing state, runtime requirement, and persisted-reference postconditions
-- are all true in the same transaction.
--
-- Manual compensation keeps the 0214 schema_migrations ledger row. Run the tested block
-- below under V5_DEV_PLAYBOOK.md §4.5's production mutation lease, advisory lock,
-- transaction, and SET LOCAL ROLE openclaude discipline. It restores semantic availability
-- from the immutable before-image ledger but deliberately does not recreate 0213's obsolete
-- deploy-gap fences. Publishing C2 again after compensation requires a new migration.

-- BEGIN TESTED MANUAL COMPENSATION 0214
-- LOCK TABLE model_catalog, model_pricing, model_runtime_requirements,
--   user_preferences, client_sessions, model_visibility_grants,
--   account_group_models, model_aliases, model_legacy_disable_snapshots
--   IN SHARE ROW EXCLUSIVE MODE;
--
-- DO $compensation$
-- DECLARE
--   v_target RECORD;
--   v_affected INTEGER;
-- BEGIN
--   IF (SELECT count(*) FROM model_legacy_disable_snapshots) <> 4 THEN
--     RAISE EXCEPTION '0214 compensation requires exactly four before-images';
--   END IF;
--
--   IF (SELECT count(*)
--         FROM model_legacy_disable_snapshots s
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
--       ) <> 4 THEN
--     RAISE EXCEPTION '0214 compensation refuses catalog/pricing drift after disable';
--   END IF;
--
--   IF EXISTS (
--     SELECT 1 FROM user_preferences
--      WHERE prefs->>'default_model' IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
--   ) OR EXISTS (
--     SELECT 1 FROM client_sessions
--      WHERE deleted_at IS NULL
--        AND model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
--   ) THEN
--     RAISE EXCEPTION '0214 compensation refuses legacy persisted references';
--   END IF;
--
--   IF EXISTS (
--     SELECT 1 FROM model_visibility_grants
--      WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
--   ) OR EXISTS (
--     SELECT 1 FROM account_group_models
--      WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
--   ) OR EXISTS (
--     SELECT 1
--       FROM model_aliases a
--       JOIN model_catalog c ON c.entry_id = a.entry_id
--      WHERE c.model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
--   ) THEN
--     RAISE EXCEPTION '0214 compensation refuses legacy grants/group mappings/aliases';
--   END IF;
--
--   IF (SELECT count(*) FROM model_runtime_requirements
--        WHERE model_id = 'glm-5.3'
--          AND requirement = 'platform_default_and_hidden_reviewer') <> 1
--      OR EXISTS (
--        SELECT 1 FROM model_runtime_requirements
--         WHERE model_id = 'glm-5.2'
--           AND requirement = 'platform_default_and_hidden_reviewer'
--      ) THEN
--     RAISE EXCEPTION '0214 compensation requires the exact GLM-5.3 runtime requirement';
--   END IF;
--
--   FOR v_target IN
--     SELECT s.entry_id, c.lock_version
--       FROM model_legacy_disable_snapshots s
--       JOIN model_catalog c ON c.entry_id = s.entry_id
--      WHERE s.catalog_state = 'active'
--      ORDER BY s.model_id
--   LOOP
--     PERFORM fn_model_activate_entry(v_target.entry_id, v_target.lock_version, NULL);
--   END LOOP;
--
--   UPDATE model_pricing p
--      SET visibility = s.pricing_visibility,
--          updated_by = s.pricing_updated_by,
--          lock_version = p.lock_version + 1,
--          updated_at = now()
--     FROM model_legacy_disable_snapshots s
--    WHERE p.model_id = s.model_id
--      AND p.visibility IS DISTINCT FROM s.pricing_visibility;
--
--   DELETE FROM model_runtime_requirements
--    WHERE model_id = 'glm-5.3'
--      AND requirement = 'platform_default_and_hidden_reviewer';
--   GET DIAGNOSTICS v_affected = ROW_COUNT;
--   IF v_affected <> 1 THEN
--     RAISE EXCEPTION '0214 compensation expected one GLM-5.3 requirement, got %', v_affected;
--   END IF;
--
--   INSERT INTO model_runtime_requirements(model_id, requirement)
--   VALUES ('glm-5.2', 'platform_default_and_hidden_reviewer');
--
--   IF (SELECT count(*)
--         FROM model_legacy_disable_snapshots s
--         JOIN model_catalog c ON c.entry_id = s.entry_id AND c.model_id = s.model_id
--         JOIN model_pricing p ON p.model_id = s.model_id
--        WHERE c.state = s.catalog_state
--          AND p.enabled = s.pricing_enabled
--          AND p.visibility = s.pricing_visibility
--          AND c.updated_by IS NOT DISTINCT FROM s.catalog_updated_by
--          AND p.updated_by IS NOT DISTINCT FROM s.pricing_updated_by
--          AND (to_jsonb(c) - ARRAY['state','lock_version','updated_at','updated_by']) = s.catalog_frozen
--          AND (to_jsonb(p) - ARRAY['enabled','visibility','lock_version','updated_at','updated_by']) = s.pricing_frozen
--       ) <> 4
--      OR EXISTS (
--        SELECT 1 FROM model_catalog
--         WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
--           AND state = 'retired'
--      ) THEN
--     RAISE EXCEPTION '0214 compensation semantic restore failed';
--   END IF;
-- END
-- $compensation$;
-- END TESTED MANUAL COMPENSATION 0214

LOCK TABLE model_catalog, model_pricing, model_runtime_requirements,
  user_preferences, client_sessions, model_visibility_grants,
  account_group_models, model_aliases, model_default_transition_snapshots
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE model_legacy_disable_snapshots (
  model_id              TEXT PRIMARY KEY CHECK (
                          model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
                        ),
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

COMMENT ON TABLE model_legacy_disable_snapshots IS
  'Permanent ops ledger for 0214. Exact catalog/pricing before-images prove that legacy models were disabled rather than retired and fence conditional compensation against later admin intent.';

DO $migration$
DECLARE
  v_target RECORD;
  v_affected INTEGER;
BEGIN
  IF (SELECT count(*) FROM model_catalog
       WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')) <> 4
     OR (SELECT count(*) FROM model_catalog
          WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
            AND state IN ('active','disabled')) <> 4 THEN
    RAISE EXCEPTION '0214 requires exactly one active/disabled catalog row per legacy model';
  END IF;

  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
         AND c.state IN ('active','disabled')
         AND p.enabled = (c.state = 'active')) <> 4 THEN
    RAISE EXCEPTION '0214 requires exact catalog/pricing parity for four legacy models';
  END IF;

  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'glm-5.3'
         AND c.state = 'active'
         AND p.enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0214 requires active and enabled glm-5.3';
  END IF;

  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'glm-5.2'
         AND requirement = 'platform_default_and_hidden_reviewer') <> 1
     OR EXISTS (
       SELECT 1 FROM model_runtime_requirements
        WHERE model_id = 'glm-5.3'
          AND requirement = 'platform_default_and_hidden_reviewer'
     ) THEN
    RAISE EXCEPTION '0214 requires the pre-cutover GLM-5.2 runtime requirement';
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_preferences
     WHERE prefs->>'default_model' IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) OR EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL
       AND model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) THEN
    RAISE EXCEPTION '0214 requires zero legacy user/session references';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) OR EXISTS (
    SELECT 1 FROM account_group_models
     WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) OR EXISTS (
    SELECT 1
      FROM model_aliases a
      JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) THEN
    RAISE EXCEPTION '0214 requires zero legacy grants/group mappings/aliases';
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN (
         'trg_0213_normalize_user_default_model',
         'trg_0213_normalize_client_session_model'
       ) AND NOT tgisinternal AND tgenabled = 'O') <> 2
     OR (SELECT count(*) FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN (
              'fn_0213_normalize_user_default_model',
              'fn_0213_normalize_client_session_model'
            )) <> 2 THEN
    RAISE EXCEPTION '0214 requires both enabled 0213 write fences and functions';
  END IF;

  INSERT INTO model_legacy_disable_snapshots(
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
   WHERE c.model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
   ORDER BY c.model_id;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 4 THEN
    RAISE EXCEPTION '0214 expected four catalog snapshots, got %', v_affected;
  END IF;

  DELETE FROM model_runtime_requirements
   WHERE model_id = 'glm-5.2'
     AND requirement = 'platform_default_and_hidden_reviewer';
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION '0214 expected one GLM-5.2 requirement, got %', v_affected;
  END IF;

  INSERT INTO model_runtime_requirements(model_id, requirement)
  VALUES ('glm-5.3', 'platform_default_and_hidden_reviewer');

  FOR v_target IN
    SELECT entry_id, lock_version, state
      FROM model_catalog
     WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
     ORDER BY model_id
  LOOP
    IF v_target.state = 'active' THEN
      PERFORM fn_model_disable_entry(v_target.entry_id, v_target.lock_version, NULL);
    END IF;
  END LOOP;

  UPDATE model_pricing
     SET visibility = 'hidden',
         lock_version = lock_version + 1,
         updated_at = now()
   WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
     AND visibility IS DISTINCT FROM 'hidden';
END
$migration$;

DROP TRIGGER trg_0213_normalize_user_default_model ON user_preferences;
DROP TRIGGER trg_0213_normalize_client_session_model ON client_sessions;
DROP FUNCTION fn_0213_normalize_user_default_model();
DROP FUNCTION fn_0213_normalize_client_session_model();

DO $postcondition$
BEGIN
  IF (SELECT count(*) FROM model_legacy_disable_snapshots) <> 4
     OR (SELECT count(*)
           FROM model_legacy_disable_snapshots s
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
        ) <> 4 THEN
    RAISE EXCEPTION '0214 catalog snapshot/post-state verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
       AND state = 'retired'
  ) THEN
    RAISE EXCEPTION '0214 must never retire a legacy model';
  END IF;

  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'glm-5.3'
         AND requirement = 'platform_default_and_hidden_reviewer') <> 1
     OR EXISTS (
       SELECT 1 FROM model_runtime_requirements
        WHERE model_id = 'glm-5.2'
          AND requirement = 'platform_default_and_hidden_reviewer'
     ) THEN
    RAISE EXCEPTION '0214 runtime requirement transition failed';
  END IF;

  IF (SELECT count(*)
        FROM model_catalog c
        JOIN model_pricing p USING (model_id)
       WHERE c.model_id = 'glm-5.3'
         AND c.state = 'active'
         AND p.enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0214 left glm-5.3 unavailable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_preferences
     WHERE prefs->>'default_model' IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) OR EXISTS (
    SELECT 1 FROM client_sessions
     WHERE deleted_at IS NULL
       AND model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) OR EXISTS (
    SELECT 1 FROM model_visibility_grants
     WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) OR EXISTS (
    SELECT 1 FROM account_group_models
     WHERE model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) OR EXISTS (
    SELECT 1 FROM model_aliases a JOIN model_catalog c ON c.entry_id = a.entry_id
     WHERE c.model_id IN ('qwen3.7-max','qwen3.7-plus','glm-5.1','glm-5.2')
  ) THEN
    RAISE EXCEPTION '0214 left a legacy reference or visibility binding';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname IN (
       'trg_0213_normalize_user_default_model',
       'trg_0213_normalize_client_session_model'
     ) AND NOT tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN (
         'fn_0213_normalize_user_default_model',
         'fn_0213_normalize_client_session_model'
       )
  ) OR to_regclass('public.model_default_transition_snapshots') IS NULL THEN
    RAISE EXCEPTION '0214 temporary-fence cleanup or permanent-ledger preservation failed';
  END IF;
END
$postcondition$;
