-- 0123_gpt56_models.sql
-- GPT-5.5 → GPT-5.6 三型号(Sol / Terra / Luna)受控迁移。
--
-- 商业定价策略:三条新型号沿用切换时 gpt-5.5 的实际价格、倍率、可见性、额外
-- prompt 与 per-model default_effort。本迁移不声称三个上游成本相同；它只保证
-- 本次能力升级不擅自改变现行 GPT 商业计费政策，后续可经 admin 定价页独立调整。
--
-- 旧 gpt-5.5 行不物理删除:历史 usage/审计/route FK 仍需可解释；改为
-- enabled=false + visibility=hidden，所有准入/API/账号组映射均转到新型号。

DO $$
DECLARE
  old_row model_pricing%ROWTYPE;
  inserted_models INTEGER;
  matching_models INTEGER;
  old_group_count INTEGER;
  new_group_count INTEGER;
  old_grant_count INTEGER;
  new_grant_count INTEGER;
  prefs_before INTEGER;
  prefs_updated INTEGER;
BEGIN
  SELECT * INTO STRICT old_row
    FROM model_pricing
   WHERE model_id = 'gpt-5.5';

  IF old_row.enabled IS NOT TRUE THEN
    RAISE EXCEPTION '0123: source gpt-5.5 must be enabled before cutover';
  END IF;

  IF EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
  ) THEN
    RAISE EXCEPTION '0123: target GPT-5.6 model rows already exist';
  END IF;

  INSERT INTO model_pricing (
    model_id, display_name,
    input_per_mtok, output_per_mtok,
    cache_read_per_mtok, cache_write_per_mtok,
    multiplier, enabled, sort_order, updated_by, visibility,
    extra_system_prompt, default_effort, lock_version
  )
  SELECT
    target.model_id, target.display_name,
    old_row.input_per_mtok, old_row.output_per_mtok,
    old_row.cache_read_per_mtok, old_row.cache_write_per_mtok,
    old_row.multiplier, TRUE, target.sort_order, old_row.updated_by, old_row.visibility,
    old_row.extra_system_prompt, old_row.default_effort, 0
  FROM (VALUES
    ('gpt-5.6-sol',   'GPT-5.6-Sol',   110),
    ('gpt-5.6-terra', 'GPT-5.6-Terra', 111),
    ('gpt-5.6-luna',  'GPT-5.6-Luna',  112)
  ) AS target(model_id, display_name, sort_order);
  GET DIAGNOSTICS inserted_models = ROW_COUNT;
  IF inserted_models <> 3 THEN
    RAISE EXCEPTION '0123: expected 3 GPT-5.6 rows inserted, got %', inserted_models;
  END IF;

  SELECT COUNT(*) INTO matching_models
    FROM model_pricing p
   WHERE p.model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
     AND p.input_per_mtok = old_row.input_per_mtok
     AND p.output_per_mtok = old_row.output_per_mtok
     AND p.cache_read_per_mtok = old_row.cache_read_per_mtok
     AND p.cache_write_per_mtok = old_row.cache_write_per_mtok
     AND p.multiplier = old_row.multiplier
     AND p.enabled IS TRUE
     AND p.visibility = old_row.visibility
     AND p.extra_system_prompt IS NOT DISTINCT FROM old_row.extra_system_prompt
     AND p.default_effort IS NOT DISTINCT FROM old_row.default_effort;
  IF matching_models <> 3 THEN
    RAISE EXCEPTION '0123: cloned GPT-5.6 pricing/policy mismatch (% matching)', matching_models;
  END IF;

  SELECT COUNT(*) INTO old_group_count
    FROM account_group_models
   WHERE model_id = 'gpt-5.5';

  INSERT INTO account_group_models (group_id, model_id)
  SELECT old_map.group_id, target.model_id
    FROM account_group_models old_map
    CROSS JOIN (VALUES
      ('gpt-5.6-sol'), ('gpt-5.6-terra'), ('gpt-5.6-luna')
    ) AS target(model_id)
   WHERE old_map.model_id = 'gpt-5.5';

  SELECT COUNT(*) INTO new_group_count
    FROM account_group_models
   WHERE model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna');
  IF new_group_count <> old_group_count * 3 THEN
    RAISE EXCEPTION '0123: expected % GPT-5.6 account-group mappings, got %',
      old_group_count * 3, new_group_count;
  END IF;

  DELETE FROM account_group_models WHERE model_id = 'gpt-5.5';
  IF EXISTS (SELECT 1 FROM account_group_models WHERE model_id = 'gpt-5.5') THEN
    RAISE EXCEPTION '0123: stale gpt-5.5 account-group mapping remains';
  END IF;

  -- 非 public 灰度环境也保留原 grant 语义；旧型号 grant 随后删除。
  SELECT COUNT(*) INTO old_grant_count
    FROM model_visibility_grants
   WHERE model_id = 'gpt-5.5';

  INSERT INTO model_visibility_grants (user_id, model_id, granted_at, granted_by)
  SELECT old_grant.user_id, target.model_id, old_grant.granted_at, old_grant.granted_by
    FROM model_visibility_grants old_grant
    CROSS JOIN (VALUES
      ('gpt-5.6-sol'), ('gpt-5.6-terra'), ('gpt-5.6-luna')
    ) AS target(model_id)
   WHERE old_grant.model_id = 'gpt-5.5';

  SELECT COUNT(*) INTO new_grant_count
    FROM model_visibility_grants
   WHERE model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna');
  IF new_grant_count <> old_grant_count * 3 THEN
    RAISE EXCEPTION '0123: expected % GPT-5.6 grants, got %',
      old_grant_count * 3, new_grant_count;
  END IF;
  DELETE FROM model_visibility_grants WHERE model_id = 'gpt-5.5';

  SELECT COUNT(*) INTO prefs_before
    FROM user_preferences
   WHERE prefs->>'default_model' = 'gpt-5.5';
  UPDATE user_preferences
     SET prefs = jsonb_set(prefs, '{default_model}', '"gpt-5.6-sol"'::jsonb),
         updated_at = NOW()
   WHERE prefs->>'default_model' = 'gpt-5.5';
  GET DIAGNOSTICS prefs_updated = ROW_COUNT;
  IF prefs_updated <> prefs_before THEN
    RAISE EXCEPTION '0123: expected % GPT-5.5 preferences migrated, got %',
      prefs_before, prefs_updated;
  END IF;

  -- 旧 per-turn relay token 不允许跨型号切换后继续使用。
  UPDATE codex_route_contexts
     SET status = 'expired'
   WHERE model_id = 'gpt-5.5' AND status = 'active';

  UPDATE model_pricing
     SET enabled = FALSE,
         visibility = 'hidden',
         lock_version = lock_version + 1,
         updated_at = NOW()
   WHERE model_id = 'gpt-5.5';

  IF NOT EXISTS (
    SELECT 1 FROM model_pricing
     WHERE model_id = 'gpt-5.5'
       AND enabled IS FALSE
       AND visibility = 'hidden'
  ) THEN
    RAISE EXCEPTION '0123: retired gpt-5.5 row is not hidden+disabled';
  END IF;
END $$;
