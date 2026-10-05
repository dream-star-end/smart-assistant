-- order-dependency: 0293_commercial_new_models_prepare
-- 0294 commercial-only (OCV5-316): catalog and pricing rows of the Box model
-- route, box-api-claude-opus-5-5 (engine ccb, provider box_cli). The agent and
-- its tools stay in the user container; egress runs one tool-less `claude -p`
-- per model request in the Box of a Cursor session account.
-- Selfhost created its row with an operator script
-- (scripts/ocv5-289/boxCatalogStage.ts) and has no migration for it: do not
-- import this file or its requiredMigrations entry into selfhost.
-- Catalog fields are the ones selfhost runs with. Price, display name, sort
-- order and the ungated public visibility are those of the commercial
-- box-claude-opus-5-5 row this model replaces (0293).
-- Born staged/disabled: nothing is offered by this migration. Activation is a
-- separate step through the catalog admin path, after egress runs with
-- OC_BOX_MODEL_API=1. The route needs no account group binding.

DO $prepare$
DECLARE
  target CONSTANT text := 'box-api-claude-opus-5-5';
  old_catalog jsonb;
  old_pricing jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id=target)
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id=target) THEN
    RAISE EXCEPTION '0294 refuses a pre-existing % row', target;
  END IF;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) INTO old_catalog FROM model_catalog c;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) INTO old_pricing FROM model_pricing p;

  INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,
    context_window,capability_profile,capability_schema_version,state)
  VALUES(target,'ccb','box_cli','claude-opus-5-5',200000,
    '{"ccb":{"context_owner":"box-native-v1","capability_zero":true,"supports_thinking":false},"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":null},"supports_vision":false}'::jsonb,
    1,'staged');
  INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,
    cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled,sort_order,
    visibility,extra_system_prompt,default_effort,lock_version,min_plan_code)
  VALUES(target,'Claude Opus 5.5',1400,5000,36,1750,1.0,FALSE,15,'public',NULL,NULL,0,NULL);

  IF old_catalog IS DISTINCT FROM (
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE c.model_id<>target)
    OR old_pricing IS DISTINCT FROM (
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p WHERE p.model_id<>target) THEN
    RAISE EXCEPTION '0294 changed existing catalog/pricing';
  END IF;
  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING(model_id)
       WHERE c.model_id=target AND c.state='staged' AND p.enabled IS FALSE) <> 1 THEN
    RAISE EXCEPTION '0294 must leave % staged/disabled', target;
  END IF;
END $prepare$;
