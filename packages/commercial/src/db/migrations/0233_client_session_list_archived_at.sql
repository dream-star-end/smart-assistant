-- 0233 — 侧栏会话归档 client_sessions.archived_at。
--
-- 与消息热尾巴 spill 的 archived_through_seq / archived_count 无关:
-- 本列表示「整条会话从默认列表隐藏」。NULL = 未归档。
-- SQLite 对应演进在 @openclaude/storage sessionsDb.ts(pragma 探测 + ALTER)。

ALTER TABLE client_sessions ADD COLUMN IF NOT EXISTS archived_at BIGINT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_client_sessions_user_list
  ON client_sessions (user_id, last_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_client_sessions_user_list_active
  ON client_sessions (user_id, last_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

COMMENT ON COLUMN client_sessions.archived_at IS
  'Sidebar session archive timestamp (epoch ms). NULL = visible in default list. Not the message-spill watermark.';
