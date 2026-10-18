#!/usr/bin/env bash
# User explicitly approved uid765 only, 2026-10-18 19:12 and normal pool use 19:23.
set -euo pipefail
SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
canonical=/opt/openclaude/openclaude-v5-selfhost
expected=67d13462edea57d43e71aae2a97d51efddcff831
[[ $(id -u) == 0 && $(hostname) == v3-dev-sg ]] || { echo BOUNDARY >&2; exit 1; }
[[ ${OCV5_502_UID765_ACK:-} == 1 ]] || { echo ACK_REQUIRED >&2; exit 1; }
[[ -z ${OC_V5_SELFHOST_LOCK_SELFTEST_SLEEP:-} ]] || exit 1
live=$(readlink -f /opt/openclaude/openclaude-v5-selfhost-live)
[[ "$live" == /opt/openclaude/openclaude-v5-selfhost-releases/rel-* ]] || exit 1
[[ $(git -C "$canonical" rev-parse HEAD) == "$expected" ]] || exit 1
[[ $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).sourceCommit)' "$live/.complete") == "$expected" ]] || exit 1
cmp -s "$canonical/scripts/deploy-v5-selfhost.sh" "$live/scripts/deploy-v5-selfhost.sh" || exit 1
unset OC_V5_SELFHOST_DEPLOY_LOCK_HELD OC_V5_SELFHOST_DEPLOY_LOCK
export OC_V5_SELFHOST_DEPLOY_LOCK_WAIT=0
source "$canonical/scripts/deploy-v5-selfhost.sh" --status >/dev/null
acquire_selfhost_deploy_lock
[[ $(readlink -f /opt/openclaude/openclaude-v5-selfhost-live) == "$live" ]] || exit 1
[[ $(systemctl is-active openclaude-v5-selfhost-cursor-proxy.service) == active ]] || exit 1
# Assert service authority without printing its full configuration or environment.
systemctl show -p ExecStart --value openclaude-v5-selfhost-cursor-proxy.service | \
  python3 -c 'import sys; assert "/etc/sing-box/openclaude-cursor-egress-proxy.json" in sys.stdin.read()'
ss -Hltn 'sport = :18992' | python3 -c 'import sys; assert "172.31.0.1:18992" in sys.stdin.read()'
python3 "$SELF_DIR/boxUid765Egress.py"
[[ $(readlink -f /opt/openclaude/openclaude-v5-selfhost-live) == "$live" ]] || exit 1
printf 'OCV5-502 uid765 egress file complete; live unchanged %s\n' "$expected"
