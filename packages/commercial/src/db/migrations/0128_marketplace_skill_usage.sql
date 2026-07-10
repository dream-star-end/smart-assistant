-- 0128_marketplace_skill_usage — 市场技能「真实使用信号」事件流水(30 天使用次数/人数 + 评分归因)。
--
-- 动机:市场目录此前只有「安装数」这一静态信号,回答不了"哪个真好用"。本表由容器 gateway
--   的 skillUsageReporter 在 hub 技能被 skill_view 时低敏上报(只记 slug/agent/trace,不记内容),
--   master 侧 verifyContainerIdentity 推 userId 后落库。catalog/detail 聚合出:
--     * usage30d = 近 30 天事件数;users30d = 近 30 天 distinct 用户(≈"多少人在用")
--     * rating   = 评分归因(response_rating.trace_id ⋈ 本表 trace_id),样本 <5 服务端返 null
--
-- 幂等/去重:UNIQUE (user_id, event_id) —— event_id 是容器侧铸造的幂等键,重试/重复上报
--   经 INSERT ... ON CONFLICT DO NOTHING 收敛为一条。落库 created_at 以 master NOW() 为准
--   (不信容器时钟;body.at 仅作参考不入库)。
--
-- slug 不加 FK:listing 可被 purge / 尚未上架,事件作为历史信号独立留存(聚合时 JOIN listing
--   过滤当前可见集即可)。user_id 加 FK ON DELETE CASCADE:用户删除则其使用事件随删,不留孤儿
--   (与 response_rating / cron_wake_index 同惯例)。
--
-- 保留策略:暂不清理(上市初期量级可控)。量大后应上「按 (slug, 日) 预聚合的日汇总表 +
--   本明细表滚动裁剪」—— 登记为技术债,偿还触发条件 = 单表行数进入千万级或 30 天聚合出现
--   明显扫描热点。
--
-- v5-only:v3 前端无使用信号面 / 其容器 image 无 skillUsageReporter,永不写入本表;v3/v5 共享库,
--   v3 不读写 → 零影响(与 response_rating 同为跨渠道无关的用户信号表,无"实例认领"语义,故无
--   runtime_channel 列)。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0127 惯例);migration runner 自带
--   BEGIN/COMMIT + schema_migrations 记账,本文件不写事务控制。

CREATE TABLE IF NOT EXISTS marketplace_skill_usage_events (
  id          BIGSERIAL   PRIMARY KEY,
  -- 使用事件归属用户(容器身份推导,绝不信容器传入的 uid);用户删除随删。
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- hub 技能 slug(= ~/.openclaude/hub/skills/ 目录名)。不加 FK:listing 可 purge / 事件可先于上架。
  slug        TEXT        NOT NULL,
  -- 触发使用的 agent id(如 main / office-assistant;容器解析不到时可空)。
  agent_id    TEXT,
  -- 会话键(诊断/交叉分析用;可空)。
  session_key TEXT,
  -- 评分归因键 = master per-turn canonical traceId(与 response_rating.trace_id 同空间)。
  -- 容器拿不到时为空 → 该事件不参与评分归因,但仍计入 usage/users。
  trace_id    TEXT,
  -- 容器侧铸造的幂等键(uuid);(user_id, event_id) 唯一,重复上报 DO NOTHING。
  event_id    TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, event_id)
);

-- 索引在建表后单独建(0119 sessionsDb 事故教训:引用后加列的 index 必须在列存在之后)。
-- 目录聚合主路径:按 slug 取近 30 天窗口计数/去重 → (slug, created_at DESC)。
CREATE INDEX IF NOT EXISTS idx_mkt_usage_slug_time
  ON marketplace_skill_usage_events (slug, created_at DESC);
-- 评分归因 JOIN 路径:response_rating.trace_id ⋈ 本表 trace_id(仅非空行有归因价值)。
CREATE INDEX IF NOT EXISTS idx_mkt_usage_trace
  ON marketplace_skill_usage_events (trace_id) WHERE trace_id IS NOT NULL;

COMMENT ON TABLE marketplace_skill_usage_events IS
  'v5-only marketplace skill usage signal stream (hub skill_view events). Aggregated into usage30d/users30d and rating attribution (join response_rating on trace_id). Idempotent by (user_id, event_id).';
