-- 0011 user_preferences
--
-- 见 docs/v3/02-DEVELOPMENT-PLAN.md §2.5 / §5.1 / 03-MVP-CHECKLIST.md Task 2B / 2G
--
-- 为什么需要:
--   v3 把"前台用户偏好"(主题 / 默认模型 / 通知 / 快捷键 …)和"运营参数"(model_pricing /
--   subscription_tier / system_settings)彻底分开。前者一人一行,前端 GET/PATCH
--   /api/me/preferences 直接读写;后者归 admin。这张表只装真正"用户绑定"的东西。
--
-- schema 取舍:
--   - JSONB 单列 prefs 而非每个偏好一列:加新偏好时不需要 ALTER TABLE,前端字段定义
--     在 modules/userPrefs.js,后端 zod schema 校验白名单字段
--   - prefs DEFAULT '{}' + NOT NULL,避免 null 判定分支
--   - updated_at 自动维护,GET 时带回去做 ETag/If-Match 乐观锁(MVP 暂不实现锁,
--     只返当前快照)
--
-- 不加约束的字段值:
--   - prefs 内具体字段(theme/default_model/...)的合法性由应用层 zod 控制,而不是
--     CHECK constraint(运营加新字段时不需要 ALTER)。
--
-- 容量:
--   - 一行一用户,索引仅 PK 即可。

CREATE TABLE user_preferences (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE user_preferences IS
  'V3: per-user UI preferences (theme, default model, notification toggles, hotkeys). '
  'Schema-less JSONB; field allowlist enforced in application layer (zod). '
  'NOT for operational settings — those go to system_settings (0017+).';

COMMENT ON COLUMN user_preferences.prefs IS
  'JSON object. Known fields (see modules/userPrefs.js): theme, default_model, default_effort, '
  'notify_email, notify_telegram, hotkeys. Unknown fields rejected by zod on PATCH.';
