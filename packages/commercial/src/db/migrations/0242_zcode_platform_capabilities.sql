-- ZCode 0.16.3 exposes reasoning parts but no per-turn effort control on the
-- Anthropic Coding Plan transport. Version the public catalog row so the UI
-- stops advertising high/max while engine=zcode. CCB rows keep their proven
-- effort pair. Never mutate the active immutable row in place.
DO $$
DECLARE
  v_live RECORD;
  v_new_entry BIGINT;
  v_profile JSONB;
  v_after RECORD;
BEGIN
  SELECT entry_id, engine, provider_id, upstream_model_id, context_window,
         capability_profile, capability_schema_version, state, lock_version
    INTO v_live
    FROM model_catalog
   WHERE model_id='glm-5.3-zai' AND state IN ('staged','active','disabled')
   ORDER BY (state='active') DESC, (state='staged') DESC, entry_id DESC
   LIMIT 1
   FOR UPDATE;

  IF v_live.entry_id IS NULL THEN
    RAISE EXCEPTION '0242 glm-5.3-zai live row missing';
  END IF;
  IF v_live.state <> 'active'
     OR v_live.upstream_model_id <> 'glm-5.3'
     OR v_live.context_window <> 1000000 THEN
    RAISE EXCEPTION '0242 glm-5.3-zai live row precondition failed';
  END IF;
  IF v_live.engine='ccb' AND v_live.provider_id='zai' THEN
    -- Commercial environments that have not cut over remain unchanged.
    RETURN;
  END IF;
  IF v_live.engine <> 'zcode' OR v_live.provider_id <> 'zcode' THEN
    RAISE EXCEPTION '0242 unexpected glm-5.3-zai engine/provider %/%',
      v_live.engine, v_live.provider_id;
  END IF;
  IF v_live.capability_profile #> '{reasoning,supported}' = '[]'::jsonb THEN
    RETURN;
  END IF;
  IF v_live.capability_profile #> '{reasoning,supported}' <> '["high","max"]'::jsonb
     OR v_live.capability_profile #>> '{reasoning,codex_model_default}' IS NOT NULL THEN
    RAISE EXCEPTION '0242 glm-5.3-zai reasoning profile precondition failed';
  END IF;

  v_profile := jsonb_set(
    v_live.capability_profile,
    '{reasoning,supported}',
    '[]'::jsonb,
    FALSE
  );
  SELECT fn_model_switch_version(
    'glm-5.3-zai','zcode','zcode','glm-5.3',1000000,
    v_profile,v_live.capability_schema_version,NULL,v_live.lock_version
  ) INTO v_new_entry;

  SELECT entry_id,engine,provider_id,upstream_model_id,context_window,
         capability_profile,state
    INTO v_after
    FROM model_catalog
   WHERE model_id='glm-5.3-zai' AND state='active';
  IF v_after.entry_id <> v_new_entry
     OR v_after.engine <> 'zcode'
     OR v_after.provider_id <> 'zcode'
     OR v_after.upstream_model_id <> 'glm-5.3'
     OR v_after.context_window <> 1000000
     OR v_after.capability_profile #> '{reasoning,supported}' <> '[]'::jsonb
     OR (SELECT count(*) FROM model_pricing WHERE model_id='glm-5.3-zai' AND enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0242 glm-5.3-zai postcondition failed';
  END IF;
END $$;

-- Guarded manual rollback lives in
-- db/manual/0242_zcode_platform_capabilities_rollback.sql. It requires an
-- operator-supplied exact active lock_version and uses fn_model_switch_version.
