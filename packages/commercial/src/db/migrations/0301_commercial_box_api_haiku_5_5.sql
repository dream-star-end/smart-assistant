-- order-dependency: 0299_commercial_box_claude_profiles
-- 0301 commercial-only (OCV5-338): catalog and pricing rows of Claude Haiku 5.5
-- on the Box model route (engine ccb, provider box_cli; see 0294 / 0295):
--   box-api-claude-haiku-5-5 -> claude-haiku-5-5
-- Claude Haiku 5.5 was released 2026-10-07. claude-haiku-5-5 is a fixed id with
-- no date suffix (platform.claude.com/docs/en/models/haiku-5-5/overview). The
-- Box CLI (2.1.294) accepts it and reports the same id as message.model, with
-- contextWindow 1000000 and maxOutputTokens 128000. The pair is an entry of
-- BOX_API_MODELS (packages/protocol); the product refuses a box_cli row that is
-- not listed there with its own upstream id.
-- 0300 is the selfhost migration of the same task (its box-claude-haiku-5-5
-- cursor row); commercial has no such row and does not take that file.
--
-- Catalog fields follow the box-api-claude-sonnet-5-5 row after 0298: window
-- 1000000, effort levels low..max (Haiku 5.5 supports all five, default medium).
-- Price, credits per 1M tokens, multiplier 1.0, public, no plan gate, like the
-- other rows of the route. box-api-claude-haiku-4-5 is exactly 200x the official
-- Haiku 4.5 list price ($1 / $5 / $0.10 / $1.25 -> 200 / 1000 / 20 / 250). Haiku
-- 5.5 takes the same factor on its official price for prompts up to 100,000
-- tokens ($0.10 / $0.50 / $0.01 cache read / $0.125 5m cache write,
-- platform.claude.com pricing, 2026-10-08): 20 / 100 / 2 / 25. The catalog has
-- one price per model, so the official >100k-token tier ($0.50 / $2.50 / $0.05 /
-- $0.625) is not applied. Display name Claude Haiku 5.5, sort order 18.
-- Born staged/disabled: nothing is offered by this migration. Activation is a
-- separate step through the catalog admin path. No account group binding.

DO $prepare$
DECLARE
  target CONSTANT text := 'box-api-claude-haiku-5-5';
  old_catalog jsonb;
  old_pricing jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id=target)
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id=target) THEN
    RAISE EXCEPTION '0301 refuses a pre-existing row of %', target;
  END IF;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) INTO old_catalog FROM model_catalog c;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) INTO old_pricing FROM model_pricing p;

  INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,
    context_window,capability_profile,capability_schema_version,state)
  VALUES(target,'ccb','box_cli','claude-haiku-5-5',1000000,
    '{"ccb":{"context_owner":"box-native-v1","capability_zero":true,"supports_thinking":false},"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":null},"supports_vision":false}'::jsonb,
    1,'staged');
  INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,
    cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled,sort_order,
    visibility,extra_system_prompt,default_effort,lock_version,min_plan_code)
  VALUES(target,'Claude Haiku 5.5',20,100,2,25,1.0,FALSE,18,'public',NULL,NULL,0,NULL);

  IF old_catalog IS DISTINCT FROM (
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE c.model_id<>target)
    OR old_pricing IS DISTINCT FROM (
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p WHERE p.model_id<>target) THEN
    RAISE EXCEPTION '0301 changed existing catalog/pricing';
  END IF;
  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING(model_id)
       WHERE c.model_id=target AND c.state='staged' AND p.enabled IS FALSE) <> 1 THEN
    RAISE EXCEPTION '0301 must leave % staged/disabled', target;
  END IF;
END $prepare$;
