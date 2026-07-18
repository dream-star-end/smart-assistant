#!/usr/bin/env bash
# 安装 v5 持续探针 timer(2026-07-18 门禁审计批B)。幂等,可重复执行。
#
#   远端 kl-mirror:openclaude-v5-turn-probe.{service,timer}(30min 矩阵轮转真 turn)
#   本机(部署发起机):openclaude-v5-e2e-probe.{service,timer}(60min 真浏览器旅程)
#
# 用法(远端 unit 安装属生产变更,经 lease 包装与部署/自愈互斥):
#   bash scripts/with-production-mutation-lease.sh -- bash scripts/install-v5-probes.sh
# 卸载:--uninstall(两侧 disable --now + 删 unit)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
UNIT_DIR="$REPO_ROOT/deploy/v5"
KL_HOST="${V5PROBE_KL_HOST:-kl-mirror}"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "── 卸载远端 turn 探针($KL_HOST)──"
  ssh "$KL_HOST" "systemctl disable --now openclaude-v5-turn-probe.timer 2>/dev/null; \
    rm -f /etc/systemd/system/openclaude-v5-turn-probe.{service,timer}; systemctl daemon-reload"
  echo "── 卸载本机 E2E 探针 ──"
  systemctl disable --now openclaude-v5-e2e-probe.timer 2>/dev/null || true
  rm -f /etc/systemd/system/openclaude-v5-e2e-probe.{service,timer}
  systemctl daemon-reload
  echo "✓ 探针已卸载"
  exit 0
fi

for f in openclaude-v5-turn-probe.service openclaude-v5-turn-probe.timer \
         openclaude-v5-e2e-probe.service openclaude-v5-e2e-probe.timer; do
  [[ -f "$UNIT_DIR/$f" ]] || { echo "✗ 缺 unit 文件:$UNIT_DIR/$f" >&2; exit 1; }
done

echo "── 安装远端 turn 探针($KL_HOST)──"
scp -q "$UNIT_DIR/openclaude-v5-turn-probe.service" "$UNIT_DIR/openclaude-v5-turn-probe.timer" \
  "$KL_HOST:/etc/systemd/system/"
ssh "$KL_HOST" "systemctl daemon-reload && systemctl enable --now openclaude-v5-turn-probe.timer \
  && systemctl is-active openclaude-v5-turn-probe.timer"

echo "── 安装本机 E2E 探针 ──"
cp "$UNIT_DIR/openclaude-v5-e2e-probe.service" "$UNIT_DIR/openclaude-v5-e2e-probe.timer" \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now openclaude-v5-e2e-probe.timer
systemctl is-active openclaude-v5-e2e-probe.timer

echo "✓ 探针已安装。首轮结果:kl-mirror /var/lib/openclaude-v5/{turn,e2e}-probe.json;"
echo "  告警由 v5-monitor.sh check_turn_probe/check_e2e_probe 消费(2 分钟一轮)。"
