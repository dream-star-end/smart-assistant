-- Track WeChat-originated sessions that currently have a runner in flight.
-- This lets `/stop` interrupt the actual long-running task even if the user's
-- "current session" pointer has moved after `/new` or another inbound turn.

CREATE TABLE IF NOT EXISTS wechat_running_sessions (
  binding_user_id TEXT   NOT NULL,
  session_id      TEXT   NOT NULL,
  agent_id        TEXT,
  started_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (binding_user_id, session_id),
  CONSTRAINT wrs_binding_user_id_chk CHECK (length(binding_user_id) BETWEEN 1 AND 64),
  CONSTRAINT wrs_session_id_chk      CHECK (length(session_id) BETWEEN 8 AND 80),
  CONSTRAINT wrs_agent_id_chk        CHECK (agent_id IS NULL OR length(agent_id) BETWEEN 1 AND 128),
  CONSTRAINT wrs_started_at_chk      CHECK (started_at > 0),
  CONSTRAINT wrs_updated_at_chk      CHECK (updated_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_wrs_binding_started
  ON wechat_running_sessions(binding_user_id, started_at DESC);

COMMENT ON TABLE wechat_running_sessions IS
  'WeChat binding -> active wsess runners. Used by /stop to interrupt actual running tasks, not just the current pointer.';
