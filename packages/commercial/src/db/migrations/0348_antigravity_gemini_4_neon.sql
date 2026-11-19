-- order-dependency: 0347_user_sites_fullstack
-- compat: purely additive staged model_catalog and disabled admin-visibility model_pricing rows for Gemini 4 Neon and Orchestrator Neon; pre-0348 binaries ignore staged/disabled entries.
-- Official USD/MTok (1M context): input 3.00, output 15.00, implicit cache 0.15.
-- Commercial-aligned stored fen/MTok (200 fen/USD input & output, 100 fen/USD cache read, multiplier 1): 600 / 3000 / 15 / 0.
INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,context_window,
  capability_profile,capability_schema_version,state)
VALUES
  ('antigravity-gemini-4-neon','antigravity','antigravity','gemini-4-neon-high',1048576,
   '{"supports_vision":false,"reasoning":{"supported":["low","medium","high","xhigh"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1,'staged'),
  ('antigravity-orchestrator-neon','antigravity','antigravity','gemini-pro-orchestrator-neon',1048576,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1,'staged');

INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,cache_read_per_mtok,
  cache_write_per_mtok,multiplier,enabled,sort_order,visibility,extra_system_prompt,default_effort,lock_version)
VALUES
  ('antigravity-gemini-4-neon','Gemini 4 Neon (Antigravity)',600,3000,15,0,'1',FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+1 FROM model_pricing),'admin',NULL,'high',0),
  ('antigravity-orchestrator-neon','Orchestrator Neon (Antigravity)',600,3000,15,0,'1',FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+2 FROM model_pricing),'admin',NULL,NULL,0);
