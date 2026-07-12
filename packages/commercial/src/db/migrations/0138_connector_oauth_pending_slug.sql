-- 0138 连接器平台 · oauth pending 放开到声明式 slug(oauth2-auth-code 切片 B)
--
-- connector_oauth_pending.provider 原为 v1 硬编码枚举 CHECK (provider IN ('feishu'))。声明式
-- oauth2-auth-code 连接器的 provider = listing slug(与 connections.provider 同语义、同形状),
-- 故照 0136 对 connections.provider 的同款做法放开为 slug 形状约束:
--   - 值域仍受约束(^[a-z][a-z0-9-]{1,63}$),不是无约束 TEXT;
--   - 指向真实 security_approved listing 由应用层保证(oauth/start 经 loadVerifiedContractWithMeta
--     取 meta.slug 作 provider,DB 事实唯一权威);
--   - v1 的 'feishu' 本就是合法 slug,值与语义不变,零回填。
--
-- 注:runner 已把整文件包在 BEGIN…INSERT schema_migrations…COMMIT 里,本文件只写 DDL(0130/0136 惯例)。

ALTER TABLE connector_oauth_pending DROP CONSTRAINT IF EXISTS connector_oauth_pending_provider_check;
ALTER TABLE connector_oauth_pending
  ADD CONSTRAINT cop_provider_slug CHECK (provider ~ '^[a-z][a-z0-9-]{1,63}$');

COMMENT ON COLUMN connector_oauth_pending.provider IS 'v1=硬编码 provider 名(feishu);声明式=listing slug(应用层校验指向真实已审 listing)';
