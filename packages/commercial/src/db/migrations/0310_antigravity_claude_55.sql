-- OCV5-515: exact Google Ultra directory models (2026-10-18).
-- USD list prices: Sonnet 2/10/.10, Opus 4/20/.20 per million tokens;
-- existing Antigravity convention = 50 stored fen/USD (100 fen = 1 displayed credit), multiplier 2. No cache writes upstream.
-- Existing 4.6 entries are disabled through audited catalog operations after cutover;
-- historical usage/model ids are never rewritten. New entries are born staged.
INSERT INTO model_catalog(model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state)
SELECT 'antigravity-claude-' || family || '-5.5', 'antigravity', 'antigravity',
  'claude-' || family || '-5-5-medium', 1000000,
  '{"supports_vision":false,"reasoning":{"supported":["low","medium","high"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb,
  1, 'staged'
FROM (VALUES ('sonnet'), ('opus')) AS v(family);
INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok,
  cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order, visibility,
  extra_system_prompt, default_effort, lock_version)
SELECT 'antigravity-claude-' || family || '-5.5', 'Claude ' || initcap(family) || ' 5.5 (Antigravity)',
  input_price, output_price, cache_price, 0, '2', FALSE,
  (SELECT COALESCE(MAX(sort_order), 100) FROM model_pricing) + ordinal, 'admin', NULL, 'medium', 0
FROM (VALUES ('sonnet', 100, 500, 5, 1), ('opus', 200, 1000, 10, 2))
  AS v(family, input_price, output_price, cache_price, ordinal);
