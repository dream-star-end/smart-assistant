-- 0155_selfheal_drill_policy — 合成 transport 演练 policy(自愈体系一等公民)
--
-- 目的:自愈闭环(condition → incident → 派单 → 执行侧 context/report → done →
-- verifying → 探测收口 source='codex')需要可重复、无生产副作用的回归演练;
-- 没有常驻演练机制的自愈体系会腐化(2026-07 批0:runbook 手写的
-- ops.monitor:synthetic_e2e 不命中任何 policy,按文跑根本不会派单)。
--
-- 语义(与 selfheal/conditionKeys.ts SELFHEAL_DRILL_TRANSPORT、个人版 broker
-- 的 drill 白名单为同一跨仓契约):
--   * exact `selfheal.drill:transport_v1`,常驻 enabled=TRUE;
--   * 常态 auto_repair=FALSE —— 只有演练脚本(scripts/v5-selfheal-drill.ts)
--     持 advisory lock 期间临时翻 TRUE,收尾必翻回;
--   * user_notice_enabled 缺省 FALSE(0137 列默认),演练绝不触达用户;
--   * 个人版执行侧对该 conditionKey 的 repair 只放行 context/report,
--     verify/cutover/Tier1 服务端拒绝 —— drill 天然无部署面。
--
-- 幂等:UNIQUE(match_kind, match_key) 上 ON CONFLICT DO NOTHING。

INSERT INTO incident_policies
  (match_kind, match_key, surface, audience, resolve_mode, auto_repair, severity_floor, user_title, user_message, repair_hint, enabled)
VALUES
  ('exact', 'selfheal.drill:transport_v1', 'global', 'all', 'probe', FALSE, 'warning',
   '自愈演练(内部)',
   '这是一次内部自愈演练,不影响您的使用。',
   'transport drill:按 skill v5-incident-repair 的演练分支执行——report progress 接单 + report done 收尾,不改代码、不 verify、不 cutover',
   TRUE)
ON CONFLICT (match_kind, match_key) DO NOTHING;
