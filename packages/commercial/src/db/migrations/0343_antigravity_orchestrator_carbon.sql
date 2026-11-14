-- OCV5-769: Antigravity CLI 1.5.8 fetchAvailableModels returns gemini-pro-orchestrator
-- ("Orchestrator (Carbon)") for Ultra accounts; --effort is unsupported so default_effort is NULL
-- and reasoning.supported is []. Carbon rates: USD/MTok input 2.00, output 10.00, implicit cache 0.10
-- -> 100 / 500 / 5 stored fen/MTok at 50 fen/USD; multiplier 1; visibility admin until opened.
INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,context_window,
  capability_profile,capability_schema_version,state)
VALUES ('antigravity-orchestrator-carbon','antigravity','antigravity','gemini-pro-orchestrator',1048576,
  '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
  1,'staged');
INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,cache_read_per_mtok,
  cache_write_per_mtok,multiplier,enabled,sort_order,visibility,extra_system_prompt,default_effort,lock_version)
VALUES ('antigravity-orchestrator-carbon','Orchestrator Carbon (Antigravity)',100,500,5,0,'1',FALSE,
  (SELECT COALESCE(MAX(sort_order),100)+1 FROM model_pricing),'admin',NULL,NULL,0);
