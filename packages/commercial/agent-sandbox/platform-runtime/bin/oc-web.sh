#!/bin/sh
# oc-web — CLI front-end over the web-context extraction core (ocWebCli.ts).
#
# Replaces the retired web-context MCP tools. The agent runs `oc-web extract <url>`
# / `oc-web parse <file>` via Bash; all fetching + SSRF/path/size/blocked safety
# lives in the shared core (packages/gateway/src/mcpWebContextServer.ts), reused
# verbatim by ocWebCli.ts.
#
# Run from /opt/openclaude so `npx tsx` resolves the image-bundled tsx (and the
# gateway's node_modules) without a network fetch — the same layout the old
# web-context MCP server was spawned under.
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
Usage: oc-web <command> [options]

Commands:
  extract <url>        Fetch a public URL and extract clean Markdown
  parse <file>         Parse a local uploaded/generated file into Markdown
  health               Check parser dependency availability

Options:
  --json               Print the full JSON result instead of Markdown
  --max-chars <n>      Max output characters
  --timeout-ms <n>     Per-call timeout in milliseconds
  --mode <m>           extract mode: auto (default) | static | browser
  --max-file-bytes <n> parse: max input file size in bytes
EOF
  exit 0
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocWebCli.ts "$@"
