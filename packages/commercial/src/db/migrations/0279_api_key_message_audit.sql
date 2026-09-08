-- 0279_api_key_message_audit.sql
-- order-dependency: 0278_friction_problem_card_dims
-- 外接 API key(/api/anthropic,oc-cc.* 密钥)请求的**用户消息审计**(管理员决定,2026-09-08)。
--
-- 背景:用户 Mac 上 Claude Code 经外接端点发请求,上游供应商回 400,但服务端只记了
-- usage_records(无内容)—— 无法回答「用户到底发了什么」。管理员要求对经外接 key 进来的
-- 请求做审计留痕,粒度选定为「用户本轮实际输入的最后一条消息」:
--   * 只存最后一条 user 角色消息的**文本**(截断到 4096 字节),不存 system prompt、工具
--     schema、历史消息、模型回复 —— 体量小,且不把用户项目里的代码/文件整体入库;
--   * 整条请求体的 SHA-256 + 字节数 + 消息数 / 工具数,能证明"这条请求就是那条请求"、
--     并量化上下文体量(排查上游 4xx 时最有用的两个维度);
--   * 结果字段(status / terminal_code / duration_ms / usage)与 usage_records 同口径,
--     但这里按 request_id 一行一请求、**失败也落**(usage_records 只记有账务意义的行)。
--
-- 可见性:仅实例管理员(GET /api/admin/api-keys/messages,requireAdmin)。普通用户看不到。
-- 离场:auditRetention TTL 90 天(AUDIT_RETENTION_POLICIES 登记 created_at),与 agent_audit 同档。
-- 写入:cursorExternal.handle 结算之后 fire-and-forget,失败只记日志,绝不影响请求本身。
--
-- CREATE only;rollback-safe(旧代码不知道这张表)。

CREATE TABLE IF NOT EXISTS api_key_message_audit (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id       TEXT        NOT NULL,
  user_id          BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id       BIGINT      REFERENCES user_api_keys(id) ON DELETE SET NULL,
  -- 客户端原话(公开 id,如 fable-5.1 / fable-5.1-high)与解析后的内部计费 id。
  requested_model  TEXT        NOT NULL,
  model            TEXT        NOT NULL,
  effort           TEXT,
  effort_source    TEXT,
  account_id       BIGINT,
  -- 请求形状(不含内容)。
  body_sha256      TEXT        NOT NULL,
  body_bytes       INTEGER     NOT NULL,
  message_count    INTEGER     NOT NULL DEFAULT 0,
  tool_count       INTEGER     NOT NULL DEFAULT 0,
  stream           BOOLEAN     NOT NULL DEFAULT true,
  -- 用户本轮输入(最后一条 role=user 的文本块拼接,UTF-8 截断到 4096 字节;tool_result 不算)。
  last_user_message TEXT,
  last_user_message_truncated BOOLEAN NOT NULL DEFAULT false,
  -- 结果。
  status           TEXT        NOT NULL,   -- success | error
  terminal_code    TEXT,
  error_message    TEXT,                   -- 对外错误文案(如 "Provider Error (400): …"),≤ 512
  duration_ms      INTEGER,
  input_tokens     BIGINT,
  output_tokens    BIGINT,
  cache_read_tokens  BIGINT,
  cache_write_tokens BIGINT,
  client_user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_akma_key_time
  ON api_key_message_audit(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_akma_user_time
  ON api_key_message_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_akma_created
  ON api_key_message_audit(created_at);

COMMENT ON TABLE api_key_message_audit IS
  'Per-request audit of external API-key (/api/anthropic) traffic: last user message (<=4KB), request-body fingerprint/shape, resolved model+effort, outcome. Admin-only read; 90d TTL.';
COMMENT ON COLUMN api_key_message_audit.last_user_message IS
  'Text of the last role=user message in the request (tool_result blocks excluded), UTF-8 truncated to 4096 bytes. NULL when the turn had no user text (pure tool-result continuation).';
COMMENT ON COLUMN api_key_message_audit.body_sha256 IS
  'SHA-256 of the exact JSON request body as received, for matching a row to a client-side log without storing the body.';
