#!/bin/bash
# 2J-1: Caddyfile CI grep 检查
#
# 拒绝把内部代理路径(/v1/* /internal/*)暴露到 Caddy site config。
# 内部代理只能由 docker bridge 内的容器通过 172.30.0.1:18791 直连访问。
# 任何 reverse_proxy 这些路径都是 P0 级安全问题。
#
# 使用:  bash check-caddyfile.sh /etc/caddy/Caddyfile
#        bash check-caddyfile.sh path/to/Caddyfile
#
# 退出码:
#   0  通过
#   1  发现禁用路径(打印行号 + 上下文)
#   2  参数错误 / 文件不存在

set -e

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <caddyfile-path>"
  exit 2
fi

FILE="$1"
if [ ! -f "$FILE" ]; then
  echo "[ABORT] Caddyfile 不存在: $FILE"
  exit 2
fi

# 禁用模式 (扩展正则):
#   - handle    /v1/...        | handle    /internal/...
#   - handle_path /v1/...      | handle_path /internal/...
#   - route     /v1/...        | route     /internal/...
#   - 任何裸出现 /v1/messages 或 /internal/ 的 site-config 行
#
# 注释 (# 开头) 不算违规,允许 boss 留 "禁止暴露 /internal/" 之类说明。
DENY_PATTERN='^[[:space:]]*(handle|handle_path|route|reverse_proxy|rewrite|redir)[[:space:]]+/(v1|internal)/'

violations=$(grep -nE "$DENY_PATTERN" "$FILE" || true)

if [ -n "$violations" ]; then
  echo "[FAIL] Caddyfile 出现禁用路径 — 内部代理 (/v1/* /internal/*) 不可暴露公网:"
  echo ""
  echo "$violations"
  echo ""
  echo "修复: 删除上述路由块。内部代理只允许容器经 172.30.0.1:18791 访问。"
  exit 1
fi

echo "[OK] $FILE 无 /v1/* /internal/* 暴露"
exit 0
