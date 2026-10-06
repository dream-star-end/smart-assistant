-- order-dependency: 0297_commercial_minimax_refs_to_grok_build
-- 0298 commercial-only: the Box model route runs Opus 5.5 and Sonnet 5.5 at a 1,000,000-token
-- window, not 200,000. 0294 and 0295 copied context_window=200000 from the selfhost row that
-- scripts/ocv5-289/boxCatalogStage.ts creates; no measurement ever backed that number. The Box CLI
-- (2.1.288) reports contextWindow 1000000 for claude-opus-5-5 and claude-sonnet-5-5 with the plain
-- model id, no [1m] suffix and no beta header, and Box accepted a 324k-token prompt on both. The
-- retired box-claude-opus-5-5 / box-claude-sonnet-5 rows and claude-opus-5-5 already carry 1000000.
-- Haiku 4.5 stays at 200000: the CLI reports 200000 for it.
--
-- The window is what the agent compacts against, so compaction now starts near 1M instead of near
-- 167k. Pricing, visibility, capability profile and upstream ids are not touched.
--
-- A staged row (a fresh database that ran 0294/0295) takes the value in place. An active or
-- disabled row has frozen execution fields (0144 guard) and goes through fn_model_switch_version,
-- which keeps an active row active (a disabled row comes back staged, still unavailable), retires
-- the old entry and bumps model_security_epoch. A row already at
-- 1000000 is skipped; any other window, a pending staged version beside a live one, or a missing
-- row fails closed.
--
-- BEGIN TESTED MANUAL ROLLBACK 0298
-- DO $rollback$
-- DECLARE
--   v_current model_catalog%ROWTYPE;
-- BEGIN
--   FOR v_current IN
--     SELECT * FROM model_catalog
--      WHERE state IN ('staged', 'active', 'disabled') AND context_window = 1000000
--        AND model_id IN ('box-api-claude-opus-5-5', 'box-api-claude-sonnet-5-5')
--      ORDER BY model_id FOR UPDATE
--   LOOP
--     IF v_current.state = 'staged' THEN
--       UPDATE model_catalog SET context_window = 200000 WHERE entry_id = v_current.entry_id;
--     ELSE
--       PERFORM fn_model_switch_version(
--         v_current.model_id, v_current.engine, v_current.provider_id,
--         v_current.upstream_model_id, 200000, v_current.capability_profile,
--         v_current.capability_schema_version, NULL, v_current.lock_version);
--     END IF;
--   END LOOP;
-- END $rollback$;
-- END TESTED MANUAL ROLLBACK 0298

DO $migration$
DECLARE
  v_model TEXT;
  v_current model_catalog%ROWTYPE;
  v_new_entry BIGINT;
  v_switched INTEGER := 0;
  v_skipped INTEGER := 0;
  v_pricing_before JSONB;
  v_pricing_after JSONB;
  v_models CONSTANT TEXT[] := ARRAY['box-api-claude-opus-5-5', 'box-api-claude-sonnet-5-5'];
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id), '[]'::jsonb)
    INTO v_pricing_before FROM model_pricing p WHERE p.model_id = ANY(v_models);

  PERFORM 1 FROM model_catalog WHERE model_id = ANY(v_models) ORDER BY model_id, entry_id FOR UPDATE;

  FOREACH v_model IN ARRAY v_models LOOP
    SELECT * INTO v_current FROM model_catalog c
     WHERE c.model_id = v_model AND c.state IN ('staged', 'active', 'disabled')
     ORDER BY (c.state = 'active') DESC, (c.state = 'staged') DESC, c.entry_id DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0298: % has no live catalog row', v_model;
    END IF;
    IF v_current.engine <> 'ccb' OR v_current.provider_id <> 'box_cli' THEN
      RAISE EXCEPTION '0298: % is engine=% provider=% (expected ccb/box_cli)', v_model, v_current.engine, v_current.provider_id;
    END IF;
    IF v_current.context_window = 1000000 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF v_current.context_window IS DISTINCT FROM 200000 THEN
      RAISE EXCEPTION '0298: % has unexpected context_window % - refusing to overwrite', v_model, v_current.context_window;
    END IF;
    IF v_current.state <> 'staged' AND EXISTS (
         SELECT 1 FROM model_catalog WHERE model_id = v_model AND state = 'staged') THEN
      RAISE EXCEPTION '0298: % has a pending staged version beside its live one', v_model;
    END IF;

    IF v_current.state = 'staged' THEN
      UPDATE model_catalog SET context_window = 1000000 WHERE entry_id = v_current.entry_id;
    ELSE
      SELECT fn_model_switch_version(
        v_current.model_id, v_current.engine, v_current.provider_id,
        v_current.upstream_model_id, 1000000, v_current.capability_profile,
        v_current.capability_schema_version, NULL, v_current.lock_version) INTO v_new_entry;
      IF NOT EXISTS (SELECT 1 FROM model_catalog
                      WHERE entry_id = v_new_entry AND model_id = v_model
                        AND state = CASE WHEN v_current.state = 'active' THEN 'active' ELSE 'staged' END
                        AND context_window = 1000000
                        AND upstream_model_id IS NOT DISTINCT FROM v_current.upstream_model_id
                        AND capability_profile IS NOT DISTINCT FROM v_current.capability_profile)
         OR NOT EXISTS (SELECT 1 FROM model_catalog WHERE entry_id = v_current.entry_id AND state = 'retired') THEN
        RAISE EXCEPTION '0298: % did not switch to a 1M entry from state %', v_model, v_current.state;
      END IF;
    END IF;
    v_switched := v_switched + 1;
  END LOOP;

  IF (SELECT count(*) FROM model_catalog
       WHERE model_id = ANY(v_models) AND state IN ('staged', 'active', 'disabled')
         AND context_window = 1000000) <> 2 THEN
    RAISE EXCEPTION '0298: postcondition failed - Opus 5.5 and Sonnet 5.5 are not both live at 1M';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id), '[]'::jsonb)
    INTO v_pricing_after FROM model_pricing p WHERE p.model_id = ANY(v_models);
  IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
    RAISE EXCEPTION '0298: pricing changed during the context window switch';
  END IF;
  RAISE NOTICE '0298: % Box route rows set to 1M (skipped % already at 1M)', v_switched, v_skipped;
END
$migration$;
