-- 0084_migrate_glm51_prefs_to_glm52.sql
-- 把存量 user_preferences.default_model='glm-5.1' 迁移到 glm-5.2。
--
-- 背景:0083 把 glm-5.1 设 visibility='hidden',canUseModel 对 hidden 模型要求 grant
-- (packages/commercial/src/billing/authzModels.ts),导致 default_model='glm-5.1' 的存量用户
-- 发消息被拦 WS 4507 "unauthorized_model" → 前端"当前账号尚未开通这个模型"。
-- boss 2026-06-17:glm-5.1 全部迁移到 glm-5.2(glm-5.1 退场)。
--
-- 幂等:已迁移(生产已于 2026-06-17 手动 UPDATE)则本次 UPDATE 0 行。
-- 仅迁 user_preferences;usage_records 等历史计费记录保留原 model 不动(审计真实性)。

UPDATE user_preferences
   SET prefs = jsonb_set(prefs, '{default_model}', '"glm-5.2"'),
       updated_at = NOW()
 WHERE prefs->>'default_model' = 'glm-5.1';
