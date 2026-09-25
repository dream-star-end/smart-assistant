#!/usr/bin/env bash
# Detached one-shot bounded driver for the audited uid3 runtime convergence.
# Run only after the invoking agent turn has ended. Never forces active turns.
set -Eeuo pipefail

WORK=/var/lib/openclaude/ocv5-289-runtime-refresh-577ba459a-1
PINNED_LIVE=/opt/openclaude/openclaude-v5-selfhost-releases/rel-577ba459a-20260925-180937
ENV_FILE=/etc/openclaude/commercial-v5-selfhost.env
DEPLOY_LOCK=/run/openclaude-v5-selfhost/deploy.lock
EXPECTED_SOURCE=577ba459a2e42dbfe5aaf38e0c1d825ecf8363ad
EXPECTED_HELPER_SHA256=08fa5b64f3de8bb9d13b7945a3d8d6477dd7781772bad0f4f48072751aa4e001
EXPECTED_MATCH_SHA256=8347fefb86a46492b893be46da8c949e1f0b62a798834cc510144f7fac4caa45

[[ "$(hostname)" == v3-dev-sg ]] || { echo BOX_REFRESH_HOST_INVALID; exit 1; }
[[ -f "$ENV_FILE" && -r "$ENV_FILE" ]] || { echo BOX_REFRESH_ENV_MISSING; exit 1; }
[[ -d "$WORK" && "$(stat -c %u:%a "$WORK")" == "0:700" ]] \
  || { echo BOX_REFRESH_SEALED_WORK_INVALID; exit 1; }
[[ "$(readlink -f "$WORK/packages")" == "$PINNED_LIVE/packages" \
  && "$(readlink -f "$WORK/node_modules")" == "$PINNED_LIVE/node_modules" ]] \
  || { echo BOX_REFRESH_DEPENDENCY_DRIFTED; exit 1; }

cd "$WORK"
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a
[[ "${OC_RUNTIME_CHANNEL:-}" == v5 ]] || { echo BOX_REFRESH_CHANNEL_INVALID; exit 1; }
unset OC_V5_FORCE_STALE_IMAGE_RECYCLE
export OCV5_289_ACK_UID=3
export OCV5_289_RUNTIME_REFRESH_ACK=1
export OCV5_289_EXPECT_LIVE_SHA="$EXPECTED_SOURCE"

# Each attempt separately owns the release lock; a busy lock is not bypassed.
# Exit 3 from the helper means authenticated drain deferred an active turn.
for attempt in $(seq 1 60); do
  [[ "$(readlink -f /opt/openclaude/openclaude-v5-selfhost-live)" == "$PINNED_LIVE" ]] \
    || { echo BOX_REFRESH_LIVE_DRIFTED; exit 1; }
  [[ "$(readlink -f "$WORK/packages")" == "$PINNED_LIVE/packages" \
    && "$(readlink -f "$WORK/node_modules")" == "$PINNED_LIVE/node_modules" ]] \
    || { echo BOX_REFRESH_DEPENDENCY_DRIFTED; exit 1; }
  [[ "$(sha256sum "$WORK/scripts/ocv5-289/boxRuntimeRefreshSelfhost.ts" | cut -d' ' -f1)" == "$EXPECTED_HELPER_SHA256" \
    && "$(sha256sum "$WORK/scripts/ocv5-289/boxRuntimeMatch.ts" | cut -d' ' -f1)" == "$EXPECTED_MATCH_SHA256" ]] \
    || { echo BOX_REFRESH_HELPER_DRIFTED; exit 1; }
  exec 9<>"$DEPLOY_LOCK"
  if ! flock -n 9; then
    echo "BOX_REFRESH_DEPLOY_LOCK_BUSY attempt=$attempt"
    exec 9>&-
    exit 4
  fi
  rc=0
  timeout --signal=TERM --kill-after=5s 180s \
    node_modules/.bin/tsx scripts/ocv5-289/boxRuntimeRefreshSelfhost.ts run || rc=$?
  flock -u 9
  exec 9>&-
  case "$rc" in
    0) echo "BOX_REFRESH_CONVERGED attempt=$attempt"; exit 0 ;;
    3) echo "BOX_REFRESH_DRAIN_DEFERRED attempt=$attempt" ;;
    *) echo "BOX_REFRESH_FAILED_OR_UNKNOWN attempt=$attempt rc=$rc"; exit "$rc" ;;
  esac
  sleep 10
done
echo BOX_REFRESH_BOUNDED_WAIT_EXHAUSTED
exit 3
