-- order-dependency: 0286_claude_opus_55
-- 0287_claude_opus_55_context_1m.sql
-- Raise the Claude Opus 5.5 mechanism window from the 200k derivation used
-- at onboard to the official 1,000,000-token context.
--
-- 0286 deliberately left context_window=200000: that value drives CCB
-- auto-compact, and the 1M subscription-pool behavior was not confirmed
-- then. The operator has now asked for the official 1M ceiling on this
-- model only. Cursor variants stay absent. Pricing, visibility, capability
-- profile, thinking policy, and every other catalog row stay put.
--
-- Active rows freeze execution fields (0144 fn_model_catalog_guard), so the
-- live entry goes through fn_model_switch_version: the 200k entry is retired
-- and a new active entry with context_window=1000000 is created, bumping
-- model_security_epoch so ModelCatalogCache refreshes. There is no per-role
-- cap for this model (modelRolePolicy only narrows kimi-k3), so the signed
-- CCB window becomes 1M for every role.
--
-- The pricing-insert derivation function still said 200000 for this id via
-- its ELSE branch. Replace it so a later re-derive cannot silently compact
-- Opus 5.5 back to 200k. Other ids keep the 0217 outputs.
--
-- Idempotent: an active row already at 1M is left in place. Any other window
-- fails closed. Pricing must be unchanged.
--
-- BEGIN TESTED MANUAL ROLLBACK 0287
-- DO $rollback$
-- DECLARE
--   v_current model_catalog%ROWTYPE;
--   v_new_entry BIGINT;
-- BEGIN
--   SELECT * INTO STRICT v_current
--     FROM model_catalog
--    WHERE model_id = 'claude-opus-5-5' AND state = 'active'
--    FOR UPDATE;
--   IF v_current.context_window = 1000000 THEN
--     SELECT fn_model_switch_version(
--       v_current.model_id, v_current.engine, v_current.provider_id,
--       v_current.upstream_model_id, 200000, v_current.capability_profile,
--       v_current.capability_schema_version, NULL, v_current.lock_version
--     ) INTO v_new_entry;
--   END IF;
-- END $rollback$;
-- Then restore fn_model_catalog_context_window to the 0217 body (no
-- claude-opus-5-5 arm; ELSE 200000) before any catalog re-derive.
-- END TESTED MANUAL ROLLBACK 0287

CREATE OR REPLACE FUNCTION fn_model_catalog_context_window(p_model_id TEXT) RETURNS INTEGER AS $$
  SELECT CASE
    WHEN p_model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN NULL
    WHEN lower(btrim(p_model_id)) = 'minimax-m3' THEN 512000
    WHEN lower(btrim(p_model_id)) IN (
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-opencode-go'
    ) THEN 1000000
    WHEN lower(btrim(p_model_id)) IN ('glm-5.2', 'glm-5.3', 'glm-5.3-zai') THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'glm-5.1' THEN 200000
    WHEN lower(btrim(p_model_id)) IN ('qwen3.7-max', 'qwen3.7-plus') THEN 1000000
    WHEN lower(btrim(p_model_id)) = 'kimi-k2.7-code' THEN 256000
    WHEN lower(btrim(p_model_id)) = 'claude-opus-5-5' THEN 1000000
    ELSE 200000
  END
$$ LANGUAGE sql IMMUTABLE;

DO $migration$
DECLARE
  v_current model_catalog%ROWTYPE;
  v_new_entry BIGINT;
  v_pricing_before JSONB;
  v_pricing_after JSONB;
BEGIN
  IF fn_model_catalog_context_window('claude-opus-5-5') <> 1000000
     OR fn_model_catalog_context_window('claude-opus-5') <> 200000
     OR fn_model_catalog_context_window('glm-5.3') <> 1000000
     OR fn_model_catalog_context_window('gpt-5.6-sol') IS NOT NULL THEN
    RAISE EXCEPTION '0287 context window derivation postcondition failed';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id), '[]'::jsonb)
    INTO v_pricing_before
    FROM model_pricing p
   WHERE p.model_id = 'claude-opus-5-5';

  PERFORM 1 FROM model_catalog
   WHERE model_id = 'claude-opus-5-5'
   ORDER BY entry_id
   FOR UPDATE;

  SELECT * INTO v_current
    FROM model_catalog
   WHERE model_id = 'claude-opus-5-5' AND state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0287: claude-opus-5-5 has no active catalog row (0286 must run first)';
  END IF;
  IF v_current.engine <> 'ccb' OR v_current.provider_id <> 'anthropic' THEN
    RAISE EXCEPTION '0287: claude-opus-5-5 active engine/provider is %/%', v_current.engine, v_current.provider_id;
  END IF;

  IF v_current.context_window IS DISTINCT FROM 1000000 THEN
    IF v_current.context_window IS DISTINCT FROM 200000 THEN
      RAISE EXCEPTION '0287: claude-opus-5-5 has unexpected context_window %', v_current.context_window;
    END IF;
    IF EXISTS (
      SELECT 1 FROM model_catalog
       WHERE model_id = 'claude-opus-5-5' AND state = 'staged'
    ) THEN
      RAISE EXCEPTION '0287: claude-opus-5-5 has a pending staged version';
    END IF;

    SELECT fn_model_switch_version(
      v_current.model_id, v_current.engine, v_current.provider_id,
      v_current.upstream_model_id, 1000000, v_current.capability_profile,
      v_current.capability_schema_version, NULL, v_current.lock_version
    ) INTO v_new_entry;

    IF NOT EXISTS (
      SELECT 1 FROM model_catalog
       WHERE entry_id = v_new_entry
         AND model_id = 'claude-opus-5-5'
         AND state = 'active'
         AND engine = 'ccb'
         AND provider_id = 'anthropic'
         AND context_window = 1000000
         AND upstream_model_id IS NOT DISTINCT FROM v_current.upstream_model_id
         AND capability_profile IS NOT DISTINCT FROM v_current.capability_profile
    ) THEN
      RAISE EXCEPTION '0287: failed to activate the 1M entry';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM model_catalog
       WHERE entry_id = v_current.entry_id AND state = 'retired' AND context_window = 200000
    ) THEN
      RAISE EXCEPTION '0287: previous entry % was not retired', v_current.entry_id;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'claude-opus-5-5' AND state = 'active' AND context_window IS DISTINCT FROM 1000000
  ) OR (
    SELECT count(*) FROM model_catalog
     WHERE model_id = 'claude-opus-5-5' AND state = 'active'
  ) <> 1 THEN
    RAISE EXCEPTION '0287: postcondition failed — active claude-opus-5-5 is not the single 1M row';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'claude-opus-5' AND state = 'active' AND context_window IS DISTINCT FROM 200000
  ) THEN
    RAISE EXCEPTION '0287: claude-opus-5 window changed';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(p) - ARRAY['updated_at', 'lock_version'] ORDER BY p.model_id), '[]'::jsonb)
    INTO v_pricing_after
    FROM model_pricing p
   WHERE p.model_id = 'claude-opus-5-5';
  IF v_pricing_after IS DISTINCT FROM v_pricing_before THEN
    RAISE EXCEPTION '0287: pricing changed during context window switch';
  END IF;
END
$migration$;
