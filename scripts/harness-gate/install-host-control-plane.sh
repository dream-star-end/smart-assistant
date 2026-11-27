#!/usr/bin/env bash
# install-host-control-plane.sh — Idempotent host installer for the OCV5-906 4-Gate Control Plane.
#
# Installs into ${OC_GOVERNOR_ROOT:-/opt/openclaude/harness-gate}:
#   - bin/oc-governor (0755, root:root)
#   - bin/sync-referee (0755, root:root)
#   - control/ (0755 dir, 0644 state files writable only by root; read-only to containers)
#   - Initializes control/mode.json = autonomous only if absent (never clobbers active locks!)
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GOV_ROOT="${OC_GOVERNOR_ROOT:-/opt/openclaude/harness-gate}"
SOURCE_DIR="$SCRIPT_DIR"
SYNC_REFEREE_NOW=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) GOV_ROOT="${2:-}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
    --sync-referee) SYNC_REFEREE_NOW=1; shift ;;
    -h|--help)
      echo "Usage: install-host-control-plane.sh [--root DIR] [--source-dir DIR] [--sync-referee]"
      exit 0
      ;;
    *)
      echo "✗ [install-host-control-plane] unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

[[ -f "$SOURCE_DIR/oc-governor.sh" ]] || { echo "✗ missing $SOURCE_DIR/oc-governor.sh" >&2; exit 1; }
[[ -f "$SOURCE_DIR/sync-referee.sh" ]] || { echo "✗ missing $SOURCE_DIR/sync-referee.sh" >&2; exit 1; }

BIN_DIR="$GOV_ROOT/bin"
CTRL_DIR="$GOV_ROOT/control"
APPROVALS_DIR="$CTRL_DIR/a0-approvals"
VOUCHERS_DIR="$CTRL_DIR/blast-vouchers"
STEWARD_DIR="$GOV_ROOT/steward-receipts"

install -d -m 0755 "$GOV_ROOT" "$BIN_DIR" "$CTRL_DIR" "$APPROVALS_DIR" "$VOUCHERS_DIR" "$STEWARD_DIR"
install -m 0755 "$SOURCE_DIR/oc-governor.sh" "$BIN_DIR/oc-governor"
install -m 0755 "$SOURCE_DIR/sync-referee.sh" "$BIN_DIR/sync-referee"

NOW_UTC="${OC_GOVERNOR_NOW_ISO:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
ACTOR="$(id -un 2>/dev/null || echo root)"

init_json_if_absent() {
  local path="$1" content="$2"
  if [[ ! -f "$path" ]]; then
    local tmp="${path}.tmp.$$"
    printf '%s\n' "$content" >"$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$path"
  else
    chmod 0644 "$path"
  fi
}

init_json_if_absent "$CTRL_DIR/mode.json" "$(cat <<EOF
{
  "schemaVersion": 1,
  "mode": "autonomous",
  "autoMergeFrozen": false,
  "reason": "initial host control-plane installation",
  "updatedAt": "${NOW_UTC}",
  "updatedBy": "${ACTOR}"
}
EOF
)"

init_json_if_absent "$CTRL_DIR/breaker.json" '{
  "schemaVersion": 1,
  "tripped": false
}'

init_json_if_absent "$CTRL_DIR/cost-breaker.json" '{
  "schemaVersion": 1,
  "tripped": false
}'

for logf in "$CTRL_DIR/audit.jsonl" "$CTRL_DIR/rollbacks.jsonl"; do
  [[ -f "$logf" ]] || : >"$logf"
  chmod 0644 "$logf"
done

chmod 0755 "$GOV_ROOT" "$BIN_DIR" "$CTRL_DIR" "$APPROVALS_DIR" "$VOUCHERS_DIR" "$STEWARD_DIR"

if [[ "$(id -u)" == "0" && "${OC_INSTALL_SKIP_CHOWN:-0}" != "1" ]]; then
  chown -R root:root "$BIN_DIR" "$CTRL_DIR" "$STEWARD_DIR"
fi

if [[ "$SYNC_REFEREE_NOW" == "1" ]]; then
  OC_GOVERNOR_ROOT="$GOV_ROOT" "$BIN_DIR/sync-referee"
fi

python3 -c 'import json,sys; print(json.dumps({"ok":True,"root":sys.argv[1],"binDir":sys.argv[2],"controlDir":sys.argv[3]}))' \
  "$GOV_ROOT" "$BIN_DIR" "$CTRL_DIR"
