-- 0043 OAuth identities — 第三方 SSO 一键登录用户与本地 user 的映射表。
--
-- 首发 provider:linuxdo(linux.do Connect)。设计为多 provider 兼容,后续加
-- GitHub/Google 时只需扩 provider CHECK 约束,不改 schema。
--
-- 关键约束:
--   1. (provider, provider_user_id) UNIQUE — 同一 LDC 用户不可绑两个本地账号
--   2. user_id 反向 FK ON DELETE CASCADE — 用户软/硬删除时,identity 一起清掉
--   3. user_id 不 UNIQUE — 单个本地账号未来允许同时绑多个 provider
--      (邮箱 + LDC + GitHub 三登)。当前阶段一个账号最多一个 LDC identity,
--      靠 provider_user_id UNIQUE 兜底。
--
-- 安全:identity 表只是"已 OAuth 验证过的 provider 用户身份"的索引,**不保
-- 留 provider 的 access/refresh token**(我们不需要后续调 LDC API,LDC 只用
-- 一次拿 userinfo)。username/avatar/trust_level 是 UI 展示快照,不作认证依据。

CREATE TABLE oauth_identities (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('linuxdo')),
  provider_user_id  TEXT NOT NULL,
  -- LDC 元数据快照,展示用,LDC 侧改昵称/升级 trust 时由二次登录路径 UPDATE
  username          TEXT,
  trust_level       INT,
  avatar_url        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

-- 反查"某 user 绑了哪些 provider"(将来 settings 页用)
CREATE INDEX idx_oauth_identities_user ON oauth_identities(user_id);
