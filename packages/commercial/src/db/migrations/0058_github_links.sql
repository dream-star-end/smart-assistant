-- GitHub OAuth links: 用户 ↔ GitHub 账号关联,access_token 加密存储 (AES-256-GCM)
-- 每个 OpenClaude 用户最多关联一个 GitHub 账号;每个 GitHub 账号也只能被一个 OpenClaude 用户关联
CREATE TABLE github_links (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_user_id BIGINT NOT NULL,
  login TEXT NOT NULL,
  avatar_url TEXT,
  access_token_enc BYTEA NOT NULL,
  access_token_nonce BYTEA NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',  -- 空格分隔
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  token_last_checked_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT github_links_login_chk CHECK (length(login) BETWEEN 1 AND 100),
  CONSTRAINT github_links_nonce_chk CHECK (octet_length(access_token_nonce) = 12),
  CONSTRAINT github_links_enc_chk CHECK (octet_length(access_token_enc) >= 16)
);
CREATE UNIQUE INDEX github_links_github_user_id_unique
  ON github_links(github_user_id)
  WHERE revoked_at IS NULL;
COMMENT ON TABLE github_links IS 'GitHub OAuth account links — access_token encrypted via crypto/aead.ts using OPENCLAUDE_KMS_KEY';
