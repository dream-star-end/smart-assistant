-- 0135 — 连接器平台 P1 切片①:Contract 内核落库(信任产物分列 + 三表版本 pin)。
--
-- 权威:v5-connector-platform-rfc-2026-07-11.md §1.1/§6.1/§10。纯 additive,存量行不受影响
-- (全部 ADD COLUMN 可空 / 带 DEFAULT;仅扩 kind CHECK 白名单)。slice① 不接真实网络,
-- 只承载 compile/sign/verify/状态机所需列;三表 pin 列 slice③④ 才强制。
--
-- 与 §1.1 同事务写的信任产物(securityApprove):exec_contract/exec_contract_hash/
-- compiler_version/security_policy_version/signature/key_id/security_reviewed_by/at。

-- ─── marketplace_skill_versions:生命周期状态机独立列 + 信任产物分列(§1.1/§6.1) ──
-- raw_artifact/artifact_hash(0092)钉死作者提交的 canonical spec(不可变);
-- exec_contract 是服务端编译产物(canonical JSONB)+ hash + 签名,与 raw 分列 ——
-- 审后改 raw 不破坏 exec_contract 的不可变 hash,且 exec_contract 可证服务端签发。
ALTER TABLE marketplace_skill_versions
  ADD COLUMN IF NOT EXISTS security_review_state TEXT NOT NULL DEFAULT 'draft'
    CHECK (security_review_state IN ('draft','security_approved','security_rejected')),
  ADD COLUMN IF NOT EXISTS functional_verify_state TEXT NOT NULL DEFAULT 'unverified'
    CHECK (functional_verify_state IN ('unverified','verified')),
  ADD COLUMN IF NOT EXISTS exec_revoked_at         TIMESTAMPTZ,  -- per-version kill switch
  ADD COLUMN IF NOT EXISTS security_reviewed_by    BIGINT,       -- ≠ author(应用层强制)
  ADD COLUMN IF NOT EXISTS security_reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS security_policy_version INTEGER,      -- 审核时策略版本(升级须重审)
  ADD COLUMN IF NOT EXISTS exec_contract           JSONB,        -- 服务端编译产物(canonical)
  ADD COLUMN IF NOT EXISTS exec_contract_hash      BYTEA,        -- sha256(canonical(exec_contract))
  ADD COLUMN IF NOT EXISTS compiler_version        INTEGER,      -- 编译器语义版本
  ADD COLUMN IF NOT EXISTS signature               BYTEA,        -- HMAC-SHA256(覆盖字段),信任根
  ADD COLUMN IF NOT EXISTS key_id                  TEXT;         -- 签名密钥 id(轮换用)

-- 待安全审的 connector version 快速定位(局部索引,存量 skill/agent 不进)。
CREATE INDEX IF NOT EXISTS idx_mkt_versions_security_draft
  ON marketplace_skill_versions (id) WHERE security_review_state = 'draft';

-- ─── ArtifactKind 白名单扩 'connector'(§6.1:不只 drop provider CHECK) ─────────
-- 0092 的内联列 CHECK 名 = marketplace_skill_listings_kind_check(inline column check 默认命名)。
ALTER TABLE marketplace_skill_listings
  DROP CONSTRAINT IF EXISTS marketplace_skill_listings_kind_check;
ALTER TABLE marketplace_skill_listings
  ADD CONSTRAINT marketplace_skill_listings_kind_check
    CHECK (kind IN ('skill','agent','connector'));

-- ─── 三表版本 pin(§6.1/§10.1:connections/pending/ledger 全 pin) ──────────────
-- 可空,slice③④ 落绑定/回调/写门时才强制并加 FK;此处纯 additive。
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS connector_version_id  BIGINT,
  ADD COLUMN IF NOT EXISTS spec_hash             BYTEA,
  ADD COLUMN IF NOT EXISTS exec_contract_hash    BYTEA,
  ADD COLUMN IF NOT EXISTS auth_contract_version INTEGER;

ALTER TABLE connector_oauth_pending
  ADD COLUMN IF NOT EXISTS connector_version_id  BIGINT,
  ADD COLUMN IF NOT EXISTS spec_hash             BYTEA,
  ADD COLUMN IF NOT EXISTS exec_contract_hash    BYTEA,
  ADD COLUMN IF NOT EXISTS auth_contract_version INTEGER;

ALTER TABLE connector_write_ledger
  ADD COLUMN IF NOT EXISTS connector_version_id  BIGINT,
  ADD COLUMN IF NOT EXISTS spec_hash             BYTEA,
  ADD COLUMN IF NOT EXISTS exec_contract_hash    BYTEA,
  ADD COLUMN IF NOT EXISTS auth_contract_version INTEGER;
