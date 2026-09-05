#!/usr/bin/env bash
# Install scripts/host/needrestart-openclaude.conf → /etc/needrestart/conf.d/openclaude.conf
# Idempotent: diff, write only when content differs. Requires root/sudo.
# Prepare-only in OCV5-117: do not run this against the live host from the PR agent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${OC_V5_NEEDRESTART_SRC:-$SCRIPT_DIR/needrestart-openclaude.conf}"
DEST="${OC_V5_NEEDRESTART_DEST:-/etc/needrestart/conf.d/openclaude.conf}"
MODE="${OC_V5_NEEDRESTART_MODE:-644}"

die() { echo "✗ $*" >&2; exit 2; }

[[ -f "$SRC" ]] || die "missing source conf: $SRC"

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || die "need root or sudo to write $DEST"
    sudo "$@"
  fi
}

if [[ -f "$DEST" ]] && diff -q "$SRC" "$DEST" >/dev/null 2>&1; then
  echo "already installed (identical): $DEST"
  exit 0
fi

if [[ -f "$DEST" ]]; then
  echo "content differs; showing diff (src → dest):"
  diff -u "$DEST" "$SRC" || true
else
  echo "dest missing: $DEST"
fi

dest_dir="$(dirname -- "$DEST")"
run_root mkdir -p "$dest_dir"
run_root install -m "$MODE" "$SRC" "$DEST"
echo "installed $SRC → $DEST mode=$MODE"
if [[ -f "$DEST" ]] && diff -q "$SRC" "$DEST" >/dev/null 2>&1; then
  echo "verify: dest matches src"
  exit 0
fi
die "post-install dest does not match src"
