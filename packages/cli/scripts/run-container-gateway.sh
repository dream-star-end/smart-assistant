#!/usr/bin/env bash
# Start the in-container OpenClaude gateway.
#
# Fast path: node the finalize-precompiled dist (no tsx compile).
# Fail-open: missing/corrupt dist → original `tsx packages/cli/src/index.ts gateway`.
# Always logs which path was taken.
#
# Lives under packages/cli/scripts/ so runtime-src-excludes `/scripts/` (repo
# root only) does not prune it out of the user-container rel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

ENTRY="$ROOT/packages/cli/dist/index.js"
MARKER="$ROOT/packages/cli/dist/.precompiled-ok"
TS_ENTRY="$ROOT/packages/cli/src/index.ts"

log() { echo "[gateway] $*" >&2; }

precompiled_ok() {
  [ -f "$MARKER" ] && [ -s "$ENTRY" ] || return 1
  node --check "$ENTRY" >/dev/null 2>&1 || return 1
}

run_tsx() {
  local reason="$1"
  log "boot=tsx reason=${reason}"
  if [ -x "$ROOT/node_modules/.bin/tsx" ]; then
    exec "$ROOT/node_modules/.bin/tsx" "$TS_ENTRY" gateway "$@"
  fi
  exec npx --no tsx "$TS_ENTRY" gateway "$@"
}

if precompiled_ok; then
  log "boot=precompiled entry=$ENTRY"
  exec node --conditions=openclaude-precompiled "$ENTRY" gateway "$@"
fi

if [ ! -f "$MARKER" ]; then
  run_tsx "precompiled-marker-missing" "$@"
elif [ ! -s "$ENTRY" ]; then
  run_tsx "precompiled-entry-missing" "$@"
else
  run_tsx "precompiled-corrupt" "$@"
fi
