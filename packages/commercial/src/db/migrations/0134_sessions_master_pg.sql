-- 0134: master 侧会话权威迁 PG(P2/RFC-v5-sessions-pg,Codex R1 修订版)
-- 纯建表,backward-compatible:旧 release 不读这些表,可提前 apply。
-- 语义与 storage/sessionsDb.ts 的 SQLite DDL 逐列对齐:
--   毫秒时间戳 INTEGER→BIGINT(node-postgres 返回 string,backend 行 mapper 显式
--   Number()+MAX_SAFE_INTEGER 断言,不改全局 parser);messages/chunk JSON 整存整取
--   →TEXT(TOAST 自动压缩;不用 JSONB——无行内查询需求,拒付转换税);pinned 0/1→SMALLINT。
-- updated_at 语义=DB 计算的逻辑版本(严格单调,见 RFC D3b),不是裸挂钟。
-- 默认值用 clock_timestamp()(语句时刻)而非 now()(事务开始时刻)。
-- team_runs/team_delegations 不迁(已废弃);client_sessions_archive 单数旧备份表不迁。

-- 权威状态机(R3):启动规则矩阵与 backfill/清表/灾难反灌的唯一裁决源。
-- backfill 全量校验通过后同事务写 authority='pg_authoritative'+新 generation;
-- 与本地 manifest($OPENCLAUDE_HOME/sessions-store-authority.json)双写,启动要求一致。
CREATE TABLE IF NOT EXISTS sessions_store_migration_state (
  singleton     BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  authority     TEXT NOT NULL CHECK (authority IN ('prepared','pg_authoritative','sqlite_disaster_recovered')),
  generation    BIGINT NOT NULL CHECK (generation >= 1),
  cutover_id    TEXT NOT NULL CHECK (cutover_id <> ''),
  source_digest TEXT,
  completed_at  BIGINT,
  -- 终态必须携带校验凭证;prepared 允许为空(R4 MINOR)
  CHECK (authority = 'prepared' OR (source_digest IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS client_sessions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL DEFAULT 'default',
  agent_id             TEXT NOT NULL DEFAULT 'main',
  title                TEXT NOT NULL DEFAULT '新会话',
  pinned               SMALLINT NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at           BIGINT NOT NULL,
  last_at              BIGINT NOT NULL,
  messages             TEXT NOT NULL DEFAULT '[]',
  message_count        INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at           BIGINT NOT NULL,
  deleted_at           BIGINT DEFAULT NULL,
  next_seq             INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  origin_channel       TEXT DEFAULT NULL,
  archived_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (archived_through_seq >= 0),
  archived_count       INTEGER NOT NULL DEFAULT 0 CHECK (archived_count >= 0)
);
-- list 查询形态:WHERE user_id=? AND deleted_at IS NULL ORDER BY last_at DESC
-- → 复合部分索引一发命中(R1 MINOR;不建两个单列索引)
CREATE INDEX IF NOT EXISTS idx_client_sessions_user_last
  ON client_sessions(user_id, last_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS client_session_archive_chunks (
  session_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  first_seq     INTEGER NOT NULL,
  last_seq      INTEGER NOT NULL,
  message_count INTEGER NOT NULL CHECK (message_count > 0),
  messages      TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (session_id, first_seq),
  CHECK (first_seq >= 1 AND first_seq <= last_seq)
);
CREATE INDEX IF NOT EXISTS idx_csa_chunks_last
  ON client_session_archive_chunks(session_id, last_seq);

CREATE TABLE IF NOT EXISTS client_session_archived_ids (
  session_id TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  PRIMARY KEY (session_id, msg_id)
);

CREATE TABLE IF NOT EXISTS server_authored_request_map (
  request_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  written_at BIGINT NOT NULL DEFAULT floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT,
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sarm_session ON server_authored_request_map(session_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_sarm_written ON server_authored_request_map(written_at);

CREATE TABLE IF NOT EXISTS pending_usage_patches (
  request_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  session_id        TEXT,
  parent_session_id TEXT,
  delegate_agent_id TEXT,
  cost_credits      TEXT NOT NULL,
  created_at        BIGINT NOT NULL DEFAULT floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT,
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pup_created ON pending_usage_patches(created_at);
-- drainByUser 精确路径 WHERE user_id=? AND session_id=?(R1 MINOR)
CREATE INDEX IF NOT EXISTS idx_pup_user_session ON pending_usage_patches(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_pup_parent
  ON pending_usage_patches(user_id, parent_session_id)
  WHERE parent_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wechat_bindings (
  user_id         TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  login_user_id   TEXT NOT NULL DEFAULT '',
  bot_token       TEXT NOT NULL,
  get_updates_buf TEXT NOT NULL DEFAULT '',
  context_tokens  TEXT NOT NULL DEFAULT '{}',
  whitelist       TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','expired')),
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  last_event_at   BIGINT DEFAULT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_bindings_account ON wechat_bindings(account_id);
CREATE INDEX IF NOT EXISTS idx_wechat_bindings_status ON wechat_bindings(status);
