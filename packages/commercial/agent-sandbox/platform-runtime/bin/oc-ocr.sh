#!/bin/sh
# oc-ocr — rev-pinned thin wrapper for the container OCR client.
set -e
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
usage: oc-ocr run <file> --out <path> [--mode hybrid|pp|vl] [--fallback 0.10] [--format markdown|jsonl] | submit <file> | status <ticket> | cancel <ticket> | download <ticket> --out <path>
EOF
  exit 0
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocOcrCli.ts "$@"
