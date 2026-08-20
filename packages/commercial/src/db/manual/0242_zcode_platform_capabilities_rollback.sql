-- Manual rollback for migration 0242 only.
-- Usage inside one transaction:
--   BEGIN;
--   SET LOCAL openclaude.expected_lock_version='<active lock_version>';
--   \i packages/commercial/src/db/manual/0242_zcode_platform_capabilities_rollback.sql
--   COMMIT;
DO $$
DECLARE
  v_expected INTEGER;
  v_live RECORD;
  v_new_entry BIGINT;
  v_profile JSONB;
  v_after RECORD;
BEGIN
  BEGIN
    v_expected := current_setting('openclaude.expected_lock_version', TRUE)::INTEGER;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '0242 rollback requires openclaude.expected_lock_version';
  END;
  IF v_expected IS NULL THEN
    RAISE EXCEPTION '0242 rollback requires openclaude.expected_lock_version';
  END IF;

  SELECT entry_id,engine,provider_id,upstream_model_id,context_window,
         capability_profile,capability_schema_version,state,lock_version
    INTO v_live
    FROM model_catalog
   WHERE model_id='glm-5.3-zai' AND state IN ('staged','active','disabled')
   ORDER BY (state='active') DESC,(state='staged') DESC,entry_id DESC
   LIMIT 1
   FOR UPDATE;
  IF v_live.entry_id IS NULL
     OR v_live.state <> 'active'
     OR v_live.engine <> 'zcode'
     OR v_live.provider_id <> 'zcode'
     OR v_live.upstream_model_id <> 'glm-5.3'
     OR v_live.context_window <> 1000000
     OR v_live.lock_version <> v_expected
     OR v_live.capability_profile #> '{reasoning,supported}' <> '[]'::jsonb THEN
    RAISE EXCEPTION '0242 rollback precondition failed';
  END IF;

  v_profile := jsonb_set(
    v_live.capability_profile,
    '{reasoning,supported}',
    '["high","max"]'::jsonb,
    FALSE
  );
  SELECT fn_model_switch_version(
    'glm-5.3-zai','zcode','zcode','glm-5.3',1000000,
    v_profile,v_live.capability_schema_version,NULL,v_expected
  ) INTO v_new_entry;
  SELECT entry_id,engine,provider_id,capability_profile,state
    INTO v_after
    FROM model_catalog
   WHERE model_id='glm-5.3-zai' AND state='active';
  IF v_after.entry_id <> v_new_entry
     OR v_after.engine <> 'zcode'
     OR v_after.provider_id <> 'zcode'
     OR v_after.capability_profile #> '{reasoning,supported}' <> '["high","max"]'::jsonb
     OR (SELECT count(*) FROM model_pricing WHERE model_id='glm-5.3-zai' AND enabled IS TRUE) <> 1 THEN
    RAISE EXCEPTION '0242 rollback postcondition failed';
  END IF;
END $$;
