#!/usr/bin/env bash
# Runs on v5-dev. The existing official lease owns the entire foreground remote job.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
LEASE="${V5CB_CONTROLLER_LEASE:-$SELF_DIR/with-production-mutation-lease.sh}"
SSH="${V5CB_CONTROLLER_SSH:-ssh}"
HOST="${V5CB_CONTROLLER_HOST:-kl-mirror}"
REMOTE="${V5CB_CONTROLLER_REMOTE:-/opt/openclaude/pg-r2-backup/current/scripts/v5-commercial-pg-backup.sh}"
case "${1:-run}" in
  run)
    queue=$("${V5CB_CONTROLLER_QUEUE:-/opt/openclaude/openclaude-v5-aurora/scripts/v5-release-queue.sh}" status --json) || exit 3
    if ! python3 -c 'import json,sys; rows=json.load(sys.stdin); assert isinstance(rows,list); sys.exit(3 if any(r["status"] in ("active","queued") for r in rows) else 0)' <<<"$queue"; then
      echo 'commercial release queue busy or unreadable' >&2; exit 3
    fi
    awk '{exit !($1 < 6)}' "${V5CB_CONTROLLER_LOADAVG:-/proc/loadavg}" || { echo 'v5-dev load >= 6' >&2; exit 3; }
    free=$(df -PB1 / | awk 'NR==2 {print $4}')
    [[ "$free" =~ ^[0-9]+$ ]] && (( free >= 8589934592 )) || { echo 'v5-dev disk below 8 GiB' >&2; exit 3; }
    exec "$LEASE" "$SELF" __leased
    ;;
  __leased)
    [[ "${OC_V5_MANUAL_LEASE_NONCE:-}" =~ ^[0-9a-f]{32}$ ]] || { echo 'official lease nonce missing' >&2; exit 3; }
    # Construct this only inside the wrapped child. The wrapper logs fixed argv, never proof values.
    printf -v command 'exec nice -n 15 ionice -c 3 env OC_V5_MANUAL_LEASE_NONCE=%q bash %q run' "$OC_V5_MANUAL_LEASE_NONCE" "$REMOTE"
    exec "$SSH" -tt -o BatchMode=yes -o ConnectTimeout=15 -o LogLevel=ERROR -o ServerAliveInterval=15 -o ServerAliveCountMax=2 "$HOST" "$command" </dev/null
    ;;
  *) echo 'usage: v5-commercial-pg-backup-controller.sh run' >&2; exit 2 ;;
esac
