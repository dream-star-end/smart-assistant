-- 0070 claude_accounts.kind + envelope_version (envv2 Phase 1)
--
-- V3 CC 外接 envv2 plan §1.1(docs/V3_CC_EXTERNAL_ENDPOINT_ENVV2_PLAN_2026-05-21.md)。
-- 把"账号"按用途拆成两个池子,物理隔离平台容器 OAuth 流量与外接 ApiKey 流量,让
-- Anthropic 反风控在 account_uuid 维度看到的流量形态保持单一(boss invariant
-- feedback_one_account_one_human:"同一 ApiKey 装 3 台机器 3 个项目像一个真人")。
--
-- 两列:
--   - kind             分区键:platform / external_api
--   - envelope_version 出站归一化版本:1 (v1 硬编码 prefix) / 2 (v2 normalizer)
--
-- Phase 1 仅添列 + 默认值 + 索引 + scheduler 签名扩展。**handler 不切**,prod 路径
-- 仍按 default kind=platform 走 — 行为完全不变。Phase 1.5(独立 PR)在 boss 手动
--   `UPDATE claude_accounts SET kind='external_api' WHERE id IN (…)`
-- 把外接池填非空后,才把 handler 外接 ApiKey 路径切到 pick({kind:'external_api'})。
-- 这避免 Phase 1 deploy 让外接路径从可用变 503。
--
-- 索引选择:
--   现有 idx_ca_schedulable(0004)是 health_score DESC WHERE status='active' 全局索引,
--   不区分 provider / kind。Phase 1 加 (kind, provider, health_score DESC)
--   WHERE status='active' 覆盖 pick({kind,provider}) 的双键过滤主路径。原索引保留 —
--   provider=claude AND kind=platform 是绝大多数 active 行,新索引顺序键有利于
--   pick({kind=external_api}) 这类小池子查询(plan §1.1)。
--
-- envelope_version CHECK 允许 (1, 2)。Phase 5 Release N+1 收紧到 = 2 单值。

ALTER TABLE claude_accounts
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'platform'
  CHECK (kind IN ('platform', 'external_api'));

ALTER TABLE claude_accounts
  ADD COLUMN envelope_version SMALLINT NOT NULL DEFAULT 1
  CHECK (envelope_version IN (1, 2));

CREATE INDEX idx_ca_kind_provider_schedulable
  ON claude_accounts(kind, provider, health_score DESC)
  WHERE status = 'active';

COMMENT ON COLUMN claude_accounts.kind IS
  'V3 envv2 (0070, 2026-05-21): 账号用途分区。'
  ' platform = 平台容器 OAuth 流量;external_api = 外接 ApiKey 专属 OAuth 流量。'
  ' 物理隔离保证 Anthropic 反风控看到的 account_uuid 维度流量形态一致。'
  ' 默认 platform 与历史行为兼容。';

COMMENT ON COLUMN claude_accounts.envelope_version IS
  'V3 envv2 (0070, 2026-05-21): 出站 envelope 归一化版本号。'
  ' 1 = v1 externalEnvelope.ts 硬编码 prefix(当前 prod);'
  ' 2 = v2 externalEnvelopeV2.ts 模板表 + L0 强锁 + L1/L2 漂移保留(Phase 3+ 引入)。'
  ' Phase 4 灰度切换;Phase 5 Release N+1 收紧 CHECK 到单值 2。';
