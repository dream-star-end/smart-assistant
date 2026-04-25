#!/usr/bin/env bash
# M7/P1-10 — Root-side backup-pull helper. Runs via sudoers NOPASSWD invoked by wrapper.
#
# Power model:
#   - Lives at /usr/local/bin/backup-pull-cmd, owner root:root, mode 0755
#   - sudoers grants `backup-pull` user permission to run **only this binary** as root
#   - Reads command verb from $1 (passed by wrapper). Does NOT trust environment.
#   - Two verbs only: `info` (returns metadata of latest dump) and `fetch=<basename>`
#     (streams that dump's bytes to stdout)
#   - Strict regex anchors filename — no path traversal possible
#
# Threat model addressed:
#   - backup-pull user can only run this single command via sudo (sudoers)
#   - Wrapper already whitelists SSH_ORIGINAL_COMMAND but we re-anchor here (defense-in-depth)
#   - No write paths — read-only operations only
#   - No shell expansion of $requested (used as path segment, regex-validated)

set -euo pipefail
umask 077

DUMP_DIR=/var/backups/postgres
DUMP_RE='^openclaude_commercial-[0-9]{8}-[0-9]{6}Z\.dump$'

if [ "$(id -u)" -ne 0 ]; then
  echo "ERR: must run as root" >&2
  exit 2
fi

verb="${1:-}"

case "$verb" in
  info)
    cd "$DUMP_DIR" 2>/dev/null || { echo "ERR: dir read" >&2; exit 3; }
    base=$(LC_ALL=C ls -1 2>/dev/null | grep -E "$DUMP_RE" | sort | tail -1 || true)
    if [ -z "$base" ]; then
      echo "ERR: no dump" >&2
      exit 4
    fi
    full="$DUMP_DIR/$base"
    [ -f "$full" ] || { echo "ERR: missing" >&2; exit 5; }
    size=$(stat -c%s "$full")
    sha=$(sha256sum "$full" | awk '{print $1}')
    printf 'FILENAME=%s\n' "$base"
    printf 'SIZE=%s\n' "$size"
    printf 'SHA256=%s\n' "$sha"
    ;;
  fetch=*)
    requested="${verb#fetch=}"
    # Defense-in-depth: re-anchor regex. Wrapper already validated, but never trust.
    if ! [[ "$requested" =~ $DUMP_RE ]]; then
      echo "ERR: bad name" >&2
      exit 6
    fi
    full="$DUMP_DIR/$requested"
    [ -f "$full" ] || { echo "ERR: gone" >&2; exit 7; }
    cat "$full"
    ;;
  *)
    echo "ERR: bad verb" >&2
    exit 1
    ;;
esac
