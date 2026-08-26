#!/usr/bin/env bash
# Build the openclaude-memory stdio MCP server into a single CJS file so engine
# adapters can launch `node dist/oc-memory-mcp.cjs` instead of interpreting
# src/index.ts through tsx (~7s cold start per spawn; grok/cursor pay it every
# turn, CCB/codex on every engine spawn).
#
# Same recipe as build-oc-memory-cli.sh: native addons (better-sqlite3,
# sqlite-vec) stay external and resolve from the release's node_modules. ESM
# output is rejected: yaml's `require("process")` breaks under esbuild's ESM
# shim.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
ENTRY="$PKG_DIR/src/index.ts"
OUT="$PKG_DIR/dist/oc-memory-mcp.cjs"

[ -f "$ENTRY" ] || { echo "build-oc-memory-mcp: missing entry $ENTRY" >&2; exit 1; }
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
  echo "build-oc-memory-mcp: need esbuild (repo node_modules) or bun" >&2
  exit 1
fi

[ -s "$OUT" ] || { echo "build-oc-memory-mcp: empty output $OUT" >&2; exit 1; }
echo "build-oc-memory-mcp: wrote $OUT ($(wc -c < "$OUT") bytes)" >&2
