-- 0095_research_config.sql
--
-- v5 科研 Agent 子系统 — 研究平台配置(单一权威)。
-- 设计权威:docs/research-agent/IMPLEMENTATION_PLAN.md §3。
--
-- 单行表 research_config(id=1)。治理"新多源研究栈"的全部配置:
--   - config_json(非密):各源 mailto/email、ncpssd 开关、ingest 引擎选择、
--     litrag embedding/vector 后端、cite 撤稿/strict 域。
--   - secrets(AEAD 加密 blob):s2_api_key / mineru_api_key / mistral_api_key /
--     embed_api_key / qdrant_api_key 等;一个 secret_ct/secret_nonce 存整个 JSON。
--   - config_version:schema 版本(未来迁移用)。
--
-- 注意:这是新研究栈的**单一权威**;DeepXiv 的 literature_deepxiv_config(0069)
-- 是另一个独立上游,保留,不构成权威分裂(方案 §3 / Codex #5)。
--
-- secret 永不进 config_json,永不进 admin_audit 明文(audit 只写元信息)。

CREATE TABLE research_config (
  id            INT    PRIMARY KEY DEFAULT 1,
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  config_version INT   NOT NULL DEFAULT 1,
  -- 非密配置(TypeBox 严格校验后写入)
  config_json   JSONB  NOT NULL DEFAULT '{}'::jsonb,
  -- AEAD(AES-256-GCM)加密的 secrets JSON blob;NULL = 未设任何 secret
  secret_ct     BYTEA,
  secret_nonce  BYTEA,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT,
  CHECK (id = 1)
);

-- seed 单行(同 0069 literature 模式;后续 patch 走 UPDATE ... WHERE id=1)
INSERT INTO research_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 回滚:DROP TABLE research_config;
