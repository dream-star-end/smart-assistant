-- 0049_model_visibility.sql
-- 加 model_pricing.visibility 列 + model_visibility_grants per-user 授权表。
-- 服务于 v3 GPT 灰度发布:模型默认 admin 可见,boss 在 admin UI 给特定 user 加 grant
-- 后该用户也能在 modelPicker 看到。
--
-- 语义(实现见 packages/commercial/src/billing/pricing.ts listForUser):
--   visibility='public'  → 所有用户(含未登录)可见
--   visibility='admin'   → role=admin OR (user_id, model_id) ∈ model_visibility_grants
--   visibility='hidden'  → 仅 (user_id, model_id) ∈ model_visibility_grants
--
-- 老 HIDDEN_FROM_PUBLIC_LIST 内置常量(只含 claude-haiku-4-5)迁移到 visibility=admin
-- (admin 可见,public 不可见;haiku 仍 enabled=true 让 anthropicProxy 内部 WebFetch 用)。

ALTER TABLE model_pricing
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'admin', 'hidden'));

UPDATE model_pricing SET visibility = 'admin' WHERE model_id = 'claude-haiku-4-5';

CREATE TABLE model_visibility_grants (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id    TEXT   NOT NULL REFERENCES model_pricing(model_id) ON DELETE CASCADE,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, model_id)
);

CREATE INDEX idx_mvg_user  ON model_visibility_grants(user_id);
CREATE INDEX idx_mvg_model ON model_visibility_grants(model_id);

-- pricing_changed NOTIFY 已在 0008 设置;visibility 列变更也通过同一个 trigger
-- 触发(trigger 是 TABLE 级而非 COLUMN 级)。grants 表暂不挂 NOTIFY:授权变化是
-- per-user 的,前端登陆后下次 /api/models 查询自然拿到最新结果即可。
