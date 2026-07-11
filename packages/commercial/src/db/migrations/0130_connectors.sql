-- 0130 — 应用连接器(App Connectors)三张表。
-- 设计终稿:openclaude-scratch/v5-connectors-design-2026-07-11.md §2(Codex R4 PASS)。
--
-- 三张表一体:
--   connections               — 用户级第三方绑定(加密凭据 + aad_seed 防跨代密文移植 + revision/generation fencing)
--   connector_oauth_pending   — BYOA OAuth 授权码流的一次性 pending(加密 draft,单事务 consume,过期整行 DELETE 即销毁)
--   connector_write_ledger    — 写操作确认门 + 幂等账本 + 写审计(一表三用;终态销毁 params 密文)
--
-- 加密:crypto/aead.ts AES-256-GCM,key=loadKmsKey();AAD 见各表 store 层。明文 Buffer 用后 zeroBuffer。

-- ─── connections ─────────────────────────────────────────────────────────
CREATE TABLE connections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('webdav','imap','notion','feishu')),
  display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 64),
  account_key TEXT NOT NULL CHECK (length(account_key) BETWEEN 16 AND 128),
  aad_seed UUID NOT NULL DEFAULT gen_random_uuid(),   -- 每次 secret 写入重生成,防跨代密文移植
  secret_enc BYTEA, secret_nonce BYTEA,
  key_version SMALLINT NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,         -- 凭据代数:换账号/重绑/换 client 凭据 +1(日常刷新不动);账本绑定它
  secret_generation BIGINT NOT NULL DEFAULT 1, -- 并发写版本:每次 secret 写入(含日常刷新)+1
  meta JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta)='object'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','error')),
  last_verified_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (length(last_error_code) <= 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT connections_secret_shape CHECK (
    (revoked_at IS NULL AND secret_enc IS NOT NULL AND secret_nonce IS NOT NULL
       AND octet_length(secret_nonce)=12 AND octet_length(secret_enc)>=16)
    OR
    (revoked_at IS NOT NULL AND secret_enc IS NULL AND secret_nonce IS NULL)
  )
);
CREATE UNIQUE INDEX connections_user_provider_account
  ON connections(user_id, provider, account_key) WHERE revoked_at IS NULL;
CREATE INDEX connections_user_active ON connections(user_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE connections IS 'App connector bindings — secret_enc encrypted via crypto/aead.ts (AAD conn:{aad_seed}:{user_id}:{provider}) using OPENCLAUDE_KMS_KEY';

-- ─── connector_oauth_pending ─────────────────────────────────────────────
CREATE TABLE connector_oauth_pending (
  state_hash BYTEA PRIMARY KEY CHECK (octet_length(state_hash)=32),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('feishu')),
  cookie_nonce_hash BYTEA NOT NULL CHECK (octet_length(cookie_nonce_hash)=32),
  draft_enc BYTEA, draft_nonce BYTEA,
  key_version SMALLINT NOT NULL DEFAULT 1,
  aad_seed UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,             -- 10min
  consumed_at TIMESTAMPTZ,
  CONSTRAINT cop_user_provider UNIQUE (user_id, provider),
  CONSTRAINT cop_draft_shape CHECK (
    (consumed_at IS NULL AND draft_enc IS NOT NULL AND draft_nonce IS NOT NULL
       AND octet_length(draft_enc)>=16 AND octet_length(draft_nonce)=12)
    OR (consumed_at IS NOT NULL AND draft_enc IS NULL AND draft_nonce IS NULL)
  )
);
COMMENT ON TABLE connector_oauth_pending IS 'BYOA OAuth pending — draft_enc encrypted (AAD oauth:{state_hash_hex}:{user_id}:{provider}:{aad_seed}); expired unconsumed row DELETEd by sweeper (destroys ciphertext)';

-- ─── connector_write_ledger(确认门 + 幂等账本 + 写审计) ────────────────────
CREATE TABLE connector_write_ledger (
  id UUID PRIMARY KEY,                          -- 应用侧预生成(即确认码)
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id BIGINT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  connection_revision INTEGER NOT NULL,
  provider TEXT NOT NULL, action TEXT NOT NULL,
  params_enc BYTEA, params_nonce BYTEA,
  params_key_version SMALLINT NOT NULL DEFAULT 1,
  params_aad_seed UUID NOT NULL DEFAULT gen_random_uuid(),
  params_hash BYTEA NOT NULL CHECK (octet_length(params_hash)=32),
  canonicalization_version SMALLINT NOT NULL DEFAULT 1,   -- v1=键排序 UTF-8 稳定 stringify
  summary TEXT NOT NULL CHECK (length(summary) <= 2000),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 64),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','executing','succeeded','failed','unknown','expired','denied')),
  error_code TEXT CHECK (length(error_code) <= 64),
  result_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT cwl_params_shape CHECK (
    (status IN ('pending','approved','executing') AND params_enc IS NOT NULL AND params_nonce IS NOT NULL
       AND octet_length(params_nonce)=12 AND octet_length(params_enc)>=16)
    OR (status IN ('succeeded','failed','unknown','expired','denied') AND params_enc IS NULL AND params_nonce IS NULL)
  )
);
CREATE INDEX cwl_user_recent ON connector_write_ledger(user_id, created_at DESC);
CREATE INDEX cwl_stale_executing ON connector_write_ledger(status, started_at) WHERE status='executing';
COMMENT ON TABLE connector_write_ledger IS 'Connector write confirm gate + idempotency ledger + audit — params_enc encrypted (AAD cwl:{id}:{user_id}:{connection_id}:{params_aad_seed}); destroyed on terminal status';
