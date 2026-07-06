-- 0110_alert_channel_wecom_aibot.sql
-- 企业微信「智能机器人」长连接告警通道:第四条 channel_type='wecom_aibot'。
--
-- 背景:0109 的 wecom_bot(群机器人 webhook)要求 boss 企业里有「群机器人」入口且
-- 自建应用可配可信 IP。boss 企业既无群机器人入口、自建应用可信 IP 也配不了 → 改走
-- 官方「智能机器人(aibot)」长连接:客户端主动 wss 连 openws.work.weixin.qq.com,
-- 订阅帧用 BotID + 长连接专用 Secret 鉴权,无需公网回调 / 无需加解密 / 无需可信 IP。
--
-- 设计要点(与 0109 的差异):
--   1. 复用 admin_alert_channels 表 + 现有 outbox / dedupe / 退避;新 channel_type='wecom_aibot'。
--   2. Secret(长连接专用密钥,机密)AEAD 加密进 bot_token_enc / bot_token_nonce
--      (同 KMS 密钥,与 iLink/telegram/wecom_bot 共用密文列)。明文永不落库。
--   3. **BotID 非机密**(每机器人唯一标识)→ 直接明文存新列 aibot_bot_id,不做指纹。
--      这是与 0109 的关键分野:0109 的 webhook key 既是身份又是机密,无法明文入库
--      故存 SHA-256 指纹(wecom_key_fp)供去重;aibot 的身份(BotID)本就非密,明文
--      存 + 直接对 aibot_bot_id 建唯一索引更干净,无需指纹层。
--   4. **推送目标 chatid/chat_type 运行时自动学习**:aibot 主动推送的前提是「用户先在
--      会话里给机器人发过消息」。连接管理器收到 aibot_msg_callback(single 私聊 / group
--      @机器人)时把 chatid+chattype 学习为该通道的推送目标,UPDATE 回写 aibot_chat_id /
--      aibot_chat_type(见 wecomAibotConnection.updateAibotBinding)。故新增这两列,初始
--      NULL(待绑定),绑定后非空。绑定与 activation 正交(见下)。
--   5. **activation_status 语义**:创建即 'active'(与 wecom_bot/telegram 同构 —— 配置
--      齐全即 active)。「是否已绑定 chatid」是运行时属性(aibot_chat_id 是否非空),不进
--      activation_status —— 因为 aibot 可随时被新会话重新绑定,绑定态与激活态天然正交。
--      仅 Secret 被服务端拒绝(订阅鉴权失败)才把 activation_status 降 'error'(permanent)。
--      未绑定时的告警投递在 dispatcher 发送期 markFailed transient(退避重试),文案提示
--      「请给机器人发一条消息完成绑定」。
--   6. CHECK 约束保证 (channel_type, fields) 一致性;全局部分唯一索引保证同一 BotID
--      在库里只能有一条 wecom_aibot 通道 —— 这不只是去重:官方约束「每个机器人同一时间
--      仅一条有效连接,新连接踢旧连接」,若两条通道(哪怕跨 admin)指向同一 BotID,连接
--      管理器会开两条 WS 互相踢 → 抖动。故唯一性提到**全局**(不 per-admin,区别于 0109),
--      在数据层根除「一机器人两连接」抖动。告警通道本就是超管共享运维设施(listAlertChannels
--      不分 admin 全量可见),全局唯一契合其共享语义。
--
-- v3 兼容性:widen channel_type 白名单对 v3 是纯放行(v3 现网树无 createWecomAibotChannel,
-- 永不写 'wecom_aibot' 行)。admin_alert_outbox 是 v3/v5 共享 PG:v3 旧 shared dispatcher 的
-- outbox claim 类型无关,会误 claim wecom_aibot 行走 else 分支 markFailed —— v5 侧 claim 已
-- 按 channel_type IN ('wecom_bot','wecom_aibot') 过滤(对称只认领自己能处理的类型),v3 影响
-- 面与 0109 同(v3 退役中,shared scheduler 多数已停),不新增风险。
--
-- ─── 人工 APPLY 提示(v5 deploy 迁移人工执行,非 auto-migrate)──────────────
-- 在 v5 master 所连的共享 PG 上执行(单事务;migrate.ts 的 version = 文件名去 .sql):
--   BEGIN;
--   \i 0110_alert_channel_wecom_aibot.sql
--   INSERT INTO schema_migrations(version) VALUES ('0110_alert_channel_wecom_aibot');
--   COMMIT;
-- 校验:\d admin_alert_channels 应见 aibot_bot_id / aibot_chat_id / aibot_chat_type 三列 +
--   idx_aac_wecom_aibot_identity 索引;chk_channel_type_fields 含 wecom_aibot 分支。
-- 幂等:列用 ADD COLUMN IF NOT EXISTS,约束/索引先 DROP IF EXISTS 再建,可重复执行。

-- ─── 放宽 channel_type 白名单 ─────────────────────────────────────────
ALTER TABLE admin_alert_channels DROP CONSTRAINT IF EXISTS admin_alert_channels_channel_type_check;
ALTER TABLE admin_alert_channels
  ADD CONSTRAINT admin_alert_channels_channel_type_check
  CHECK (channel_type IN ('ilink_wechat', 'telegram', 'wecom_bot', 'wecom_aibot'));

-- ─── 新增 aibot 列 ───────────────────────────────────────────────────
ALTER TABLE admin_alert_channels ADD COLUMN IF NOT EXISTS aibot_bot_id TEXT;
ALTER TABLE admin_alert_channels ADD COLUMN IF NOT EXISTS aibot_chat_id TEXT;
ALTER TABLE admin_alert_channels ADD COLUMN IF NOT EXISTS aibot_chat_type TEXT;

-- ─── 重建字段一致性约束(含 wecom_aibot 分支)──────────────────────────
-- iLink 行:tg_chat_id / wecom_key_fp / aibot_* 必须 NULL
-- Telegram 行:ilink_* / target_sender_id / context_token / wecom_key_fp / aibot_* 必须 NULL,tg_chat_id 非空
-- WeCom(webhook)行:ilink_* / target_sender_id / context_token / tg_chat_id / aibot_* 必须 NULL,wecom_key_fp 非空
-- WeCom aibot 行:ilink_* / target_sender_id / context_token / tg_chat_id / wecom_key_fp 必须 NULL,
--                aibot_bot_id 非空;aibot_chat_id 与 aibot_chat_type 同生共死(要么都 NULL=待绑定,
--                要么都非空=已绑定);chat_type 若非空只能是 single|group。
ALTER TABLE admin_alert_channels DROP CONSTRAINT IF EXISTS chk_channel_type_fields;
ALTER TABLE admin_alert_channels
  ADD CONSTRAINT chk_channel_type_fields CHECK (
    (channel_type = 'ilink_wechat'
        AND tg_chat_id IS NULL
        AND wecom_key_fp IS NULL
        AND aibot_bot_id IS NULL AND aibot_chat_id IS NULL AND aibot_chat_type IS NULL)
    OR (channel_type = 'telegram'
        AND ilink_account_id IS NULL
        AND ilink_login_user_id IS NULL
        AND target_sender_id IS NULL
        AND context_token IS NULL
        AND tg_chat_id IS NOT NULL
        AND wecom_key_fp IS NULL
        AND aibot_bot_id IS NULL AND aibot_chat_id IS NULL AND aibot_chat_type IS NULL)
    OR (channel_type = 'wecom_bot'
        AND ilink_account_id IS NULL
        AND ilink_login_user_id IS NULL
        AND target_sender_id IS NULL
        AND context_token IS NULL
        AND tg_chat_id IS NULL
        AND wecom_key_fp IS NOT NULL
        AND aibot_bot_id IS NULL AND aibot_chat_id IS NULL AND aibot_chat_type IS NULL)
    OR (channel_type = 'wecom_aibot'
        AND ilink_account_id IS NULL
        AND ilink_login_user_id IS NULL
        AND target_sender_id IS NULL
        AND context_token IS NULL
        AND tg_chat_id IS NULL
        AND wecom_key_fp IS NULL
        AND aibot_bot_id IS NOT NULL
        AND (
          (aibot_chat_id IS NULL AND aibot_chat_type IS NULL)
          OR (aibot_chat_id IS NOT NULL AND aibot_chat_type IN ('single', 'group'))
        ))
  );

-- ─── 唯一性:全局同一 BotID 只能有一条 wecom_aibot 通道 ─────────────────
-- 全局(非 per-admin):物理约束「一机器人一连接」——防两条通道指向同一 BotID 让连接
-- 管理器开两条 WS 互相踢。
CREATE UNIQUE INDEX IF NOT EXISTS idx_aac_wecom_aibot_identity
  ON admin_alert_channels(aibot_bot_id)
  WHERE channel_type = 'wecom_aibot' AND aibot_bot_id IS NOT NULL;

COMMENT ON COLUMN admin_alert_channels.aibot_bot_id IS
  'WeCom aibot BotID (non-secret bot identity). Globally unique among wecom_aibot rows. NULL for non-aibot channels.';
COMMENT ON COLUMN admin_alert_channels.aibot_chat_id IS
  'Learned push-target chatid for wecom_aibot (runtime-learned from aibot_msg_callback). NULL until bound.';
COMMENT ON COLUMN admin_alert_channels.aibot_chat_type IS
  'Learned push-target chat type for wecom_aibot: single|group. NULL until bound; paired with aibot_chat_id.';
