-- 0105_model_ops.sql
-- admin「模型与服务商」统一运维页(2026-07-06)。三件事:
--
-- 1) model_pricing.default_effort —— per-model 默认思考深度(proxy 请求期注入,client 显式
--    output_config.effort 永远优先)。落 model_pricing 列使 0008 的 NOTIFY 触发器 +
--    PricingCache 热加载天然生效,不引入第二套缓存/表(Codex 方案评审确认)。
--    与 system_settings.default_effort(新用户偏好种子)分层:那是用户侧默认,本列是
--    proxy 侧注入;优先级 client 显式 > 本列 > 用户偏好。
--
-- 2) 四个价格列补 CHECK >= 0:0002 初版没有约束;本批 admin PATCH 放开价格列编辑
--    (原"要动走 migration/seed"的安全初衷改由 API 整数分校验 + 本 CHECK + 逐列审计 +
--    if_match_updated_at 乐观并发四重护栏承接,Codex 评审要求)。
--
-- 3) provider_ops(**稀疏表**,只存可编辑运维字段;服务商枚举的单一权威 = protocol
--    STATIC_KEY_PROVIDERS + codex 虚拟条目,GET 时派生左联,首次 PUT 才建行 ——
--    新增 provider 时本页零迁移零种子,不产生第二份 provider 清单)
--    + provider_latency_samples(egress 探测器直写,7 天滚动保留,transport 延迟语义)。

ALTER TABLE model_pricing
  ADD COLUMN default_effort TEXT
  CHECK (default_effort IN ('low','medium','high','xhigh','max'));

ALTER TABLE model_pricing
  ADD CONSTRAINT model_pricing_prices_nonneg CHECK (
    input_per_mtok >= 0 AND output_per_mtok >= 0
    AND cache_read_per_mtok >= 0 AND cache_write_per_mtok >= 0
  );

CREATE TABLE provider_ops (
  provider_id             TEXT PRIMARY KEY,
  display_name            TEXT CHECK (char_length(display_name) <= 128),
  subscription_expires_at TIMESTAMPTZ,
  notes                   TEXT CHECK (char_length(notes) <= 2000),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by              BIGINT REFERENCES users(id)
);

-- 无 FK 到 provider_ops:provider 枚举权威在代码注册表,ops 行稀疏可缺;样本表独立存在。
CREATE TABLE provider_latency_samples (
  id          BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  probed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  latency_ms  INTEGER NOT NULL CHECK (latency_ms >= 0),
  ok          BOOLEAN NOT NULL,
  status_code INTEGER,
  error       TEXT
);

CREATE INDEX idx_provider_latency_provider_time
  ON provider_latency_samples (provider_id, probed_at DESC);
