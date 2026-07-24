-- Auto-Dream V2 now defaults to DeepSeek V4 Flash. Stage A already taught
-- both the active and rollback releases to execute this CCB model safely.
--
-- Preserve an administrator's explicit non-Terra choice. An absent row is the
-- old code default and should become an explicit DeepSeek setting.

INSERT INTO system_settings (key, value, description, updated_at)
VALUES (
  'auto_dream_model',
  '"deepseek-v4-flash"'::jsonb,
  'Auto-Dream 全面优化审计模型（默认使用 active/public 的 DeepSeek V4 Flash）',
  NOW()
)
ON CONFLICT (key) DO UPDATE
   SET value = EXCLUDED.value,
       description = EXCLUDED.description,
       updated_at = NOW()
 WHERE system_settings.value = '"gpt-5.6-terra"'::jsonb;
