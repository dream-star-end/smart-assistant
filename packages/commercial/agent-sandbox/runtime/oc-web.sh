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
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocWebCli.ts "$@"
