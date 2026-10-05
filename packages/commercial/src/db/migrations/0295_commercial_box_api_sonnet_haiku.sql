-- order-dependency: 0294_commercial_box_api_model
-- 0295 commercial-only (OCV5-318): catalog and pricing rows of two more models
-- of the Box model route (engine ccb, provider box_cli; see 0294):
--   box-api-claude-sonnet-5-5 -> claude-sonnet-5-5
--   box-api-claude-haiku-4-5  -> claude-haiku-4-5-20251001
-- The upstream id is the one the Box CLI is started with and reports back.
-- Haiku carries its dated id because the CLI reports that id, not the alias.
-- Both ids are entries of BOX_API_MODELS (packages/protocol); the product
-- refuses a box_cli row that is not listed there with its own upstream id.
-- Selfhost stages its rows with an operator script and has no migration for
-- them: do not import this file or its requiredMigrations entry into selfhost.
-- Catalog fields follow the box-api-claude-opus-5-5 row. Haiku 4.5 has no
-- effort parameter, so its supported list is empty. Price, display name
-- pattern, sort order and the ungated public visibility are those of the
-- commercial box-claude-sonnet-5 / box-claude-haiku-4-5 rows these models
-- replace (0293); Sonnet 5.5 is priced as that Sonnet row.
-- Born staged/disabled: nothing is offered by this migration. Activation is a
-- separate step through the catalog admin path. No account group binding.

DO $prepare$
DECLARE
  targets CONSTANT text[] := ARRAY['box-api-claude-sonnet-5-5','box-api-claude-haiku-4-5'];
  old_catalog jsonb;
  old_pricing jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id=ANY(targets))
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id=ANY(targets)) THEN
    RAISE EXCEPTION '0295 refuses a pre-existing row of %', targets;
  END IF;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) INTO old_catalog FROM model_catalog c;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) INTO old_pricing FROM model_pricing p;

  INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,
    context_window,capability_profile,capability_schema_version,state)
  VALUES('box-api-claude-sonnet-5-5','ccb','box_cli','claude-sonnet-5-5',200000,
    '{"ccb":{"context_owner":"box-native-v1","capability_zero":true,"supports_thinking":false},"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":null},"supports_vision":false}'::jsonb,
    1,'staged'),
  ('box-api-claude-haiku-4-5','ccb','box_cli','claude-haiku-4-5-20251001',200000,
    '{"ccb":{"context_owner":"box-native-v1","capability_zero":true,"supports_thinking":false},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false}'::jsonb,
    1,'staged');
  INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,
    cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled,sort_order,
    visibility,extra_system_prompt,default_effort,lock_version,min_plan_code)
  VALUES('box-api-claude-sonnet-5-5','Claude Sonnet 5.5',600,3000,60,750,1.0,FALSE,16,'public',NULL,NULL,0,NULL),
    ('box-api-claude-haiku-4-5','Claude Haiku 4.5',200,1000,20,250,1.0,FALSE,17,'public',NULL,NULL,0,NULL);

  IF old_catalog IS DISTINCT FROM (
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE NOT(c.model_id=ANY(targets)))
    OR old_pricing IS DISTINCT FROM (
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p WHERE NOT(p.model_id=ANY(targets))) THEN
    RAISE EXCEPTION '0295 changed existing catalog/pricing';
  END IF;
  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING(model_id)
       WHERE c.model_id=ANY(targets) AND c.state='staged' AND p.enabled IS FALSE) <> 2 THEN
    RAISE EXCEPTION '0295 must leave % staged/disabled', targets;
  END IF;
END $prepare$;
