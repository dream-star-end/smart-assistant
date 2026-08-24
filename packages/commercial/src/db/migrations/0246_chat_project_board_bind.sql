-- 0246 — chat_projects.board_project_id: bind a sidebar folder to a taskboard
-- tb_project.id (UUID). No cross-database FK. 1:1 per user among live rows.
-- SQLite counterpart: sessionsDb.ts ALTER + unique partial index (self-heal).

ALTER TABLE chat_projects
  ADD COLUMN IF NOT EXISTS board_project_id TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_projects_user_board
  ON chat_projects (user_id, board_project_id)
  WHERE deleted_at IS NULL AND board_project_id IS NOT NULL;

COMMENT ON COLUMN chat_projects.board_project_id IS
  'Optional tb_project.id (container taskboard). Application-level 1:1 bind; not a FK.';
