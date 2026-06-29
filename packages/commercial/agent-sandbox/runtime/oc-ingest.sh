#!/bin/sh
# oc-ingest — in-container research CLI. Thin wrapper → gateway tsx entry (talks to master
# /v3/research/* with the container token). See the `oc-ingest` baseline skill for usage.
set -e
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocIngestCli.ts "$@"
