-- 0134 连接器平台 · token 交换缓存(slice⑤ token 引擎)
--
-- token-exchange 连接器:引擎用连接里的交换凭据(client_secret/refresh_token,永不进容器)向
-- token 受众 origin 换取短寿命 access_token。为避免每次调用都重换,缓存加密的 access_token。
--
-- **cache key = (connection_id, node_id) 引擎派生、不可配**(声明层无法指定 cache key,§3.4)。
-- access_token 是凭据 → AEAD 加密(AAD=tokcache:{aad_seed}:{connection_id}:{node_id});连接删除级联清。
-- expires_at 带 skew 判过期,过期即重换。
--
-- 注:runner 已把整文件包在 BEGIN…INSERT schema_migrations…COMMIT 里,本文件只写 DDL(0130/0132 惯例)。

CREATE TABLE IF NOT EXISTS connector_token_cache (
  connection_id BIGINT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  node_id       TEXT   NOT NULL CHECK (length(node_id) BETWEEN 1 AND 64),
  token_enc     BYTEA  NOT NULL CHECK (octet_length(token_enc) >= 16),
  token_nonce   BYTEA  NOT NULL CHECK (octet_length(token_nonce) = 12),
  aad_seed      UUID   NOT NULL DEFAULT gen_random_uuid(),
  expires_at    TIMESTAMPTZ NOT NULL,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, node_id)
);

COMMENT ON TABLE connector_token_cache IS
  '声明式 token-exchange 连接的 access_token 缓存;token_enc AEAD 加密(AAD tokcache:{aad_seed}:{connection_id}:{node_id}),cache key=(connection_id,node_id) 引擎派生';
