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
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocWebCli.ts "$@"
