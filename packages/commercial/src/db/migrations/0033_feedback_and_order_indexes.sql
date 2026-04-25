-- 0033_feedback_and_order_indexes.sql
-- M2 整改:用户反馈入库 + 订单 admin 列表所需索引
-- 依赖:0001(users), 0003(orders), 0025(admin_alert_outbox)

-- ── feedback 表 ───────────────────────────────────────────────────
-- 现状:gateway 把反馈写文件 ~/.openclaude/feedback/fb-*.json,
--       admin 只能 ssh ls。改入 PG 才能在 admin 面板看到。
-- 入 PG 失败时仍然走文件 fallback(P1-2),所以本表是唯一来源,但不是必须来源。

CREATE TABLE feedback (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  category    TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL,
  -- 顶级常用过滤字段(从 body.meta 提升,避免 jsonb -> 索引 cost)
  request_id  TEXT,
  version     TEXT,
  session_id  TEXT,
  user_agent  TEXT,
  -- 长 + 不索引字段塞 meta:last_api_errors、current_route、sw_version 等
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','acked','closed')),
  handled_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  handled_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- admin "未处理反馈" 列表主路径:status='open' 优先看,按 created_at desc 翻页
CREATE INDEX idx_feedback_status_created
  ON feedback(status, created_at DESC, id DESC);

-- admin 默认 "全部反馈" 列表(不带 status 过滤)主路径
CREATE INDEX idx_feedback_created
  ON feedback(created_at DESC, id DESC);

-- 单用户反馈历史(若后续展示):带 id DESC 与游标排序对齐
CREATE INDEX idx_feedback_user_created
  ON feedback(user_id, created_at DESC, id DESC)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE feedback IS
  'User feedback. Written by /api/feedback POST. Fallback to file when PG fails (P1-2 design).';
COMMENT ON COLUMN feedback.meta IS
  'Submission context: { last_api_errors[], current_route, sw_version, ... }. Display via admin UI textContent only.';

-- ── orders 索引补全(P0-3 admin 列表)─────────────────────────────
-- 现状:
--   idx_orders_user(user_id, created_at DESC) — 用户单页 OK
--   idx_orders_status(status, expires_at) WHERE status='pending' — 仅 expire sweep
-- 不满足:admin 全表按 created_at 翻页 / 按 status 过滤翻页。
-- 复合游标 (created_at, id) 排序需要 id DESC tie-break,所以 idx_orders_user
-- 那条没法直接用(没有 id),但 (user_id, created_at, id) 全表只是 admin 用,
-- 单用户视图很少触发,补一个最常用的覆盖即可。

CREATE INDEX idx_orders_created
  ON orders(created_at DESC, id DESC);

CREATE INDEX idx_orders_status_created
  ON orders(status, created_at DESC, id DESC);
