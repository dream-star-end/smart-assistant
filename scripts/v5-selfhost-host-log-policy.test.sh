#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$EUID" != 0 ]]; then
  exec sudo -n env PYTHONDONTWRITEBYTECODE=1 python3 scripts/__tests__/v5SelfhostHostLogPolicy.test.py
fi
exec env PYTHONDONTWRITEBYTECODE=1 python3 scripts/__tests__/v5SelfhostHostLogPolicy.test.py
