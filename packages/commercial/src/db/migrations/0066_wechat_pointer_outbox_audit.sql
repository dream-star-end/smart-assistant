-- 0066_wechat_pointer_outbox_audit.sql
--
-- v3 commercial 微信 broker 化(RFC: docs/v3/wechat-broker-design.md)P1.5 数据模型。
--
-- 三张表 落在 commercial PostgreSQL DB(broker 跑在 master 进程里,与本 DB 同生命周期):
--
--   wechat_session_pointer — binding ↔ current_session_id 指针;reconcile 用 current_session_id
--                            反查孤儿(binding 已失活但 pointer 残留)。P3 才补 lru_stack。
--   wechat_outbox          — iLink sendText 重试队列 + 跨容器重启幂等 tombstone。container 端
--                            可能因 ACK 丢包重发同一 outbound_id,master 借 status='sent' 行
--                            (保留 24h)直接返 already_sent 而非二次下发。
--   wechat_audit           — 入站原始 payload 7d 审计 + (account_id, message_id) 去重。
--                            raw_payload 保留完整 iLink 事件,故障复盘用。
--
-- 跨 DB 一致性说明:
--   wechat_bindings 住 master SQLite,本表 binding_user_id 是逻辑外键无强制 FK。broker.reconcile
--   每 30s 对账(见 RFC §4.8): 删 orphan pointer / pointer 查询前校验 binding 仍 active /
--   wechat_outbox 启动时 drop >24h pending。session_id 同样逻辑引用 client_sessions,故意不加
--   FK(session 被删但出站重试/审计快照不该 CASCADE 消失)。
--
-- 时间列一律 BIGINT epoch ms(非 TIMESTAMPTZ):
--   - 与 master SQLite wechat_bindings.updated_at (INTEGER epoch ms) 跨 DB 直接可比
--   - daemon JS 端 Date.now() 直入,避免 ::timestamptz 来回 cast
--   - 全部带 > 0 CHECK 拦截 0/负值脏写
--
-- 不在本 migration 内的事项(明确划清边界):
--   - wechat_session_pointer.lru_stack JSONB — P3 多会话指针增量(ALTER TABLE 即可)
--   - wechat_bindings.status 'degraded' enum — master SQLite,走 sessionsDb.ts CHECK 修改
--   - user_preferences.wechat_quiet_hours / default_notify_channel — P4 notify_user 实施时
--   - TTL trigger / pg_cron — daemon 侧周期 DELETE 即可,不引入 PG 扩展
--   - 任何 ENUM 类型 — 仓内既有风格用 text + CHECK(见 0059_github_session_workspaces.sql)

-- ── 表 1:binding → current session 指针 ─────────────────────────────────────
CREATE TABLE wechat_session_pointer (
  binding_user_id    TEXT   PRIMARY KEY,        -- PG-side raw digit form(同 users.id / agent_containers.user_id);
                                                 -- 写 master sqlite wechat_bindings 时 broker/dispatcher 会 prepend `c:`,
                                                 -- 见 packages/commercial/src/wechat/userIds.ts
  current_session_id TEXT   NOT NULL,           -- = client_sessions.session_id
  updated_at         BIGINT NOT NULL,           -- epoch ms;每次 switch / new / inbound 触发即 stamp
  CONSTRAINT wsp_binding_user_id_chk CHECK (length(binding_user_id) BETWEEN 1 AND 64),
  CONSTRAINT wsp_session_id_chk      CHECK (length(current_session_id) BETWEEN 8 AND 80),
  CONSTRAINT wsp_updated_at_chk      CHECK (updated_at > 0)
);

-- broker reconcile 反查 orphan 用(也是 session 删除时回扫 pointer 的辅助索引)
CREATE INDEX idx_wsp_current_session ON wechat_session_pointer(current_session_id);

COMMENT ON TABLE wechat_session_pointer IS
  'binding(微信 bot 绑定的 OC 用户)→ 当前 session 指针。P1 schema;P3 增加 lru_stack JSONB 列。binding_user_id 是 PG-side raw digit(对应 users.id);跨 master sqlite 读 wechat_bindings 时 prepend `c:`,见 wechat/userIds.ts。';

-- ── 表 2:iLink sendText 重试队列 + 跨重启幂等 tombstone ────────────────────
--
-- 状态机:
--   queued  → sending  → sent     (正常 happy path)
--   queued  → sending  → failed   (iLink permanent err / payload invalid)
--   sending(locked_at >5min)→ daemon 启动扫描后视作 worker crash 退到 queued
--   sent     保留 24h(tombstone):daemon DELETE WHERE status='sent' AND sent_at < NOW-24h
--   failed   注 1:reset 命中 ON CONFLICT(outbound_id) 时 attempts < maxAttempts 才回 'queued',且**保留 attempts**
--            (不清零)— 防止 container 反复重发 outbound_id 触发 broker 反复 retry 死循环
--          注 2:>=maxAttempts 永久 failed 终态;dropAgedPending(>24h)/ aging 时强转 attempts = maxAttempts
--          兜底,等同 already_failed,enqueue 不复活
--
-- 跨重启幂等机制:
--   container 重发同 outbound_id → INSERT ON CONFLICT DO NOTHING 命中 → 查 status:
--     'sent'    → 返 200 {already_sent}(借 24h tombstone 拦住二次下发)
--     'queued' / 'sending' → 返 202 {pending}
--     'failed' + attempts < maxAttempts → reset 'queued' 保留 attempts(让后续 pick 自然重试或最终失败)
--     'failed' + attempts >= maxAttempts → 返 200 {already_failed}(broker 已放弃,container 不应再发)
--
-- 注:attempts 单调递增不清零 —— reset 'failed'→'queued' 时保留计数防止"container 反复重发触发 broker 反复 retry"
-- 死循环。worker pick → send 失败 → if attempts < maxAttempts release 'queued' 让自然下次再 pick;
-- ≥maxAttempts 转 'failed' 终态。dropAgedPending(>24h)直接把 attempts 强转 maxAttempts 配 status='failed',
-- 等同 already_failed,enqueue 复活时立刻判定 ≥cap 返回 already_failed,不会被复活。
--
CREATE TABLE wechat_outbox (
  id              BIGSERIAL PRIMARY KEY,
  outbound_id     TEXT      NOT NULL UNIQUE,             -- container 端 idempotency key
  binding_user_id TEXT      NOT NULL,
  sender_id       TEXT      NOT NULL,                    -- iLink fromUser(base64url)— worker drain 时调 sendIlinkText 必备
                                                          -- P1 仅支持 dm,senderId 必填;P3 群消息时另 migration ALTER NULLABLE
  session_id      TEXT      NOT NULL,                    -- 出站来源 session(审计/调试)
  payload         JSONB     NOT NULL,                    -- IlinkPart[](P1 文字-only,P2 后丰富)
                                                          -- shape 不在 SQL 层 CHECK,worker 取出时手工 validate
  status          TEXT      NOT NULL DEFAULT 'queued',
  attempts        INT       NOT NULL DEFAULT 0,
  last_error      TEXT,                                  -- 截 ≤1000 字符
  locked_at       BIGINT,                                -- worker pick 时 stamp,stale (>5min) 释放
  sent_at         BIGINT,                                -- status='sent' 时 stamp,24h 后 daemon 清
  created_at      BIGINT    NOT NULL,
  updated_at      BIGINT    NOT NULL,
  CONSTRAINT wox_outbound_id_chk     CHECK (length(outbound_id) BETWEEN 1 AND 128),
  CONSTRAINT wox_binding_user_id_chk CHECK (length(binding_user_id) BETWEEN 1 AND 64),
  CONSTRAINT wox_sender_id_chk       CHECK (length(sender_id) BETWEEN 1 AND 256),
  CONSTRAINT wox_session_id_chk      CHECK (length(session_id) BETWEEN 8 AND 80),
  CONSTRAINT wox_status_chk          CHECK (status IN ('queued','sending','sent','failed')),
  CONSTRAINT wox_attempts_chk        CHECK (attempts >= 0 AND attempts <= 1000),
  CONSTRAINT wox_last_error_len_chk  CHECK (last_error IS NULL OR length(last_error) <= 1000),
  CONSTRAINT wox_created_at_chk      CHECK (created_at > 0),
  CONSTRAINT wox_updated_at_chk      CHECK (updated_at > 0),
  CONSTRAINT wox_locked_at_chk       CHECK (locked_at IS NULL OR locked_at > 0),
  CONSTRAINT wox_sent_at_chk         CHECK (sent_at IS NULL OR sent_at > 0),
  -- 防脏写:status='sent' ↔ sent_at IS NOT NULL 必须同步(Codex r2 plan review 建议)
  CONSTRAINT wox_sent_consistency_chk CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

-- worker drain 主索引(只关心 queued)
CREATE INDEX idx_wox_drain ON wechat_outbox(status, created_at) WHERE status = 'queued';

-- 启动 stale 扫描:status='sending' partial,按 locked_at 找进程崩前卡住的(0065 同型风格)
CREATE INDEX idx_wox_sending_locked ON wechat_outbox(locked_at) WHERE status = 'sending';

-- tombstone 清理:daemon 周期 DELETE WHERE status='sent' AND sent_at < cutoff
CREATE INDEX idx_wox_sent_tombstone ON wechat_outbox(sent_at) WHERE status = 'sent';

-- failed 终态清理:daemon 周期 DELETE WHERE status='failed' AND updated_at < cutoff(7d)
-- 防止 failed 行无限堆积(Codex R2 plan review 建议)
CREATE INDEX idx_wox_failed_purge ON wechat_outbox(updated_at) WHERE status = 'failed';

-- 按 binding 反查(运维侧"某用户 outbox pending 列表")
CREATE INDEX idx_wox_binding ON wechat_outbox(binding_user_id);

COMMENT ON TABLE wechat_outbox IS
  'iLink sendText 重试队列 + 跨重启幂等 tombstone。status=sent 保留 24h 让 container 重发 outbound_id 命中 ON CONFLICT 返 already_sent;daemon 24h 后 DELETE。';

-- ── 表 3:入站审计 + (account_id, message_id) 跨重启去重 ───────────────────
CREATE TABLE wechat_audit (
  id              BIGSERIAL PRIMARY KEY,
  binding_user_id TEXT      NOT NULL,
  account_id      TEXT      NOT NULL,                    -- iLink bot account
  sender_id       TEXT,                                  -- iLink fromUser(base64url);群消息可能 null
  message_id      TEXT,                                  -- iLink msgId,跨 broker 重启去重;部分老事件 null
  item_types      TEXT      NOT NULL,                    -- 'text' / 'image' / 'text,image' 等逗号串
  raw_payload     JSONB     NOT NULL,                    -- 完整 iLink 入站事件(故障复盘用)
  received_at     BIGINT    NOT NULL,                    -- epoch ms (broker 收到时打点)
  CONSTRAINT waud_binding_user_id_chk CHECK (length(binding_user_id) BETWEEN 1 AND 64),
  CONSTRAINT waud_account_id_chk      CHECK (length(account_id) BETWEEN 1 AND 128),
  CONSTRAINT waud_sender_id_chk       CHECK (sender_id IS NULL OR length(sender_id) <= 256),
  -- 排除空字符串参与下方 UNIQUE 索引:空串入库前需 normalize 成 NULL(Codex r2 plan review 建议)
  CONSTRAINT waud_message_id_chk      CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 128),
  CONSTRAINT waud_item_types_chk      CHECK (length(item_types) BETWEEN 1 AND 256),
  CONSTRAINT waud_received_at_chk     CHECK (received_at > 0)
);

-- 运维"最近 N 条入站记录" 主查询路径
CREATE INDEX idx_waud_binding_time ON wechat_audit(binding_user_id, received_at DESC);

-- 跨 broker 重启去重:仅 message_id 非空时生效;不同 bot account 命名空间隔离
CREATE UNIQUE INDEX idx_waud_msgid ON wechat_audit(account_id, message_id) WHERE message_id IS NOT NULL;

COMMENT ON TABLE wechat_audit IS
  '入站审计 + 去重。raw_payload 存完整 iLink 事件;(account_id, message_id) 仅作用 message_id IS NOT NULL,允许无 msgId 多条记录。daemon 定期 DELETE WHERE received_at < NOW - 7d。';

-- 回滚提示(项目无 down migration 传统,手动 rollback SQL):
--   DROP TABLE wechat_audit;
--   DROP TABLE wechat_outbox;
--   DROP TABLE wechat_session_pointer;
