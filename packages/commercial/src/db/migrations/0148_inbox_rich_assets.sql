-- 0148_inbox_rich_assets.sql
--
-- 站内信富媒体图片。图片归一为静态 WebP 后直接存 PG，跟随消息级联删除；正文只保存
-- `/api/inbox-assets/<uuid>` 引用，不把 BYTEA/base64 暴露到列表或审计响应。

CREATE TABLE inbox_message_assets (
  id          UUID PRIMARY KEY,
  message_id  BIGINT NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  mime_type   TEXT NOT NULL CHECK (mime_type = 'image/webp'),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256      TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (octet_length(data) = size_bytes)
);

CREATE INDEX idx_inbox_message_assets_message
  ON inbox_message_assets (message_id);

COMMENT ON TABLE inbox_message_assets IS
  '站内信静态 WebP 图片；访问必须经短期签名 URL，并复核消息对当前用户可见。';
