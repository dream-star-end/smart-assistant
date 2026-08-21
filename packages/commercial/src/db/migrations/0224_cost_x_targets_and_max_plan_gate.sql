-- 0224_cost_x_targets_and_max_plan_gate.sql
-- Reprice selected public models so picker/billing xN vs DeepSeek V4 Pro
-- matches the 2026-08-19 product table, and require Max+ for Opus 5 / Fable 5.
--
-- xN stays the existing blended formula (protocol modelCostIndex). Fen ratios
-- are scaled from the 0223 official CNY list so input/cache/output shape is
-- preserved; 1M twins stay exactly 2× their short-window fen; Cursor Fast rows
-- keep multiplier=2 (so Fast is 2× the family xN). V4 Pro fen is unchanged.
-- Historical usage_records are not rewritten.
--
-- glm-5.2 is disabled/hidden; it is still repriced in lockstep with live
-- glm-5.3 / glm-5.3-zai (user named glm-5.2; the public GLM family is 5.3).
--
-- Opus 5 / Fable 5: model_pricing.min_plan_code = 'max'. listForUser and
-- canUseModel hide and reject below Max. Personal tier >= max, or org-max /
-- org-ultra, qualifies. Admin role does not bypass. Cursor credential gate
-- is unchanged and still required.

ALTER TABLE model_pricing
  ADD COLUMN IF NOT EXISTS min_plan_code text;

DO $$
DECLARE
  affected INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'deepseek-v4-pro' AND c.state = 'active' AND p.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0224 requires active enabled deepseek-v4-pro floor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM subscription_plans WHERE code = 'max' AND scope = 'user' AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '0224 requires enabled user-scope max plan';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
     WHERE c.model_id = 'gpt-5.6-sol-1m' AND c.state = 'active'
  ) THEN
    RAISE EXCEPTION '0224 requires 0223 GPT 1M twins';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'model_pricing_min_plan_code_fkey'
  ) THEN
    ALTER TABLE model_pricing
      ADD CONSTRAINT model_pricing_min_plan_code_fkey
      FOREIGN KEY (min_plan_code) REFERENCES subscription_plans(code) ON DELETE RESTRICT;
  END IF;

  -- GLM family → x2.0
  UPDATE model_pricing
     SET input_per_mtok = 453,
         cache_read_per_mtok = 84,
         cache_write_per_mtok = 0,
         output_per_mtok = 1424
   WHERE model_id IN ('glm-5.2', 'glm-5.3', 'glm-5.3-zai');
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 3 THEN
    RAISE EXCEPTION '0224: expected 3 GLM rows, got %', affected;
  END IF;

  -- Kimi K3 default 256k → x4.0; 1M = 2× → x8.0
  UPDATE model_pricing
     SET input_per_mtok = 1219,
         cache_read_per_mtok = 122,
         cache_write_per_mtok = 0,
         output_per_mtok = 6092
   WHERE model_id = 'k3-256k';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for k3-256k, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 2438,
         cache_read_per_mtok = 244,
         cache_write_per_mtok = 0,
         output_per_mtok = 12184
   WHERE model_id = 'kimi-k3';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for kimi-k3, got %', affected;
  END IF;

  -- GPT-5.6 Sol → x4.0 / 1M x8.0
  UPDATE model_pricing
     SET input_per_mtok = 1199,
         cache_read_per_mtok = 120,
         cache_write_per_mtok = 0,
         output_per_mtok = 7197
   WHERE model_id = 'gpt-5.6-sol';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for gpt-5.6-sol, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 2398,
         cache_read_per_mtok = 240,
         cache_write_per_mtok = 0,
         output_per_mtok = 14394
   WHERE model_id = 'gpt-5.6-sol-1m';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for gpt-5.6-sol-1m, got %', affected;
  END IF;

  -- Terra → x2.0 / 1M x4.0
  UPDATE model_pricing
     SET input_per_mtok = 600,
         cache_read_per_mtok = 60,
         cache_write_per_mtok = 0,
         output_per_mtok = 3599
   WHERE model_id = 'gpt-5.6-terra';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for gpt-5.6-terra, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 1200,
         cache_read_per_mtok = 120,
         cache_write_per_mtok = 0,
         output_per_mtok = 7198
   WHERE model_id = 'gpt-5.6-terra-1m';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for gpt-5.6-terra-1m, got %', affected;
  END IF;

  -- Luna → x1.0 / 1M x2.0
  UPDATE model_pricing
     SET input_per_mtok = 296,
         cache_read_per_mtok = 31,
         cache_write_per_mtok = 0,
         output_per_mtok = 1776
   WHERE model_id = 'gpt-5.6-luna';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for gpt-5.6-luna, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 592,
         cache_read_per_mtok = 62,
         cache_write_per_mtok = 0,
         output_per_mtok = 3552
   WHERE model_id = 'gpt-5.6-luna-1m';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for gpt-5.6-luna-1m, got %', affected;
  END IF;

  -- DeepSeek V4 Flash → x0.5 (V4 Pro stays x1.0)
  UPDATE model_pricing
     SET input_per_mtok = 225,
         cache_read_per_mtok = 7,
         cache_write_per_mtok = 0,
         output_per_mtok = 675
   WHERE model_id = 'deepseek-v4-flash';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0224: expected 1 row for deepseek-v4-flash, got %', affected;
  END IF;

  -- Cursor Grok 4.6 family → x2.0 (Fast stays multiplier=2 → x4.0)
  UPDATE model_pricing
     SET input_per_mtok = 376,
         cache_read_per_mtok = 94,
         cache_write_per_mtok = 0,
         output_per_mtok = 1127
   WHERE model_id LIKE 'cursor-grok-4.6-%';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 8 THEN
    RAISE EXCEPTION '0224: expected 8 cursor-grok-4.6 rows, got %', affected;
  END IF;

  -- Composer 2.5 → x2.0 (Fast → x4.0)
  UPDATE model_pricing
     SET input_per_mtok = 264,
         cache_read_per_mtok = 106,
         cache_write_per_mtok = 0,
         output_per_mtok = 1320
   WHERE model_id LIKE 'cursor-composer-2.5%';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 2 THEN
    RAISE EXCEPTION '0224: expected 2 composer-2.5 rows, got %', affected;
  END IF;

  -- Opus 5 → x10 (Fast → x20)
  UPDATE model_pricing
     SET input_per_mtok = 3047,
         cache_read_per_mtok = 305,
         cache_write_per_mtok = 0,
         output_per_mtok = 15234
   WHERE model_id LIKE 'cursor-opus-5-%';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 10 THEN
    RAISE EXCEPTION '0224: expected 10 cursor-opus-5 rows, got %', affected;
  END IF;

  -- Fable 5 → x20 (no Fast rows)
  UPDATE model_pricing
     SET input_per_mtok = 6098,
         cache_read_per_mtok = 610,
         cache_write_per_mtok = 0,
         output_per_mtok = 30486
   WHERE model_id LIKE 'cursor-fable-5-%';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 5 THEN
    RAISE EXCEPTION '0224: expected 5 cursor-fable-5 rows, got %', affected;
  END IF;

  UPDATE model_pricing
     SET min_plan_code = 'max'
   WHERE model_id LIKE 'cursor-opus-5-%'
      OR model_id LIKE 'cursor-fable-5-%';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 15 THEN
    RAISE EXCEPTION '0224: expected 15 Opus/Fable min_plan rows, got %', affected;
  END IF;
END $$;
