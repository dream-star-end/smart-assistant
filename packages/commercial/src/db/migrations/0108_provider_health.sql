-- 0108_provider_health.sql
-- provider 健康度自动探测与降级(roadmap P3.2)。两件事:
--
-- 1) provider_health_samples(**新表**,egress 进程在流 settle/finalizer 处直写)——
--    per-request 健康信号:失败(partial/aborted/上游 5xx/超时/config 拒绝)全记,
--    success(final)抽样 1/10 控写放大。这是「可用性」权威信号,与 0105 的
--    provider_latency_samples(transport 延迟语义,不代表可用性)是两套独立数据面。
--    judgement scheduler(master,60s tick)按近 10min 窗评估 → 写 provider_ops
--    健康列。样本近 30min 滚动保留(judgement 只看近 10min,冗余供 admin 观察)。
--
-- 2) provider_ops 加健康列(**降级状态的单一权威**):
--    * health_status  scheduler 观测判定:healthy / degraded(auto 模式才自动改写)。
--    * degraded_since 最近一次转入 degraded 的时刻(healthy 时清 NULL)。
--    * degrade_reason 人读降级理由(如「近 10min 失败率 72%(13/18)」),恢复时清 NULL。
--    * health_mode    生效策略三态:auto(scheduler 自动)/ forced_degraded(admin 强制降级)
--                     / forced_healthy(admin 强制健康,压误判)。DEFAULT 'auto'。
--    生效降级 = (health_mode='forced_degraded') OR (health_mode='auto' AND health_status='degraded');
--    forced_healthy 恒健康。此派生是 /api/models 注解、proxy 503 闸、admin badge 的唯一口径。
--
-- 架构红线(与红线②对齐):健康列 **不触碰** pricing.enabled / visibility —— 降级只做
--    「显式报错 + 可见性标注」,绝不隐式改模型可用性权威,避免与 admin 手工价格/可见性编辑
--    打架。降级动作(503 拦截)默认关,由 env OC_PROVIDER_HEALTH_ENFORCE=1 显式开(影子模式默认)。
--
-- 共享库影响面:provider_ops 是 0105 v5 引入的表(v3 树无此迁移、v3 代码不引用);
--    provider_health_samples 全新表。二者对 v3 均不可见 → additive 迁移对 v3 零影响
--    (同 0107 additive 惯例)。
--
-- 铁律(07-06 sessionsDb 事故 + 0087 建表顺序):引用新列/新表的 index 一律放在建表/ALTER 之后。
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0107 惯例):
--   psql "$DATABASE_URL" -f packages/commercial/src/db/migrations/0108_provider_health.sql
-- ALTER ADD COLUMN(常量 DEFAULT / 无默认)为元数据级操作不重写表;CREATE TABLE / CREATE INDEX
-- 非 CONCURRENTLY(runner 在事务内执行),该表量级(每 provider 恒几千行)秒级完成。

CREATE TABLE provider_health_samples (
  id          BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  ok          BOOLEAN NOT NULL,
  -- 请求最终态。final=完整完成(唯一 ok=true);partial=中途断流;aborted=客户端断开
  -- (记录供诊断,judgement 排除不计入失败率);upstream_5xx=上游 5xx;timeout=上游/首响超时;
  -- reject_config=静态 provider 配置拒绝(缺 key 等,provider 不可用)。
  kind        TEXT NOT NULL
    CHECK (kind IN ('final','partial','aborted','upstream_5xx','timeout','reject_config')),
  model       TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- judgement 窗口扫描:按 provider 取近 N min 样本。索引放建表之后(建列后)。
CREATE INDEX idx_provider_health_provider_at
  ON provider_health_samples (provider_id, at DESC);

ALTER TABLE provider_ops
  ADD COLUMN health_status  TEXT
    CHECK (health_status IN ('healthy','degraded')),
  ADD COLUMN degraded_since TIMESTAMPTZ,
  ADD COLUMN degrade_reason TEXT CHECK (char_length(degrade_reason) <= 500),
  ADD COLUMN health_mode    TEXT NOT NULL DEFAULT 'auto'
    CHECK (health_mode IN ('auto','forced_degraded','forced_healthy'));
