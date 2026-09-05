-- order-dependency: 0259_cursor_gemini_38_flash
-- 0260_research_workspace.sql
-- R3.0 课题工作区: research_documents ↔ chat_projects membership +
-- chat_projects.is_research_default 默认课题标记。
-- 不给 research_documents 加 project_id:课题是组织关系,不是文档身份。
-- project_id 存 chat_projects.id(TEXT UUID),不建跨域 FK(与 board_project_id 同一纪律)。
-- SQLite 对应: sessionsDb.ts ALTER + unique partial index(自愈)。
--
-- rollback:
--   DROP INDEX IF EXISTS idx_rlm_project;
--   DROP TABLE IF EXISTS research_library_memberships;
--   DROP INDEX IF EXISTS idx_chat_projects_user_research_default;
--   ALTER TABLE chat_projects DROP COLUMN IF EXISTS is_research_default;

CREATE TABLE IF NOT EXISTS research_library_memberships (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id     TEXT   NOT NULL,
  project_id TEXT   NOT NULL,          -- chat_projects.id; application-level, not a FK
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, doc_id, project_id),
  FOREIGN KEY (user_id, doc_id)
    REFERENCES research_documents (user_id, doc_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rlm_project
  ON research_library_memberships (user_id, project_id, added_at DESC);

COMMENT ON TABLE research_library_memberships IS
  'research_documents ↔ chat_projects many-to-many. Application-level project_id (no cross-domain FK). Soft-deleting a chat project does not delete documents.';

ALTER TABLE chat_projects
  ADD COLUMN IF NOT EXISTS is_research_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_projects_user_research_default
  ON chat_projects (user_id)
  WHERE is_research_default AND deleted_at IS NULL;

COMMENT ON COLUMN chat_projects.is_research_default IS
  'Lazy-created default research workspace (课题). At most one live row per user.';
