-- 0121_response_rating.sql
-- v5-only —— 每条 assistant 响应的轻量满意度评分(👍/👎 + 可选快捷标签 + 可选一句话评论)。
--
-- 语义边界(务必与 feedback 表区分):
--   * feedback(0033)= **自由文本问题上报**,description NOT NULL 且 ≥15 字符,是"用户主动
--     提问/报障"的重语义通道,走 admin open→acked→closed 工单流转。
--   * response_rating(本表)= **每条响应的持续体验采样**,评论可空、无最小长度,是"低摩擦
--     信号"用于系统优化(按模型统计好评率、快速捞差评做改进)。两者语义不同,故独立建表,
--     **不复用 / 不扩列 feedback**。
--
-- v5-only:v3 正在下线,其前端无评分 UI,永不写入本表 → 无需 runtime_channel 列
--   (与 feedback 同为跨渠道无关的用户信号表;runtime_channel 只用于 agent_containers /
--    cron_wake_index 这类"实例认领"隔离,本表无认领语义)。v3/v5 共享库,v3 不读写 → 零影响。
--
-- upsert 语义:UNIQUE (user_id, message_id) —— 一个用户对同一条响应只保留一条评分;
--   用户可改 👍↔👎、改标签、补/改评论(handler 走 ON CONFLICT DO UPDATE)。
--
-- 运维注:v5 AUTO_MIGRATE=0,须在受控窗口人工 apply(同 0096-0120 惯例);migration
-- runner 自带 BEGIN/COMMIT + schema_migrations 记账,本文件不写事务控制。

CREATE TABLE IF NOT EXISTS response_rating (
  id          BIGSERIAL   PRIMARY KEY,
  -- 评分归属用户;用户删除则其评分随删(不留孤儿),与 cron_wake_index / research_* 同惯例。
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 前端 activeId(渲染会话键)。可空:极少数无会话上下文的响应仍可评分。
  session_id  TEXT,
  -- 前端 msg.id —— 每条响应的稳定键,upsert 的业务主键之一。
  message_id  TEXT        NOT NULL,
  -- master per-turn canonical traceId(msg.usage.traceId),用于反查全链路日志 / 交叉分析。可空。
  trace_id    TEXT,
  -- 该响应使用的模型 id(如 deepseek-v4-pro / glm-5.2 ...),admin 按模型统计好评率。可空。
  model       TEXT,
  rating      TEXT        NOT NULL CHECK (rating IN ('up','down')),
  -- 可选快捷标签(前端预设 + 自由),后端截断入库;空数组表示只点了 👍/👎 未选标签。
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  -- 可选一句话评论,**无最小长度**(轻量信号,不是问题上报);硬上限由 handler 截断。
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 一个用户对一条响应只有一条评分 —— 支持 upsert(改 👍↔👎 / 改标签 / 改评论)。
  UNIQUE (user_id, message_id)
);

-- admin 按模型统计 up/down 计数与好评率(GROUP BY model, rating 的覆盖索引)。
CREATE INDEX IF NOT EXISTS idx_response_rating_model_rating
  ON response_rating (model, rating);

-- 时间序:近 7d/30d 窗口计数 + 全量 created_at 翻页对齐 (created_at, id) 游标。
CREATE INDEX IF NOT EXISTS idx_response_rating_created
  ON response_rating (created_at DESC, id DESC);

-- "快速捞差评 + 评论做优化"主路径:WHERE rating='down' ORDER BY created_at DESC, id DESC。
-- 部分索引直接服务差评明细列表的过滤 + 排序 + 复合游标(比裸 (rating) 单值索引有用得多:
-- rating='down' 在分区内恒定,真正的排序键是 created_at/id,故索引键取 (created_at, id))。
CREATE INDEX IF NOT EXISTS idx_response_rating_down
  ON response_rating (created_at DESC, id DESC)
  WHERE rating = 'down';

COMMENT ON TABLE response_rating IS
  'v5-only per-response satisfaction sampling (up/down + optional tags/comment). Distinct from feedback(0033) which is free-text issue reports. Upsert keyed by (user_id, message_id).';
COMMENT ON COLUMN response_rating.trace_id IS
  'master per-turn canonical traceId (msg.usage.traceId), for cross-referencing full-chain logs.';
