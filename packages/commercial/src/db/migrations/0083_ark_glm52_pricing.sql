-- 0083_ark_glm52_pricing.sql
-- 火山方舟 Ark 通道:glm-5.1 → glm-5.2 主力替换(2026-06-17)。
-- boss 决定:替换掉 glm-5.1、coder + 队长(=平台默认)全切 glm-5.2。glm-5.2 走火山 ark 端点
-- (ark.cn-beijing.volces.com/api/coding,复用 ARK_CODING_PLAN_KEY,Anthropic 兼容,零协议转换)。
--
-- glm-5.2:visibility='public'(继承 glm-5.1 开放档;它现在是**平台默认模型**,必须 public + enabled)。
-- 定价:boss 参照 glm-5.1 原价(input ¥6 / output ¥24 / cache_read ¥1.2 / cache_write 0,×1.0);
--   火山 glm-5.2 真实采购价待确认,可后写迁移调整。单位:人民币"分"/Mtok(沿 0007/0082)。
-- sort_order=84:主力,排在 glm-5.1(85)前。
--
-- glm-5.1:visibility public → 'hidden'(从 picker 撤下,被 glm-5.2 替换);**保留 enabled=TRUE 不动**
--   —— ARK provider 仍路由 glm-5.1(staticKeyProviders.ts),存量会话 / 用户 prefs 里仍引用 glm-5.1
--   的请求不至于 404/503,平滑过渡。
--
-- glm-5.2 是平台默认模型,故 ON CONFLICT 强刷 enabled=TRUE(默认模型必须启用,同 0082 语义)。

DO $$
DECLARE
  row52_enabled BOOLEAN;
  row52_visibility TEXT;
  row52_input BIGINT;
  row52_output BIGINT;
  row51_visibility TEXT;
  row51_found BOOLEAN;
BEGIN
  -- glm-5.2 主力(public / enabled)
  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility
  ) VALUES (
    'glm-5.2', 'GLM-5.2',
    600, 2400, 120, 0,
    1.000, TRUE, 84, 'public'
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

  -- glm-5.1 退 picker:visibility → hidden,**enabled 不动**(兼容存量会话/prefs)
  UPDATE model_pricing
     SET visibility = 'hidden', updated_at = NOW()
   WHERE model_id = 'glm-5.1';

  -- ── 断言:glm-5.2 ──
  SELECT enabled, visibility, input_per_mtok, output_per_mtok
    INTO row52_enabled, row52_visibility, row52_input, row52_output
    FROM model_pricing WHERE model_id = 'glm-5.2';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0083: expected glm-5.2 row after upsert, got none';
  END IF;
  IF row52_visibility <> 'public' THEN
    RAISE EXCEPTION '0083: glm-5.2 visibility must be public, got %', row52_visibility;
  END IF;
  IF row52_enabled IS NOT TRUE THEN
    RAISE EXCEPTION '0083: glm-5.2 must be enabled (platform default model)';
  END IF;
  IF row52_input <> 600 OR row52_output <> 2400 THEN
    RAISE EXCEPTION '0083: glm-5.2 pricing mismatch (in=%, out=%)', row52_input, row52_output;
  END IF;

  -- ── 断言:glm-5.1 已退 picker(若存在) ──
  SELECT TRUE, visibility INTO row51_found, row51_visibility
    FROM model_pricing WHERE model_id = 'glm-5.1';
  IF row51_found IS TRUE AND row51_visibility <> 'hidden' THEN
    RAISE EXCEPTION '0083: glm-5.1 visibility must be hidden after retire, got %', row51_visibility;
  END IF;
END $$;
