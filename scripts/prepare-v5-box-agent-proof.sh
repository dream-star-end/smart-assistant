#!/usr/bin/env bash
# Explicit executable preparation, before the unchanged 120s incident proof.
# No deploy/activation/queue/lease operation. Only this candidate is built.
set -euo pipefail
candidate="$(cd "${1:?candidate required}" && pwd -P)"
if [[ $# != 1 ]]; then echo 'usage: prepare-v5-box-agent-proof.sh <candidate>' >&2; exit 2; fi
if compgen -v FEATURE_ >/dev/null; then
  echo 'Box Agent proof requires the unchanged production build feature profile' >&2
  exit 1
fi
source "$candidate/scripts/v5-runtime-release-lib.sh"
build_identity="$(oc_hotcfg_build_ccb_dist "$candidate" '')"
IFS=$'\t' read -r bun_version ccb_dist_key <<<"$build_identity"
( cd "$candidate" && npx --no-install tsx scripts/lib/boxAgentArtifact.ts \
    --record "$candidate" "$bun_version" "$ccb_dist_key" )
echo "Box Agent proof production artifact ready: bun=$bun_version key=$ccb_dist_key"
