-- 0163 — managed-browser Plugin 写能力：账号级显式同意开关 + 外部写 dispatch fence。
--
-- 默认关闭；只有接受当前免责声明版本后才能开启。revision 每次开关变化均递增，
-- 使此前创建的确认账本失效。dispatch_fence_required + dispatch_armed_at 是
-- Plugin-only 的外部写边界：
-- connection 行与 ledger 行按固定顺序加锁并写入该时间后，任何不能证明完整成功的
-- 结果都必须终态 unknown，且禁止自动重试。

ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS plugin_write_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS plugin_write_disclaimer_version INTEGER,
  ADD COLUMN IF NOT EXISTS plugin_write_disclaimer_accepted_at TIMESTAMPTZ;

ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_plugin_write_consent;
ALTER TABLE connections
  ADD CONSTRAINT connections_plugin_write_consent CHECK (
    plugin_write_enabled = FALSE
    OR (
      plugin_write_disclaimer_version IS NOT NULL
      AND plugin_write_disclaimer_version > 0
      AND plugin_write_disclaimer_accepted_at IS NOT NULL
    )
  );

ALTER TABLE connector_write_ledger
  ADD COLUMN IF NOT EXISTS dispatch_fence_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dispatch_armed_at TIMESTAMPTZ;

ALTER TABLE connector_write_ledger
  DROP CONSTRAINT IF EXISTS connector_write_ledger_dispatch_fence_shape;
ALTER TABLE connector_write_ledger
  ADD CONSTRAINT connector_write_ledger_dispatch_fence_shape CHECK (
    dispatch_armed_at IS NULL OR dispatch_fence_required = TRUE
  );

COMMENT ON COLUMN connections.plugin_write_enabled IS
  'User-controlled managed-browser Plugin write switch; default OFF and revision-fenced';
COMMENT ON COLUMN connections.plugin_write_disclaimer_version IS
  'Last explicitly accepted server-owned Plugin write disclaimer version';
COMMENT ON COLUMN connections.plugin_write_disclaimer_accepted_at IS
  'Audit timestamp for the last explicit Plugin write disclaimer acceptance';
COMMENT ON COLUMN connector_write_ledger.dispatch_armed_at IS
  'Plugin-only DB-ordered external write boundary; post-arm uncertainty must finalize unknown';
COMMENT ON COLUMN connector_write_ledger.dispatch_fence_required IS
  'TRUE only for Plugin writes that can prove pre-dispatch failure via dispatch_armed_at';
