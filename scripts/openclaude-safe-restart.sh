#!/usr/bin/env bash
# openclaude-safe-restart v2 — 个人版 gateway 重启的唯一安全入口。
#
# v1 只挡"非 boss 用户近 5 分钟活跃",boss 自己的开发会话不设防 → 07-15/16/17 三天
# 三次重启把 boss 的全部活跃会话(codex webchat turn + CC 终端)一锅端(07-18 审计)。
# v2 新增:
#   ① 静默排水门:重启前轮询 /api/dev-status,等 in-flight turn 清零 + CC 终端
#      120s 无输出;超时(默认 900s)仍忙 → 拒绝重启(OPENCLAUDE_SAFE_FORCE=1/--force 跳过)。
#      端点不可用(旧代码未部署/服务已挂)→ 告警后跳过该门(fail-open:服务挂着才更要能重启)。
#   ② --detach:经 systemd-run transient unit 自托管执行 —— 寄宿在 gateway 里的
#      会话(CC 终端/运维会话)严禁内联重启宿主(2026-07-16 自杀式循环重启事故),
#      必须用本 flag。调用方调度后应立即停止输出,让排水门能收敛。
#   ③ 重启后 /healthz smoke(v1 只等端口)。
#
# 用法: openclaude-safe-restart [--detach] [--force] [--drain-timeout <sec>]
set -euo pipefail

SERVICE=${OPENCLAUDE_PROD_SERVICE:-openclaude.service}
PROD_HOME=${OPENCLAUDE_PROD_HOME:-/root/.openclaude}
PROD_PORT=${OPENCLAUDE_PROD_PORT:-18789}
ACTIVE_WINDOW_SECONDS=${OPENCLAUDE_SAFE_ACTIVE_WINDOW_SECONDS:-300}
ALLOWED_USER=${OPENCLAUDE_SAFE_ALLOWED_USER:-boss}
DRAIN_TIMEOUT=${OPENCLAUDE_SAFE_DRAIN_TIMEOUT:-900}
DRAIN_POLL=${OPENCLAUDE_SAFE_DRAIN_POLL:-10}
TERMINAL_QUIET_MS=${OPENCLAUDE_SAFE_TERMINAL_QUIET_MS:-120000}
FORCE=${OPENCLAUDE_SAFE_FORCE:-0}
DETACH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --detach) DETACH=1; shift ;;
    --force) FORCE=1; shift ;;
    --drain-timeout) DRAIN_TIMEOUT="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ "$DETACH" = 1 ]; then
  unit="oc-safe-restart-$(date +%s)"
  echo "detaching restart into transient unit $unit (journalctl -u $unit 查看结果)"
  exec systemd-run --unit="$unit" --collect \
    --property=Type=oneshot --property=RemainAfterExit=yes \
    --setenv=OPENCLAUDE_SAFE_FORCE="$FORCE" \
    --setenv=OPENCLAUDE_SAFE_DRAIN_TIMEOUT="$DRAIN_TIMEOUT" \
    "$(readlink -f "$0")"
fi

# ── 门① 非 boss 用户活跃(v1 原样保留)─────────────────────────────
if [[ -f "$PROD_HOME/sessions.db" ]] && command -v sqlite3 >/dev/null 2>&1; then
  count=$(sqlite3 "$PROD_HOME/sessions.db" "select count(*) from client_sessions where user_id <> '$ALLOWED_USER' and last_at > (strftime('%s','now')-$ACTIVE_WINDOW_SECONDS)*1000 and deleted_at is null;" 2>/dev/null || echo 0)
  if [[ "$count" != "0" ]]; then
    echo "refusing restart: $count non-$ALLOWED_USER client session(s) active in last ${ACTIVE_WINDOW_SECONDS}s" >&2
    exit 1
  fi
fi

# ── 门② 静默排水:in-flight turn + CC 终端活跃度 ──────────────────
# 输出: "<inFlightTurns> <activeTerminals>";端点不可用输出 "unavailable"。
probe_busy() {
  python3 - "$PROD_HOME/openclaude.json" "$PROD_PORT" "$TERMINAL_QUIET_MS" <<'PY' 2>/dev/null || echo unavailable
import base64, hashlib, hmac, json, sys, time, urllib.request
cfg_path, port, quiet_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    secret = json.load(open(cfg_path))["gateway"]["accessToken"].encode()
except Exception:
    print("unavailable"); raise SystemExit
b64 = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
h = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
p = b64(json.dumps({"userId": "boss", "exp": int(time.time()) + 120}, separators=(",", ":")).encode())
tok = f"{h}.{p}." + b64(hmac.new(secret, f"{h}.{p}".encode(), hashlib.sha256).digest())
req = urllib.request.Request(f"http://127.0.0.1:{port}/api/dev-status",
                             headers={"Authorization": f"Bearer {tok}"})
try:
    # 本机直连,显式绕代理(shell 里常有 ALL_PROXY)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    d = json.load(opener.open(req, timeout=5))
except Exception:
    print("unavailable"); raise SystemExit
now = d.get("now") or int(time.time() * 1000)
turns = int(d.get("inFlightTurns") or 0)
terms = sum(1 for t in d.get("terminals") or []
            if t.get("lastOutputAt") and now - t["lastOutputAt"] < quiet_ms)
print(turns, terms)
PY
}

if [ "$FORCE" = 1 ]; then
  echo "FORCE=1 — skipping quiesce drain gate"
else
  deadline=$(( $(date +%s) + DRAIN_TIMEOUT ))
  gate_state=waiting
  while :; do
    busy="$(probe_busy)"
    if [ "$busy" = unavailable ]; then
      echo "quiesce gate: /api/dev-status unavailable (旧代码或服务不健康) — skipping drain gate" >&2
      gate_state=skipped; break
    fi
    turns=${busy% *}; terms=${busy#* }
    if [ "$turns" = 0 ] && [ "$terms" = 0 ]; then
      gate_state=quiesced; break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "refusing restart: still busy after ${DRAIN_TIMEOUT}s drain (inFlightTurns=$turns activeTerminals=$terms)." >&2
      echo "等待自然收敛后重试,或确认可打断后 --force。" >&2
      exit 3
    fi
    echo "draining: inFlightTurns=$turns activeTerminals=$terms (deadline -$((deadline - $(date +%s)))s)"
    sleep "$DRAIN_POLL"
  done
  echo "quiesce gate: $gate_state"
fi

if command -v openclaude-dev-stop >/dev/null 2>&1; then
  openclaude-dev-stop || true
fi

before=$(systemctl show "$SERVICE" -p ActiveEnterTimestamp --value 2>/dev/null || true)
echo "restarting $SERVICE (previous ActiveEnterTimestamp: ${before:-unknown})"
systemctl restart "$SERVICE"

for _ in {1..60}; do
  if systemctl is-active --quiet "$SERVICE"; then
    if ! command -v ss >/dev/null 2>&1 || ss -ltn "sport = :$PROD_PORT" | grep -q ":$PROD_PORT"; then
      code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$PROD_PORT/healthz" 2>/dev/null || echo 000)
      if [ "$code" = 200 ]; then
        after=$(systemctl show "$SERVICE" -p ActiveEnterTimestamp --value 2>/dev/null || true)
        echo "$SERVICE active + healthz 200 (ActiveEnterTimestamp: ${after:-unknown})"
        exit 0
      fi
    fi
  fi
  sleep 0.5
done

echo "restart failed / port $PROD_PORT not listening / healthz not 200; service status:" >&2
systemctl status "$SERVICE" --no-pager -l >&2 || true
exit 1
