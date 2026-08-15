-- 0216_kimi_k3_256k.sql
-- Publish Moonshot Kimi Code's explicit 256K model and expose the verified
-- low/high/max effort contract on both Moonshot K3 entries.
--
-- k3-256k uses the same Kimi Coding subscription route as kimi-k3.  The
-- upstream advertises a 262144-token context window and charges about half
-- as much as k3, so the platform price is exactly half of the existing
-- kimi-k3 row.  No default_effort is stored: upstream default high remains
-- authoritative when the caller omits output_config.effort.
--
-- This migration is intentionally fail-closed.  It only accepts the exact
-- 0160 predecessor or its own exact terminal lineage.  The permanent ledger
-- is also the fence used by the tested manual compensation below.

CREATE TABLE IF NOT EXISTS model_k3_256k_transition (
  id                           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  legacy_catalog_before        JSONB NOT NULL,
  legacy_pricing_before        JSONB NOT NULL,
  aliases_before               JSONB NOT NULL,
  requirements_before          JSONB NOT NULL,
  legacy_retired_after         JSONB NOT NULL,
  legacy_catalog_after         JSONB NOT NULL,
  legacy_pricing_after         JSONB NOT NULL,
  target_catalog_after         JSONB NOT NULL,
  target_pricing_after         JSONB NOT NULL,
  aliases_after                JSONB NOT NULL,
  requirements_after           JSONB NOT NULL,
  legacy_after_entry_id        BIGINT NOT NULL UNIQUE,
  target_entry_id              BIGINT NOT NULL UNIQUE,
  restored_legacy_entry_id     BIGINT UNIQUE,
  migrated_at                  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  compensated_at               TIMESTAMPTZ
);

COMMENT ON TABLE model_k3_256k_transition IS
  '0216 permanent Kimi K3 capability/publication ledger and compensation fence.';

-- Manual compensation: keep both this transition ledger and the
-- 0216_kimi_k3_256k schema_migrations row.  Run the block under the production
-- mutation lease + migration advisory lock + transaction + SET LOCAL ROLE
-- openclaude discipline from V5_DEV_PLAYBOOK.md section 4.5.  Compensation is
-- deliberately refused after any target binding/use drift.  Republishing then
-- requires a new migration; rerunning 0216 is rejected.
--
-- BEGIN TESTED MANUAL COMPENSATION 0216
-- LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
--   model_visibility_grants, account_group_models, user_preferences, client_sessions,
--   model_k3_256k_transition IN SHARE ROW EXCLUSIVE MODE;
--
-- DO $compensation$
-- DECLARE
--   v_transition model_k3_256k_transition%ROWTYPE;
--   v_legacy model_catalog%ROWTYPE;
--   v_target model_catalog%ROWTYPE;
--   v_restored_entry BIGINT;
--   v_current_aliases JSONB;
--   v_current_requirements JSONB;
--   v_old_profile JSONB := '{
--     "supports_vision": true,
--     "reasoning": { "supported": [], "codex_model_default": null },
--     "ccb": { "capability_zero": true, "supports_thinking": true }
--   }'::jsonb;
-- BEGIN
--   SELECT * INTO STRICT v_transition
--     FROM model_k3_256k_transition WHERE id FOR UPDATE;
--   IF v_transition.compensated_at IS NOT NULL THEN
--     RAISE EXCEPTION '0216 compensation already completed';
--   END IF;
--
--   IF (SELECT count(*) FROM model_catalog WHERE model_id='kimi-k3') <> 2
--      OR (SELECT count(*) FROM model_catalog WHERE model_id='k3-256k') <> 1 THEN
--     RAISE EXCEPTION '0216 compensation refuses catalog lineage drift';
--   END IF;
--
--   SELECT * INTO STRICT v_legacy
--     FROM model_catalog WHERE entry_id=v_transition.legacy_after_entry_id FOR UPDATE;
--   SELECT * INTO STRICT v_target
--     FROM model_catalog WHERE entry_id=v_transition.target_entry_id FOR UPDATE;
--   IF to_jsonb(v_legacy) IS DISTINCT FROM v_transition.legacy_catalog_after
--      OR to_jsonb(v_target) IS DISTINCT FROM v_transition.target_catalog_after
--      OR (SELECT to_jsonb(c) FROM model_catalog c
--           WHERE c.entry_id=(v_transition.legacy_catalog_before->>'entry_id')::bigint)
--         IS DISTINCT FROM v_transition.legacy_retired_after THEN
--     RAISE EXCEPTION '0216 compensation refuses catalog descriptor drift';
--   END IF;
--   IF (SELECT to_jsonb(p) FROM model_pricing p WHERE p.model_id='kimi-k3')
--        IS DISTINCT FROM v_transition.legacy_pricing_after
--      OR (SELECT to_jsonb(p) FROM model_pricing p WHERE p.model_id='k3-256k')
--        IS DISTINCT FROM v_transition.target_pricing_after THEN
--     RAISE EXCEPTION '0216 compensation refuses pricing drift';
--   END IF;
--
--   SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.alias),'[]'::jsonb)
--     INTO v_current_aliases
--     FROM model_aliases a
--     JOIN model_catalog c ON c.entry_id=a.entry_id
--    WHERE a.alias='k3-256k' OR c.model_id IN ('kimi-k3','k3-256k');
--   IF v_current_aliases IS DISTINCT FROM v_transition.aliases_after THEN
--     RAISE EXCEPTION '0216 compensation refuses alias drift';
--   END IF;
--
--   SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.model_id,r.requirement),'[]'::jsonb)
--     INTO v_current_requirements
--     FROM model_runtime_requirements r
--    WHERE r.model_id IN ('kimi-k3','k3-256k');
--   IF v_current_requirements IS DISTINCT FROM v_transition.requirements_after THEN
--     RAISE EXCEPTION '0216 compensation refuses runtime requirement drift';
--   END IF;
--
--   IF EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='k3-256k')
--      OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='k3-256k') THEN
--     RAISE EXCEPTION '0216 compensation refuses target grant/group mapping drift';
--   END IF;
--   IF EXISTS (SELECT 1 FROM user_preferences
--               WHERE prefs->>'default_model'='k3-256k')
--      OR EXISTS (SELECT 1 FROM client_sessions
--                  WHERE deleted_at IS NULL AND model_id='k3-256k') THEN
--     RAISE EXCEPTION '0216 compensation refuses target default/live session drift';
--   END IF;
--
--   PERFORM fn_model_disable_entry(
--     v_target.entry_id,
--     v_target.lock_version,
--     NULL
--   );
--   UPDATE model_pricing
--      SET visibility='hidden',lock_version=lock_version+1,updated_at=now()
--    WHERE model_id='k3-256k' AND enabled IS FALSE AND visibility='public';
--   IF NOT FOUND THEN
--     RAISE EXCEPTION '0216 compensation failed to hide k3-256k pricing';
--   END IF;
--
--   SELECT fn_model_switch_version(
--     'kimi-k3',
--     v_transition.legacy_catalog_before->>'engine',
--     v_transition.legacy_catalog_before->>'provider_id',
--     v_transition.legacy_catalog_before->>'upstream_model_id',
--     (v_transition.legacy_catalog_before->>'context_window')::integer,
--     v_old_profile,
--     (v_transition.legacy_catalog_before->>'capability_schema_version')::integer,
--     (v_transition.legacy_catalog_before->>'updated_by')::bigint,
--     v_legacy.lock_version
--   ) INTO v_restored_entry;
--
--   UPDATE model_k3_256k_transition
--      SET restored_legacy_entry_id=v_restored_entry,
--          compensated_at=clock_timestamp()
--    WHERE id AND compensated_at IS NULL;
--   IF NOT FOUND THEN
--     RAISE EXCEPTION '0216 compensation ledger fence changed concurrently';
--   END IF;
--
--   IF (SELECT count(*) FROM model_catalog
--        WHERE entry_id=v_restored_entry AND model_id='kimi-k3' AND state='active'
--          AND engine='ccb' AND provider_id='moonshot' AND upstream_model_id IS NULL
--          AND context_window=1048576 AND capability_schema_version=1
--          AND capability_profile=v_old_profile) <> 1
--      OR (SELECT count(*) FROM model_catalog
--          WHERE entry_id=v_transition.target_entry_id AND model_id='k3-256k'
--            AND state='disabled') <> 1
--      OR NOT EXISTS (SELECT 1 FROM model_pricing
--          WHERE model_id='kimi-k3' AND enabled IS TRUE AND visibility='public')
--      OR NOT EXISTS (SELECT 1 FROM model_pricing
--          WHERE model_id='k3-256k' AND enabled IS FALSE AND visibility='hidden') THEN
--     RAISE EXCEPTION '0216 compensation postcondition failed';
--   END IF;
--   IF EXISTS (SELECT 1 FROM model_aliases a JOIN model_catalog c ON c.entry_id=a.entry_id
--               WHERE a.alias='k3-256k' OR c.model_id='k3-256k')
--      OR v_current_requirements IS DISTINCT FROM v_transition.requirements_before THEN
--     RAISE EXCEPTION '0216 compensation binding postcondition failed';
--   END IF;
-- END
-- $compensation$;
-- END TESTED MANUAL COMPENSATION 0216

LOCK TABLE model_catalog, model_pricing, model_aliases, model_runtime_requirements,
  model_visibility_grants, account_group_models, user_preferences, client_sessions,
  model_k3_256k_transition IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
DECLARE
  v_transition model_k3_256k_transition%ROWTYPE;
  v_legacy model_catalog%ROWTYPE;
  v_legacy_pricing model_pricing%ROWTYPE;
  v_legacy_after_entry BIGINT;
  v_target_entry BIGINT;
  v_aliases_before JSONB;
  v_aliases_after JSONB;
  v_requirements_before JSONB;
  v_requirements_after JSONB;
  v_old_profile JSONB := '{
    "supports_vision": true,
    "reasoning": { "supported": [], "codex_model_default": null },
    "ccb": { "capability_zero": true, "supports_thinking": true }
  }'::jsonb;
  v_k3_profile JSONB := '{
    "supports_vision": true,
    "reasoning": { "supported": ["low", "high", "max"], "codex_model_default": null },
    "ccb": { "capability_zero": true, "supports_thinking": true }
  }'::jsonb;
BEGIN
  IF (SELECT count(*) FROM model_k3_256k_transition) > 1 THEN
    RAISE EXCEPTION '0216 transition ledger cardinality drift';
  END IF;
  SELECT * INTO v_transition FROM model_k3_256k_transition WHERE id FOR UPDATE;
  IF FOUND THEN
    IF v_transition.compensated_at IS NOT NULL THEN
      RAISE EXCEPTION '0216 was compensated and cannot be re-published';
    END IF;
    IF (SELECT count(*) FROM model_catalog WHERE model_id='kimi-k3') <> 2
       OR (SELECT count(*) FROM model_catalog WHERE model_id='k3-256k') <> 1
       OR (SELECT to_jsonb(c) FROM model_catalog c
            WHERE c.entry_id=(v_transition.legacy_catalog_before->>'entry_id')::bigint)
          IS DISTINCT FROM v_transition.legacy_retired_after
       OR (SELECT to_jsonb(c) FROM model_catalog c
            WHERE c.entry_id=v_transition.legacy_after_entry_id)
          IS DISTINCT FROM v_transition.legacy_catalog_after
       OR (SELECT to_jsonb(c) FROM model_catalog c
            WHERE c.entry_id=v_transition.target_entry_id)
          IS DISTINCT FROM v_transition.target_catalog_after
       OR (SELECT to_jsonb(p) FROM model_pricing p WHERE p.model_id='kimi-k3')
          IS DISTINCT FROM v_transition.legacy_pricing_after
       OR (SELECT to_jsonb(p) FROM model_pricing p WHERE p.model_id='k3-256k')
          IS DISTINCT FROM v_transition.target_pricing_after THEN
      RAISE EXCEPTION '0216 exact terminal catalog/pricing lineage drift';
    END IF;
    SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.alias),'[]'::jsonb)
      INTO v_aliases_after
      FROM model_aliases a
      JOIN model_catalog c ON c.entry_id=a.entry_id
     WHERE a.alias='k3-256k' OR c.model_id IN ('kimi-k3','k3-256k');
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.model_id,r.requirement),'[]'::jsonb)
      INTO v_requirements_after
      FROM model_runtime_requirements r
     WHERE r.model_id IN ('kimi-k3','k3-256k');
    IF v_aliases_after IS DISTINCT FROM v_transition.aliases_after
       OR v_requirements_after IS DISTINCT FROM v_transition.requirements_after THEN
      RAISE EXCEPTION '0216 exact terminal binding lineage drift';
    END IF;
    RETURN;
  END IF;

  IF (SELECT count(*) FROM model_catalog WHERE model_id='kimi-k3') <> 1 THEN
    RAISE EXCEPTION '0216 kimi-k3 catalog lineage precondition failed';
  END IF;
  SELECT * INTO STRICT v_legacy
    FROM model_catalog WHERE model_id='kimi-k3' AND state='active' FOR UPDATE;
  SELECT * INTO STRICT v_legacy_pricing
    FROM model_pricing WHERE model_id='kimi-k3' FOR UPDATE;

  IF v_legacy.engine <> 'ccb' OR v_legacy.provider_id <> 'moonshot'
     OR v_legacy.upstream_model_id IS NOT NULL OR v_legacy.context_window <> 1048576
     OR v_legacy.capability_profile IS DISTINCT FROM v_old_profile
     OR v_legacy.capability_schema_version <> 1 THEN
    RAISE EXCEPTION '0216 kimi-k3 catalog predecessor precondition failed';
  END IF;
  IF v_legacy_pricing.display_name <> 'Kimi K3'
     OR v_legacy_pricing.input_per_mtok <> 1000
     OR v_legacy_pricing.output_per_mtok <> 5000
     OR v_legacy_pricing.cache_read_per_mtok <> 100
     OR v_legacy_pricing.cache_write_per_mtok <> 0
     OR v_legacy_pricing.multiplier <> 1.000
     OR v_legacy_pricing.enabled IS NOT TRUE
     OR v_legacy_pricing.sort_order <> 89
     OR v_legacy_pricing.visibility <> 'public'
     OR v_legacy_pricing.extra_system_prompt IS NOT NULL
     OR v_legacy_pricing.default_effort IS NOT NULL THEN
    RAISE EXCEPTION '0216 kimi-k3 pricing predecessor precondition failed';
  END IF;
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id='k3-256k')
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id='k3-256k')
     OR EXISTS (SELECT 1 FROM model_aliases a LEFT JOIN model_catalog c ON c.entry_id=a.entry_id
                WHERE a.alias='k3-256k' OR c.model_id='k3-256k')
     OR EXISTS (SELECT 1 FROM model_runtime_requirements WHERE model_id='k3-256k')
     OR EXISTS (SELECT 1 FROM model_visibility_grants WHERE model_id='k3-256k')
     OR EXISTS (SELECT 1 FROM account_group_models WHERE model_id='k3-256k')
     OR EXISTS (SELECT 1 FROM user_preferences WHERE prefs->>'default_model'='k3-256k')
     OR EXISTS (SELECT 1 FROM client_sessions WHERE model_id='k3-256k') THEN
    RAISE EXCEPTION '0216 refuses pre-existing k3-256k catalog/pricing/binding references';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.alias),'[]'::jsonb)
    INTO v_aliases_before
    FROM model_aliases a JOIN model_catalog c ON c.entry_id=a.entry_id
   WHERE c.model_id='kimi-k3';
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.model_id,r.requirement),'[]'::jsonb)
    INTO v_requirements_before
    FROM model_runtime_requirements r
   WHERE r.model_id IN ('kimi-k3','k3-256k');

  SELECT fn_model_switch_version(
    'kimi-k3','ccb','moonshot',NULL,1048576,
    v_k3_profile,1,NULL,v_legacy.lock_version
  ) INTO v_legacy_after_entry;

  SELECT fn_model_stage_version(
    'k3-256k','ccb','moonshot',NULL,262144,
    v_k3_profile,1,NULL
  ) INTO v_target_entry;
  PERFORM fn_model_activate('k3-256k',NULL);

  INSERT INTO model_pricing (
    model_id,display_name,input_per_mtok,output_per_mtok,
    cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled,
    sort_order,visibility,extra_system_prompt,default_effort,updated_by
  ) VALUES (
    'k3-256k','Kimi K3 256K',500,2500,50,0,
    v_legacy_pricing.multiplier,TRUE,90,'public',NULL,NULL,NULL
  );

  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.alias),'[]'::jsonb)
    INTO v_aliases_after
    FROM model_aliases a JOIN model_catalog c ON c.entry_id=a.entry_id
   WHERE a.alias='k3-256k' OR c.model_id IN ('kimi-k3','k3-256k');
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.model_id,r.requirement),'[]'::jsonb)
    INTO v_requirements_after
    FROM model_runtime_requirements r
   WHERE r.model_id IN ('kimi-k3','k3-256k');

  INSERT INTO model_k3_256k_transition (
    legacy_catalog_before,legacy_pricing_before,aliases_before,requirements_before,
    legacy_retired_after,legacy_catalog_after,legacy_pricing_after,
    target_catalog_after,target_pricing_after,aliases_after,requirements_after,
    legacy_after_entry_id,target_entry_id
  ) VALUES (
    to_jsonb(v_legacy),to_jsonb(v_legacy_pricing),v_aliases_before,v_requirements_before,
    (SELECT to_jsonb(c) FROM model_catalog c WHERE c.entry_id=v_legacy.entry_id),
    (SELECT to_jsonb(c) FROM model_catalog c WHERE c.entry_id=v_legacy_after_entry),
    (SELECT to_jsonb(p) FROM model_pricing p WHERE p.model_id='kimi-k3'),
    (SELECT to_jsonb(c) FROM model_catalog c WHERE c.entry_id=v_target_entry),
    (SELECT to_jsonb(p) FROM model_pricing p WHERE p.model_id='k3-256k'),
    v_aliases_after,v_requirements_after,v_legacy_after_entry,v_target_entry
  );
END
$migration$;

DO $postcondition$
DECLARE
  v_k3_profile JSONB := '{
    "supports_vision": true,
    "reasoning": { "supported": ["low", "high", "max"], "codex_model_default": null },
    "ccb": { "capability_zero": true, "supports_thinking": true }
  }'::jsonb;
BEGIN
  IF (SELECT count(*) FROM model_k3_256k_transition
       WHERE compensated_at IS NULL AND restored_legacy_entry_id IS NULL) <> 1 THEN
    RAISE EXCEPTION '0216 transition ledger postcondition failed';
  END IF;
  IF (SELECT count(*) FROM model_catalog
       WHERE model_id='kimi-k3' AND state='active' AND engine='ccb'
         AND provider_id='moonshot' AND upstream_model_id IS NULL
         AND context_window=1048576 AND capability_schema_version=1
         AND capability_profile=v_k3_profile) <> 1
     OR (SELECT count(*) FROM model_catalog
       WHERE model_id='k3-256k' AND state='active' AND engine='ccb'
         AND provider_id='moonshot' AND upstream_model_id IS NULL
         AND context_window=262144 AND capability_schema_version=1
         AND capability_profile=v_k3_profile) <> 1 THEN
    RAISE EXCEPTION '0216 active catalog descriptor postcondition failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM model_pricing
       WHERE model_id='kimi-k3' AND display_name='Kimi K3'
         AND input_per_mtok=1000 AND output_per_mtok=5000
         AND cache_read_per_mtok=100 AND cache_write_per_mtok=0
         AND multiplier=1.000 AND enabled IS TRUE AND sort_order=89
         AND visibility='public' AND default_effort IS NULL)
     OR NOT EXISTS (SELECT 1 FROM model_pricing
       WHERE model_id='k3-256k' AND display_name='Kimi K3 256K'
         AND input_per_mtok=500 AND output_per_mtok=2500
         AND cache_read_per_mtok=50 AND cache_write_per_mtok=0
         AND multiplier=1.000 AND enabled IS TRUE AND sort_order=90
         AND visibility='public' AND default_effort IS NULL) THEN
    RAISE EXCEPTION '0216 public pricing postcondition failed';
  END IF;
END
$postcondition$;
