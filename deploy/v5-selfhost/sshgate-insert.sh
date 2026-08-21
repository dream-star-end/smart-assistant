#!/usr/bin/env bash
# 把「容器网段 → 宿主 22 RETURN」插到 V5_EGRESS_IN 链首。
# 链不存在时必须失败(非 0)+清晰错误,禁止静默成功。
set -euo pipefail
if ! iptables -nL V5_EGRESS_IN >/dev/null 2>&1; then
  echo "✗ V5_EGRESS_IN 链不存在。hostnet 未建链,不能插 SSH RETURN。补救: systemctl restart openclaude-v5-selfhost-hostnet.service && systemctl restart openclaude-v5-selfhost-sshgate.service" >&2
  exit 1
fi
iptables -C V5_EGRESS_IN -s 172.31.0.0/16 -d 172.31.0.1 -p tcp --dport 22 -j RETURN 2>/dev/null \
  || iptables -I V5_EGRESS_IN 1 -s 172.31.0.0/16 -d 172.31.0.1 -p tcp --dport 22 -j RETURN
