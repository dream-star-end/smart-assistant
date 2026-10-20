-- order-dependency: 0311_antigravity_paid_tier
-- OCV5-517: verified with the official 1.4.0 CLI consumer user-agent on 2026-10-18.
-- Ultra-lite generates Argon successfully; current Pro explicitly advertises disabled Argon.
-- Official introductory USD/MTok through 2026-11-30: input 2, output 10, implicit cache .10.
-- 50 stored fen/USD (100 fen = 1 displayed credit); preserve the Gemini subscription multiplier 1. No explicit cache writes.
INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,context_window,
  capability_profile,capability_schema_version,state)
VALUES ('antigravity-gemini-4-argon','antigravity','antigravity','gemini-4-argon-medium',1048576,
  '{"supports_vision":false,"reasoning":{"supported":["low","medium","high"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
  1,'staged');
INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,cache_read_per_mtok,
  cache_write_per_mtok,multiplier,enabled,sort_order,visibility,extra_system_prompt,default_effort,lock_version)
VALUES ('antigravity-gemini-4-argon','Gemini 4 Argon (Antigravity)',100,500,5,0,'1',FALSE,
  (SELECT COALESCE(MAX(sort_order),100)+1 FROM model_pricing),'admin',NULL,'medium',0);
