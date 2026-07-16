-- 0156_selfheal_execution_routing — Tier1 运维自愈路由(批1a)
--
-- 让 master policy 成为"某类事故怎么修"的单一声明权威(个人版执行侧不得
-- 自行猜测 tier)。新增两列:
--   execution_class = tier1(确定性运维动作,纯机器路径,零 codex 会话)
--                   | tier2(代码修复,起降权 codex 会话,现有流程)
--   action_opcode   = tier1 专用,版本化固定 opcode(个人版 broker exact map
--                     与 kl-mirror forced-command 三层取交集,任一漂移 fail-closed)
--
-- 批1a 只声明路由,**不放开任何真实类的 auto_repair**(仍全 FALSE,零行为
-- 变化);逐类开闸走后续独立迁移(0158+),每类先受控故障注入实证。
--
-- additive 在线:加列带默认值 + 定向 UPDATE,不改现有 reader。

ALTER TABLE incident_policies
  ADD COLUMN IF NOT EXISTS execution_class TEXT NOT NULL DEFAULT 'tier2'
    CHECK (execution_class IN ('tier1','tier2')),
  ADD COLUMN IF NOT EXISTS action_opcode TEXT;

-- tier1 行必须带 opcode;tier2 行必须不带(DB 级不变量,防路由与动作错配)。
ALTER TABLE incident_policies
  DROP CONSTRAINT IF EXISTS incident_policies_tier1_opcode_ck;
ALTER TABLE incident_policies
  ADD CONSTRAINT incident_policies_tier1_opcode_ck CHECK (
    (execution_class = 'tier1' AND action_opcode IS NOT NULL) OR
    (execution_class = 'tier2' AND action_opcode IS NULL)
  );

-- Tier1 路由声明(auto_repair 保持不动 = 仍全 FALSE):
--   egress 服务面(svc/http)→ 重启 egress 进程
--   磁盘水位(disk_root/disk_var,prefix 'ops.monitor:disk')→ 定量清盘
UPDATE incident_policies
   SET execution_class = 'tier1', action_opcode = 'restart-v5-egress-v1', updated_at = NOW()
 WHERE match_kind = 'prefix' AND match_key IN ('ops.monitor:svc_egress', 'ops.monitor:http_egress');

UPDATE incident_policies
   SET execution_class = 'tier1', action_opcode = 'clean-v5-disk-v1', updated_at = NOW()
 WHERE match_kind = 'prefix' AND match_key = 'ops.monitor:disk';
