#!/usr/bin/env bash
# v5 线上持续 turn 探针(2026-07-18 门禁审计批B)。运行位置:kl-mirror(systemd timer,
# 由 scripts/install-v5-probes.sh 安装到 /usr/local/lib/openclaude-v5/)。
#
# 背景:canary/E2E 此前只在 deploy 时跑一次,线上持续期唯一的 turn 级监控是
# turn_failures 被动聚合(带阈值:低流量/单模型故障在阈值内静默)——用户仍是首个发现者。
# 本探针每 30 分钟主动跑一格真 turn(矩阵轮转:codex-new → ccb-new → codex-reuse),
# 结果写 /var/lib/openclaude-v5/turn-probe.json,由 v5-monitor.sh check_turn_probe 消费
# (复用既有告警管线:去重/6h 重提/恢复通知;本脚本自身不直接告警 = 不造第二套通道)。
#
# 避让语义(不引入新互斥,复用两个既有信号):
#   · planned-maintenance marker 活跃(deploy 窗口)→ 本轮跳过,写 skipped 结果保鲜度;
#   · production-mutation lock 被持有(deploy/自愈/人工变更)→ 同上。
# 探针失败绝不重试掩蔽(单格三信号判据在 canary 脚本内,冷启动重连也在其内)。
set -euo pipefail

ENV_FILE="${V5PROBE_ENV_FILE:-/etc/openclaude/commercial-v5.env}"
STATE_DIR="/var/lib/openclaude-v5"
RESULT="$STATE_DIR/turn-probe.json"
COUNTER="$STATE_DIR/turn-probe.counter"
MAINTENANCE_FILE="/run/openclaude-v5/planned-maintenance.json"
MUTATION_LOCK="/run/openclaude-v5/production-mutation.lock"
CELLS=(codex-new ccb-new codex-reuse)

mkdir -p -m 700 "$STATE_DIR"

write_result() { # <ok:true|false> <kind> <cell> <detail>
  local tmp="$RESULT.tmp.$$"
  jq -n --argjson ok "$1" --arg kind "$2" --arg cell "$3" --arg detail "$4" \
    --argjson at "$(date +%s)" \
    '{ok:$ok,kind:$kind,cell:$cell,detail:($detail|.[0:400]),at:$at}' >"$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$RESULT"
}

# ── 避让:deploy 维护窗 / 生产变更 lease 持有中 → 跳过(结果保鲜,不误报 stale)。
now="$(date +%s)"
if [[ -f "$MAINTENANCE_FILE" ]] && jq -e --argjson now "$now" \
    '(.deadline|type)=="number" and .deadline >= $now' "$MAINTENANCE_FILE" >/dev/null 2>&1; then
  write_result true skipped none "planned-maintenance 活跃,本轮跳过"
  exit 0
fi
if [[ -e "$MUTATION_LOCK" ]] && ! flock -n -x "$MUTATION_LOCK" true 2>/dev/null; then
  write_result true skipped none "production-mutation lock 持有中,本轮跳过"
  exit 0
fi

# ── 解析 serving slot(与 v5-monitor check_serving_masters 同一推导,单一权威=deploy_state)。
DBURL="$(grep '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
if [[ -z "$DBURL" ]]; then
  write_result false infra none "读不到 DATABASE_URL($ENV_FILE)"
  exit 0
fi
if ! row="$(psql "$DBURL" -X -v ON_ERROR_STOP=1 -tA -F '|' -c \
    "SELECT phase,transition_step,active_slot FROM deploy_state WHERE singleton=true" 2>&1)"; then
  write_result false infra none "deploy_state 查询失败:$(echo "$row" | head -c 200)"
  exit 0
fi
IFS='|' read -r phase step active <<<"$row"
primary="$active"
[[ "$phase" == finalizing && "${step:-0}" -ge 6 ]] && primary="$(psql "$DBURL" -X -tA -c \
  "SELECT COALESCE(candidate_slot,active_slot) FROM deploy_state WHERE singleton=true" 2>/dev/null || echo "$active")"
case "$primary" in
  A) port=18790; src=/opt/openclaude/openclaude-v5 ;;
  B) port=18795; src=/opt/openclaude/openclaude-v5-b ;;
  *) write_result false infra none "非法 active_slot:$primary"; exit 0 ;;
esac
release="$(readlink -f "$src" 2>/dev/null || true)"
if [[ -z "$release" || ! -f "$release/scripts/v5-smoke-turn-canary.mjs" ]]; then
  write_result false infra none "无法解析 slot=$primary 的 release(src=$src)"
  exit 0
fi

# ── 矩阵轮转:每轮一格(成本约束),3 轮覆盖全矩阵(30min 间隔 → 90min 全覆盖)。
idx=0
[[ -f "$COUNTER" ]] && idx="$(cat "$COUNTER" 2>/dev/null | tr -dc '0-9' || echo 0)"
cell="${CELLS[$(( idx % ${#CELLS[@]} ))]}"
echo "$(( (idx + 1) % 1000000 ))" >"$COUNTER"

out=""
if out="$(cd "$release" && V5_BASE="http://127.0.0.1:${port}" V5_CANARY_CELLS="$cell" \
    timeout 300 node scripts/v5-smoke-turn-canary.mjs 2>&1)"; then
  write_result true probe "$cell" "$(echo "$out" | tail -c 300)"
else
  rc=$?
  write_result false probe "$cell" "rc=$rc $(echo "$out" | tail -c 300)"
fi
exit 0
