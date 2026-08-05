#!/bin/sh
# oc-ocr — rev-pinned thin wrapper for the container OCR client.
set -e
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocOcrCli.ts "$@"
