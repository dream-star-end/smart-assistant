-- order-dependency: 0312_antigravity_gemini_4_argon
-- 0313 (selfhost) — OpenCode Go MiniMax M3.1 Flash Free and Beam Free catalog rows (unified OpenCode rules,
-- user 2026-10-20 09:18/09:48; butler 16:05 chose a migration over direct inserts). Selfhost-only, like the
-- commercial 0313 (which is not synced here); the chat bridge routes both ids since #905.
-- Data only; both rows are born unavailable and admin-only (catalog staged, pricing disabled, visibility
-- admin, OCV5-411 rule). Activation, the real-call check and opening to users run afterwards through the
-- audited admin catalog ops.
-- Prices: free models are raised to the UI floor x0.2 (cost_x vs deepseek-v4-pro 225/675/7) = 45/135/2/0,
-- multiplier 1; display names carry no "Go" or "Free" (same rows as commercial 0313).
--
-- BEGIN MANUAL ROLLBACK 0313 (only while the rows are still staged; after activation disable them with
-- disableEntry first)
-- DELETE FROM model_pricing WHERE model_id IN ('minimax-m3.1-flash-free-go', 'beam-free-go') AND enabled = FALSE;
-- DELETE FROM model_catalog WHERE model_id IN ('minimax-m3.1-flash-free-go', 'beam-free-go') AND state = 'staged';
-- END MANUAL ROLLBACK 0313

LOCK TABLE model_catalog, model_pricing IN SHARE ROW EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id IN ('minimax-m3.1-flash-free-go', 'beam-free-go'))
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id IN ('minimax-m3.1-flash-free-go', 'beam-free-go'))
     OR EXISTS (SELECT 1 FROM model_aliases WHERE alias IN ('minimax-m3.1-flash-free-go', 'beam-free-go')) THEN
    RAISE EXCEPTION '0313 refuses pre-existing minimax-m3.1-flash-free-go / beam-free-go ids';
  END IF;
END $guard$;

-- capability_profile = goCapabilityProfile(): no efforts, no thinking for either upstream
INSERT INTO model_catalog(model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state)
SELECT v.model_id, 'ccb', 'opencodego', v.upstream, v.ctx,
  jsonb_build_object('supports_vision', false,
    'reasoning', jsonb_build_object('supported', '[]'::jsonb, 'codex_model_default', NULL),
    'ccb', jsonb_build_object('capability_zero', true, 'supports_thinking', false)),
  1, 'staged'
FROM (VALUES
  ('minimax-m3.1-flash-free-go', 'minimax-m3.1-flash-free', 1000000),
  ('beam-free-go',               'beam-free',               1048576)
) AS v(model_id, upstream, ctx);

-- sort_order = openCodeGoCatalog rows (330/331)
INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
  cache_write_per_mtok, multiplier, enabled, sort_order, visibility, extra_system_prompt, default_effort, lock_version)
VALUES
  ('minimax-m3.1-flash-free-go', 'MiniMax M3.1 Flash', 45, 135, 2, 0, '1', FALSE, 330, 'admin', NULL, NULL, 0),  -- free → x0.2
  ('beam-free-go',               'Beam',               45, 135, 2, 0, '1', FALSE, 331, 'admin', NULL, NULL, 0);  -- free → x0.2
