-- 0065_inbox_email_notify.sql
--
-- 站内信 → 邮件推送(Plan C)。
--
-- 设计要点(为什么不是 fire-and-forget):
--   群发 audience='all' 在 200 用户量 × 600ms/封 ≈ 120s,期间任意 deploy / 进程
--   crash 都会把"已发到 N / 计划发 M"卡死 + 用户已读站内信但邮件未到。所以引入
--   一张 durable jobs 表:创建消息同事务写收件人快照,后台 worker drain,失败/中断
--   状态持久化,不自动重试(避免"已发但 DB 未写 sent"导致用户重复收到)。
--
-- 收件人快照语义:
--   audience='user' → jobs 写 1 行(收件人 id + email 当时快照)
--   audience='all'  → 创建时 INSERT...SELECT users WHERE status='active' AND
--                     email_verified=TRUE AND deleted_at IS NULL —— 锁定那一刻的
--                     receiver 列表。之后注册的用户不会收邮件,与站内信"广播只对
--                     注册前的用户可见"语义一致。
--
-- email_send_status 状态机(主表汇总,不参与 worker 状态机):
--   NULL(notify_email=false)→ 'queued' →(worker 跑过一遍)→ 'done' / 'partial' /
--   'interrupted'(发到一半 daemon 重启,部分 jobs 卡 sending,启动时清 stale)
--
-- jobs 表状态机:
--   'queued' → 'sending'(locked_at=NOW)→ 'sent' / 'failed'
--   'sending' + locked_at < NOW - 5min(daemon 重启留下)→ 'interrupted'(启动清扫)
--   'dropped':收件人邮箱在快照后变空/账号删除等异常,worker 主动跳过

ALTER TABLE inbox_messages
  ADD COLUMN notify_email      BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN email_send_status TEXT,                -- null / queued / done / partial / interrupted
  ADD COLUMN email_sent_at     TIMESTAMPTZ,
  ADD COLUMN email_summary     JSONB;               -- { total, sent, failed, interrupted, dropped }

CREATE TABLE inbox_email_jobs (
  id           BIGSERIAL PRIMARY KEY,
  message_id   BIGINT NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  -- 不加 FK 到 users:用户被硬删后 job 仍能 dropped 标记,不让 CASCADE 把审计快照吞掉
  user_id      BIGINT NOT NULL,
  -- 创建时快照,worker 不重新读 users 表 —— 用户改邮箱不影响已 queue 的群发
  email        TEXT   NOT NULL,
  status       TEXT   NOT NULL DEFAULT 'queued',
                       -- queued / sending / sent / failed / interrupted / dropped
  attempts     INT    NOT NULL DEFAULT 0,
  -- worker pick 时填,完成/失败清空。重启时 stale(locked_at < NOW-5min)→ interrupted
  locked_at    TIMESTAMPTZ,
  last_error   TEXT,                                 -- 单条错误截 500 字符
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 同一封站内信对同一用户最多一条 job —— 防止重复 enqueue 或 manual retry 双发
  UNIQUE (message_id, user_id),
  CHECK (status IN ('queued','sending','sent','failed','interrupted','dropped'))
);

-- worker drain 主索引:status='queued' partial index,picker 按 id 升序消费
CREATE INDEX idx_inbox_email_jobs_queued
  ON inbox_email_jobs (id)
  WHERE status = 'queued';

-- 启动 stale 扫描:status='sending' partial,按 locked_at 找进程崩前卡住的
CREATE INDEX idx_inbox_email_jobs_sending_locked
  ON inbox_email_jobs (locked_at)
  WHERE status = 'sending';

-- 主表汇总聚合:某条 message 跑完后回写主表,前端列表读主表不 N+1 jobs
CREATE INDEX idx_inbox_email_jobs_by_message
  ON inbox_email_jobs (message_id);

-- 回滚提示(项目无 down migration 传统,手动 rollback SQL):
--   DROP TABLE inbox_email_jobs;
--   ALTER TABLE inbox_messages
--     DROP COLUMN notify_email,
--     DROP COLUMN email_send_status,
--     DROP COLUMN email_sent_at,
--     DROP COLUMN email_summary;
