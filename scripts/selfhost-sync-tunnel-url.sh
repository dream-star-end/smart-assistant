#!/usr/bin/env bash
# 把当前 quick tunnel 域名同步进 COMMERCIAL_BASE_URL 并按需重启 master。
#
# quick tunnel 每次重启换一个 trycloudflare.com 域名,而组织邀请链接和密码重置
# 链接都拼在 COMMERCIAL_BASE_URL 上(packages/commercial/src/index.ts)。tunnel
# 重启后跑一次本脚本即可让这两类链接重新指向可达域名。
#
# 用法: selfhost-sync-tunnel-url.sh [--apply]
#        不带 --apply 只打印将要做的改动。
set -euo pipefail

ENV_FILE=/etc/openclaude/commercial-v5-selfhost.env
LOG_FILE="${LOG_FILE:-/var/log/cloudflared-v5-selfhost.log}"
UNIT=openclaude-v5-selfhost.service
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

TUNNEL_UNIT=cloudflared-v5-selfhost.service
systemctl is-active --quiet "$TUNNEL_UNIT" ||
  { echo "✗ $TUNNEL_UNIT 未运行" >&2; exit 1; }

# 日志是 append-only,上一次启动的旧域名还留在里面,而 cloudflared 进入 active 到
# 打印新域名之间有几秒窗口,只 tail -1 会抓到已失效的旧域名。日志时间戳只到秒,
# 单纯比时间在"旧域名与本次启动同秒"时仍会取错,所以改为锚定 cloudflared 自己打的
# 会话起始行:取本次启动之后最后一次 "Requesting new quick Tunnel",只认它之后的域名。
STARTED=$(date -d "$(systemctl show "$TUNNEL_UNIT" --value -p ExecMainStartTimestamp)" +%s)
REQUEST_MARK='Requesting new quick Tunnel'

url_this_session() {
  local line lineno ts anchor=0
  while IFS= read -r line; do
    lineno="${line%%:*}"
    ts=$(date -d "$(printf '%s' "${line#*:}" | cut -d' ' -f1)" +%s 2>/dev/null) || continue
    [[ "$ts" -ge "$STARTED" ]] && anchor="$lineno"
  done < <(grep -n -F "$REQUEST_MARK" "$LOG_FILE")
  [[ "$anchor" -gt 0 ]] || return 0
  tail -n "+$anchor" "$LOG_FILE" |
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1
}

url=""
for _ in $(seq 1 30); do
  url=$(url_this_session)
  [[ -n "$url" ]] && break
  sleep 2
done
[[ -n "$url" ]] || {
  echo "✗ 本次启动($(date -d "@$STARTED" '+%F %T'))后 60s 内没在 $LOG_FILE 抓到域名" >&2
  exit 1
}

current=$(grep -E '^COMMERCIAL_BASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
echo "tunnel  = $url"
echo "env     = ${current:-<未配置>}"

if [[ "$current" == "$url" ]]; then
  echo "✓ 已一致,无需改动"
  exit 0
fi

if [[ "$APPLY" != 1 ]]; then
  echo "dry-run: 未写盘。确认后加 --apply(会重启 $UNIT,进行中的会话会断)。"
  exit 0
fi

if [[ -n "$current" ]]; then
  sed -i "s#^COMMERCIAL_BASE_URL=.*#COMMERCIAL_BASE_URL=${url}#" "$ENV_FILE"
else
  printf 'COMMERCIAL_BASE_URL=%s\n' "$url" >> "$ENV_FILE"
fi
echo "✓ 已写入 $ENV_FILE"

systemctl restart "$UNIT"
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:18790/healthz || true)
  [[ "$code" == 200 ]] && { echo "✓ master 已恢复 (healthz 200)"; exit 0; }
  sleep 2
done
echo "✗ master 重启后 healthz 未在 120s 内返回 200" >&2
exit 1
