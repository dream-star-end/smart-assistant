-- 0160_moonshot_kimi_k3.sql
-- Moonshot 官方「Kimi For Coding」订阅接入:kimi-k3 上架(2026-07-17,boss 指令)。
--
-- 上游:https://api.kimi.com/coding/v1/messages(Anthropic 兼容,x-api-key,provider id='moonshot',
--   见 protocol staticKeyProviders MOONSHOT_CODING;与火山转售的 'kimi'/kimi-k2.7-code 是两家上游)。
--
-- 定价 = **官方 API 牌价的一半**(boss 2026-07-17 指令)。官方牌价(platform.moonshot.cn
-- /docs/pricing/chat-k3,人民币/1M tokens):输入(缓存未命中)¥20 / 输入(缓存命中)¥2 / 输出 ¥100。
--   → 半价:input 1000 分/Mtok(¥10)/ cache_read 100 分/Mtok(¥1)/ output 5000 分/Mtok(¥50)。
--   cache_write=0:Kimi 自动上下文缓存不单独计缓存写价(与国产 provider 各行一致);×1.000。
-- sort_order=89:排在 kimi-k2.7-code(88)之后、claude 系(90+)之前。
--
-- catalog 行:走 0144 的受控状态机 fn_model_stage_version → fn_model_activate(0144 起
-- fn_model_catalog_guard 拒绝直插 active;这也是割接后应用角色唯一可达的写路径)。
-- **必须先于 pricing 行落 catalog**:0143 的 fn_model_catalog_ensure_for_pricing 兼容路径
-- 只认 protocol 派生函数,不认识 kimi-k3 → 会兜底成 provider='anthropic'/200k,错;
-- catalog live 行先就位,pricing INSERT 时走 apply_enabled 的 active→no-op 分支。
--   context_window=1048576:**机制窗口**(官方规格 1M)。产品层"admin 1M / 其他 500k"是
--   commercial modelRolePolicy 的角色投影语义,不落 catalog(catalog 只放机制事实)。
--   capability:vision=true(官方多模态+实测 image block 接受)/ thinking=true(恒思考,
--   disabled 实测真生效)/ capabilityZero=true(effort/betas 等 firstParty 能力不生成;
--   K3 effort 官方仅 max 单档,不暴露档位选择 → reasoning.supported=[])。
-- 激活由 fn_model_catalog_after 自动 bump security epoch + 同步 pricing.enabled 镜像。
--
-- 幂等:catalog 侧带 live 行存在性守卫(重复 apply 直接跳过,不会撞 stage_version 对
-- active 行的拒绝);pricing 侧 ON CONFLICT DO NOTHING。

DO $$
BEGIN
  -- 1) model_catalog 权威行:staged → active(受控状态机;先于 pricing,防兼容路径建错行)
  IF NOT EXISTS (
    SELECT 1 FROM model_catalog
     WHERE model_id = 'kimi-k3' AND state IN ('staged', 'active', 'disabled')
  ) THEN
    PERFORM fn_model_stage_version(
      'kimi-k3',
      'ccb',
      'moonshot',
      NULL,                -- 上游 model 名与 model_id 相同(kimi-k3 实测直接可用)
      1048576,
      -- 键名必须是 snake_case(parseCapabilityProfile 的 wire 契约;camelCase 会让快照
      -- 重建 fail-closed → 全站模型面 503,2026-07-17 上线时踩过,契约测试已锁死)。
      '{
        "supports_vision": true,
        "reasoning": { "supported": [], "codex_model_default": null },
        "ccb": { "capability_zero": true, "supports_thinking": true }
      }'::jsonb,
      1,
      NULL                 -- updated_by=NULL:迁移=系统操作(model_pricing.updated_by 有
                           -- users FK,全新建库时 uid 还不存在;0083 先例同为省略/NULL)
    );
    PERFORM fn_model_activate('kimi-k3', NULL);
  END IF;

  -- 2) model_pricing 行(catalog live 行已在 → enabled 走 apply_enabled active→no-op)
  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, visibility
  ) VALUES (
    'kimi-k3', 'Kimi K3',
    1000, 5000, 100, 0,
    1.000, TRUE, 89, 'public'
  )
  ON CONFLICT (model_id) DO NOTHING;
END $$;
