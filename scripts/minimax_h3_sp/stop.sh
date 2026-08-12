#!/usr/bin/env bash
set -euo pipefail
STATE=${H3_SP_STATE_ROOT:-/root/minimax-h3-sp-runtime}
if [[ ! -f "$STATE/torchrun.pid" ]]; then
  echo "H3 sequence-parallel worker is not running"
  exit 0
fi
pid=$(cat "$STATE/torchrun.pid")
kill -TERM -- "-$pid" 2>/dev/null || true
for _ in $(seq 1 30); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL -- "-$pid" 2>/dev/null || true
fi
rm -f "$STATE/torchrun.pid"
echo "H3 sequence-parallel worker stopped"
