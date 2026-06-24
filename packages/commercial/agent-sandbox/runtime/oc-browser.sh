#!/bin/sh
# oc-browser — thin CLI client over the oc-browser daemon (ocBrowserCli.ts), which
# keeps one @playwright/mcp session alive so `snapshot → click` shares the browser
# across calls. Replaces the retired browser_* MCP tools.
#
# Run from /opt/openclaude so `npx --no-install tsx` resolves the image-bundled
# tsx without a network fetch (same layout as oc-web).
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocBrowserCli.ts "$@"
