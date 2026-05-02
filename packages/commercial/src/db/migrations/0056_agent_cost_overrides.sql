-- 0056_agent_cost_overrides.sql
-- PR2 v1.0.65 — codex agent 真扣费的 per-agent 倍率覆盖表。
--
-- 与 model_pricing.multiplier 的关系:
--   每次扣费 cost = Σ tokens × per_mtok × (model_multiplier × agent_cost_multiplier)
--   即在 model 多倍率之上再乘一个 agent 维度倍率。
--
-- 用途:
--   codex-native 的 agent (e.g. 'codex' / 未来 'codex-gpt6') 复用 opus-4.7 的
--   model_pricing 行,但需要相对 anthropic 调价(例如 codex 上游成本结构不同,
--   倍率 1.5 表示比 opus-4.7 贵 50%;0.5 表示打 5 折)。
--
-- 精度选择:NUMERIC(8,3) 而非 (8,4):
--   commercial/src/billing/calculator.ts:64 multiplierToScaled 实现是 3 位小数
--   scale (×1000),(8,4) 的第 4 位会被截断丢失。NUMERIC(8,3) 严格对齐实现,
--   杜绝精度漂移。CHECK 下限 0.001 = 千分之一,精度边界。
--
-- 缺省语义:不在表里 → cost_multiplier = 1.0(无 agent 倍率,等同纯 model 倍率)。
--   `commercial/src/billing/agentMultiplier.ts:getAgentCostMultiplier` 实现 fallback。
--
-- admin 改价方式:直接 SQL UPDATE,记得显式写 updated_at = now()。
--   60s TTL cache 后生效(和 PricingCache 的 NOTIFY-driven 不同 — 此表改价频率极低
--   不值得加 LISTEN/NOTIFY 复杂度)。

CREATE TABLE agent_cost_overrides (
  agent_id        TEXT PRIMARY KEY,
  cost_multiplier NUMERIC(8,3) NOT NULL DEFAULT 1.000
    CHECK (cost_multiplier >= 0.001 AND cost_multiplier <= 10.000),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agent_cost_overrides IS
  'Per-agent cost multiplier on top of model_pricing.multiplier. PR2 v1.0.65.';
