-- compute_hosts.bridge_cidr:master 侧记录的 host bridge 子网,与远端 node-agent.yml 一致。
--
-- 背景:admin 创建 host 时用户输入 bridge_cidr 仅写到远端 yaml,master 自己不留档。
-- nodeScheduler.pickBoundIp 首次落地容器时只能走 fallback 公式(index-based),和实际
-- yaml 值不一致 → 首次 provision 永远 "ip not in bridge cidr"。
--
-- 修:DB 持久化 bridge_cidr,scheduler 优先读 DB。老行保持 nullable;回填由 ops 做。

ALTER TABLE compute_hosts ADD COLUMN bridge_cidr TEXT;
