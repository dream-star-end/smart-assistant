-- 0218_public_zai_glm53.sql
-- Release B: publish the Release A Z.AI Coding Plan GLM-5.3 rollback floor.
--
-- Accepted input lineages are deliberately narrow:
--   1. the untouched 0217 floor (selfhost applies 0217 -> 0218 in one migration run), or
--   2. one exact audited production verification cycle
--      activate -> canary grant -> grant revoke -> disable.
-- The successful Release A usage/ledger records are durable evidence, not authority bindings,
-- and therefore are intentionally retained.
--
-- Manual rollback keeps the 0218 schema_migrations row. Re-publishing after compensation
-- requires a new migration. Run the tested block under the production mutation lease,
-- migration advisory lock, transaction, and SET LOCAL ROLE openclaude discipline from
-- V5_DEV_PLAYBOOK section 4.5.
--
-- BEGIN TESTED MANUAL ROLLBACK 0218
-- LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
--   model_visibility_grants, account_group_models, user_preferences, client_sessions,
--   admin_audit IN SHARE ROW EXCLUSIVE MODE;
--
-- DO $rollback$
-- DECLARE
--   v_target model_catalog%ROWTYPE;
--   v_affected INTEGER;
--   v_pricing_before JSONB;
--   v_pricing_after JSONB;
--   v_catalog_before JSONB;
--   v_catalog_after JSONB;
--   v_profile JSONB := '{
--     "supports_vision": false,
--     "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
--     "ccb": { "capability_zero": true, "supports_thinking": true }
--   }'::jsonb;
-- BEGIN
--   IF NOT EXISTS (
--     SELECT 1 FROM schema_migrations
--      WHERE version='0218_public_zai_glm53'
--   ) THEN
--     RAISE EXCEPTION '0218 rollback requires its schema_migrations ledger row';
--   END IF;
--
--   IF (SELECT count(*) FROM model_catalog WHERE model_id='glm-5.3-zai') <> 1 THEN
--     RAISE EXCEPTION '0218 rollback requires exactly one target catalog row';
--   END IF;
--   SELECT * INTO STRICT v_target
--     FROM model_catalog WHERE model_id='glm-5.3-zai' FOR UPDATE;
--   PERFORM 1 FROM model_pricing WHERE model_id='glm-5.3-zai' FOR UPDATE;
--
--   IF v_target.state <> 'active'
--      OR v_target.engine <> 'ccb'
--      OR v_target.provider_id <> 'zai'
--      OR v_target.upstream_model_id <> 'glm-5.3'
--      OR v_target.context_window <> 1000000
--      OR v_target.capability_schema_version <> 1
--      OR v_target.capability_profile IS DISTINCT FROM v_profile
--      OR NOT (
--        (v_target.lock_version=3 AND v_target.updated_by IS NULL)
--        OR (v_target.lock_version=5 AND v_target.updated_by=1)
--      ) THEN
--     RAISE EXCEPTION '0218 rollback requires the exact public catalog post-state';
--   END IF;
--
--   IF NOT EXISTS (
--     SELECT 1
--       FROM model_pricing target
--       JOIN model_pricing source ON source.model_id='glm-5.3'
--      WHERE target.model_id='glm-5.3-zai'
--        AND target.display_name='GLM-5.3 (Z.AI)'
--        AND target.input_per_mtok=source.input_per_mtok
--        AND target.output_per_mtok=source.output_per_mtok
--        AND target.cache_read_per_mtok=source.cache_read_per_mtok
--        AND target.cache_write_per_mtok=source.cache_write_per_mtok
--        AND target.multiplier=source.multiplier
--        AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
--        AND target.default_effort IS NOT DISTINCT FROM source.default_effort
--        AND target.enabled IS TRUE
--        AND target.sort_order=84
--        AND target.visibility='public'
--        AND target.lock_version=1
--        AND target.updated_by IS NULL
--   ) THEN
--     RAISE EXCEPTION '0218 rollback requires the exact public pricing post-state';
--   END IF;
--
--   IF EXISTS (
--        SELECT 1 FROM model_aliases a
--        LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
--        WHERE a.alias='glm-5.3-zai' OR c.model_id='glm-5.3-zai'
--      )
--      OR EXISTS (SELECT 1 FROM model_runtime_requirements WHERE model_id='glm-5.3-zai')
--      OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='glm-5.3-zai')
--      OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='glm-5.3-zai')
--      OR EXISTS (SELECT 1 FROM user_preferences
--                  WHERE prefs->>'default_model'='glm-5.3-zai')
--      OR EXISTS (SELECT 1 FROM client_sessions
--                  WHERE deleted_at IS NULL AND model_id='glm-5.3-zai') THEN
--     RAISE EXCEPTION '0218 rollback refuses target authority-binding drift';
--   END IF;
--
--   SELECT to_jsonb(p)-ARRAY['enabled','visibility','lock_version','updated_at']
--     INTO STRICT v_pricing_before
--     FROM model_pricing p WHERE p.model_id='glm-5.3-zai';
--   SELECT to_jsonb(c)-ARRAY['state','lock_version','updated_at']
--     INTO STRICT v_catalog_before
--     FROM model_catalog c WHERE c.entry_id=v_target.entry_id;
--
--   PERFORM fn_model_disable_entry(v_target.entry_id, v_target.lock_version, NULL);
--   UPDATE model_pricing
--      SET visibility='hidden',lock_version=lock_version+1,updated_at=now()
--    WHERE model_id='glm-5.3-zai' AND enabled IS FALSE AND visibility='public';
--   GET DIAGNOSTICS v_affected=ROW_COUNT;
--   IF v_affected <> 1 THEN
--     RAISE EXCEPTION '0218 rollback expected one public pricing row, got %', v_affected;
--   END IF;
--
--   SELECT to_jsonb(p)-ARRAY['enabled','visibility','lock_version','updated_at']
--     INTO STRICT v_pricing_after
--     FROM model_pricing p WHERE p.model_id='glm-5.3-zai';
--   SELECT to_jsonb(c)-ARRAY['state','lock_version','updated_at']
--     INTO STRICT v_catalog_after
--     FROM model_catalog c WHERE c.entry_id=v_target.entry_id;
--   IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
--     RAISE EXCEPTION '0218 rollback changed frozen pricing columns';
--   END IF;
--   IF v_catalog_after IS DISTINCT FROM v_catalog_before THEN
--     RAISE EXCEPTION '0218 rollback changed catalog identity or descriptor';
--   END IF;
--
--   IF NOT EXISTS (
--     SELECT 1 FROM model_catalog c JOIN model_pricing p USING(model_id)
--      WHERE c.entry_id=v_target.entry_id
--        AND c.state='disabled'
--        AND c.lock_version IN (4,6)
--        AND p.enabled IS FALSE
--        AND p.visibility='hidden'
--        AND p.lock_version=2
--   ) THEN
--     RAISE EXCEPTION '0218 rollback hidden floor postcondition failed';
--   END IF;
--   IF EXISTS (
--        SELECT 1 FROM model_aliases a
--        LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
--        WHERE a.alias='glm-5.3-zai' OR c.model_id='glm-5.3-zai'
--      )
--      OR EXISTS (SELECT 1 FROM model_runtime_requirements WHERE model_id='glm-5.3-zai')
--      OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='glm-5.3-zai')
--      OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='glm-5.3-zai')
--      OR EXISTS (SELECT 1 FROM user_preferences
--                  WHERE prefs->>'default_model'='glm-5.3-zai')
--      OR EXISTS (SELECT 1 FROM client_sessions
--                  WHERE deleted_at IS NULL AND model_id='glm-5.3-zai') THEN
--     RAISE EXCEPTION '0218 rollback binding postcondition failed';
--   END IF;
-- END
-- $rollback$;
-- END TESTED MANUAL ROLLBACK 0218

LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
  model_visibility_grants, account_group_models, user_preferences, client_sessions,
  admin_audit IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
DECLARE
  v_target model_catalog%ROWTYPE;
  v_canary_id BIGINT;
  v_a1 admin_audit%ROWTYPE;
  v_a2 admin_audit%ROWTYPE;
  v_a3 admin_audit%ROWTYPE;
  v_a4 admin_audit%ROWTYPE;
  v_affected INTEGER;
  v_pricing_before JSONB;
  v_pricing_after JSONB;
  v_catalog_before JSONB;
  v_catalog_after JSONB;
  v_profile JSONB := '{
    "supports_vision": false,
    "reasoning": { "supported": ["high", "max"], "codex_model_default": null },
    "ccb": { "capability_zero": true, "supports_thinking": true }
  }'::jsonb;
BEGIN
  IF (SELECT count(*) FROM model_catalog WHERE model_id='glm-5.3-zai') <> 1 THEN
    RAISE EXCEPTION '0218 requires exactly one 0217 target catalog row';
  END IF;
  SELECT * INTO STRICT v_target
    FROM model_catalog WHERE model_id='glm-5.3-zai' FOR UPDATE;
  PERFORM 1 FROM model_pricing WHERE model_id='glm-5.3-zai' FOR UPDATE;

  IF v_target.state <> 'disabled'
     OR v_target.engine <> 'ccb'
     OR v_target.provider_id <> 'zai'
     OR v_target.upstream_model_id <> 'glm-5.3'
     OR v_target.context_window <> 1000000
     OR v_target.capability_schema_version <> 1
     OR v_target.capability_profile IS DISTINCT FROM v_profile
     OR NOT (
       (v_target.lock_version=2 AND v_target.updated_by IS NULL)
       OR (v_target.lock_version=4 AND v_target.updated_by=1)
     ) THEN
    RAISE EXCEPTION '0218 requires an exact disabled 0217 catalog lineage';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM model_pricing target
      JOIN model_pricing source ON source.model_id='glm-5.3'
     WHERE target.model_id='glm-5.3-zai'
       AND target.display_name='GLM-5.3 (Z.AI)'
       AND target.input_per_mtok=source.input_per_mtok
       AND target.output_per_mtok=source.output_per_mtok
       AND target.cache_read_per_mtok=source.cache_read_per_mtok
       AND target.cache_write_per_mtok=source.cache_write_per_mtok
       AND target.multiplier=source.multiplier
       AND target.extra_system_prompt IS NOT DISTINCT FROM source.extra_system_prompt
       AND target.default_effort IS NOT DISTINCT FROM source.default_effort
       AND target.enabled IS FALSE
       AND target.sort_order=84
       AND target.visibility='hidden'
       AND target.lock_version=0
       AND target.updated_by IS NULL
  ) THEN
    RAISE EXCEPTION '0218 requires the exact hidden 0217 pricing floor';
  END IF;

  IF EXISTS (
       SELECT 1 FROM model_aliases a
       LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
       WHERE a.alias='glm-5.3-zai' OR c.model_id='glm-5.3-zai'
     )
     OR EXISTS (SELECT 1 FROM model_runtime_requirements WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM user_preferences
                 WHERE prefs->>'default_model'='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM client_sessions
                 WHERE deleted_at IS NULL AND model_id='glm-5.3-zai') THEN
    RAISE EXCEPTION '0218 refuses target authority bindings before publication';
  END IF;

  IF v_target.lock_version=2 THEN
    IF EXISTS (
      SELECT 1 FROM admin_audit
       WHERE target='model_catalog:'||v_target.entry_id::text
          OR target LIKE 'user:%/model:glm-5.3-zai'
    ) THEN
      RAISE EXCEPTION '0218 untouched lineage refuses target verification audit drift';
    END IF;
  ELSE
    SELECT id INTO STRICT v_canary_id
      FROM users WHERE email='v5-canary@claudeai.chat';
    IF (SELECT count(*) FROM admin_audit
         WHERE target='model_catalog:'||v_target.entry_id::text
            OR target LIKE 'user:%/model:glm-5.3-zai') <> 4 THEN
      RAISE EXCEPTION '0218 verified lineage requires exactly four target audit rows';
    END IF;
    SELECT * INTO STRICT v_a1 FROM admin_audit
     WHERE target='model_catalog:'||v_target.entry_id::text
        OR target LIKE 'user:%/model:glm-5.3-zai'
     ORDER BY id LIMIT 1 OFFSET 0;
    SELECT * INTO STRICT v_a2 FROM admin_audit
     WHERE target='model_catalog:'||v_target.entry_id::text
        OR target LIKE 'user:%/model:glm-5.3-zai'
     ORDER BY id LIMIT 1 OFFSET 1;
    SELECT * INTO STRICT v_a3 FROM admin_audit
     WHERE target='model_catalog:'||v_target.entry_id::text
        OR target LIKE 'user:%/model:glm-5.3-zai'
     ORDER BY id LIMIT 1 OFFSET 2;
    SELECT * INTO STRICT v_a4 FROM admin_audit
     WHERE target='model_catalog:'||v_target.entry_id::text
        OR target LIKE 'user:%/model:glm-5.3-zai'
     ORDER BY id LIMIT 1 OFFSET 3;

    IF v_a1.admin_id <> 1 OR v_a2.admin_id <> 1
       OR v_a3.admin_id <> 1 OR v_a4.admin_id <> 1
       OR v_a1.action <> 'model_catalog.activate'
       OR v_a1.target <> 'model_catalog:'||v_target.entry_id::text
       OR v_a1.before IS DISTINCT FROM '{"state":"disabled","lock_version":2}'::jsonb
       OR v_a1.after IS DISTINCT FROM '{"state":"active","model_id":"glm-5.3-zai"}'::jsonb
       OR v_a2.action <> 'model_grant.add'
       OR v_a2.target <> 'user:'||v_canary_id::text||'/model:glm-5.3-zai'
       OR v_a2.before IS DISTINCT FROM 'null'::jsonb
       OR v_a2.after IS DISTINCT FROM jsonb_build_object(
            'user_id',v_canary_id::text,'model_id','glm-5.3-zai','granted_by','1')
       OR v_a3.action <> 'model_grant.remove'
       OR v_a3.target <> 'user:'||v_canary_id::text||'/model:glm-5.3-zai'
       OR v_a3.after IS DISTINCT FROM 'null'::jsonb
       OR v_a3.before-'granted_at'
          IS DISTINCT FROM jsonb_build_object(
            'user_id',v_canary_id::text,'model_id','glm-5.3-zai','granted_by','1')
       OR jsonb_typeof(v_a3.before->'granted_at') <> 'object'
       OR v_a4.action <> 'model_catalog.disable'
       OR v_a4.target <> 'model_catalog:'||v_target.entry_id::text
       OR v_a4.before IS DISTINCT FROM '{"state":"active","lock_version":3}'::jsonb
       OR v_a4.after IS DISTINCT FROM '{"state":"disabled","model_id":"glm-5.3-zai"}'::jsonb THEN
      RAISE EXCEPTION '0218 verified lineage audit sequence mismatch';
    END IF;
  END IF;

  SELECT to_jsonb(p)-ARRAY['enabled','visibility','lock_version','updated_at']
    INTO STRICT v_pricing_before
    FROM model_pricing p WHERE p.model_id='glm-5.3-zai';
  SELECT to_jsonb(c)-ARRAY['state','lock_version','updated_at']
    INTO STRICT v_catalog_before
    FROM model_catalog c WHERE c.entry_id=v_target.entry_id;

  PERFORM fn_model_activate_entry(v_target.entry_id, v_target.lock_version, NULL);
  UPDATE model_pricing
     SET visibility='public',lock_version=lock_version+1,updated_at=now()
   WHERE model_id='glm-5.3-zai' AND enabled IS TRUE AND visibility='hidden';
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION '0218 expected one hidden pricing row, got %', v_affected;
  END IF;

  SELECT to_jsonb(p)-ARRAY['enabled','visibility','lock_version','updated_at']
    INTO STRICT v_pricing_after
    FROM model_pricing p WHERE p.model_id='glm-5.3-zai';
  SELECT to_jsonb(c)-ARRAY['state','lock_version','updated_at']
    INTO STRICT v_catalog_after
    FROM model_catalog c WHERE c.entry_id=v_target.entry_id;
  IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
    RAISE EXCEPTION '0218 changed frozen pricing columns';
  END IF;
  IF v_catalog_after IS DISTINCT FROM v_catalog_before THEN
    RAISE EXCEPTION '0218 changed catalog identity or descriptor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING(model_id)
     WHERE c.entry_id=v_target.entry_id
       AND c.state='active'
       AND c.lock_version IN (3,5)
       AND p.enabled IS TRUE
       AND p.visibility='public'
       AND p.lock_version=1
  ) THEN
    RAISE EXCEPTION '0218 public activation postcondition failed';
  END IF;
  IF EXISTS (
       SELECT 1 FROM model_aliases a
       LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
       WHERE a.alias='glm-5.3-zai' OR c.model_id='glm-5.3-zai'
     )
     OR EXISTS (SELECT 1 FROM model_runtime_requirements WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM user_preferences
                 WHERE prefs->>'default_model'='glm-5.3-zai')
     OR EXISTS (SELECT 1 FROM client_sessions
                 WHERE deleted_at IS NULL AND model_id='glm-5.3-zai') THEN
    RAISE EXCEPTION '0218 public model must not gain authority bindings';
  END IF;
END
$migration$;
