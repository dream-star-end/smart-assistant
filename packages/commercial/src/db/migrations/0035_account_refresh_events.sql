-- 0035_account_refresh_events.sql
-- M6 / P1-9 — 账号 OAuth refresh 事件历史表。
--
-- 设计要点:
--   1. 取代 accounts.last_error 单字段(最后一次失败原因被新成功覆盖,无法回看)。
--      新表追加每一次 refresh 结果,28 天 retention。
--   2. account_id FK ON DELETE CASCADE — 账号删除时事件历史一并清理,
--      避免孤儿。call site 因此跳过 account_not_found / "vanished" 路径
--      (账号不存在则没有 FK 父行可挂)。
--   3. CHECK chk_event_consistency — 强制 ok=true 时 err_code/err_msg 必为 NULL,
--      ok=false 时两者必非空。DB 层挡住 instrumentation 写错。
--   4. err_msg 落库内容**必须是固定受控字符串**,不允许写入 raw err.message
--      或上游 response body(可能含 proxy 凭据 / token 片段)。在 refresh.ts
--      调用点用枚举字面量。
--   5. 索引:
--      - (account_id, ts DESC) — admin UI 按账号倒序读最近 N 条
--      - (ts) — 给 retention sweeper 走 DELETE WHERE ts < now() - '28 days'

CREATE TABLE account_refresh_events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES claude_accounts(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok BOOLEAN NOT NULL,
  err_code TEXT,
  err_msg TEXT,
  CONSTRAINT chk_event_consistency CHECK (
    (ok = TRUE AND err_code IS NULL AND err_msg IS NULL)
    OR
    (ok = FALSE AND err_code IS NOT NULL AND err_msg IS NOT NULL)
  )
);

CREATE INDEX idx_account_refresh_events_account_ts
  ON account_refresh_events(account_id, ts DESC);

CREATE INDEX idx_account_refresh_events_ts
  ON account_refresh_events(ts);

COMMENT ON TABLE account_refresh_events IS
  'M6/P1-9: 账号 OAuth refresh 历史。28天 retention。err_msg 仅可为受控固定字符串,不许写 raw err.message。';

COMMENT ON COLUMN account_refresh_events.err_code IS
  'RefreshErrorCode 枚举字符串: no_refresh_token | http_error | network_transient | bad_response | persist_error。NULL 当 ok=true。';

COMMENT ON COLUMN account_refresh_events.err_msg IS
  '受控固定字符串(参见 refresh.ts 落库点)。NULL 当 ok=true。禁止写 raw err.message。';
