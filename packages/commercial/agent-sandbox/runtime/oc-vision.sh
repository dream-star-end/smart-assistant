#!/bin/sh
# oc-vision — in-container CLI for image understanding (text-only models / when
# the model needs to look at a local image). Thin wrapper → gateway tsx entry.
# Reuses the mcpVisionServer core (default MiniMax-M3 backend via the container
# internal anthropic proxy). Replaces the retired long-lived openclaude-vision
# MCP stdio server (a fragile persistent transport). See the `oc-vision` baseline skill.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocVisionCli.ts "$@"
