#!/usr/bin/env bash
# selfheal-closeout-restart.sh — 恰好一次的个人版收口重启(P8)。
#
# 为什么要这个脚本:承载运维会话的 Claude 终端**寄宿在 openclaude.service 里**,
# 内联 `systemctl restart openclaude` 会杀死会话自己→无完成记录→恢复后复读→
# 自杀式循环重启(2026-07-16 已发生一次)。所以重启必须:
#   ① 由独立 transient systemd unit 承载(systemd-run),不受被重启进程牵连;
#   ② 重启**前**原子写持久 marker=started(带目标 SHA);smoke 通过后写 succeeded;
#   ③ 恢复方看到 started 但无 succeeded → 判"结果不确定",只告警,**绝不自动再重启**。
#
# 用法(调度,不要直接跑):
#   TARGET_SHA=$(git -C /opt/openclaude/openclaude rev-parse HEAD)
#   systemd-run --unit="openclaude-selfheal-closeout-${TARGET_SHA:0:12}" \
#     --property=RemainAfterExit=yes --on-active=30 \
#     /opt/openclaude/openclaude/scripts/selfheal-closeout-restart.sh "$TARGET_SHA"
set -uo pipefail

TARGET_SHA="${1:?usage: selfheal-closeout-restart.sh <target-sha>}"
MARKER_DIR=/var/lib/openclaude-selfheal
MARKER="$MARKER_DIR/closeout-${TARGET_SHA:0:12}.json"
UNIT=openclaude.service
# /healthz 是无鉴权健康端点;/api/doctor 需要鉴权(401),用它做 smoke 会把
# 一次成功的重启误判成 failed(2026-07-16 首次收口重启实际踩到)。
HEALTH_URL=http://127.0.0.1:18789/healthz
BROKER_SOCK=/run/openclaude-selfheal/broker.sock

mkdir -p "$MARKER_DIR"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
write_marker() { # write_marker <phase> [health]
  printf '{"phase":"%s","targetSha":"%s","unit":"%s","health":"%s","at":"%s"}\n' \
    "$1" "$TARGET_SHA" "$UNIT" "${2:-}" "$(now)" > "$MARKER"
}

# At-most-once: a marker already at started/succeeded for THIS sha ⇒ do nothing
# (a re-fire must never restart again — result is decided by inspection).
if [ -f "$MARKER" ]; then
  phase="$(grep -o '"phase":"[a-z]*"' "$MARKER" | cut -d'"' -f4)"
  echo "[closeout] marker exists phase=$phase — refusing to restart again"
  exit 0
fi

# Guard: only restart if the running tree actually is the target SHA (the merge
# landed). Otherwise abort loudly without touching the service.
CUR="$(git -C /opt/openclaude/openclaude rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$CUR" != "$TARGET_SHA" ]; then
  echo "[closeout] HEAD=$CUR != target=$TARGET_SHA — aborting, not restarting" >&2
  exit 2
fi

write_marker started
echo "[closeout] marker=started, restarting $UNIT (target=$TARGET_SHA)"

# safe-restart if present, else plain restart. This DOES kill any hosted
# session on the service — that is expected; the marker survives it.
if command -v openclaude-safe-restart >/dev/null 2>&1; then
  openclaude-safe-restart || true
else
  systemctl restart "$UNIT" || true
fi

# Post-restart smoke: service active + doctor 200 + broker socket + tunnel unit.
ok=1
for _ in $(seq 1 30); do
  sleep 2
  systemctl is-active --quiet "$UNIT" || { ok=0; continue; }
  code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] || { ok=0; continue; }
  [ -S "$BROKER_SOCK" ] || { ok=0; continue; }
  ok=1; break
done
systemctl is-active --quiet openclaude-selfheal-tunnel.service || ok=0

if [ "$ok" = "1" ]; then
  write_marker succeeded "doctor=200 broker=ok tunnel=ok"
  echo "[closeout] marker=succeeded"
else
  write_marker failed "smoke failed — inspect manually"
  echo "[closeout] marker=failed — smoke did not pass" >&2
  exit 1
fi
