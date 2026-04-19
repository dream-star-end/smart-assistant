-- 0005_init_agent.sql
-- agent_subscriptions / agent_containers / agent_audit
-- 依赖:0001(users)

CREATE TABLE agent_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan            TEXT NOT NULL CHECK (plan IN ('basic')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','expired','canceled','suspended')),
  start_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_at          TIMESTAMPTZ NOT NULL,
  auto_renew      BOOLEAN NOT NULL DEFAULT FALSE,
  last_renewed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 每用户只能有一个 active 订阅
CREATE UNIQUE INDEX idx_as_one_active_per_user
  ON agent_subscriptions(user_id) WHERE status = 'active';

CREATE INDEX idx_as_end_at ON agent_subscriptions(end_at) WHERE status = 'active';

CREATE TABLE agent_containers (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id  BIGINT NOT NULL REFERENCES agent_subscriptions(id) ON DELETE RESTRICT,
  docker_id        TEXT,
  docker_name      TEXT NOT NULL,
  workspace_volume TEXT NOT NULL,
  home_volume      TEXT NOT NULL,
  image            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'provisioning'
                   CHECK (status IN (
                     'provisioning','running','stopped','removed','error'
                   )),
  last_started_at  TIMESTAMPTZ,
  last_stopped_at  TIMESTAMPTZ,
  volume_gc_at     TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_audit (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id  TEXT NOT NULL,
  tool        TEXT NOT NULL,
  input_meta  JSONB NOT NULL,
  input_hash  TEXT,
  output_hash TEXT,
  duration_ms INTEGER,
  success     BOOLEAN NOT NULL,
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_aa_agent_user_time ON agent_audit(user_id, created_at DESC);
CREATE INDEX idx_aa_agent_tool ON agent_audit(tool, created_at DESC);
