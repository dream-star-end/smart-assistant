-- Selfhost-only post-release operation. Caller supplies a transaction and
-- verified running master/egress/runtime SHA; not an automatic migration.
DO $op$
DECLARE
  model CONSTANT TEXT := 'gemini-4-argon-contributor';
  profile CONSTANT JSONB := '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":true,"supports_thinking":false}}';
  entry model_catalog%ROWTYPE;
  price model_pricing%ROWTYPE;
  entry_id_new BIGINT;
  mode TEXT := current_setting('openclaude.ocv5_423_enable',true);
  enable BOOLEAN := mode = 'on';
BEGIN
  IF current_database() <> 'openclaude_v5_selfhost' THEN
    RAISE EXCEPTION 'OCV5-423 is selfhost-only';
  END IF;
  IF mode IS NULL OR mode NOT IN ('on','off') THEN RAISE EXCEPTION 'OCV5-423 requires explicit mode'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ocv5-423-gemini-catalog'));
  SELECT * INTO entry FROM model_catalog
    WHERE model_id=model AND state IN ('staged','active','disabled') FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT enable THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM model_pricing WHERE model_id=model)
       OR EXISTS (SELECT 1 FROM model_aliases WHERE alias=model) THEN
      RAISE EXCEPTION 'OCV5-423 refuses existing unbound pricing/alias';
    END IF;
    SELECT fn_model_stage_version(model,'ccb','opencodego',model,1000000,profile,1,3)
      INTO entry_id_new;
    PERFORM fn_model_activate_entry(entry_id_new,0,3);
    INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,
      cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled,visibility,sort_order,updated_by)
      VALUES(model,'Gemini 4 Argon Contributor (Go)',200,1000,10,0,1,true,'admin',130,3);
    -- Existing selfhost price convention: floor(official USD * 100 / 2),
    -- documented in migration 0288. This is not an FX conversion.
    RETURN;
  END IF;
  IF entry.engine <> 'ccb' OR entry.provider_id <> 'opencodego'
     OR entry.upstream_model_id IS DISTINCT FROM model OR entry.context_window <> 1000000
     OR entry.capability_profile IS DISTINCT FROM profile OR entry.capability_schema_version <> 1 THEN
    RAISE EXCEPTION 'OCV5-423 refuses drifted catalog';
  END IF;
  SELECT * INTO STRICT price FROM model_pricing WHERE model_id=model FOR UPDATE;
  IF price.input_per_mtok <> 200 OR price.output_per_mtok <> 1000
     OR price.cache_read_per_mtok <> 10 OR price.cache_write_per_mtok <> 0
     OR price.multiplier <> 1 OR price.visibility NOT IN ('admin','hidden') THEN
    RAISE EXCEPTION 'OCV5-423 refuses drifted pricing';
  END IF;
  IF enable AND entry.state <> 'active' THEN
    PERFORM fn_model_activate_entry(entry.entry_id,entry.lock_version,3);
  ELSIF NOT enable AND entry.state='active' THEN
    PERFORM fn_model_disable_entry(entry.entry_id,entry.lock_version,3);
  END IF;
  UPDATE model_pricing SET enabled=enable,visibility=CASE WHEN enable THEN 'admin' ELSE 'hidden' END,
    updated_by=3,updated_at=clock_timestamp(),lock_version=lock_version+1
    WHERE model_id=model AND (enabled IS DISTINCT FROM enable OR visibility IS DISTINCT FROM
      CASE WHEN enable THEN 'admin' ELSE 'hidden' END);
END $op$;
