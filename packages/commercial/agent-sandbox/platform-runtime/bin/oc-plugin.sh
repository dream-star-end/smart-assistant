#!/bin/sh
# oc-plugin — canonical in-container CLI for declarative-http and managed-browser
# Plugins (sandboxed-local is not wired on the master; see OCV5-383 FINDINGS). Credentials/browser state remain on the master; this
# wrapper sends only container identity + stdin JSON to /v3/plugins/*.
set -e
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
Usage: oc-plugin <command> [options]

Commands:
  list                                    列出当前可调用的插件目标与操作
  catalog [query]                         列出已安装的可用插件(可选关键词搜索)
  describe <plugin> [<action>]           查看操作说明与参数结构
  call <plugin> <action> [options]        调用插件操作(params 从 stdin 读 JSON)

Options (call):
  --account <targetId>       指定目标(同一插件有多个账户时必填)
  --confirm <id>             执行已被用户在确认卡批准的插件写操作
  --out <file>               结果含文件时,解码 base64 落盘到 <file>(只打印路径与大小)
EOF
  exit 0
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocPluginCli.ts "$@"
