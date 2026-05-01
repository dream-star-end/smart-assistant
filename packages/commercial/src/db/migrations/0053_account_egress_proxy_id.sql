-- 0053_account_egress_proxy_id.sql
-- claude_accounts 加 egress_proxy_id 引用代理池(0052)。
--
-- 与 0010 加的 egress_proxy 文本列共存:
--   - egress_proxy_id IS NOT NULL → 解析时 JOIN egress_proxies 拿池 URL
--   - egress_proxy_id IS NULL     → 回落到 0010 raw 文本列
-- HTTP 层互斥校验:同时提供 id + raw → 400(决策 R)。
--
-- ON DELETE SET NULL:
--   admin 删代理池 entry 时,被绑账号自动 SET NULL;raw `egress_proxy` 文本
--   列保持不变,账号回落到本机出口或 raw 文本(0010 字段语义)。delete 路径
--   force=1 流程审计 log 受影响 account_id 列表。

ALTER TABLE claude_accounts
  ADD COLUMN egress_proxy_id BIGINT REFERENCES egress_proxies(id) ON DELETE SET NULL;

CREATE INDEX idx_ca_egress_proxy_id
  ON claude_accounts(egress_proxy_id)
  WHERE egress_proxy_id IS NOT NULL;

COMMENT ON COLUMN claude_accounts.egress_proxy_id IS
  'V3 egress proxy pool FK (0052). NULL → fall back to egress_proxy raw text column. '
  'Mutually exclusive with egress_proxy at HTTP layer (decision R).';
