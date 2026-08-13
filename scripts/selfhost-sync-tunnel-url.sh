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
LOG_FILE=/var/log/cloudflared-v5-selfhost.log
UNIT=openclaude-v5-selfhost.service
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

TUNNEL_UNIT=cloudflared-v5-selfhost.service
systemctl is-active --quiet "$TUNNEL_UNIT" ||
  { echo "✗ $TUNNEL_UNIT 未运行" >&2; exit 1; }

# 日志是 append-only,上一次启动的旧域名还留在里面。cloudflared 进入 active 到
# 打印新域名之间有几秒窗口,只 tail -1 会抓到已失效的旧域名,所以按本次启动
# 时间过滤,并等到本次启动真的产出域名为止。
started=$(date -d "$(systemctl show "$TUNNEL_UNIT" --value -p ExecMainStartTimestamp)" +%s)

url_since_start() {
  local line ts
  while IFS= read -r line; do
    ts=$(date -d "${line%% *}" +%s 2>/dev/null) || continue
    [[ "$ts" -ge "$started" ]] || continue
    printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com'
  done < <(grep -E 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE") | tail -1
}

url=""
for _ in $(seq 1 30); do
  url=$(url_since_start)
  [[ -n "$url" ]] && break
  sleep 2
done
[[ -n "$url" ]] || {
  echo "✗ 本次启动($(date -d "@$started" '+%F %T'))后 60s 内没在 $LOG_FILE 抓到域名" >&2
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
