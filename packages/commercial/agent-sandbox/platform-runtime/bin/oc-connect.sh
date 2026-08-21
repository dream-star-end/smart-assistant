#!/bin/sh
# oc-connect — in-container CLI for user-bound app connectors (webdav/imap/notion/github/feishu).
# Thin wrapper → gateway tsx entry (talks to master /v3/connectors/{list|call} with the
# container token; third-party credentials never enter the container). Write actions go
# through the propose-then-commit confirmation gate. See the `app-connectors` baseline skill.
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
Usage: oc-connect <command> [options]

Commands:
  list                                    列出已绑定的应用连接与可用操作
  catalog [query]                         列出可绑定的应用连接器(可选关键词搜索)
  call <provider> <action> [options]      调用某连接的操作(params 从 stdin 读 JSON)

Options (call):
  --account <connectionId>   指定连接(同一 provider 有多个连接时必填)
  --confirm <id>             执行已被用户确认的写操作(凭确认卡返回的 id)
  --out <file>               结果含文件时,解码 base64 落盘到 <file>(只打印路径与大小)
EOF
  exit 0
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocConnectCli.ts "$@"
