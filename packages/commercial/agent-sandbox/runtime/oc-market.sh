#!/bin/sh
# oc-market — in-container CLI for AI-driven AI-marketplace operations.
# Thin wrapper → gateway tsx entry (talks to master /internal/v3/marketplace/agent/*
# with the container token). See the `market` baseline skill for usage.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocMarketCli.ts "$@"
