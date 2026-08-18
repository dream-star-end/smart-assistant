-- 0221_cursor_official_pricing.sql
-- Cursor 平台计费：按 Cursor 官方价（2026-08-18 docs/models-and-pricing）写入
-- model_pricing；*-fast 用基线官方价 + multiplier=2。不改 visibility/grants/schema。
--
-- 单位与 0007/0020/0063 一致：*_per_mtok = 分/MTok，1¥ = $1。
-- 来源：https://cursor.com/docs/models-and-pricing （抓取 2026-08-18）
--   Grok 4.6 / 4.5          $2 / — / $0.5 / $6
--   Composer 2.5 基线       $0.5 / — / $0.2 / $2.5   （不用官方 Fast $3/$15；fast 一律 x2）
--   Claude Opus 5           $5 / $6.25 / $0.5 / $25
--   Claude Fable 5          $10 / $12.5 / $1 / $50
-- cursor-auto 保持 0（hidden router，无单一官方价）。
-- 不用 Grok 4.6 一周 50% 首发折扣。
--
-- 对旧 master 安全：旧代码 billingMode=external，从不 settle，改价是空操作。
-- pricing_changed NOTIFY（0008）会让 PricingCache 重载。

DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE model_pricing
     SET input_per_mtok = 200,
         output_per_mtok = 600,
         cache_read_per_mtok = 50,
         cache_write_per_mtok = 0,
         multiplier = 1
   WHERE model_id = 'cursor-grok-4.6-high';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0221: expected 1 row for cursor-grok-4.6-high, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 200,
         output_per_mtok = 600,
         cache_read_per_mtok = 50,
         cache_write_per_mtok = 0,
         multiplier = 2
   WHERE model_id = 'cursor-grok-4.6-high-fast';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0221: expected 1 row for cursor-grok-4.6-high-fast, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 200,
         output_per_mtok = 600,
         cache_read_per_mtok = 50,
         cache_write_per_mtok = 0,
         multiplier = 1
   WHERE model_id = 'cursor-grok-4.5-high';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0221: expected 1 row for cursor-grok-4.5-high, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 50,
         output_per_mtok = 250,
         cache_read_per_mtok = 20,
         cache_write_per_mtok = 0,
         multiplier = 2
   WHERE model_id = 'cursor-composer-2.5-fast';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0221: expected 1 row for cursor-composer-2.5-fast, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 500,
         output_per_mtok = 2500,
         cache_read_per_mtok = 50,
         cache_write_per_mtok = 625,
         multiplier = 1
   WHERE model_id = 'cursor-opus-5-high';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0221: expected 1 row for cursor-opus-5-high, got %', affected;
  END IF;

  UPDATE model_pricing
     SET input_per_mtok = 1000,
         output_per_mtok = 5000,
         cache_read_per_mtok = 100,
         cache_write_per_mtok = 1250,
         multiplier = 1
   WHERE model_id = 'cursor-fable-5-high';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION '0221: expected 1 row for cursor-fable-5-high, got %', affected;
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'cursor-auto'
       AND (input_per_mtok <> 0 OR output_per_mtok <> 0
            OR cache_read_per_mtok <> 0 OR cache_write_per_mtok <> 0)
  ) THEN
    RAISE EXCEPTION '0221: cursor-auto must remain zero-priced';
  END IF;
END $$;
