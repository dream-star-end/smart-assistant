-- order-dependency: 0313_commercial_overnight_catalog_20261020
-- 0314 — commercial: OpenCode Go Muse Spark 1.3 Contributor (user 2026-10-20 09:13; 09:48: 1.3 only, not 1.2).
-- Same rules as 0313: page USD x100/2 fen = 5/10/1/0 (x0.0) raised to the x0.2 floor = 22/44/5/0,
-- multiplier 1, no "Go" in the name. The page says these models' prompts and completions may train
-- Meta models; the user approved it for commercial. Born staged, unpriced and admin-only (OCV5-411);
-- activation and opening are audited admin ops after acceptance.
--
-- BEGIN MANUAL ROLLBACK 0314 (only while staged; after activation disable with disableEntry first)
-- DELETE FROM model_pricing WHERE model_id = 'muse-spark-1.3-go' AND enabled = FALSE;
-- DELETE FROM model_catalog WHERE model_id = 'muse-spark-1.3-go' AND state = 'staged';
-- END MANUAL ROLLBACK 0314

LOCK TABLE model_catalog, model_pricing IN SHARE ROW EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = 'muse-spark-1.3-go')
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'muse-spark-1.3-go') THEN
    RAISE EXCEPTION '0314 refuses pre-existing Muse Spark ids';
  END IF;
END $guard$;

-- protocol OPENCODE_GO_RESPONSES_MODELS routes these ids through the Responses bridge
INSERT INTO model_catalog(model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state)
SELECT v.model_id, 'ccb', 'opencodego', v.upstream, 1048576,
  jsonb_build_object('supports_vision', false,
    'reasoning', jsonb_build_object('supported', to_jsonb(v.efforts), 'codex_model_default', NULL),
    'ccb', jsonb_build_object('capability_zero', true, 'supports_thinking', false)),
  1, 'staged'
FROM (VALUES
  ('muse-spark-1.3-go', 'muse-spark-1.3-contributor', ARRAY[]::text[])
) AS v(model_id, upstream, efforts);

INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
  cache_write_per_mtok, multiplier, enabled, sort_order, visibility, extra_system_prompt, default_effort, lock_version)
SELECT v.model_id, v.name, 22, 44, 5, 0, '1', FALSE,
  (SELECT COALESCE(MAX(sort_order), 100) FROM model_pricing) + v.ord, 'admin', NULL, NULL, 0
FROM (VALUES ('muse-spark-1.3-go', 'Muse Spark 1.3 Contributor', 1)) AS v(model_id, name, ord);
