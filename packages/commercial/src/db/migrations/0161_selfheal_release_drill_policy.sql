-- 0161_selfheal_release_drill_policy — 合成 release 演练 policy(批1b:Tier2 部署闭环回归)
--
-- 目的:Tier2 代码自愈闭环(condition → incident → 派单 → 执行侧 context/report/verify/
-- cutover → pending_release → boss 一键放行 → 真部署 → probe 归因)需要可重复的低峰演练;
-- 没有常驻演练机制的部署链会腐化(见 0155 transport drill 同款理由)。
--
-- 语义(与 selfheal/conditionKeys.ts SELFHEAL_DRILL_RELEASE、个人版 broker release
-- drill 分级白名单 {context,report,verify,cutover} 为同一跨仓契约):
--   * exact `selfheal.drill:release_v1`,常驻 enabled=TRUE;
--   * 常态 auto_repair=FALSE —— 只有演练脚本(scripts/v5-selfheal-drill.ts --release)
--     持 advisory lock 期间临时翻 TRUE,收尾必翻回;
--   * execution_class='tier2'(代码自愈路径,action_opcode 必须 NULL,见 0156 CHECK);
--   * user_notice_enabled 缺省 FALSE(0137 列默认),演练绝不触达用户;
--   * 个人版执行侧对该 conditionKey 的 repair 放行 context/report/verify/cutover,
--     但真部署仍必须 boss 显式放行(演练脚本二段人工确认走真实 admin API)。
--
-- 频率:批1b 验收低峰真跑一次;不做常态高频回归(docs-only commit 仍会推进 canonical、
-- 重启 master、可能构建 runtime release)。
--
-- 幂等:UNIQUE(match_kind, match_key) 上 ON CONFLICT DO NOTHING。

INSERT INTO incident_policies
  (match_kind, match_key, surface, audience, resolve_mode, auto_repair, severity_floor,
   execution_class, user_title, user_message, repair_hint, enabled)
VALUES
  ('exact', 'selfheal.drill:release_v1', 'global', 'all', 'probe', FALSE, 'warning',
   'tier2',
   '自愈部署演练(内部)',
   '这是一次内部自愈部署演练,不影响您的使用。',
   'release drill:按 skill v5-incident-repair 的 release 演练分支执行——append 唯一 repairId/UTC 行到 docs/selfheal/RELEASE_DRILLS.md → commit → verify → cutover → report progress 等待放行(真部署须 boss 一键放行)',
   TRUE)
ON CONFLICT (match_kind, match_key) DO NOTHING;
