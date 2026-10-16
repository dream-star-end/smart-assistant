#!/usr/bin/env bash
# PR-time migration precheck for selfhost (OCV5-450). Runs the same checks the
# release train's migration gate runs, before a train slot is taken:
#   - every added/changed packages/commercial/src/db/migrations/*.sql must be
#     listed in deploy/v5/release-metadata.json requiredMigrations
#     (the train dies on this; no override exists) -> exit 1;
#   - breaking DDL (shared detector, scripts/lib/v5-migration-ddl.sh) is only
#     reported: the train refuses it unless the user approves and the release
#     sets OC_V5_ALLOW_BREAKING_MIGRATION=1. Nothing here adds an override.
# Usage: v5-selfhost-migration-precheck.sh --base <git-ref>
# Exit: 0 ok (warnings allowed), 1 unregistered migration, 2 usage/git error.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/v5-migration-ddl.sh
source "$SCRIPT_DIR/lib/v5-migration-ddl.sh"

base=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) [[ -n "${2:-}" ]] || { echo "--base needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$base" ]] || { echo "--base is required" >&2; exit 2; }
git -C "$REPO_ROOT" rev-parse --verify -q "$base^{commit}" >/dev/null || { echo "base not a commit: $base" >&2; exit 2; }

meta="$REPO_ROOT/deploy/v5/release-metadata.json"
mapfile -t files < <(git -C "$REPO_ROOT" diff --name-only --diff-filter=AMR "$base"...HEAD -- 'packages/commercial/src/db/migrations/*.sql')
if (( ${#files[@]} == 0 )); then
  echo "migration precheck: no migration changes since $base"
  exit 0
fi
unregistered=0
breaking=0
for f in "${files[@]}"; do
  name="$(basename "$f" .sql)"
  if ! jq -e --arg n "$name" '.requiredMigrations | index($n) != null' "$meta" >/dev/null; then
    echo "::error file=$f::$name is not listed in deploy/v5/release-metadata.json requiredMigrations (the release train refuses it)"
    unregistered=$((unregistered + 1))
  fi
  if hit="$(sql_file_has_breaking_ddl "$REPO_ROOT/$f")"; then
    echo "::warning file=$f::$name has breaking DDL ($hit). The release train refuses it unless the user approves and the release sets OC_V5_ALLOW_BREAKING_MIGRATION=1."
    breaking=$((breaking + 1))
  fi
done
echo "migration precheck: files=${#files[@]} unregistered=$unregistered breaking_ddl=$breaking"
(( unregistered == 0 ))
