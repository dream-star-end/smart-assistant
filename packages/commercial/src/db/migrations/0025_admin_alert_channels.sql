-- 0025_admin_alert_channels.sql
-- T-63 admin 告警通道 + 规则持久化 + outbox + 静默窗口
--
-- 设计要点:
--   1. channels per-admin:一个 admin 可绑多个 iLink bot(生产/灰度/备用),每条存
--      AEAD 加密的 bot_token。未来可扩 telegram / email / webhook,channel_type 白名单。
--   2. rule_state 持久化:旧 alerts.ts 的 firing Set 在进程内,gateway 重启会丢状态,
--      进而重复喷同一告警。改用 rule_id PK 行锁持久化。
--   3. outbox = (event, channel) 展开后的投递队列:
--      - dedupe_key 软去重(5min 窗口):同样事件短时间内多次发生只保留一条 pending
--      - 状态机:pending → sent | failed → pending(retry) | suppressed(静默命中)
--      - attempts / next_attempt_at / last_error 支撑指数退避
--   4. silences:matcher JSONB(event_type/severity/rule_id),时间窗内 enqueue 时
--      直接标 suppressed,不进重试。

-- ─── admin_alert_channels ─────────────────────────────────────────────

CREATE TABLE admin_alert_channels (
  id                      BIGSERIAL PRIMARY KEY,
  admin_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_type            TEXT NOT NULL
                          CHECK (channel_type IN ('ilink_wechat')),
  label                   TEXT NOT NULL,
  enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
  severity_min            TEXT NOT NULL DEFAULT 'warning'
                          CHECK (severity_min IN ('info', 'warning', 'critical')),
  -- 空数组 = 订阅全部事件;非空 = 只订阅白名单里的 event_type
  event_types             JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ── iLink 专用字段 ────────────────────────────────────────────────
  -- AEAD(AES-256-GCM)加密的 bot_token,nonce 12B,密文含 16B tag
  bot_token_enc           BYTEA,
  bot_token_nonce         BYTEA,
  -- iLink 扫码返回的 bot/user 身份
  ilink_account_id        TEXT,
  ilink_login_user_id     TEXT,
  -- 告警实际要发给哪个 wechat user(一般就是扫码者 = login_user_id,但支持白名单扩展)
  target_sender_id        TEXT,
  -- long-poll worker 维护:最近一次入站消息里的 context_token,发消息必须带
  context_token           TEXT,
  get_updates_buf         TEXT NOT NULL DEFAULT '',
  -- 通道激活状态:
  --   pending  → QR 已扫但 admin 还没给 bot 发过消息,context_token 为空,不能 send
  --   active   → context_token 已收到,可以 send
  --   disabled → admin 主动关闭
  --   error    → long-poll 连续失败,被 worker 标记(session expired 等)
  activation_status       TEXT NOT NULL DEFAULT 'pending'
                          CHECK (activation_status IN ('pending', 'active', 'disabled', 'error')),
  last_inbound_at         TIMESTAMPTZ,
  last_send_at            TIMESTAMPTZ,
  last_error              TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by              BIGINT REFERENCES users(id) ON DELETE SET NULL
);

-- worker 扫描要 dispatch / long-poll 的通道
CREATE INDEX idx_aac_dispatch
  ON admin_alert_channels(enabled, activation_status)
  WHERE enabled = TRUE AND activation_status = 'active';

-- 按 admin 列通道
CREATE INDEX idx_aac_admin
  ON admin_alert_channels(admin_id, created_at DESC);

-- iLink 绑定幂等约束:同一 admin 对同一 (bot account, wechat user) 只能有一条通道。
-- Codex FAIL finding #2:前端 /ilink/poll 可能被多 tab / 重复点击并发触发,
-- 两个请求都拿到同一个 confirmed qrcode,会各插一条通道。加 partial unique,
-- 让第二个请求走 ON CONFLICT 路径回落到 "已存在" 语义,不会重复落库。
CREATE UNIQUE INDEX idx_aac_ilink_identity
  ON admin_alert_channels(admin_id, ilink_account_id, ilink_login_user_id)
  WHERE channel_type = 'ilink_wechat'
    AND ilink_account_id IS NOT NULL
    AND ilink_login_user_id IS NOT NULL;

COMMENT ON TABLE admin_alert_channels IS
  'Per-admin alert delivery channels. Currently only iLink WeChat; token AEAD-encrypted with OPENCLAUDE_KMS_KEY.';
COMMENT ON COLUMN admin_alert_channels.event_types IS
  'JSON array of event_type strings. Empty = subscribe all events.';
COMMENT ON COLUMN admin_alert_channels.context_token IS
  'Latest iLink context_token captured from inbound getupdates. Required to call sendIlinkText. NULL → channel still pending activation.';

-- ─── admin_alert_rule_state ──────────────────────────────────────────

CREATE TABLE admin_alert_rule_state (
  rule_id              TEXT PRIMARY KEY,
  firing               BOOLEAN NOT NULL DEFAULT FALSE,
  dedupe_key           TEXT,
  last_transition_at   TIMESTAMPTZ,
  last_evaluated_at    TIMESTAMPTZ,
  last_payload         JSONB
);

COMMENT ON TABLE admin_alert_rule_state IS
  'Persistent firing/resolved state for polled alert rules. Survives gateway restart so we do not re-fire on every boot.';

-- ─── admin_alert_outbox ──────────────────────────────────────────────

CREATE TABLE admin_alert_outbox (
  id                 BIGSERIAL PRIMARY KEY,
  event_type         TEXT NOT NULL,
  severity           TEXT NOT NULL
                     CHECK (severity IN ('info', 'warning', 'critical')),
  dedupe_key         TEXT,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 目标通道;enqueue 时按订阅展开,每 (event, channel) 一行。
  channel_id         BIGINT REFERENCES admin_alert_channels(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'sent', 'failed', 'suppressed', 'skipped')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at            TIMESTAMPTZ
);

-- dispatcher 扫 pending/failed 取就绪的行
CREATE INDEX idx_aao_dispatch
  ON admin_alert_outbox(status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- 前端按 event_type / time 看投递历史
CREATE INDEX idx_aao_event_time
  ON admin_alert_outbox(event_type, created_at DESC);

-- dedupe 唯一约束:同一 (channel, dedupe_key) 的 pending/failed 行只允许一条
--   - 这样 5 分钟内重复 enqueue(例如 account_pool.all_down 每次 tick 都触发)
--     不会堆积;已 sent / suppressed 的不计入冲突,满足长期去重
CREATE UNIQUE INDEX idx_aao_dedupe_pending
  ON admin_alert_outbox(channel_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'failed');

COMMENT ON TABLE admin_alert_outbox IS
  'Durable fan-out queue for admin alerts. One row per (event, channel). Dispatcher retries failed rows with exponential backoff.';

-- ─── admin_alert_silences ────────────────────────────────────────────

CREATE TABLE admin_alert_silences (
  id           BIGSERIAL PRIMARY KEY,
  matcher      JSONB NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  reason       TEXT NOT NULL,
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

-- matcher 结构(宽松:任一字段 undefined 视为 "match any"):
--   { "event_type": "account_pool.all_down" }
--   { "severity": "warning" }
--   { "event_type": "payment.first_topup", "severity": "info" }
--
-- 注:只能用 IMMUTABLE predicate,NOW() 不行;silence 表行数极小(理论上
-- 永远 < 百行),全表扫描 or 普通 ends_at index 都够了。
CREATE INDEX idx_aas_ends_at ON admin_alert_silences(ends_at);

COMMENT ON TABLE admin_alert_silences IS
  'Maintenance/incident silences. If an event matches any active silence, outbox row is created with status=suppressed (no retry).';
