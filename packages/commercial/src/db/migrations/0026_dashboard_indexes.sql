-- 0026 — 超管 dashboard 聚合查询专用索引
--
-- R1 Codex 审查 M6:/api/admin/stats/* 的几条聚合都是"单列 created_at
-- 范围扫 + GROUP BY date_trunc",现有复合索引(如 `(user_id, created_at)`)
-- 不能作为 leading 范围过滤。数据量上来会退化成全表扫。
--
-- 以下索引是"只读 dashboard"专用,写路径影响可忽略(单列索引写入成本很低),
-- 索引大小受控(过滤 partial index / reason 上)。
--
-- 幂等:全部 IF NOT EXISTS。

-- 1) usage_records.created_at —— /api/admin/stats/request-series 按小时聚合
--    窗口过滤: created_at >= NOW() - N hours
--    现有 (user_id, created_at DESC) 不能 leading 范围。
CREATE INDEX IF NOT EXISTS idx_ur_created_at
  ON usage_records (created_at DESC);

-- 2) orders.paid_at 过滤 paid 订单 —— /api/admin/stats/revenue-by-day
--    现有 idx_orders_status 只索引 pending 行。
CREATE INDEX IF NOT EXISTS idx_orders_paid_at
  ON orders (paid_at DESC)
  WHERE status = 'paid' AND paid_at IS NOT NULL;

-- 3) refresh_tokens.created_at —— /api/admin/stats/dau returning_users
--    需要 "created_at > NOW() - window AND revoked_at IS NULL"
CREATE INDEX IF NOT EXISTS idx_rt_created_at
  ON refresh_tokens (created_at DESC)
  WHERE revoked_at IS NULL;

-- 4) agent_subscriptions.created_at —— /api/admin/stats/revenue-by-day
--    subs_agg 分支
CREATE INDEX IF NOT EXISTS idx_as_created_at
  ON agent_subscriptions (created_at DESC);

-- 5) credit_ledger 已有 idx_cl_reason(reason, created_at DESC),
--    paying_users 查询用 reason='topup' AND created_at > NOW() - window AND delta > 0
--    是其 leading prefix,已命中。不新增。

-- 6) admin_alert_outbox.created_at —— /api/admin/stats/alerts-summary
--    events_24h_by_severity 走 "created_at > NOW() - 24h AND status IN (...)"
--    现有 idx_aao_event_time 是 (event_type, created_at),dedupe/dispatch 都是
--    status-partial。新加一个按 created_at 排序的顶层索引,兼顾 severity 统计。
CREATE INDEX IF NOT EXISTS idx_aao_created_at
  ON admin_alert_outbox (created_at DESC);
