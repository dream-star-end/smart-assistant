#!/usr/bin/env bash
# 看护判定逻辑自测入口。默认测仓库候选脚本，不测已安装的旧副本。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${WATCH_BIN:-$DIR/v5-selfhost-watch.sh}"
case "$BIN" in
  /opt/openclaude/v5-selfhost-watch/watch.sh)
    echo "REFUSE: 不测已安装副本 $BIN" >&2
    exit 2
    ;;
esac
if [[ ! -f "$BIN" ]]; then
  echo "REFUSE: 候选脚本不存在 $BIN" >&2
  exit 2
fi
exec "$BIN" --selftest
