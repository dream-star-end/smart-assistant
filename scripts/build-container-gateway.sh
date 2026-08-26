#!/usr/bin/env bash
# Wrapper: precompile container gateway TS→JS (see build-container-gateway.mjs).
# Fail-loud. Runtime fail-open lives in run-container-gateway.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ESBUILD="$REPO_ROOT/node_modules/esbuild/bin/esbuild"
if [ ! -x "$ESBUILD" ] && [ ! -f "$REPO_ROOT/node_modules/esbuild/lib/main.js" ]; then
  echo "build-container-gateway: missing esbuild in node_modules (need npm ci --include=dev)" >&2
  exit 1
fi

exec node "$REPO_ROOT/scripts/build-container-gateway.mjs"
