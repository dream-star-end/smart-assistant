-- 0240 — 侧栏「未读的完成」权威迁到服务端 client_sessions.last_read_at。
--
-- 绿点跨浏览器一致:打开会话才 bump last_read_at,终态本身不写本列。
-- list 用 last dispatch terminal_at > COALESCE(last_read_at, 0) 派生 unread 布尔。
-- 存量一律回填成已读,避免上线后侧栏全绿。
-- SQLite 对应演进在 @openclaude/storage sessionsDb.ts(pragma 探测 + ALTER + 同款回填)。

ALTER TABLE client_sessions
  ADD COLUMN IF NOT EXISTS last_read_at BIGINT DEFAULT NULL;

UPDATE client_sessions
   SET last_read_at = last_at
 WHERE last_read_at IS NULL;

COMMENT ON COLUMN client_sessions.last_read_at IS
  'Sidebar unread watermark (epoch ms). NULL/0 = never opened after cutover. Bumped only when the user opens the session; terminal outcomes do not write this column.';
