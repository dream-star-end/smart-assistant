-- 0230 — 侧栏聊天项目(chat_projects) + client_sessions.project_id。
--
-- 与看板 tb_project / /api/board/projects 无关。软删、无硬外键:删项目只把其下
-- 会话 project_id 置 NULL,绝不级联删会话。时间戳风格对齐 0134(epoch ms BIGINT)。
-- SQLite 对应演进在 @openclaude/storage sessionsDb.ts(pragma 探测 + ALTER,自愈式)。

CREATE TABLE IF NOT EXISTS chat_projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  instructions TEXT,
  color        TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  deleted_at   BIGINT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_projects_user_deleted
  ON chat_projects (user_id, deleted_at);

ALTER TABLE client_sessions ADD COLUMN IF NOT EXISTS project_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_client_sessions_user_project
  ON client_sessions (user_id, project_id);

COMMENT ON TABLE chat_projects IS
  'Sidebar chat-session folders (not the taskboard tb_project). Soft-delete; ungroup sessions on delete.';
