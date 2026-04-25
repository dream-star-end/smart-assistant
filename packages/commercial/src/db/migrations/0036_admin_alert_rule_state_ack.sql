-- M8.3 / P2-21 — 给 polled rule state 加 ack 三态.
--
-- 有了 acked 字段后, UI 可以从 (firing, acked) 推 status:
--   firing=true,  acked=false → 'open'      (UI 红, 需要处理)
--   firing=true,  acked=true  → 'acked'     (UI 黄, 已确认在处理中)
--   firing=false              → 'resolved'  (UI 绿/隐藏)
--
-- 不持久化 'resolved' 历史 — 这张表设计就是 latest snapshot, 历史看 outbox.
--
-- transitionRuleState 在 firing 翻转时(任意方向)会 reset acked = FALSE,
-- 保证新一轮告警不会继承上次 ack(以及 resolved 状态下 ack 字段没意义).

ALTER TABLE admin_alert_rule_state
  ADD COLUMN acked     BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN acked_at  TIMESTAMPTZ,
  ADD COLUMN acked_by  BIGINT;     -- admin user id, 不加 FK (保留删账号不挂)
