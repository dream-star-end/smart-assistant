-- 0136 连接器平台 · 声明式绑定(slice③)
--
-- connections 表从"v1 四个手写 provider"升级为"声明式平台的单一绑定表":
--   1. 放开 provider 硬编码白名单 CHECK → slug 形状约束。声明式连接的 provider = listing slug,
--      应用层(bind 服务)校验 slug 指向真实 security_approved listing;v1 的 webdav/imap/notion/
--      feishu 本就是合法 slug,值与语义不变,零回填。
--   2. 加 (user_id, connector_version_id) 活跃索引:声明式执行/列表按 pin 的 version 查。
--
-- 四个 pin 列(connector_version_id / spec_hash / exec_contract_hash / auth_contract_version)在
-- 0135 已 additive 加好(可空,兼容 v1 行);声明式行由应用层保证四列非空,v1 行留空。
--
-- 注:runner 已把整文件包在 BEGIN…INSERT schema_migrations…COMMIT 里,本文件只写 DDL(0130/0135 惯例)。

-- 1. provider 从枚举 CHECK → slug 形状(与 ConnectorSpec.id / listing slug 同形)。
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_provider_check;
ALTER TABLE connections
  ADD CONSTRAINT connections_provider_slug CHECK (provider ~ '^[a-z][a-z0-9-]{1,63}$');

-- 2. 声明式连接活跃查询索引(按用户 + pin 的 connector 版本)。
CREATE INDEX IF NOT EXISTS connections_user_version
  ON connections(user_id, connector_version_id)
  WHERE revoked_at IS NULL AND connector_version_id IS NOT NULL;

COMMENT ON COLUMN connections.provider IS 'v1=硬编码 provider 名;声明式=listing slug(应用层校验指向真实 listing)';
