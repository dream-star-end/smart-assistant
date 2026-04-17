-- 0006_init_audit.sql
-- admin_audit / rate_limit_events
-- 依赖:0001(users)

CREATE TABLE admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action     TEXT NOT NULL,
  target     TEXT,
  before     JSONB,
  after      JSONB,
  ip         INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_aa_admin_admin_time ON admin_audit(admin_id, created_at DESC);
CREATE INDEX idx_aa_admin_action_time ON admin_audit(action, created_at DESC);

-- 超管审计 append-only:不允许 UPDATE / DELETE
CREATE RULE aa_admin_no_update AS ON UPDATE TO admin_audit DO INSTEAD NOTHING;
CREATE RULE aa_admin_no_delete AS ON DELETE TO admin_audit DO INSTEAD NOTHING;

CREATE TABLE rate_limit_events (
  id         BIGSERIAL PRIMARY KEY,
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  blocked    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rle_time ON rate_limit_events(created_at);
CREATE INDEX idx_rle_scope_time ON rate_limit_events(scope, created_at DESC);
