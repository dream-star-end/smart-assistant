-- 0302 — 项目工作空间(个人版 P2):项目可归档、可置顶、带创建模板,删除可在 30 天内恢复。
--
-- archived_at / pinned_at:epoch ms(对齐 0230)。归档只是不在侧栏主列表显示,
-- 会话、文件、看板都保留;置顶决定侧栏顺序优先。
-- template:新建时选的类型(blank/repo/research/writing),决定新项目的默认工作区;
-- 此前创建的项目为 NULL(行为同 blank)。
-- 纯增列,可空,旧代码读写不受影响。SQLite 侧对应演进在 @openclaude/storage sessionsDb.ts。

ALTER TABLE chat_projects ADD COLUMN IF NOT EXISTS archived_at BIGINT DEFAULT NULL;
ALTER TABLE chat_projects ADD COLUMN IF NOT EXISTS pinned_at BIGINT DEFAULT NULL;
ALTER TABLE chat_projects ADD COLUMN IF NOT EXISTS template TEXT DEFAULT NULL;
-- deleted_manifest:删除时解绑了哪些会话/资产、客户端先暂停了哪些定时任务(JSON)。
-- 30 天内恢复据此把仍未分类的会话/资产挂回,并把暂停的定时任务交还客户端重新启用。
ALTER TABLE chat_projects ADD COLUMN IF NOT EXISTS deleted_manifest TEXT DEFAULT NULL;

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
