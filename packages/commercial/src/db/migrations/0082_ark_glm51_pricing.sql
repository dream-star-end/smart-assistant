-- 0082_ark_glm51_pricing.sql
-- 火山方舟 Ark Coding Plan 接入：glm-5.1 文本路由计费。
--
-- glm-5.1 是**平台全局默认模型**(2026-06-15 起)，故直接 visibility='public' + enabled=TRUE
-- 一步到位，不走 MiniMax 那种 admin→public 两段灰度(默认模型若 visibility=admin 会出现
-- “人人在用但 picker 里看不到”的怪 UX)。
--
-- 价格口径：boss 2026-06-15 指定“按智谱官方 GLM-5.1 定价、按原价算”(multiplier=1.000)。
-- 智谱官方按量价(bigmodel.cn / 阿里云百炼)：input ¥6/Mtok、output ¥24/Mtok；
-- cache_read 按约 0.2×input = ¥1.2/Mtok(boss 确认)；cache_write 不计(0)。
-- 注意：上游虽经火山方舟 Ark 订阅端点(平台静态 key)，但**用户侧计费按智谱官方原价**。
-- model_pricing 单位沿 0007/0057/0077：人民币“分”/Mtok → ¥6=600, ¥24=2400, ¥1.2=120。
--
-- sort_order=85：作为平台默认旗舰模型排在列首(< claude-opus-4-7=90 / sonnet=100)。
--
-- ON CONFLICT DO UPDATE 会把 enabled 强制刷成 TRUE：因 glm-5.1 是默认模型、必须上线即启用，
-- 接受此“覆盖 ops 手工 kill switch”语义(与 0077 一致)。若将来要把默认模型回退到别的模型，
-- 应同步改 platformDefaults.ts / entrypoint，并按需另写迁移调 enabled。

DO $$
DECLARE
  row_enabled BOOLEAN;
  row_visibility TEXT;
  row_input BIGINT;
  row_output BIGINT;
  row_cache_read BIGINT;
  row_cache_write BIGINT;
BEGIN
  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility
  ) VALUES (
    'glm-5.1', 'GLM-5.1 (200k)',
    600, 2400, 120, 0,
    1.000, TRUE, 85, 'public'
  )
  ON CONFLICT (model_id) DO UPDATE
     SET display_name          = EXCLUDED.display_name,
         input_per_mtok        = EXCLUDED.input_per_mtok,
         output_per_mtok       = EXCLUDED.output_per_mtok,
         cache_read_per_mtok   = EXCLUDED.cache_read_per_mtok,
         cache_write_per_mtok  = EXCLUDED.cache_write_per_mtok,
         multiplier            = EXCLUDED.multiplier,
         enabled               = TRUE,
         sort_order            = EXCLUDED.sort_order,
         visibility            = EXCLUDED.visibility,
         updated_at            = NOW();

  SELECT enabled, visibility,
         input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok
    INTO row_enabled, row_visibility,
         row_input, row_output, row_cache_read, row_cache_write
    FROM model_pricing
   WHERE model_id = 'glm-5.1';

  IF NOT FOUND THEN
    RAISE EXCEPTION '0082: expected glm-5.1 row after upsert, got none';
  END IF;
  IF row_visibility <> 'public' THEN
    RAISE EXCEPTION '0082: expected glm-5.1 visibility public, got %', row_visibility;
  END IF;
  IF row_enabled IS NOT TRUE THEN
    RAISE EXCEPTION '0082: expected glm-5.1 enabled true, got %', row_enabled;
  END IF;
  IF row_input <> 600 OR row_output <> 2400
     OR row_cache_read <> 120 OR row_cache_write <> 0 THEN
    RAISE EXCEPTION '0082: glm-5.1 pricing mismatch (in=%, out=%, cr=%, cw=%)',
      row_input, row_output, row_cache_read, row_cache_write;
  END IF;
END $$;
