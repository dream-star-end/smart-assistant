-- OCV5-768: on 2026-11-14 active Ultra account (id=3) fetchAvailableModels lists
-- gemini-4-hydrogen-{low,medium,high,xhigh} and generateContent probes return 200.
-- Official USD/MTok (1M flat): input 1.50, output 7.50, implicit cache 0.075.
-- 50 stored fen/USD (100 fen = 1 displayed credit; 0.075 * 50 = 3.75 -> 4 fen);
-- Gemini subscription multiplier 1; default effort high; visibility admin until explicit catalog opening (OCV5-411).
INSERT INTO model_catalog(model_id,engine,provider_id,upstream_model_id,context_window,
  capability_profile,capability_schema_version,state)
VALUES ('antigravity-gemini-4-hydrogen','antigravity','antigravity','gemini-4-hydrogen-high',1048576,
  '{"supports_vision":false,"reasoning":{"supported":["low","medium","high","xhigh"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
  1,'staged');
INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok,cache_read_per_mtok,
  cache_write_per_mtok,multiplier,enabled,sort_order,visibility,extra_system_prompt,default_effort,lock_version)
VALUES ('antigravity-gemini-4-hydrogen','Gemini 4 Hydrogen (Antigravity)',75,375,4,0,'1',FALSE,
  (SELECT COALESCE(MAX(sort_order),100)+1 FROM model_pricing),'admin',NULL,'high',0);
