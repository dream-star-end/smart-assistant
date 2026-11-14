-- OCV5-771: sync Antigravity Gemini 4 models (Carbon, Hydrogen, Orchestrator Carbon)
-- from selfhost (0338 / 0342 / 0343) into commercial catalog.
-- Seed all three as staged, enabled = FALSE, visibility = 'admin' (OCV5-411).
-- Post-deploy admin catalog operations activate and open Carbon & Hydrogen at
-- commercial 4x input/output & 2x cache-read pricing while leaving Orchestrator
-- Carbon staged/disabled.
INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,context_window,
  capability_profile,capability_schema_version,state)
VALUES
  ('antigravity-gemini-4-carbon','antigravity','antigravity','gemini-4-carbon-medium',1048576,
   '{"supports_vision":false,"reasoning":{"supported":["low","medium","high"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1,'staged'),
  ('antigravity-gemini-4-hydrogen','antigravity','antigravity','gemini-4-hydrogen-high',1048576,
   '{"supports_vision":false,"reasoning":{"supported":["low","medium","high","xhigh"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1,'staged'),
  ('antigravity-orchestrator-carbon','antigravity','antigravity','gemini-pro-orchestrator',1048576,
   '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
   1,'staged');

INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,cache_read_per_mtok,
  cache_write_per_mtok,multiplier,enabled,sort_order,visibility,extra_system_prompt,default_effort,lock_version)
VALUES
  ('antigravity-gemini-4-carbon','Gemini 4 Carbon (Antigravity)',100,500,5,0,'1',FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+1 FROM model_pricing),'admin',NULL,'medium',0),
  ('antigravity-gemini-4-hydrogen','Gemini 4 Hydrogen (Antigravity)',75,375,4,0,'1',FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+2 FROM model_pricing),'admin',NULL,'high',0),
  ('antigravity-orchestrator-carbon','Orchestrator Carbon (Antigravity)',100,500,5,0,'1',FALSE,
   (SELECT COALESCE(MAX(sort_order),100)+3 FROM model_pricing),'admin',NULL,NULL,0);
