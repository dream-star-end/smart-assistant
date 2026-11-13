#!/usr/bin/env bash
# check-biome-changed.sh — biome lint for the files a branch changes; fails only on errors the
# branch adds (OCV5-376).
#
# Why not `biome check packages`: the whole repo has ~3.4k pre-existing lint errors and ~4.3k
# formatting differences (mostly commercial tests shared by both V5 trees). That command was red
# on every tree, so nothing ran it and nobody read it. Fixing all of it at once would rewrite
# thousands of shared lines right before the two trees are synchronised.
#
# This gate is the one every release session already ran by hand (g37x-gates.sh
# "biome_lint_changed"/"biome_touched_no_new"), now in the repo and in CI:
#   · files = everything changed between the merge-base with the target branch and the working tree
#     (added/modified/renamed .ts/.tsx/.js/.jsx/.mjs/.cjs/.json/.jsonc that biome handles);
#   · errors are counted per file at the merge-base and now, both under the current biome.json;
#   · any file with more errors than at the merge-base fails, new files count from 0.
# Touching a file never makes you fix its old errors; it only stops you adding new ones.
#
# Usage: scripts/check-biome-changed.sh [--base <ref>]
#   default base: origin/$GITHUB_BASE_REF in a PR job, otherwise whichever of
#   origin/feat/v5-selfhost / origin/feat/v5-aurora-rewrite is closer to HEAD.
# Exit: 0 no new errors / 1 new errors (listed) / 2 usage or environment problem.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BIOME="$ROOT/node_modules/.bin/biome"
[[ -x "$BIOME" ]] || { echo "✗ biome not installed ($BIOME)" >&2; exit 2; }

base=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$base" && -n "${GITHUB_BASE_REF:-}" ]]; then base="origin/$GITHUB_BASE_REF"; fi
if [[ -z "$base" ]]; then
  best=""; best_n=""
  for cand in origin/feat/v5-selfhost origin/feat/v5-aurora-rewrite; do
    git rev-parse -q --verify "$cand^{commit}" >/dev/null || continue
    n="$(git rev-list --count "$(git merge-base "$cand" HEAD)..HEAD")"
    if [[ -z "$best_n" || "$n" -lt "$best_n" ]]; then best="$cand"; best_n="$n"; fi
  done
  base="$best"
fi
[[ -n "$base" ]] && git rev-parse -q --verify "$base^{commit}" >/dev/null \
  || { echo "✗ no base ref (pass --base <ref>)" >&2; exit 2; }
mb="$(git merge-base "$base" HEAD)"

mapfile -t files < <(
  git diff --name-only --diff-filter=AMR "$mb" -- \
    | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc)$' \
    | while IFS= read -r f; do [[ -f "$f" ]] && printf '%s\n' "$f"; done
)
echo "biome (changed files) vs $base @ ${mb:0:9}: ${#files[@]} files"
(( ${#files[@]} > 0 )) || exit 0

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp biome.json "$tmp/biome.json"

# errors <dir> <file...> → "<errors>\t<file>" per file (biome's JSON reporter, one run per file)
count_errors() {
  local dir="$1"; shift
  local f out n
  for f in "$@"; do
    if [[ ! -f "$dir/$f" ]]; then printf '0\t%s\n' "$f"; continue; fi
    # biome skips files over files.maxSize (1 MiB default) and reports 0 errors for them: gateway
    # server.ts sits right at that edge, so a version over it counted as clean. Lint every version
    # with the same raised limit, and treat a skipped file as unreadable instead of clean.
    out="$(cd "$dir" && "$BIOME" lint --reporter=json --max-diagnostics=0 --files-max-size=8388608 "$f" 2>/dev/null || true)"
    n="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.summary?.skipped?"?":(j.summary?.errors??0))}catch{console.log("?")}})')"
    printf '%s\t%s\n' "$n" "$f"
  done
}

for f in "${files[@]}"; do
  if git cat-file -e "$mb:$f" 2>/dev/null; then
    mkdir -p "$tmp/$(dirname "$f")"
    git show "$mb:$f" > "$tmp/$f"
  fi
done

declare -A before
while IFS=$'\t' read -r n f; do before["$f"]="$n"; done < <(count_errors "$tmp" "${files[@]}")

bad=0
while IFS=$'\t' read -r n f; do
  b="${before[$f]:-0}"
  if [[ "$n" == "?" || "$b" == "?" ]]; then
    echo "✗ $f: biome output unreadable" >&2; bad=1; continue
  fi
  if (( n > b )); then
    echo "✗ $f: $n biome errors (was $b at the merge-base)" >&2
    # Preserve the strict count gate, and expose the exact rule/location so CI
    # failures can be fixed without rerunning a whole suite just for diagnostics.
    "$BIOME" lint --max-diagnostics=20 --files-max-size=8388608 "$f" >&2 || true
    bad=1
  elif (( n > 0 )); then
    echo "  $f: $n pre-existing errors (was $b), none added"
  fi
done < <(count_errors "$ROOT" "${files[@]}")

if (( bad )); then
  echo "✗ new biome errors; see: npx biome lint <file>" >&2
  exit 1
fi
echo "✓ no new biome errors"
