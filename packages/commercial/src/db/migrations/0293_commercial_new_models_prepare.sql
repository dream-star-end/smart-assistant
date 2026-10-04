-- order-dependency: 0285_content_review_strikes
-- 0293 commercial-only preparation (OCV5-308).
-- Personal 0283..0292 are a DIFFERENT execution history, not dependencies.
-- Do not import this file or requiredMigrations entry into selfhost.
-- Born staged/disabled; no activation, standard Grok upgrade or repricing here.
-- Frozen source: ops/ocv5-308/model-release-manifest.json (public new 17).
-- New min_plan=NULL preserves commercial ungated policy; price/multiplier,
-- capabilities and context are frozen from selfhost. No credentials copied.
-- Activation is an independent double-lock/CAS operator AFTER compatible
-- runtime/CLI/Box probes, code review and protected CI. No active model change.

DO $prepare$
DECLARE
  models CONSTANT jsonb := $models$[{"model_id":"box-claude-haiku-4-5","display_name":"Claude Haiku 4.5","input_per_mtok":200,"output_per_mtok":1000,"cache_read_per_mtok":20,"cache_write_per_mtok":250,"multiplier":1.0,"default_effort":null,"sort_order":17,"engine":"cursor","provider_id":"cursor","upstream_model_id":"claude-haiku-4-5","context_window":200000,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"box-claude-haiku-4-5"},{"model_id":"box-claude-opus-5-5","display_name":"Claude Opus 5.5","input_per_mtok":1400,"output_per_mtok":5000,"cache_read_per_mtok":36,"cache_write_per_mtok":1750,"multiplier":1.0,"default_effort":null,"sort_order":15,"engine":"cursor","provider_id":"cursor","upstream_model_id":"claude-opus-5-5","context_window":1000000,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"box-claude-opus-5-5"},{"model_id":"box-claude-sonnet-5","display_name":"Claude Sonnet 5","input_per_mtok":600,"output_per_mtok":3000,"cache_read_per_mtok":60,"cache_write_per_mtok":750,"multiplier":1.0,"default_effort":null,"sort_order":16,"engine":"cursor","provider_id":"cursor","upstream_model_id":"claude-sonnet-5","context_window":1000000,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"box-claude-sonnet-5"},{"model_id":"claude-opus-5-5","display_name":"Claude Opus 5.5","input_per_mtok":250,"output_per_mtok":1250,"cache_read_per_mtok":25,"cache_write_per_mtok":312,"multiplier":2.5,"default_effort":null,"sort_order":139,"engine":"ccb","provider_id":"anthropic","upstream_model_id":null,"context_window":1000000,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"claude-opus-5","group_provider":"claude","group_key":"claude-opus-5-5"},{"model_id":"cursor-grok-4.7-high","display_name":"Grok 4.7 High","input_per_mtok":190,"output_per_mtok":950,"cache_read_per_mtok":48,"cache_write_per_mtok":238,"multiplier":1.0,"default_effort":null,"sort_order":143,"engine":"cursor","provider_id":"cursor","upstream_model_id":"grok-4.7-high","context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"cursor-grok-4.7-high"},{"model_id":"cursor-grok-4.7-high-fast","display_name":"Grok 4.7 High Fast","input_per_mtok":190,"output_per_mtok":950,"cache_read_per_mtok":48,"cache_write_per_mtok":238,"multiplier":2.0,"default_effort":null,"sort_order":143,"engine":"cursor","provider_id":"cursor","upstream_model_id":"grok-4.7-high-fast","context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"cursor-grok-4.7-high-fast"},{"model_id":"cursor-grok-4.7-low","display_name":"Grok 4.7 Low","input_per_mtok":190,"output_per_mtok":950,"cache_read_per_mtok":48,"cache_write_per_mtok":238,"multiplier":1.0,"default_effort":null,"sort_order":143,"engine":"cursor","provider_id":"cursor","upstream_model_id":"grok-4.7-low","context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"cursor-grok-4.7-low"},{"model_id":"cursor-grok-4.7-low-fast","display_name":"Grok 4.7 Low Fast","input_per_mtok":190,"output_per_mtok":950,"cache_read_per_mtok":48,"cache_write_per_mtok":238,"multiplier":2.0,"default_effort":null,"sort_order":143,"engine":"cursor","provider_id":"cursor","upstream_model_id":"grok-4.7-low-fast","context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"cursor-grok-4.7-low-fast"},{"model_id":"cursor-grok-4.7-medium","display_name":"Grok 4.7 Medium","input_per_mtok":190,"output_per_mtok":950,"cache_read_per_mtok":48,"cache_write_per_mtok":238,"multiplier":1.0,"default_effort":null,"sort_order":143,"engine":"cursor","provider_id":"cursor","upstream_model_id":"grok-4.7-medium","context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"cursor-grok-4.7-medium"},{"model_id":"cursor-grok-4.7-medium-fast","display_name":"Grok 4.7 Medium Fast","input_per_mtok":190,"output_per_mtok":950,"cache_read_per_mtok":48,"cache_write_per_mtok":238,"multiplier":2.0,"default_effort":null,"sort_order":143,"engine":"cursor","provider_id":"cursor","upstream_model_id":"grok-4.7-medium-fast","context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"cursor-grok-4.7-medium-fast"},{"model_id":"cursor-grok-4.7-xhigh","display_name":"Grok 4.7 Extra High","input_per_mtok":190,"output_per_mtok":950,"cache_read_per_mtok":48,"cache_write_per_mtok":238,"multiplier":1.0,"default_effort":null,"sort_order":143,"engine":"cursor","provider_id":"cursor","upstream_model_id":"grok-4.7-xhigh","context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"cursor-grok-4.7-xhigh"},{"model_id":"cursor-grok-4.7-xhigh-fast","display_name":"Grok 4.7 Extra High Fast","input_per_mtok":190,"output_per_mtok":950,"cache_read_per_mtok":48,"cache_write_per_mtok":238,"multiplier":2.0,"default_effort":null,"sort_order":143,"engine":"cursor","provider_id":"cursor","upstream_model_id":"grok-4.7-xhigh-fast","context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":true},"reasoning":{"supported":[],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"cursor-grok-4.6-high","group_provider":"cursor","group_key":"cursor-grok-4.7-xhigh-fast"},{"model_id":"gpt-6-luna","display_name":"GPT-6-Luna","input_per_mtok":5,"output_per_mtok":25,"cache_read_per_mtok":1,"cache_write_per_mtok":6,"multiplier":0.4,"default_effort":"medium","sort_order":111,"engine":"codex","provider_id":"codex","upstream_model_id":null,"context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":false},"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":"medium"},"supports_vision":true},"capability_schema_version":1,"min_plan_code":null,"group_donor":"gpt-5.6-luna","group_provider":"codex","group_key":"gpt-6-luna"},{"model_id":"gpt-6-luna-1m","display_name":"GPT-6-Luna","input_per_mtok":8,"output_per_mtok":38,"cache_read_per_mtok":2,"cache_write_per_mtok":9,"multiplier":0.4,"default_effort":"medium","sort_order":111,"engine":"codex","provider_id":"codex","upstream_model_id":"gpt-6-luna","context_window":1000000,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":false},"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":"medium"},"supports_vision":true},"capability_schema_version":1,"min_plan_code":null,"group_donor":"gpt-5.6-luna","group_provider":"codex","group_key":"gpt-6-luna"},{"model_id":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","input_per_mtok":100,"output_per_mtok":500,"cache_read_per_mtok":5,"cache_write_per_mtok":125,"multiplier":1.0,"default_effort":"medium","sort_order":109,"engine":"codex","provider_id":"codex","upstream_model_id":null,"context_window":null,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":false},"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":"medium"},"supports_vision":true},"capability_schema_version":1,"min_plan_code":null,"group_donor":"gpt-5.6-sol","group_provider":"codex","group_key":"gpt-6.1-sol"},{"model_id":"gpt-6.1-sol-1m","display_name":"GPT-6.1-Sol","input_per_mtok":150,"output_per_mtok":750,"cache_read_per_mtok":8,"cache_write_per_mtok":188,"multiplier":1.0,"default_effort":"medium","sort_order":109,"engine":"codex","provider_id":"codex","upstream_model_id":"gpt-6.1-sol","context_window":1000000,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":false},"reasoning":{"supported":["low","medium","high","xhigh","max"],"codex_model_default":"medium"},"supports_vision":true},"capability_schema_version":1,"min_plan_code":null,"group_donor":"gpt-5.6-sol","group_provider":"codex","group_key":"gpt-6.1-sol"},{"model_id":"grok-build-fast","display_name":"Grok 4.7 Fast","input_per_mtok":250,"output_per_mtok":1500,"cache_read_per_mtok":25,"cache_write_per_mtok":0,"multiplier":4.0,"default_effort":"high","sort_order":141,"engine":"grok","provider_id":"grok","upstream_model_id":"grok-4.7-build-fast","context_window":500000,"capability_profile":{"ccb":{"capability_zero":false,"supports_thinking":false},"reasoning":{"supported":["low","medium","high"],"codex_model_default":null},"supports_vision":false},"capability_schema_version":1,"min_plan_code":null,"group_donor":"grok-build","group_provider":"grok","group_key":"grok-build-fast"}]$models$::jsonb;
  rec jsonb;
  new_ids text[];
  old_catalog jsonb;
  old_pricing jsonb;
  check_expr text;
  old_check_expr text;
  check_cols smallint[];
  model_att smallint;
BEGIN
  SELECT array_agg(x->>'model_id' ORDER BY x->>'model_id') INTO new_ids
    FROM jsonb_array_elements(models) x;
  IF cardinality(new_ids) <> 17 THEN RAISE EXCEPTION '0293 target must have 17 models'; END IF;
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id=ANY(new_ids))
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id=ANY(new_ids)) THEN
    RAISE EXCEPTION '0293 refuses pre-existing new model rows';
  END IF;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) INTO old_catalog FROM model_catalog c;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) INTO old_pricing FROM model_pricing p;

  FOR rec IN SELECT x FROM jsonb_array_elements(models) x LOOP
    INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,
      context_window,capability_profile,capability_schema_version,state)
    VALUES(rec->>'model_id',rec->>'engine',rec->>'provider_id',
      rec->>'upstream_model_id',(rec->>'context_window')::int,
      rec->'capability_profile',(rec->>'capability_schema_version')::int,'staged');
    INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,
      cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled,sort_order,
      visibility,extra_system_prompt,default_effort,lock_version,min_plan_code)
    VALUES(rec->>'model_id',rec->>'display_name',(rec->>'input_per_mtok')::bigint,
      (rec->>'output_per_mtok')::bigint,(rec->>'cache_read_per_mtok')::bigint,
      (rec->>'cache_write_per_mtok')::bigint,(rec->>'multiplier')::numeric,FALSE,
      (rec->>'sort_order')::int,'public',NULL,rec->>'default_effort',0,NULL);
    -- Derive bindings from THIS environment, never personal group IDs.
    -- A fresh database may have no accounts yet; activation requires a live
    -- compatible group and credentials. 1M twins use standard group keys.
    INSERT INTO account_group_models(group_id,model_id)
      SELECT DISTINCT g.id,rec->>'group_key'
        FROM account_groups g JOIN account_group_models gm ON gm.group_id=g.id
       WHERE g.enabled AND g.provider=rec->>'group_provider'
         AND g.kind='official_oauth' AND gm.model_id=rec->>'group_donor'
      ON CONFLICT DO NOTHING;
  END LOOP;

  -- Preserve the EXACT existing model-only CHECK meaning, union new Cursor
  -- IDs. In particular old Grok4.6/Gemini/Luna must remain accepted.
  SELECT pg_get_expr(conbin,conrelid),conkey INTO check_expr,check_cols
    FROM pg_constraint
   WHERE conrelid='cursor_external_usage_audit'::regclass
     AND conname='cursor_external_usage_audit_model_id_check' AND contype='c';
  SELECT attnum INTO model_att FROM pg_attribute
    WHERE attrelid='cursor_external_usage_audit'::regclass AND attname='model_id';
  IF check_expr IS NULL OR check_cols IS DISTINCT FROM ARRAY[model_att] THEN
    RAISE EXCEPTION '0293 requires existing model-only Cursor audit CHECK';
  END IF;
  old_check_expr := check_expr;
  ALTER TABLE cursor_external_usage_audit DROP CONSTRAINT cursor_external_usage_audit_model_id_check;
  SELECT string_agg(quote_literal(x->>'model_id'),',') INTO check_expr
    FROM jsonb_array_elements(models) x WHERE x->>'engine'='cursor';
  EXECUTE format('ALTER TABLE cursor_external_usage_audit ADD CONSTRAINT cursor_external_usage_audit_model_id_check CHECK ((%s) OR model_id IN (%s))',old_check_expr,check_expr);
  IF old_catalog IS DISTINCT FROM (
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE NOT(c.model_id=ANY(new_ids)))
    OR old_pricing IS DISTINCT FROM (
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p WHERE NOT(p.model_id=ANY(new_ids))) THEN
    RAISE EXCEPTION '0293 changed existing catalog/pricing';
  END IF;
  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING(model_id)
       WHERE c.model_id=ANY(new_ids) AND c.state='staged' AND p.enabled IS FALSE) <> 17 THEN
    RAISE EXCEPTION '0293 must leave all new 17 staged/disabled';
  END IF;
END $prepare$;
