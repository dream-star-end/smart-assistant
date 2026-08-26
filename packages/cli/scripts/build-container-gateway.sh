#!/usr/bin/env bash
# Precompile container gateway TS→JS (see sibling build-container-gateway.mjs).
# Fail-loud. Runtime fail-open lives in run-container-gateway.sh.
#
# Invoked as: ( cd "$staging" && bash packages/cli/scripts/build-container-gateway.sh )
# Compiles process.cwd() (the staging / repo root), not this script's location.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$PWD/packages/cli/src/index.ts" ]; then
  REPO_ROOT="$PWD"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
fi
cd "$REPO_ROOT"

if [ ! -x "$REPO_ROOT/node_modules/esbuild/bin/esbuild" ] \
  && [ ! -f "$REPO_ROOT/node_modules/esbuild/lib/main.js" ]; then
  echo "build-container-gateway: missing esbuild in $REPO_ROOT/node_modules (need npm ci --include=dev)" >&2
  exit 1
fi

exec node "$SCRIPT_DIR/build-container-gateway.mjs"
