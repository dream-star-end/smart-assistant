#!/bin/sh
# oc-browser — thin CLI client over the oc-browser daemon (ocBrowserCli.ts), which
# keeps one @playwright/mcp session alive so `snapshot → click` shares the browser
# across calls. Replaces the retired browser_* MCP tools.
#
# Run from /opt/openclaude so `npx --no-install tsx` resolves the image-bundled
# tsx without a network fetch (same layout as oc-web).
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocBrowserCli.ts "$@"
