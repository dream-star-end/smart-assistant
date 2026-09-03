-- order-dependency: 0257_cursor_session_credential
-- 0258_cursor_opus_fable_context_1m.sql
-- Declare the mechanism context window of Cursor Opus 5 / Opus 4.8 / Fable 5 /
-- Fable 5.1 as 1,000,000 tokens. Upstream Cursor runs these SKUs at 1M; every
-- catalog row was minted with context_window NULL, which the CCB harness reads
-- as its 200k default and auto-compacts at ~167k — hence the frequent
-- compaction users observe on Fable 5.1.
--
-- Product tiering (300k default / 1M opt-in) is NOT a catalog concern. The
-- master narrows the signed executionDescriptor.contextWindow per turn from
-- InboundMessage.contextTier (protocol projectContextWindowForCursorTier);
-- the catalog only carries the ceiling. No pricing, visibility, alias,
-- capability_profile or upstream id changes here.
--
-- Active rows freeze execution fields (0144 fn_model_catalog_guard), so each
-- family row goes through fn_model_switch_version: the live entry is retired
-- and a new active entry with context_window=1000000 is created, bumping
-- model_security_epoch so ModelCatalogCache refreshes on all masters.
--
-- Idempotent: rows already at 1M are skipped; rows in any other lineage
-- (already switched with a different window, or not NULL/200k) fail closed.
--
-- BEGIN TESTED MANUAL ROLLBACK 0258
-- DO $rollback$
-- DECLARE
--   v_current model_catalog%ROWTYPE;
--   v_new_entry BIGINT;
-- BEGIN
--   FOR v_current IN
--     SELECT * FROM model_catalog
--      WHERE state = 'active' AND engine = 'cursor' AND context_window = 1000000
--        AND model_id ~ '^cursor-(opus-5|opus-4\.8|fable-5|fable-5\.1)-'
--      ORDER BY model_id FOR UPDATE
--   LOOP
--     SELECT fn_model_switch_version(
--       v_current.model_id, v_current.engine, v_current.provider_id,
--       v_current.upstream_model_id, NULL, v_current.capability_profile,
--       v_current.capability_schema_version, NULL, v_current.lock_version
--     ) INTO v_new_entry;
--   END LOOP;
-- END $rollback$;
-- END TESTED MANUAL ROLLBACK 0258

DO $migration$
DECLARE
  v_current model_catalog%ROWTYPE;
  v_new_entry BIGINT;
  v_switched INTEGER := 0;
  v_skipped INTEGER := 0;
  v_pricing_before JSONB;
  v_pricing_after JSONB;
  v_pattern CONSTANT TEXT := '^cursor-(opus-5|opus-4\.8|fable-5|fable-5\.1)-';
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id), '[]'::jsonb)
    INTO v_pricing_before FROM model_pricing p
   WHERE p.model_id ~ v_pattern;

  PERFORM 1 FROM model_catalog
   WHERE model_id ~ v_pattern
   ORDER BY model_id, entry_id FOR UPDATE;

  FOR v_current IN
    SELECT * FROM model_catalog
     WHERE state = 'active' AND model_id ~ v_pattern
     ORDER BY model_id
  LOOP
    IF v_current.engine <> 'cursor' THEN
      RAISE EXCEPTION '0258: % is active but engine=% (expected cursor)', v_current.model_id, v_current.engine;
    END IF;
    IF v_current.context_window = 1000000 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF v_current.context_window IS NOT NULL AND v_current.context_window <> 200000 THEN
      RAISE EXCEPTION '0258: % has unexpected context_window % — refusing to overwrite', v_current.model_id, v_current.context_window;
    END IF;
    IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = v_current.model_id AND state = 'staged') THEN
      RAISE EXCEPTION '0258: % has a pending staged version; activate or drop it first', v_current.model_id;
    END IF;

    SELECT fn_model_switch_version(
      v_current.model_id, v_current.engine, v_current.provider_id,
      v_current.upstream_model_id, 1000000, v_current.capability_profile,
      v_current.capability_schema_version, NULL, v_current.lock_version
    ) INTO v_new_entry;

    IF NOT EXISTS (SELECT 1 FROM model_catalog
                    WHERE entry_id = v_new_entry AND model_id = v_current.model_id
                      AND state = 'active' AND context_window = 1000000
                      AND upstream_model_id IS NOT DISTINCT FROM v_current.upstream_model_id
                      AND capability_profile IS NOT DISTINCT FROM v_current.capability_profile) THEN
      RAISE EXCEPTION '0258: % failed to activate the 1M entry', v_current.model_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM model_catalog
                    WHERE entry_id = v_current.entry_id AND state = 'retired') THEN
      RAISE EXCEPTION '0258: % previous entry % not retired', v_current.model_id, v_current.entry_id;
    END IF;
    v_switched := v_switched + 1;
  END LOOP;

  IF v_switched + v_skipped = 0 THEN
    RAISE EXCEPTION '0258: no active cursor opus/fable rows found';
  END IF;

  IF EXISTS (SELECT 1 FROM model_catalog
              WHERE state = 'active' AND model_id ~ v_pattern
                AND context_window IS DISTINCT FROM 1000000) THEN
    RAISE EXCEPTION '0258: postcondition failed — an active cursor opus/fable row is not 1M';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id), '[]'::jsonb)
    INTO v_pricing_after FROM model_pricing p
   WHERE p.model_id ~ v_pattern;
  IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
    RAISE EXCEPTION '0258: pricing changed during context window switch';
  END IF;

  RAISE NOTICE '0258: switched % cursor opus/fable rows to 1M (skipped % already at 1M)', v_switched, v_skipped;
END
$migration$;
