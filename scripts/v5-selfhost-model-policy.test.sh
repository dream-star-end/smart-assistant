#!/usr/bin/env bash
# Private artifact fixtures only: no root, host release, database or model calls.
set -euo pipefail
cd "$(dirname "$0")/.."
exec env PYTHONDONTWRITEBYTECODE=1 python3 scripts/__tests__/v5SelfhostModelPolicy.test.py
