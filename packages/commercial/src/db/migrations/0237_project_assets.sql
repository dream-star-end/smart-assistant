-- 0237 — 聊天项目资产层(project_assets):用户上传的参考资料 + 会话产出物索引。
--
-- 软删(deleted_at)只删索引行,绝不删磁盘文件。文件是 sha256 内容寻址的,
-- 可能被别的消息/资产共用,删行不等于删文件。
-- SQLite 对应演进在 @openclaude/storage sessionsDb.ts(CREATE TABLE IF NOT EXISTS 自愈式)。
-- 时间戳风格对齐 0134 / 0230(epoch ms BIGINT)。

CREATE TABLE IF NOT EXISTS project_assets (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  project_id      TEXT,
  source          TEXT NOT NULL,
  session_id      TEXT,
  name            TEXT NOT NULL,
  url             TEXT,
  container_path  TEXT,
  mime            TEXT,
  size_bytes      BIGINT,
  digest          TEXT,
  excerpt         TEXT,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  deleted_at      BIGINT DEFAULT NULL,
  CHECK (source IN ('upload', 'output')),
  CHECK (
    (url IS NOT NULL AND btrim(url) <> '')
    OR (container_path IS NOT NULL AND btrim(container_path) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_project_assets_user_project_created
  ON project_assets (user_id, project_id, deleted_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_assets_user_project_pinned
  ON project_assets (user_id, project_id, pinned)
  WHERE deleted_at IS NULL AND pinned;

CREATE INDEX IF NOT EXISTS idx_project_assets_user_digest
  ON project_assets (user_id, digest);

COMMENT ON TABLE project_assets IS
  'Chat-project asset index (uploads + session outputs). Soft-delete the row only; never unlink content-addressed disk files that other messages/assets may share.';
