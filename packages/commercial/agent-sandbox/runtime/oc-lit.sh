#!/bin/sh
# oc-lit — in-container CLI for multi-source literature metadata search.
# Thin wrapper → gateway tsx entry (talks to master /v3/research/lit/* with the
# container token; platform holds source API keys). See the `oc-lit` baseline skill.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocLitCli.ts "$@"
