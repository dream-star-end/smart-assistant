#!/usr/bin/env bash
# 看护判定逻辑自测入口。默认测仓库候选脚本，不测已安装的旧副本。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCH_SOURCE="${WATCH_BIN:-$DIR/v5-selfhost-watch.sh}"
case "$(readlink -f "$WATCH_SOURCE")" in
  /opt/openclaude/v5-selfhost-watch/watch.sh)
    echo "REFUSE: 不测已安装副本 $WATCH_SOURCE" >&2
    exit 2
    ;;
esac
if [[ ! -f "$WATCH_SOURCE" ]]; then
  echo "REFUSE: 候选脚本不存在 $WATCH_SOURCE" >&2
  exit 2
fi
BASE="$(mktemp -d "${TMPDIR:-/tmp}/v5-watch-selftest-fixture.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
BIN="$BASE/watch-fixture.sh"
# This fixture has no CC5 activation. Keep the real watch/main and all original
# assertions while isolating only the fixed host CC5 dependency.
printf '#!/usr/bin/env bash\nsource %q\ncc5_activation_recovery_safe() { return 0; }\nmain "$@"\n' \
  "$WATCH_SOURCE" >"$BIN"
chmod 0700 "$BIN"
bash "$BIN" --selftest
