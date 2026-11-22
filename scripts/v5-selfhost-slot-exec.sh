#!/usr/bin/env bash
# OCV5-854 (B02): Trusted per-slot launcher for openclaude-v5-selfhost@.service.
#
# systemd's EnvironmentFile= overrides Environment= regardless of unit ordering,
# and commercial-v5-selfhost.env carries OC_SLOT=A. This launcher executes after
# EnvironmentFile= has been loaded and authoritatively pins per-slot identity
# (OC_SLOT, OPENCLAUDE_GATEWAY_PORT, OC_REMOTE_V4_DRAIN_SOCKET, disable flags)
# before exec'ing the gateway.
set -euo pipefail

SLOT="${1:-}"
case "$SLOT" in
  A)
    PORT="${OC_FRONTDOOR_SLOT_A_PORT:-18791}"
    ;;
  B)
    PORT="${OC_FRONTDOOR_SLOT_B_PORT:-18795}"
    ;;
  *)
    echo "FATAL: v5-selfhost-slot-exec.sh requires slot argument A or B (got '${SLOT}')" >&2
    exit 64
    ;;
esac

DRAIN_PREFIX="${V5_SLOT_DRAIN_SOCK_PREFIX:-/run/openclaude-v5-selfhost/remote-v4-drain}"

export OC_SLOT="$SLOT"
export OPENCLAUDE_GATEWAY_PORT="$PORT"
export OC_REMOTE_V4_DRAIN_SOCKET="${DRAIN_PREFIX}-${SLOT}.sock"
export OC_PREHEAT_DISABLED=1
export OC_IMAGE_DISTRIBUTE_DISABLED=1

if [[ -n "${OC_SLOT_EXEC_OVERRIDE:-}" ]]; then
  exec "$OC_SLOT_EXEC_OVERRIDE"
fi

exec /usr/bin/npx tsx packages/cli/src/index.ts gateway
