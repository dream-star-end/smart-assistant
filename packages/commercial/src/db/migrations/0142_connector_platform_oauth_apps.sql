-- 0139 连接器平台 · 平台自有 OAuth App 凭据(clientProvisioning='platform' 的信任闸)
--
-- 背景:oauth2-auth-code 此前只有 BYOA 一种形态 —— 用户自己去 provider 后台注册 OAuth App、
-- 把 client_id/client_secret 填进表单。对普通用户这是劝退级门槛。平台模式让**平台**注册一次
-- OAuth App,用户点一下就授权。
--
-- 安全模型(为什么"平台模式"不构成提权):
--   ① 平台 client 凭据**只有 admin 显式 provision** 才存在(本表唯一写入口 = admin API);
--      没 provision 的 slug 走 platform 分支必 fail-closed(OAUTH_NOT_CONFIGURED),连
--      catalog 都不展示。admin provisioning 本身就是那道信任闸。
--   ② client_secret **绝不复制进用户连接袋**(connections.secret_enc):platform 模式的袋只有
--      access_token(+可选 refresh_token)。secret 只在本表 + 发往 token origin 的交换请求里存在。
--   ③ 按 slug 一行:凭据与"哪个已审连接器"强绑定;换 secret 只动这一行,不触碰任何用户连接。
--
-- 加密:crypto/aead.ts AES-256-GCM,key=loadKmsKey();
--       **AAD = `platform_oauth:{aad_seed}:{slug}`**(照 oauthPending 的 AAD 范式:aad_seed 每次
--       写入重生成 → 旧密文无法被移植到新行/别的 slug 上)。列形状对齐 0130/0137:
--       nonce=12B、密文 ≥16B(含 GCM tag)、key_version 备将来轮换。
--
-- 注:runner 已把整文件包在 BEGIN…INSERT schema_migrations…COMMIT 里,本文件只写 DDL(0130/0135/0137 惯例)。

CREATE TABLE IF NOT EXISTS connector_platform_oauth_apps (
  -- slug = marketplace listing slug(与 connections.provider 声明式取值同形状,spec/types.ts Slug)。
  slug                TEXT   PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9-]{1,63}$'),
  -- client_id 是公开标识(非凭据):进 authorize URL,故明文存(便于 admin 列表核对)。
  client_id           TEXT   NOT NULL CHECK (length(client_id) BETWEEN 1 AND 256),
  client_secret_enc   BYTEA  NOT NULL CHECK (octet_length(client_secret_enc) >= 16),
  client_secret_nonce BYTEA  NOT NULL CHECK (octet_length(client_secret_nonce) = 12),
  key_version         SMALLINT NOT NULL DEFAULT 1,
  aad_seed            UUID   NOT NULL DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 谁最后改的(admin 用户被删 → 置 NULL,不连坐删凭据行:凭据的存续与操作者账号无关)。
  updated_by          BIGINT REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE connector_platform_oauth_apps IS
  '平台自有 OAuth App 凭据(clientProvisioning=platform);client_secret_enc AEAD 加密(AAD platform_oauth:{aad_seed}:{slug});唯一写入口=admin API;secret 绝不进用户连接袋';
