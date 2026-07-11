-- 0130_skill_usage_layer — 使用事件区分「技能层」(hub 市场技能 vs user 自建技能)。
--
-- 动机(P3 真实使用驱动进化):
--   0128 的 marketplace_skill_usage_events 只承载 hub(市场上架)技能的使用信号,用于目录
--   聚合(usage30d/users30d + 评分归因)。P3 要把「用户对自建技能的真实差评场景」喂给技能训练
--   —— 这需要容器 skillUsageReporter 也上报 user 层(用户自建目录)的使用事件。两层事件同表,
--   靠 layer 列区分命名空间:
--     * layer='hub'  —— 市场 slug,全局命名空间,进市场聚合信号(usage30d/users30d/rating)。
--     * layer='user' —— 用户自建 slug,**用户私有命名空间**,只服务该用户自己的技能训练素材,
--                       绝不进市场聚合(否则甲用户给自建技能起的 slug 会污染同名市场技能的信号)。
--
-- 正确性红线(marketplaceDb 侧已加 layer='hub' 过滤 + 行为测试锁死):
--   所有市场聚合子查询(catalog/detail 的 usage/users/rating)必须显式 layer='hub',user 层事件
--   不得出现在任何面向市场的口径里。
--
-- 向后兼容:DEFAULT 'hub' —— 旧容器镜像不传 layer 时按 hub 落库(与 0128 语义完全一致),存量行
--   ADD COLUMN 时也回填 'hub'。常量默认值在 PG11+ 是元数据变更,不重写整表。
--
-- CHECK 只允许 ('hub','user'):越界值在 handler 层已整批 400 拦截,DB CHECK 是纵深防御的兜底,
--   与 response_rating.rating CHECK ('up','down') 同惯例。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0129 惯例);migration runner
--   自带 BEGIN/COMMIT + schema_migrations 记账,本文件不写事务控制。

ALTER TABLE marketplace_skill_usage_events
  ADD COLUMN IF NOT EXISTS layer TEXT NOT NULL DEFAULT 'hub';

-- CHECK 单独加(IF NOT EXISTS 幂等由 DO 块保证:ADD CONSTRAINT 无 IF NOT EXISTS 语法)。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_skill_usage_events_layer_check'
  ) THEN
    ALTER TABLE marketplace_skill_usage_events
      ADD CONSTRAINT marketplace_skill_usage_events_layer_check
      CHECK (layer IN ('hub', 'user'));
  END IF;
END $$;

-- 差评引用查询(skill-feedback 端点)专用索引:按 (user_id, slug, layer) 直取某用户某技能某层的
-- 使用事件,再 nested-loop 进 response_rating 做归因。
--   * 为何需要:该端点**天然按用户**(容器身份推导 userId),而既有 idx_mkt_usage_slug_time 以
--     slug 领衔 —— 对一个热门 hub slug 会扫全体用户的事件再过滤 user_id,浪费。以 user_id 领衔
--     直达该用户的事件子集。
--   * 为何 partial WHERE trace_id IS NOT NULL:归因只看有 traceId 的行(无 trace 无法 ⋈
--     response_rating),partial 让索引只覆盖可归因行,体积更小。
--   * 三列均为等值谓词,顺序取 (user_id, slug, layer) 契合「该用户 → 该技能 → 该层」的访问局部性。
CREATE INDEX IF NOT EXISTS idx_mkt_usage_user_slug_layer
  ON marketplace_skill_usage_events (user_id, slug, layer)
  WHERE trace_id IS NOT NULL;

COMMENT ON COLUMN marketplace_skill_usage_events.layer IS
  'Skill namespace layer: hub = marketplace slug (feeds catalog signals); user = user-authored skill dir name (private to the user, drives skill training only, NEVER enters marketplace aggregates).';
