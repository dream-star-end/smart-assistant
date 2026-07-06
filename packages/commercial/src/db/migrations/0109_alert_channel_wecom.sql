-- 0109_alert_channel_wecom.sql
-- 企业微信群机器人告警通道:第三条 channel_type='wecom_bot'。
-- 偿「v5 告警只入库不推送」债(playbook 债表 af1b054f):iLink/Telegram 投递
-- worker 寄生 shared 域 startAlertScheduler,v5 controlPlane 关 → 只 enqueue 不推送;
-- iLink 主动推送又依赖入站 context_token 天然不可靠,改走企业微信群机器人。
--
-- 设计要点:
--   1. 复用 admin_alert_channels 表 + 现有 outbox / dedupe / 退避;新 channel_type='wecom_bot'。
--   2. 复用 bot_token_enc / bot_token_nonce 字段存 webhook key(?key=<...> 的值,同 AES-GCM
--      KMS 密钥);iLink-only 字段(ilink_* / target_sender_id / context_token)与 telegram
--      的 tg_chat_id 对 wecom 行强制 NULL,避免误用。
--   3. 新增 wecom_key_fp text:webhook key 的 SHA-256 hex 指纹(非密、不可逆),仅用于
--      同 admin 幂等去重(admin 手动粘贴 webhook,防重复提交多插一份通道)。明文 key 永不落库。
--   4. wecom 无扫码 / 无 inbound,落库直接 activation_status='active'(与 telegram 同构)。
--   5. CHECK 约束保证 (channel_type, fields) 一致性;部分唯一索引保证同 admin 同 webhook
--      不能重复建通道。
--
-- v3 兼容性:widen channel_type 白名单对 v3 是纯放行(v3 现网树无 createWecomChannel,
-- 永不写 'wecom_bot' 行)。v3 旧 shared dispatcher 的 outbox claim 是类型无关的,会误
-- claim wecom_bot 行走 else 分支 markFailed —— v5 侧 claim 已按 channel_type 过滤(对称
-- 只认领自己能处理的类型),v3 影响面详见交接报告。

-- ─── 放宽 channel_type 白名单 ─────────────────────────────────────────
ALTER TABLE admin_alert_channels DROP CONSTRAINT IF EXISTS admin_alert_channels_channel_type_check;
ALTER TABLE admin_alert_channels
  ADD CONSTRAINT admin_alert_channels_channel_type_check
  CHECK (channel_type IN ('ilink_wechat', 'telegram', 'wecom_bot'));

-- ─── 新增 wecom 指纹列 ───────────────────────────────────────────────
ALTER TABLE admin_alert_channels ADD COLUMN wecom_key_fp TEXT;

-- ─── 重建字段一致性约束(含 wecom_bot 分支)──────────────────────────
-- iLink 行:tg_chat_id / wecom_key_fp 必须 NULL
-- Telegram 行:ilink_* / target_sender_id / context_token / wecom_key_fp 必须 NULL,tg_chat_id 非空
-- WeCom 行:ilink_* / target_sender_id / context_token / tg_chat_id 必须 NULL,wecom_key_fp 非空
ALTER TABLE admin_alert_channels DROP CONSTRAINT IF EXISTS chk_channel_type_fields;
ALTER TABLE admin_alert_channels
  ADD CONSTRAINT chk_channel_type_fields CHECK (
    (channel_type = 'ilink_wechat'
        AND tg_chat_id IS NULL
        AND wecom_key_fp IS NULL)
    OR (channel_type = 'telegram'
        AND ilink_account_id IS NULL
        AND ilink_login_user_id IS NULL
        AND target_sender_id IS NULL
        AND context_token IS NULL
        AND tg_chat_id IS NOT NULL
        AND wecom_key_fp IS NULL)
    OR (channel_type = 'wecom_bot'
        AND ilink_account_id IS NULL
        AND ilink_login_user_id IS NULL
        AND target_sender_id IS NULL
        AND context_token IS NULL
        AND tg_chat_id IS NULL
        AND wecom_key_fp IS NOT NULL)
  );

-- ─── 唯一性:同 admin 的同 webhook(按指纹)只能有一条 wecom 通道 ─────
CREATE UNIQUE INDEX idx_aac_wecom_identity
  ON admin_alert_channels(admin_id, wecom_key_fp)
  WHERE channel_type = 'wecom_bot' AND wecom_key_fp IS NOT NULL;

COMMENT ON COLUMN admin_alert_channels.wecom_key_fp IS
  'SHA-256 hex fingerprint of the WeCom group-bot webhook key (non-secret, irreversible). Per-admin dedupe only. NULL for non-wecom channels.';
