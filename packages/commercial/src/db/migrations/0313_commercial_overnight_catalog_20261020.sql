-- order-dependency: 0312_antigravity_gemini_4_argon
-- 0313 — commercial overnight catalog (user authorization 2026-10-20 01:37–02:13 Taipei, cc3 sync).
-- Data only; every new row is born unavailable and admin-only (catalog staged, pricing disabled,
-- visibility admin, OCV5-411 rule). Activation, opening to users and the price/disable changes of live
-- models run afterwards through the audited admin catalog ops.
--
-- 1. GLM-5.3 (scnet, degraded since 2026-10-05) retirement: the 0144 runtime requirement
--    platform_default_and_hidden_reviewer moves to glm-5.3-zai (same model on Z.AI, the selfhost value),
--    which the hidden reviewer, the CCB sub-agent default (an aux model the turn gate requires active)
--    and the web fallback now name again. glm-5.3 itself is disabled after the release with
--    disableEntry; nothing here disables it.
-- 2. Antigravity commercial prices (user 01:37): Claude 5.5 = the commercial Claude 5.5 of the same
--    name (box-api-claude-*-5-5); Gemini 4 Argon = Claude Opus 5.5. Rows stay staged: commercial has
--    no Antigravity account yet.
-- 3. OpenCode Go (user 01:37–01:53, rules in CONTINUE gsync1020): Go plan quota >= 6x the $10 plan or
--    free (limited-time boosts count); price = page USD x100 / 2 fen; free and anything lower are
--    raised to the UI floor x0.2 (cost_x vs deepseek-v4-pro 225/675/7); multiplier 1; no "Go" or
--    "Free" in display names; models already served by another commercial route are not added.
--
-- BEGIN MANUAL ROLLBACK 0313 (only while the new rows are still staged; after activation disable
-- them with disableEntry first)
-- DELETE FROM model_runtime_requirements
--  WHERE model_id = 'glm-5.3-zai' AND requirement = 'platform_default_and_hidden_reviewer';
-- INSERT INTO model_runtime_requirements(model_id, requirement)
--   VALUES ('glm-5.3', 'platform_default_and_hidden_reviewer');   -- glm-5.3 must be active and priced
-- UPDATE model_pricing SET input_per_mtok = 100, output_per_mtok = 500, cache_read_per_mtok = 5,
--   cache_write_per_mtok = 0, multiplier = 2 WHERE model_id = 'antigravity-claude-sonnet-5.5';
-- UPDATE model_pricing SET input_per_mtok = 200, output_per_mtok = 1000, cache_read_per_mtok = 10,
--   cache_write_per_mtok = 0, multiplier = 2 WHERE model_id = 'antigravity-claude-opus-5.5';
-- UPDATE model_pricing SET input_per_mtok = 100, output_per_mtok = 500, cache_read_per_mtok = 5,
--   cache_write_per_mtok = 0, multiplier = 1 WHERE model_id = 'antigravity-gemini-4-argon';
-- DELETE FROM model_pricing WHERE model_id IN (<the 11 Go ids below>) AND enabled = FALSE;
-- DELETE FROM model_catalog WHERE model_id IN (<the 11 Go ids below>) AND state = 'staged';
-- END MANUAL ROLLBACK 0313

LOCK TABLE model_catalog, model_pricing, model_runtime_requirements IN SHARE ROW EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM model_runtime_requirements
       WHERE model_id = 'glm-5.3' AND requirement = 'platform_default_and_hidden_reviewer') <> 1 THEN
    RAISE EXCEPTION '0313 expects glm-5.3 to hold platform_default_and_hidden_reviewer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
                  WHERE c.model_id = 'glm-5.3-zai' AND c.state = 'active' AND p.enabled) THEN
    RAISE EXCEPTION '0313 needs glm-5.3-zai active and priced';
  END IF;
  IF (SELECT count(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('antigravity-claude-sonnet-5.5', 'antigravity-claude-opus-5.5', 'antigravity-gemini-4-argon')
         AND c.state = 'staged' AND NOT p.enabled) <> 3 THEN
    RAISE EXCEPTION '0313 expects the three Antigravity rows of 0310/0312 staged and unpriced';
  END IF;
  IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id IN ('glm-5.3-flash-go', 'glm-5.2-go', 'step-5-preview-go',
       'mimo-v2.6-flash-go', 'mimo-v2.5-go', 'minimax-m3-go', 'qwen3.7-plus-go', 'hy3-go',
       'longcat-2.5-preview-free-go', 'minimax-m3.1-flash-free-go', 'beam-free-go'))
     OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id IN ('glm-5.3-flash-go', 'glm-5.2-go', 'step-5-preview-go',
       'mimo-v2.6-flash-go', 'mimo-v2.5-go', 'minimax-m3-go', 'qwen3.7-plus-go', 'hy3-go',
       'longcat-2.5-preview-free-go', 'minimax-m3.1-flash-free-go', 'beam-free-go')) THEN
    RAISE EXCEPTION '0313 refuses pre-existing OpenCode Go ids';
  END IF;
END $guard$;

-- 1. runtime requirement (the 0144 deferred guard re-checks both rows at commit)
DELETE FROM model_runtime_requirements
 WHERE model_id = 'glm-5.3' AND requirement = 'platform_default_and_hidden_reviewer';
INSERT INTO model_runtime_requirements(model_id, requirement)
  VALUES ('glm-5.3-zai', 'platform_default_and_hidden_reviewer');

-- 2. Antigravity prices: copied from the live rows they must equal
UPDATE model_pricing AS p
   SET input_per_mtok = s.input_per_mtok, output_per_mtok = s.output_per_mtok,
       cache_read_per_mtok = s.cache_read_per_mtok, cache_write_per_mtok = s.cache_write_per_mtok,
       multiplier = s.multiplier, updated_at = now()
  FROM (VALUES ('antigravity-claude-sonnet-5.5', 'box-api-claude-sonnet-5-5'),
               ('antigravity-claude-opus-5.5', 'box-api-claude-opus-5-5'),
               ('antigravity-gemini-4-argon', 'box-api-claude-opus-5-5')) AS m(target, source)
  JOIN model_pricing AS s ON s.model_id = m.source
 WHERE p.model_id = m.target AND NOT p.enabled;

DO $prices$
BEGIN
  IF (SELECT count(*) FROM model_pricing a JOIN model_pricing b
        ON b.model_id = CASE a.model_id WHEN 'antigravity-claude-sonnet-5.5' THEN 'box-api-claude-sonnet-5-5'
                                        ELSE 'box-api-claude-opus-5-5' END
       WHERE a.model_id IN ('antigravity-claude-sonnet-5.5', 'antigravity-claude-opus-5.5', 'antigravity-gemini-4-argon')
         AND (a.input_per_mtok, a.output_per_mtok, a.cache_read_per_mtok, a.cache_write_per_mtok, a.multiplier)
           = (b.input_per_mtok, b.output_per_mtok, b.cache_read_per_mtok, b.cache_write_per_mtok, b.multiplier)) <> 3 THEN
    RAISE EXCEPTION '0313 Antigravity prices do not match their commercial Claude 5.5 sources';
  END IF;
END $prices$;

-- 3. OpenCode Go rows (protocol OPENCODE_GO_MESSAGES_MODELS / OPENCODE_GO_CHAT_MODELS route them)
INSERT INTO model_catalog(model_id, engine, provider_id, upstream_model_id, context_window,
  capability_profile, capability_schema_version, state)
SELECT v.model_id, 'ccb', 'opencodego', v.upstream, v.ctx,
  jsonb_build_object('supports_vision', false,
    'reasoning', jsonb_build_object('supported', to_jsonb(v.efforts), 'codex_model_default', NULL),
    'ccb', jsonb_build_object('capability_zero', true, 'supports_thinking', v.thinking)),
  1, 'staged'
FROM (VALUES
  ('glm-5.3-flash-go',            'glm-5.3-flash',            1000000, ARRAY['low','high'],           false),
  ('glm-5.2-go',                  'glm-5.2',                  1000000, ARRAY['low','medium','high'],  false),
  ('step-5-preview-go',           'step-5-preview',           1000000, ARRAY[]::text[],               false),
  ('mimo-v2.6-flash-go',          'mimo-v2.6-flash',          1048576, ARRAY[]::text[],               false),
  ('mimo-v2.5-go',                'mimo-v2.5',                1000000, ARRAY[]::text[],               false),
  ('minimax-m3-go',               'minimax-m3',                200000, ARRAY[]::text[],               true),
  ('qwen3.7-plus-go',             'qwen3.7-plus',              200000, ARRAY[]::text[],               true),
  ('hy3-go',                      'hy3',                       192000, ARRAY['low','high'],           false),
  ('longcat-2.5-preview-free-go', 'longcat-2.5-preview-free', 1000000, ARRAY[]::text[],               false),
  ('minimax-m3.1-flash-free-go',  'minimax-m3.1-flash-free',  1000000, ARRAY[]::text[],               false),
  ('beam-free-go',                'beam-free',                1048576, ARRAY[]::text[],               false)
) AS v(model_id, upstream, ctx, efforts, thinking);

INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
  cache_write_per_mtok, multiplier, enabled, sort_order, visibility, extra_system_prompt, default_effort, lock_version)
SELECT v.model_id, v.name, v.i, v.o, v.cr, v.cw, '1', FALSE,
  (SELECT COALESCE(MAX(sort_order), 100) FROM model_pricing) + v.ord, 'admin', NULL, NULL, 0
FROM (VALUES
  -- page USD in/out/cache-read[/cache-write] → fen (x100/2) → x0.2 floor where lower
  ('glm-5.3-flash-go',            'GLM-5.3 Flash',        26,  93,  4,  0,  1),  -- .15/.50/.03 → x0.1 → x0.2
  ('glm-5.2-go',                  'GLM-5.2',              70, 220, 13,  0,  2),  -- 1.40/4.40/.26 → x0.6
  ('step-5-preview-go',           'Step 5 Preview',       50, 135,  5,  0,  3),  -- 1/2.70/.10 → x0.3 (4x limited-time quota)
  ('mimo-v2.6-flash-go',          'MiMo V2.6 Flash',      27,  53,  4,  0,  4),  -- .14/.28/.0028 → x0.2
  ('mimo-v2.5-go',                'MiMo V2.5',            27,  53,  4,  0,  5),  -- .14/.28/.0028 → x0.2
  ('minimax-m3-go',               'MiniMax M3',           22,  85,  5,  0,  6),  -- .30/1.20/.06 → x0.2
  ('qwen3.7-plus-go',             'Qwen3.7 Plus',         31, 123,  4, 39,  7),  -- .40/1.60/.04/.50 (<=256K) → x0.2
  ('hy3-go',                      'Hy3',                  26, 107,  4,  0,  8),  -- .14/.58/.035 → x0.2
  ('longcat-2.5-preview-free-go', 'LongCat 2.5 Preview',  45, 135,  2,  0,  9),  -- free → x0.2
  ('minimax-m3.1-flash-free-go',  'MiniMax M3.1 Flash',   45, 135,  2,  0, 10),  -- free → x0.2
  ('beam-free-go',                'Beam',                 45, 135,  2,  0, 11)   -- free → x0.2
) AS v(model_id, name, i, o, cr, cw, ord);
