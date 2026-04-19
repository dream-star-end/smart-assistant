-- 0001 users / auth 初始建表
-- 参见 docs/commercial/03-DATA-MODEL.md §1 §2 §3
--
-- 包含:
--   users                 — 用户主表
--   email_verifications   — 邮箱验证 / 密码重置令牌
--   refresh_tokens        — JWT refresh token
--
-- 幂等性:由 migrate.ts 的 schema_migrations 表保证;SQL 本身不 IF NOT EXISTS,
-- 破坏 DDL 时才能及时暴露 bug(不要用 IF NOT EXISTS 遮掩)。

-- ─── users ────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  role            TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user','admin')),
  credits         BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','banned','deleting','deleted')),
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_status      ON users(status) WHERE status != 'deleted';
CREATE INDEX idx_users_deleted_at  ON users(deleted_at) WHERE deleted_at IS NOT NULL;

-- ─── email_verifications ──────────────────────────────────────────────
CREATE TABLE email_verifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ev_user  ON email_verifications(user_id, purpose);
CREATE INDEX idx_ev_token ON email_verifications(token_hash);

-- ─── refresh_tokens ───────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip         INET,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rt_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
