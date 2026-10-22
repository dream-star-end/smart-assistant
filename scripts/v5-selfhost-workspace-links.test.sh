#!/usr/bin/env bash
# OCV5-549: scripts/lib/v5-selfhost-workspace-links.sh (ws_links_ensure) and its wiring into
# deploy-v5-selfhost.sh ensure_node_modules. Usage: bash scripts/v5-selfhost-workspace-links.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/v5-selfhost-workspace-links.sh"
DEPLOY="$SCRIPT_DIR/deploy-v5-selfhost.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1" >&2; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

# A repo with three workspaces: @x/a (no deps), @x/b (depends on lodash), plain (no scope).
mkrepo() { # <dir>
  local r="$1"
  mkdir -p "$r/packages/a" "$r/packages/b" "$r/packages/plain" "$r/node_modules/@x"
  printf '%s' '{"name":"root","workspaces":["packages/a","packages/b","packages/plain"]}' >"$r/package.json"
  printf '%s' '{"name":"@x/a","version":"0.1.0"}' >"$r/packages/a/package.json"
  printf '%s' '{"name":"@x/b","dependencies":{"lodash":"*","@x/a":"*"}}' >"$r/packages/b/package.json"
  printf '%s' '{"name":"plain"}' >"$r/packages/plain/package.json"
}
run() { # <dir> [DRY]  -> output, rc in $RC
  OUT="$(DRY="${2:-0}" bash -c "source '$LIB'; ws_links_ensure '$1'" 2>&1)"; RC=$?
}

# 1. Missing links for packages without missing deps are created, relative, like npm ci.
r="$T/r1"; mkrepo "$r"; mkdir -p "$r/node_modules/lodash"; ln -s ../../packages/b "$r/node_modules/@x/b"
run "$r"
check "creates missing links, exit 0" test "$RC" = 0
check "scoped link is ../../packages/a" test "$(readlink "$r/node_modules/@x/a")" = ../../packages/a
check "unscoped link is ../packages/plain" test "$(readlink "$r/node_modules/plain")" = ../packages/plain
check "created links resolve into the workspace" test -f "$r/node_modules/@x/a/package.json"
check "reports what it created" grep -qF '+ node_modules/@x/a -> ../../packages/a' <<<"$OUT"
run "$r"
check "second run: nothing to do, silent, exit 0" test "$RC" = 0 -a -z "$OUT"

# 2. Missing link whose package has an uninstalled dependency: fail closed, create nothing.
r="$T/r2"; mkrepo "$r"; ln -s ../../packages/a "$r/node_modules/@x/a"; ln -s ../packages/plain "$r/node_modules/plain"
run "$r"
check "missing link + missing dependency: exit 1" test "$RC" = 1
check "names the missing dependency and the remedy" grep -qE 'lodash.*npm ci' <<<"$OUT"
check "nothing created for it" test ! -e "$r/node_modules/@x/b"

# 3. A link pointing somewhere else is never repaired silently.
r="$T/r3"; mkrepo "$r"; mkdir -p "$r/node_modules/lodash" "$T/elsewhere"
ln -s "$T/elsewhere" "$r/node_modules/@x/a"; ln -s ../../packages/b "$r/node_modules/@x/b"; ln -s ../packages/plain "$r/node_modules/plain"
run "$r"
check "foreign link: exit 1" test "$RC" = 1
check "foreign link left as it was" test "$(readlink "$r/node_modules/@x/a")" = "$T/elsewhere"
# a link to the canonical checkout from another worktree (absolute, same target) is fine
r="$T/r3b"; mkrepo "$r"; mkdir -p "$r/node_modules/lodash"
ln -s "$r/packages/a" "$r/node_modules/@x/a"; ln -s ../../packages/b "$r/node_modules/@x/b"; ln -s ../packages/plain "$r/node_modules/plain"
run "$r"
check "absolute link to the same workspace is accepted" test "$RC" = 0

# 4. DRY=1 prints and changes nothing.
r="$T/r4"; mkrepo "$r"; mkdir -p "$r/node_modules/lodash"
run "$r" 1
check "dry-run: exit 0, prints the plan" bash -c "[ '$RC' = 0 ] && grep -qF '[dry-run] ln -s ../../packages/a node_modules/@x/a' <<<\"\$1\"" _ "$OUT"
check "dry-run: nothing created" test ! -e "$r/node_modules/@x/a" -a ! -e "$r/node_modules/plain"

# 5. A workspace without package.json, or an unreadable root package.json: fail closed.
r="$T/r5"; mkrepo "$r"; rm "$r/packages/plain/package.json"
run "$r"
check "workspace without package.json: exit 1" test "$RC" = 1
r="$T/r6"; mkdir -p "$r/node_modules"; printf '{' >"$r/package.json"
run "$r"
check "unreadable root package.json: exit 1" test "$RC" = 1

# 6. Wiring: ensure_node_modules runs it on the existing-node_modules path and dies on failure.
body="$(sed -n '/^ensure_node_modules() {/,/^}/p' "$DEPLOY")"
check "deploy sources the lib" grep -qE '^source "\$SCRIPT_DIR/lib/v5-selfhost-workspace-links\.sh"' "$DEPLOY"
check "existing node_modules path checks workspace links before skipping npm ci" \
  bash -c "printf '%s\n' \"\$1\" | grep -B1 -A3 'ws_links_ensure \"\$REPO_ROOT\"' | grep -q 'die '" _ "$body"

echo "---"
if (( fails )); then echo "FAIL: $fails" >&2; exit 1; fi
echo "PASS"
