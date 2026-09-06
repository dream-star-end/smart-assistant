-- 0273_chatgpt_proxy_credentials.sql
-- order-dependency: 0272_cursor_sonnet5_admin_only
--
-- ChatGPT direct-connect proxy: per-user Basic-auth secret for the master-hosted
-- TLS CONNECT proxy (chained into the subscription egress). One row per user;
-- rotate = UPSERT new hash, revoke = set revoked_at. Plaintext never stored.

CREATE TABLE IF NOT EXISTS chatgpt_proxy_credentials (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_hash   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

COMMENT ON TABLE chatgpt_proxy_credentials IS
  'ChatGPT direct-connect proxy Basic-auth secrets (scrypt hash). Entitlement itself lives in system_settings chatgpt_proxy_enabled / chatgpt_proxy_allowlist.';
