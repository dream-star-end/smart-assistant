-- 0111_init_orgs.sql
-- 企业版(P3.1)批次 A — 组织账号骨架:orgs / org_memberships / org_invitations
-- 依赖:0001(users)
--
-- 方案权威源:docs/plans/v5-enterprise-edition-2026-07-06.md §1 §2。
--
-- 建表:
--   orgs             — 组织主表 + 组织钱包(credits,BIGINT cents,对齐 users.credits 语义)
--   org_memberships  — 成员归属(org_role 独立于 users.role 二元 CHECK,不污染平台超管判定面)
--   org_invitations  — 邀请令牌(token_hash 模式,仿 email_verifications)
--
-- 单一权威源纪律(§1.2):
--   - owner 唯一权威 = org_memberships.org_role='owner' + partial UNIQUE(org_id)。
--     orgs 表**不设** owner_user_id,避免双权威;orgs.created_by 仅审计。
--   - 每用户至多一个 active org = partial UNIQUE(user_id) WHERE status='active'(V1 显式简化,
--     让"谁付钱/看谁的报表"无歧义;放开多 org 时删该索引 + 加 payer 选择)。
--
-- 幂等性:由 migrate.ts 的 schema_migrations 表保证;新表 SQL 本身**不** IF NOT EXISTS,
-- 破坏 DDL 时才能及时暴露 bug(同 0001:9-10 惯例)。金额一律 BIGINT;枚举一律 TEXT+CHECK 禁 ENUM。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0110 惯例)。
-- 全部为 CREATE TABLE / CREATE INDEX,migration runner 在事务内执行,新表建索引无锁竞争。

-- ─── orgs ─────────────────────────────────────────────────────────────
CREATE TABLE orgs (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended','deleting','deleted')),
  credits      BIGINT NOT NULL DEFAULT 0,          -- 组织钱包(cents),对齐 users.credits 语义
  max_members  INTEGER NOT NULL DEFAULT 100 CHECK (max_members > 0),
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- 仅审计:创建该 org 的操作者
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orgs_status ON orgs(status) WHERE status != 'deleted';

-- ─── org_memberships ──────────────────────────────────────────────────
CREATE TABLE org_memberships (
  org_id          BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_role        TEXT NOT NULL DEFAULT 'member'
                  CHECK (org_role IN ('owner','admin','member')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended')),
  billing_enabled BOOLEAN NOT NULL DEFAULT TRUE,   -- 该成员是否花 org 钱包(默认宽松,UX 铁律)
  invited_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);

-- owner 单一权威:每 org 至多一行 org_role='owner'
CREATE UNIQUE INDEX uq_org_owner ON org_memberships(org_id) WHERE org_role = 'owner';
-- V1 单 org 简化:每用户至多一行 active 成员归属
CREATE UNIQUE INDEX uq_user_active_org ON org_memberships(user_id) WHERE status = 'active';
-- "我属于哪个 org" 点查(requireOrgRole / handleMe / 邀请接受席位校验)
CREATE INDEX idx_org_memberships_user ON org_memberships(user_id);

-- ─── org_invitations ──────────────────────────────────────────────────
-- token_hash 模式仿 email_verifications:明文 token 只在邀请链接/邮件里出现一次,
-- DB 只存 sha256(token) hex,接受时按 hash 点查。org_role 只允许 admin/member
-- (owner 不可被邀请产生,只能 transfer-owner 转让)。
CREATE TABLE org_invitations (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  org_role    TEXT NOT NULL DEFAULT 'member' CHECK (org_role IN ('admin','member')),
  token_hash  TEXT NOT NULL,
  invited_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 接受邀请按 token_hash 点查(仿 idx_ev_token)
CREATE INDEX idx_org_invitations_token ON org_invitations(token_hash);
-- admin 列表:某 org 的邀请按时间倒序
CREATE INDEX idx_org_invitations_org ON org_invitations(org_id, created_at DESC);
-- 重发前撤销同 org 同 email 的 pending 邀请(lower(email) 大小写不敏感)
CREATE INDEX idx_org_invitations_pending
  ON org_invitations(org_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE orgs IS
  'v5 企业版(P3.1)组织主表。credits=组织钱包(cents);owner 权威在 org_memberships,orgs 不设 owner 列。';
COMMENT ON TABLE org_memberships IS
  'v5 企业版成员归属。org_role 独立于 users.role;owner 唯一 + 每用户单 active org 由 partial unique 保证。';
COMMENT ON TABLE org_invitations IS
  'v5 企业版邀请令牌(token_hash 仿 email_verifications)。接受时校验受邀邮箱==当前账号邮箱 + 席位 + 单 org。';
