#!/usr/bin/env bash
# Additive-only migration gate for this phase (OCV5-542, phase 3 plan v3.6 §9.3 rule 3, R8-1, §9.8).
# Fails (exit 1) when a new or changed packages/commercial/src/db/migrations/*.sql has a compatibility
# candidate statement (scripts/lib/v5-migration-compat.py: SET NOT NULL, type changes, constraints,
# unique indexes, NOT NULL columns without a default, standalone DROPs, renames, triggers, functions,
# UPDATE/DELETE, dynamic SQL, anything unclassifiable) without a `-- compat: <reason>` comment right
# before it. Declared candidates are listed for the reviewer.
# With --pr-body-file, a PR that changes migrations must also carry a "## Migration compatibility"
# section naming every changed migration (the detector not matching is not proof of safety).
# Unlike scripts/v5-selfhost-migration-precheck.sh (breaking DDL is only a warning there), this is a
# blocking check.
# Usage: v5-selfhost-migration-compat-check.sh --base <git-ref> [--pr-body-file <file>]
# Exit: 0 ok; 1 undeclared candidate or missing PR section; 2 usage/git error.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DETECTOR="$SCRIPT_DIR/lib/v5-migration-compat.py"

base="" body_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) [[ -n "${2:-}" ]] || { echo "--base needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
    --pr-body-file) [[ -n "${2:-}" ]] || { echo "--pr-body-file needs a file" >&2; exit 2; }; body_file="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$base" ]] || { echo "--base is required" >&2; exit 2; }
git -C "$REPO_ROOT" rev-parse --verify -q "$base^{commit}" >/dev/null || { echo "base not a commit: $base" >&2; exit 2; }
[[ -z "$body_file" || -r "$body_file" ]] || { echo "cannot read $body_file" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }

if ! changed="$(git -C "$REPO_ROOT" diff --name-only --diff-filter=AMR "$base"...HEAD -- 'packages/commercial/src/db/migrations/*.sql')"; then
  echo "git diff $base...HEAD failed; cannot tell which migrations changed" >&2
  exit 2
fi
files=()
if [[ -n "$changed" ]]; then mapfile -t files <<<"$changed"; fi
if (( ${#files[@]} == 0 )); then
  echo "migration compat: no migration changes since $base"
  exit 0
fi

errors=0 declared=0
for f in "${files[@]}"; do
  out="" rc=0
  out="$(python3 "$DETECTOR" "$REPO_ROOT/$f")" || rc=$?
  if [[ "$rc" != 0 && "$rc" != 1 ]]; then
    echo "::error file=$f::compat detector failed (rc=$rc); cannot prove this migration is additive"
    errors=$((errors + 1))
    continue
  fi
  while IFS= read -r row; do
    [[ -n "$row" ]] || continue
    line="$(jq -r '.line' <<<"$row")"; kinds="$(jq -r '.kinds | join(",")' <<<"$row")"
    snippet="$(jq -r '.snippet' <<<"$row")"
    if [[ "$(jq -r '.declared' <<<"$row")" == true ]]; then
      echo "::notice file=$f,line=$line::compat candidate [$kinds] declared: $(jq -r '.reason' <<<"$row") — reviewer must check this claim"
      declared=$((declared + 1))
    else
      echo "::error file=$f,line=$line::compat candidate [$kinds] without a '-- compat: <reason>' comment right before it: $snippet"
      errors=$((errors + 1))
    fi
  done <<<"$out"
done

if [[ -n "$body_file" ]]; then
  section="$(tr -d '\r' <"$body_file" | awk 'tolower($0) ~ /^##[ \t]+migration compatibility[ \t]*$/ {f=1; next} f && /^##[ \t]/ {exit} f {print}')"
  if [[ -z "${section//[[:space:]]/}" ]]; then
    echo "::error::this PR changes migrations; its description needs a '## Migration compatibility' section (existing column encodings, enum/status values, JSON(B) shapes, UPDATE/DELETE/backfill, function/trigger side effects, old-version writes; and the old-version read/write test for each)"
    errors=$((errors + 1))
  else
    for f in "${files[@]}"; do
      n="$(basename "$f" .sql)"
      grep -qF -- "$n" <<<"$section" || { echo "::error::'## Migration compatibility' does not mention $n"; errors=$((errors + 1)); }
    done
  fi
fi

echo "migration compat: files=${#files[@]} declared_candidates=$declared errors=$errors"
(( errors == 0 ))
