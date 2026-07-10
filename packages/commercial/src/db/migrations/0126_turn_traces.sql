-- 0126_turn_traces — traceId(响应底部展示的请求ID)唯一持久登记。
--
-- 动机:UI 底部的请求ID = bridge 在 inbound.message 铸造的 canonical traceId,
-- 此前没有任何持久面存它(usage_records.request_id 是上游请求 id,另一套 id 空间),
-- 运维拿着用户报的 id 无从定位(2026-07-10 实测只能靠消息原文扫容器卷)。
-- 本表由 bridge 铸造点 fire-and-forget 写入,一条 SQL 即可 trace→user/session/时间。
CREATE TABLE IF NOT EXISTS turn_traces (
  trace_id    text PRIMARY KEY,
  user_id     bigint NOT NULL,
  session_key text NOT NULL,
  agent_id    text,
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 索引在建表后单独建(sessionsDb 0119 事故教训:引用后加列的 index 必须在列存在之后)。
CREATE INDEX IF NOT EXISTS turn_traces_user_created_idx ON turn_traces (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS turn_traces_created_idx ON turn_traces (created_at);
