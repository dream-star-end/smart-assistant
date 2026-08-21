#!/usr/bin/env bash
# 看护判定逻辑自测入口。优先跑固定目录副本(与线上一致)。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x /opt/openclaude/v5-selfhost-watch/watch.sh ]]; then
  exec /opt/openclaude/v5-selfhost-watch/watch.sh --selftest
fi
exec "$DIR/v5-selfhost-watch.sh" --selftest
