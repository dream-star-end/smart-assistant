-- 0264_desktop_virtual_container.sql
-- order-dependency: 0263_gpt6_astra_and_luna_public
-- gap 0254-0263 occupied by canonical feat/v5-selfhost; desktop chain renumbered from 0254-0259 at merge
-- P1 桌面虚拟容器底座 A 段:agent_containers 加 runtime_kind / issued_by_host_uuid /
-- session_secret_expires_at / update_required,以及 enrollment / device / audit 表。
--
-- 普通事务(migrate.ts 包 BEGIN/COMMIT)。任一语句失败整单回滚。
-- 编号顺延自 0253;设计稿 v2 §2.2 / §2.4。
--
-- runtime_kind DEFAULT 'docker' 使存量行恒为 docker。CHECK 用 NOT VALID + VALIDATE
-- (同 0091 runtime_channel),不全表长锁。desktop 行不得占用 host_uuid(调度拓扑);
-- issued_by_host_uuid 仅审计。session_secret_expires_at 是 token expiry 的 PG 权威(B-04)。
--
-- desktop_devices 的「每用户一台未吊销设备」用独立 UNIQUE INDEX ... WHERE,禁止表级
-- partial UNIQUE constraint(B-05;PG 不支持 UNIQUE (...) WHERE)。

ALTER TABLE agent_containers
  ADD COLUMN IF NOT EXISTS runtime_kind TEXT NOT NULL DEFAULT 'docker';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_containers_runtime_kind_check'
  ) THEN
    ALTER TABLE agent_containers
      ADD CONSTRAINT agent_containers_runtime_kind_check
      CHECK (runtime_kind IN ('docker', 'desktop')) NOT VALID;
  END IF;
END $$;

ALTER TABLE agent_containers VALIDATE CONSTRAINT agent_containers_runtime_kind_check;

ALTER TABLE agent_containers
  ADD COLUMN IF NOT EXISTS issued_by_host_uuid UUID REFERENCES compute_hosts(id) ON DELETE SET NULL;

ALTER TABLE agent_containers
  ADD COLUMN IF NOT EXISTS session_secret_expires_at TIMESTAMPTZ;

ALTER TABLE agent_containers
  ADD COLUMN IF NOT EXISTS update_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS desktop_enrollments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             TEXT NOT NULL,
  public_name        TEXT NOT NULL DEFAULT '',
  platform           TEXT NOT NULL CHECK (platform IN ('windows', 'sim')),
  pkce_challenge     TEXT NOT NULL,
  code_hash          BYTEA,
  user_id            BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  container_id       BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  device_id          UUID,
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_ip          INET,
  user_agent         TEXT,
  CONSTRAINT desktop_enrollments_app_id_chk CHECK (app_id = 'chat.claudeai.clarvy')
);

CREATE INDEX IF NOT EXISTS idx_desktop_enrollments_expiry
  ON desktop_enrollments (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS desktop_devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  container_id      BIGINT NOT NULL REFERENCES agent_containers(id) ON DELETE RESTRICT,
  enrollment_id     UUID REFERENCES desktop_enrollments(id) ON DELETE SET NULL,
  credential_hash   BYTEA NOT NULL,
  CONSTRAINT desktop_devices_credential_hash_len CHECK (octet_length(credential_hash) = 32),
  public_name       TEXT NOT NULL DEFAULT '',
  platform          TEXT NOT NULL DEFAULT 'windows'
                    CHECK (platform IN ('windows', 'sim')),
  app_id            TEXT NOT NULL DEFAULT 'chat.claudeai.clarvy',
  tls_client_fp     BYTEA NOT NULL,
  CONSTRAINT desktop_devices_tls_fp_len CHECK (octet_length(tls_client_fp) = 32),
  cert_serial       TEXT NOT NULL,
  cert_expires_at   TIMESTAMPTZ NOT NULL,
  last_enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_token_at     TIMESTAMPTZ,
  last_seen_at      TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoke_reason     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- B-05: partial unique 必须是 INDEX 不是 CONSTRAINT
CREATE UNIQUE INDEX IF NOT EXISTS desktop_devices_one_live_per_user
  ON desktop_devices (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_desktop_devices_container ON desktop_devices (container_id);

CREATE TABLE IF NOT EXISTS desktop_device_audit (
  id            BIGSERIAL PRIMARY KEY,
  device_id     UUID REFERENCES desktop_devices(id) ON DELETE SET NULL,
  enrollment_id UUID REFERENCES desktop_enrollments(id) ON DELETE SET NULL,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event         TEXT NOT NULL CHECK (event IN (
                  'enroll_start','enroll_confirm','enroll_finish','enroll_expire',
                  'token_mint','token_refresh','token_revoke','device_revoke',
                  'tunnel_up','tunnel_down','desktop_offline',
                  'token_device_mismatch','update_required','killswitch'
                )),
  container_id  BIGINT REFERENCES agent_containers(id) ON DELETE SET NULL,
  ip            INET,
  user_agent    TEXT,
  extra         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
