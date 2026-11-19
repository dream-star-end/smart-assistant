-- order-dependency: 0343_commercial_gpt62_sol_astra_models
-- compat: purely additive staged model_catalog and disabled admin-visibility model_pricing rows for Gemini 4 Neon and Orchestrator Neon; pre-0344 binaries ignore staged/disabled entries.
-- Official USD/MTok (1M context): input 3.00, output 15.00, implicit cache 0.15.
-- Commercial-aligned stored fen/MTok (200 fen/USD input & output, 100 fen/USD cache read, multiplier 1): 600 / 3000 / 15 / 0.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE model_catalog, model_pricing IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  rec RECORD;
  cat_count INTEGER;
  has_pricing BOOLEAN;
  did_insert BOOLEAN := FALSE;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      (
        'antigravity-gemini-4-neon',
        'gemini-4-neon-high',
        'Gemini 4 Neon (Antigravity)',
        'high'::TEXT,
        '{"supports_vision":false,"reasoning":{"supported":["low","medium","high","xhigh"],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb
      ),
      (
        'antigravity-orchestrator-neon',
        'gemini-pro-orchestrator-neon',
        'Orchestrator Neon (Antigravity)',
        NULL::TEXT,
        '{"supports_vision":false,"reasoning":{"supported":[],"codex_model_default":null},"ccb":{"capability_zero":false,"supports_thinking":false}}'::jsonb
      )
    ) AS t(model_id, upstream_model_id, display_name, default_effort, capability_profile)
  LOOP
    SELECT count(*) INTO cat_count
      FROM model_catalog
     WHERE model_id = rec.model_id AND state IN ('staged', 'active', 'disabled');
    SELECT EXISTS (
      SELECT 1 FROM model_pricing WHERE model_id = rec.model_id
    ) INTO has_pricing;

    IF cat_count = 0 AND NOT has_pricing THEN
      INSERT INTO model_catalog(
        model_id, engine, provider_id, upstream_model_id, context_window,
        capability_profile, capability_schema_version, state
      ) VALUES (
        rec.model_id, 'antigravity', 'antigravity', rec.upstream_model_id, 1048576,
        rec.capability_profile, 1, 'staged'
      );

      INSERT INTO model_pricing(
        model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok,
        cache_write_per_mtok, multiplier, enabled, sort_order, visibility,
        extra_system_prompt, default_effort, lock_version
      ) VALUES (
        rec.model_id, rec.display_name, 600, 3000, 15,
        0, '1', FALSE, (SELECT COALESCE(MAX(sort_order), 100) + 1 FROM model_pricing), 'admin',
        NULL, rec.default_effort, 0
      );

      did_insert := TRUE;
    ELSIF cat_count = 1 AND has_pricing THEN
      IF NOT EXISTS (
        SELECT 1
          FROM model_catalog c
          JOIN model_pricing p USING (model_id)
         WHERE c.model_id = rec.model_id
           AND c.state IN ('staged', 'active', 'disabled')
           AND c.engine = 'antigravity'
           AND c.provider_id = 'antigravity'
           AND c.upstream_model_id IS NOT DISTINCT FROM rec.upstream_model_id
           AND c.context_window = 1048576
           AND c.capability_schema_version = 1
           AND c.capability_profile = rec.capability_profile
           AND p.input_per_mtok = 600
           AND p.output_per_mtok = 3000
           AND p.cache_read_per_mtok = 15
           AND p.cache_write_per_mtok = 0
           AND p.multiplier = 1
           AND p.default_effort IS NOT DISTINCT FROM rec.default_effort
           AND (
             (c.state = 'active' AND p.enabled IS TRUE)
             OR (c.state IN ('staged', 'disabled') AND p.enabled IS FALSE AND p.visibility = 'admin')
           )
      ) THEN
        RAISE EXCEPTION '0344 refuses drifted or inconsistent % row', rec.model_id;
      END IF;
    ELSE
      RAISE EXCEPTION '0344 refuses incomplete % catalog/pricing pair (catalog=%, pricing=%)', rec.model_id, cat_count, has_pricing;
    END IF;
  END LOOP;

  IF did_insert THEN
    PERFORM fn_model_security_epoch_bump();
  END IF;
END $$;
