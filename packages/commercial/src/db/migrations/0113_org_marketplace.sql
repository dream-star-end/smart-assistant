-- 0113_org_marketplace.sql
-- 企业版(P3.1)批次 C — org 维度共享技能(marketplace 单机制扩 org)。
-- 依赖:0087(marketplace_skill_listings / _versions / _installs)、0111(orgs)。
--
-- 方案权威源:docs/plans/v5-enterprise-edition-2026-07-06.md §1.5 §2(0113)§4。
--
-- 变更:
--   1) marketplace_skill_listings 加 org_id —— listing 可见范围。
--        NULL     = 公开(任何用户可见/可装,现网既有语义,零回填)。
--        非空     = 仅该 org 成员可见/可装(可见性谓词 org_id IS NULL OR org_id = caller_org
--                   收口在 marketplaceDb 单函数,防泄露 oracle)。
--      ON DELETE RESTRICT:org 尚有私有 listing 时禁止硬删 org(先处置 listing),避免
--        悬垂 org_id 导致"谁都看不见但占着 slug"。orgs 走 status='deleted' 软删,本约束
--        是结构防线(与 0114 invoice、0111 memberships CASCADE 的取舍一致:财务/可见性
--        凭证 RESTRICT,纯关联行 CASCADE)。
--   2) org_installs —— org 维度已装技能(admin 装一次 → sync 下发全 org 成员容器)。
--      结构镜像 marketplace_installs(0087:53-67 + 0102 agent_ids),把 user_id 换成 org_id:
--      pin(version_id, artifact_hash)快照语义、agent_ids 归属、软删(uninstalled_at)全搬过来。
--      每 org 每 slug 至多一条活跃安装(partial unique),卸载后可重装。
--
-- 幂等性:由 migrate.ts 的 schema_migrations 表保证。惯例(方案 §2:additive 才 IF NOT EXISTS):
--   - ADD COLUMN 是对现存表的 additive 变更 → IF NOT EXISTS(同 0102 对 marketplace_installs)。
--   - 全新表 / 全新索引 → 裸 DDL(破坏 DDL 早暴露,同 0111 惯例)。
--
-- 引用新列 org_id 的 index 放 ALTER 之后(先有列再建索引)。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0112 惯例)。
-- 全部为 ALTER / CREATE,migration runner 在事务内执行,新增列/表/索引无锁竞争。

-- ─── 1) listing org 可见范围 ─────────────────────────────────────────
ALTER TABLE marketplace_skill_listings
  ADD COLUMN IF NOT EXISTS org_id BIGINT REFERENCES orgs(id) ON DELETE RESTRICT;

-- ─── 2) org_installs(镜像 marketplace_installs,user_id → org_id)──────
CREATE TABLE org_installs (
  id             BIGSERIAL   PRIMARY KEY,
  org_id         BIGINT      NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  slug           TEXT        NOT NULL,
  version_id     BIGINT      NOT NULL REFERENCES marketplace_skill_versions(id),  -- pin(同 marketplace_installs 引用方式)
  artifact_hash  TEXT        NOT NULL,                                            -- 安装时快照,防版本漂移
  agent_ids      JSONB       NOT NULL DEFAULT '["main"]'::jsonb,                  -- 归属哪些 agent(与个人 install 同语义)
  installed_by   BIGINT      NOT NULL,                                            -- 执行安装的 org admin(审计;同 0087 无 FK)
  installed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uninstalled_at TIMESTAMPTZ,                                                     -- 软删;NULL = 活跃
  CONSTRAINT ck_org_installs_agent_ids_nonempty
    CHECK (jsonb_typeof(agent_ids) = 'array' AND jsonb_array_length(agent_ids) > 0)
);

-- 每 org 每 slug 至多一条活跃安装(卸载后重装合法),对齐 uq_marketplace_active_install。
CREATE UNIQUE INDEX uq_org_installs_active
  ON org_installs (org_id, slug) WHERE uninstalled_at IS NULL;

-- sync 并入按 org 拉活跃 org_installs
CREATE INDEX idx_org_installs_org_active
  ON org_installs (org_id) WHERE uninstalled_at IS NULL;

-- ─── 引用新列 org_id 的 index(放 ALTER 之后)────────────────────────
-- org 可见目录枚举(公开 ∪ 本 org 私有):只索引私有 listing,公开走既有全表扫描路径。
CREATE INDEX idx_mkt_listings_org
  ON marketplace_skill_listings (org_id) WHERE org_id IS NOT NULL;

COMMENT ON COLUMN marketplace_skill_listings.org_id IS
  'v5 企业版:listing 可见范围。NULL=公开;非空=仅该 org 成员可见/可装(可见性谓词收口在 marketplaceDb)。';
COMMENT ON TABLE org_installs IS
  'v5 企业版(P3.1)org 维度已装技能。镜像 marketplace_installs(pin version+hash / agent_ids / 软删),user_id→org_id;sync 并入成员容器(个人 install 同 slug 优先)。';
