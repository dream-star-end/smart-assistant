-- 0204_auto_dream_minimax_m3.sql
-- Both Auto-Dream memory consolidation and the comprehensive optimizer now
-- use the same active/public MiniMax M3 model. Stage A first taught the active
-- and rollback runtimes to execute this CCB model safely.

INSERT INTO system_settings (key, value, description, updated_at)
VALUES (
  'auto_dream_model',
  '"MiniMax-M3"'::jsonb,
  'Auto-Dream 整理与全面优化模型（统一使用 active/public 的 MiniMax M3）',
  NOW()
)
ON CONFLICT (key) DO UPDATE
   SET value = EXCLUDED.value,
       description = EXCLUDED.description,
       updated_at = NOW();
