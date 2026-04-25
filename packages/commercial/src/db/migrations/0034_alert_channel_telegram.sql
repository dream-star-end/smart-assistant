-- 0034_alert_channel_telegram.sql
-- M4 / P1-4 — 第二条告警通道:Telegram。
--
-- 设计要点:
--   1. 复用 admin_alert_channels 表 + 现有 outbox / dedupe / 退避;新 channel_type='telegram'
--   2. 复用 bot_token_enc / bot_token_nonce 字段存 Telegram bot token(同 AES-GCM KMS 密钥);
--      iLink-only 字段(ilink_account_id / ilink_login_user_id / target_sender_id /
--      context_token)对 Telegram 行强制 NULL,避免误用。
--   3. 新增 tg_chat_id text:Telegram 数字 chat_id 或 @username,明文存(没什么需要保密的)
--   4. Telegram 通道无扫码 / 无 inbound,落库直接 activation_status='active';
--      get_updates_buf 仍受 NOT NULL DEFAULT '' 约束,保持 ''(代码层不读不写)。
--   5. CHECK 约束保证 (channel_type, fields) 一致性,部分唯一索引保证同 admin
--      不能给同一 chat_id 重复建通道。

-- ─── 放宽 channel_type 白名单 ─────────────────────────────────────────
ALTER TABLE admin_alert_channels DROP CONSTRAINT IF EXISTS admin_alert_channels_channel_type_check;
ALTER TABLE admin_alert_channels
  ADD CONSTRAINT admin_alert_channels_channel_type_check
  CHECK (channel_type IN ('ilink_wechat', 'telegram'));

-- ─── 新增 Telegram 字段 ──────────────────────────────────────────────
ALTER TABLE admin_alert_channels ADD COLUMN tg_chat_id TEXT;

-- ─── 字段一致性约束 ──────────────────────────────────────────────────
-- iLink 行:tg_chat_id 必须 NULL
-- Telegram 行:ilink_* / target_sender_id / context_token 必须 NULL,tg_chat_id 必须非空
ALTER TABLE admin_alert_channels
  ADD CONSTRAINT chk_channel_type_fields CHECK (
    (channel_type = 'ilink_wechat' AND tg_chat_id IS NULL)
    OR (channel_type = 'telegram'
        AND ilink_account_id IS NULL
        AND ilink_login_user_id IS NULL
        AND target_sender_id IS NULL
        AND context_token IS NULL
        AND tg_chat_id IS NOT NULL)
  );

-- ─── 唯一性:同 admin 的同 chat_id 只能有一条 telegram 通道 ─────────
CREATE UNIQUE INDEX idx_aac_tg_identity
  ON admin_alert_channels(admin_id, tg_chat_id)
  WHERE channel_type = 'telegram' AND tg_chat_id IS NOT NULL;

COMMENT ON COLUMN admin_alert_channels.tg_chat_id IS
  'Telegram chat_id (-?\d+ for groups/users, or @username). NULL for non-telegram channels.';
