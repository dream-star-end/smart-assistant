-- 0302 — 项目工作空间(个人版 P2):项目可归档、可置顶、带创建模板。
--
-- archived_at / pinned_at:epoch ms(对齐 0230)。归档只是不在侧栏主列表显示,
-- 会话、文件、看板都保留;置顶决定侧栏顺序优先。
-- template:新建时选的类型(blank/repo/research/writing),决定新项目的默认工作区;
-- 此前创建的项目为 NULL(行为同 blank)。
-- 纯增列,可空,旧代码读写不受影响。SQLite 侧对应演进在 @openclaude/storage sessionsDb.ts。

ALTER TABLE chat_projects ADD COLUMN IF NOT EXISTS archived_at BIGINT DEFAULT NULL;
ALTER TABLE chat_projects ADD COLUMN IF NOT EXISTS pinned_at BIGINT DEFAULT NULL;
ALTER TABLE chat_projects ADD COLUMN IF NOT EXISTS template TEXT DEFAULT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_projects_template_check'
  ) THEN
    ALTER TABLE chat_projects
      ADD CONSTRAINT chat_projects_template_check
      CHECK (template IS NULL OR template IN ('blank', 'repo', 'research', 'writing'));
  END IF;
END $$;
