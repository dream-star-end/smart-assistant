#!/usr/bin/env bash
# v5 线上持续 E2E 旅程探针(2026-07-18 门禁审计批B)。运行位置:**部署发起机本机**
# (kl-mirror 无浏览器;与 deploy 时的 E2E 门同一形态:本机真 Chromium + ssh 隧道)。
# systemd timer 每 60 分钟一跑(scripts/install-v5-probes.sh 安装)。
#
# 结果经 ssh 写 kl-mirror /var/lib/openclaude-v5/e2e-probe.json,由 v5-monitor.sh
# check_e2e_probe 消费(复用既有告警管线;staleness 也在 monitor 侧裁定——本机宕机/
# timer 失效时探针文件变陈旧,monitor 会告警"探针失联",这是有意的 fail-visible)。
#
# 避让:kl-mirror maintenance marker 活跃 或 本机部署锁被持有 → 跳过并保鲜结果。
# 失败语义:重试一次全新旅程(与 deploy 门同构;确定性回归两跑必双红),双红才记失败。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KL_HOST="${V5PROBE_KL_HOST:-kl-mirror}"
DEPLOY_LOCK="/var/lock/oc-v5-deploy.lock"
REMOTE_RESULT="/var/lib/openclaude-v5/e2e-probe.json"

write_result() { # <ok:true|false> <kind> <detail>
  ssh "$KL_HOST" bash -s -- "$REMOTE_RESULT" "$1" "$2" "$3" <<'REMOTE' || true
set -Eeuo pipefail
f="$1"; ok="$2"; kind="$3"; detail="$4"
mkdir -p -m 700 "$(dirname "$f")"
jq -n --argjson ok "$ok" --arg kind "$kind" --arg detail "$detail" --argjson at "$(date +%s)" \
  '{ok:$ok,kind:$kind,detail:($detail|.[0:400]),at:$at}' >"$f.tmp"
chmod 600 "$f.tmp"; mv -f "$f.tmp" "$f"
REMOTE
}

# ── 避让:远端维护窗 / 本机部署进行中。
if ssh "$KL_HOST" "test -f /run/openclaude-v5/planned-maintenance.json && jq -e --argjson now \$(date +%s) '(.deadline|type)==\"number\" and .deadline >= \$now' /run/openclaude-v5/planned-maintenance.json >/dev/null 2>&1" 2>/dev/null; then
  write_result true skipped "planned-maintenance 活跃,本轮跳过"
  exit 0
fi
if [[ -e "$DEPLOY_LOCK" ]] && ! flock -n -x "$DEPLOY_LOCK" true 2>/dev/null; then
  write_result true skipped "本机部署锁持有中,本轮跳过"
  exit 0
fi

# ── 解析远端 serving 口(单一权威=deploy_state;与 v5-turn-probe.sh 同推导)。
row="$(ssh "$KL_HOST" "set -a; . /etc/openclaude/commercial-v5.env; set +a; psql \"\$DATABASE_URL\" -X -tA -F '|' -c \"SELECT phase,transition_step,active_slot,COALESCE(candidate_slot,'') FROM deploy_state WHERE singleton=true\"" 2>&1)" || {
  write_result false infra "deploy_state 查询失败:$(echo "$row" | head -c 200)"
  exit 0
}
IFS='|' read -r phase step active candidate <<<"$row"
primary="$active"
[[ "$phase" == finalizing && "${step:-0}" -ge 6 && -n "$candidate" ]] && primary="$candidate"
case "$primary" in
  A) port=18790 ;;
  B) port=18795 ;;
  *) write_result false infra "非法 active_slot:$primary"; exit 0 ;;
esac

run_journey() {
  V5_E2E_SSH_HOST="$KL_HOST" V5_E2E_REMOTE_PORT="$port" \
    timeout 240 node "$SCRIPT_DIR/v5-e2e-journey-canary.mjs"
}

out=""
if out="$(run_journey 2>&1)"; then
  write_result true probe "$(echo "$out" | tail -c 300)"
  exit 0
fi
echo "e2e-probe: 首跑失败,重试一次全新旅程" >&2
if out2="$(run_journey 2>&1)"; then
  # 重试通过 = flake:结果记成功但 kind=flaky(monitor 不告警;flake 流水账另有
  # deploy 侧 e2e-journey-flake.json,两个面向不同——这里是"线上现在好不好"。)
  write_result true flaky "首跑失败重试通过:$(echo "$out" | tail -c 200)"
  exit 0
fi
write_result false probe "连续两跑失败:$(echo "$out2" | tail -c 300)"
exit 0
