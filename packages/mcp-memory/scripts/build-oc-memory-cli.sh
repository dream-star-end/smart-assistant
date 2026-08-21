#!/usr/bin/env bash
# Build the one-shot oc-memory CLI into a single CJS file so the sandbox
# wrapper can `exec node` instead of `npx tsx` (avoids ~7s cold start).
#
# Native addons (better-sqlite3, sqlite-vec) stay external and resolve from
# the runtime release's /opt/openclaude/node_modules. ESM output is rejected:
# yaml's `require("process")` breaks under esbuild's ESM shim.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
ENTRY="$PKG_DIR/src/ocMemoryCli.ts"
OUT="$PKG_DIR/dist/oc-memory.cjs"

[ -f "$ENTRY" ] || { echo "build-oc-memory-cli: missing entry $ENTRY" >&2; exit 1; }
mkdir -p "$PKG_DIR/dist"

ESBUILD="$REPO_ROOT/node_modules/esbuild/bin/esbuild"
if [ -x "$ESBUILD" ]; then
  "$ESBUILD" "$ENTRY" \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node22 \
    --outfile="$OUT" \
    --external:better-sqlite3 \
    --external:sqlite-vec
elif command -v bun >/dev/null 2>&1; then
  bun build "$ENTRY" \
    --target=node \
    --format=cjs \
    --outfile="$OUT" \
    --external better-sqlite3 \
    --external sqlite-vec
else
  echo "build-oc-memory-cli: need esbuild (repo node_modules) or bun" >&2
  exit 1
fi

[ -s "$OUT" ] || { echo "build-oc-memory-cli: empty output $OUT" >&2; exit 1; }
echo "build-oc-memory-cli: wrote $OUT ($(wc -c < "$OUT") bytes)" >&2
