-- 0223_official_cny_pricing_and_gpt_1m.sql
-- Refresh live catalog prices to vendor list prices as of 2026-08-18, convert
-- USD rows with the 2026-08-18 CNY mid-rate 6.7905 (100 USD = 679.05 CNY),
-- and add GPT-5.6 1M twins billed at short-window ×2.
--
-- Units remain 分/MTok. USD fen = round(usd * 679.05).
-- DeepSeek / MiniMax are already CNY list prices (DeepSeek uses off-peak;
-- peak is 08:00-12:00 and 14:00-18:00 Beijing time).
-- GLM-5.3 has no published per-token row; glm-5.3 / glm-5.3-zai use GLM-5.2
-- list $1.4 / $0.26 / $4.4 as the stand-in.
-- Grok 4.6 launch 50% discount is not written.
-- Historical usage_records are not rewritten.
--
-- GPT 1M: independent catalog ids. Codex spawn keeps the short-window CLI
-- model and injects per-spawn `-c model_context_window=1000000` /
-- `model_auto_compact_token_limit=900000`. Do not persist ~/.codex/config.toml.
-- Kimi 1M stays the existing kimi-k3 row (official K3); k3-256k is official/2.
--
-- Old master: price UPDATEs apply immediately (more accurate billing).
-- New GPT 1M rows are born staged then activated; unknown ids are unroutable
-- until the new protocol/gateway/web deploy.

DO $$
DECLARE
  affected INT;
  rec RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'deepseek-v4-pro' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0223 requires active enabled deepseek-v4-pro floor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-5.6-sol' AND c.engine = 'codex' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0223 requires active enabled gpt-5.6-sol floor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'k3-256k' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0223 requires active enabled k3-256k floor';
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 150,
         cache_read_per_mtok = 5,
         cache_write_per_mtok = 0,
         output_per_mtok = 450,
         multiplier = 1
   WHERE model_id = 'deepseek-v4-flash';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for deepseek-v4-flash, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 450,
         cache_read_per_mtok = 15,
         cache_write_per_mtok = 0,
         output_per_mtok = 1350,
         multiplier = 1
   WHERE model_id = 'deepseek-v4-pro';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for deepseek-v4-pro, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 210,
         cache_read_per_mtok = 42,
         cache_write_per_mtok = 0,
         output_per_mtok = 840,
         multiplier = 1
   WHERE model_id = 'MiniMax-M3';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for MiniMax-M3, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 951,
         cache_read_per_mtok = 177,
         cache_write_per_mtok = 0,
         output_per_mtok = 2988,
         multiplier = 1
   WHERE model_id IN ('glm-5.3', 'glm-5.3-zai');
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 2 THEN
    RAISE EXCEPTION '0223: expected 2 GLM-5.3 rows, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 951,
         cache_read_per_mtok = 177,
         cache_write_per_mtok = 0,
         output_per_mtok = 2988,
         multiplier = 1
   WHERE model_id = 'glm-5.2';

  IF EXISTS (SELECT 1 FROM model_pricing WHERE model_id = 'qwen3.8-max') THEN
    UPDATE model_pricing
       SET input_per_mtok = 1358,
           cache_read_per_mtok = 170,
           cache_write_per_mtok = 0,
           output_per_mtok = 4074,
           multiplier = 1
     WHERE model_id = 'qwen3.8-max';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION '0223: expected 1 row for qwen3.8-max, got %', affected;
    END IF;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 2037,
         cache_read_per_mtok = 204,
         cache_write_per_mtok = 0,
         output_per_mtok = 10186,
         multiplier = 1
   WHERE model_id = 'kimi-k3';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for kimi-k3, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 1019,
         cache_read_per_mtok = 102,
         cache_write_per_mtok = 0,
         output_per_mtok = 5093,
         multiplier = 1
   WHERE model_id = 'k3-256k';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for k3-256k, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 645,
         cache_read_per_mtok = 129,
         cache_write_per_mtok = 0,
         output_per_mtok = 2716,
         multiplier = 1
   WHERE model_id = 'kimi-k2.7-code';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for kimi-k2.7-code, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 3395,
         cache_read_per_mtok = 340,
         cache_write_per_mtok = 4244,
         output_per_mtok = 20372,
         multiplier = 1
   WHERE model_id = 'gpt-5.6-sol';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for gpt-5.6-sol, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 1358,
         cache_read_per_mtok = 136,
         cache_write_per_mtok = 1698,
         output_per_mtok = 8149,
         multiplier = 1
   WHERE model_id = 'gpt-5.6-terra';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for gpt-5.6-terra, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 136,
         cache_read_per_mtok = 14,
         cache_write_per_mtok = 170,
         output_per_mtok = 815,
         multiplier = 1
   WHERE model_id = 'gpt-5.6-luna';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0223: expected 1 row for gpt-5.6-luna, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 1358,
         cache_read_per_mtok = 340,
         cache_write_per_mtok = 0,
         output_per_mtok = 4074
   WHERE model_id LIKE 'cursor-grok-4.6-%'
      OR model_id = 'cursor-grok-4.5-high';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 9 THEN
    RAISE EXCEPTION '0223: expected 9 Grok Cursor rows, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 340,
         cache_read_per_mtok = 136,
         cache_write_per_mtok = 0,
         output_per_mtok = 1698
   WHERE model_id IN ('cursor-composer-2.5', 'cursor-composer-2.5-fast');
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 2 THEN
    RAISE EXCEPTION '0223: expected 2 Composer rows, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 3395,
         cache_read_per_mtok = 340,
         cache_write_per_mtok = 4244,
         output_per_mtok = 16976
   WHERE model_id LIKE 'cursor-opus-5-%';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 10 THEN
    RAISE EXCEPTION '0223: expected 10 Opus 5 rows, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 6791,
         cache_read_per_mtok = 679,
         cache_write_per_mtok = 8488,
         output_per_mtok = 33953
   WHERE model_id LIKE 'cursor-fable-5-%';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 5 THEN
    RAISE EXCEPTION '0223: expected 5 Fable 5 rows, got %', affected;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'cursor-auto'
       AND (input_per_mtok <> 0 OR output_per_mtok <> 0
            OR cache_read_per_mtok <> 0 OR cache_write_per_mtok <> 0)
  ) THEN
    RAISE EXCEPTION '0223: cursor-auto must remain zero-priced';
  END IF;

  FOR rec IN
    SELECT * FROM (VALUES
      ('gpt-5.6-sol-1m', 'gpt-5.6-sol', 'GPT-5.6-Sol', 6790, 680, 8488, 40744),
      ('gpt-5.6-terra-1m', 'gpt-5.6-terra', 'GPT-5.6-Terra', 2716, 272, 3396, 16298),
      ('gpt-5.6-luna-1m', 'gpt-5.6-luna', 'GPT-5.6-Luna', 272, 28, 340, 1630)
    ) AS t(model_id, baseline_id, display_name, input_per_mtok, cache_read_per_mtok, cache_write_per_mtok, output_per_mtok)
  LOOP
    IF EXISTS (SELECT 1 FROM model_catalog WHERE model_id = rec.model_id)
       OR EXISTS (SELECT 1 FROM model_pricing WHERE model_id = rec.model_id) THEN
      RAISE EXCEPTION '0223 refuses pre-existing %', rec.model_id;
    END IF;

    INSERT INTO model_catalog (
      model_id, engine, provider_id, upstream_model_id, context_window,
      capability_profile, capability_schema_version, state
    )
    SELECT
      rec.model_id,
      engine,
      provider_id,
      rec.baseline_id,
      1000000,
      capability_profile,
      capability_schema_version,
      'staged'
    FROM model_catalog
    WHERE model_id = rec.baseline_id AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0223 failed to clone catalog from % for %', rec.baseline_id, rec.model_id;
    END IF;

    INSERT INTO model_pricing (
      model_id, display_name,
      input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
      multiplier, enabled, sort_order, visibility, extra_system_prompt,
      default_effort, lock_version
    )
    SELECT
      rec.model_id,
      rec.display_name,
      rec.input_per_mtok, rec.output_per_mtok, rec.cache_read_per_mtok, rec.cache_write_per_mtok,
      1, FALSE, sort_order, visibility, extra_system_prompt,
      default_effort, 0
    FROM model_pricing
    WHERE model_id = rec.baseline_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0223 failed to clone pricing from % for %', rec.baseline_id, rec.model_id;
    END IF;

    UPDATE model_catalog
       SET state = 'active'
     WHERE model_id = rec.model_id AND state = 'staged';
    IF NOT FOUND THEN
      RAISE EXCEPTION '0223 failed to activate catalog %', rec.model_id;
    END IF;

    UPDATE model_pricing AS neu
       SET enabled = TRUE,
           visibility = baseline.visibility,
           multiplier = 1,
           lock_version = neu.lock_version + 1
      FROM model_pricing AS baseline
     WHERE neu.model_id = rec.model_id
       AND baseline.model_id = rec.baseline_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0223 failed to enable pricing %', rec.model_id;
    END IF;

    INSERT INTO model_visibility_grants(user_id, model_id, granted_by)
    SELECT g.user_id, rec.model_id, g.granted_by
      FROM model_visibility_grants g
     WHERE g.model_id = rec.baseline_id
    ON CONFLICT (user_id, model_id) DO NOTHING;
  END LOOP;

  IF (SELECT COUNT(*) FROM model_catalog c JOIN model_pricing p USING (model_id)
       WHERE c.model_id IN ('gpt-5.6-sol-1m', 'gpt-5.6-terra-1m', 'gpt-5.6-luna-1m')
         AND c.engine = 'codex'
         AND c.state = 'active'
         AND c.context_window = 1000000
         AND p.enabled IS TRUE) <> 3 THEN
    RAISE EXCEPTION '0223 expected 3 active GPT 1M rows';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'gpt-5.6-sol' AND multiplier <> 1
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'gpt-5.6-sol-1m'
       AND (input_per_mtok <> 6790 OR multiplier <> 1)
  ) OR EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'deepseek-v4-pro' AND input_per_mtok <> 450
  ) THEN
    RAISE EXCEPTION '0223 price postcondition mismatch';
  END IF;
END $$;
