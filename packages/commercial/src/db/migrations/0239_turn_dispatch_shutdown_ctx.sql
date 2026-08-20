-- 0239 — dispatch 级停机证据(侧栏状态点 P0-A)。
--
-- visible_head 是 tape 展示头,不能塞 gatewayExitedAt(空头会被当成 VisibleHead 渲染)。
-- 本列只承载「master 进程在 T 退出」证据,不是活着证明:容器回 running/queued/sink_staged
-- 时 reconciler 必须忽略或清掉,不得据此收口。

ALTER TABLE turn_dispatches
  ADD COLUMN IF NOT EXISTS shutdown_ctx jsonb;

COMMENT ON COLUMN turn_dispatches.shutdown_ctx IS
  'Dispatch-level gateway shutdown evidence (gatewayExitedAt/gatewayExitReason). Open rows only; not a liveness proof. Reconciler and boot recovery combine it with live container state.';
