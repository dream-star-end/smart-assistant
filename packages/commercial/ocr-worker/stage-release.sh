#!/bin/bash
# Build one immutable, manifest-bound OCR worker candidate before activation.
# Usage: stage-release.sh <source-directory> <40-character-source-commit>
set -euo pipefail

ROOT=${OC_OCR_RELEASE_ROOT:-/opt/openclaude-ocr-worker}
[[ $# -eq 2 ]] || { echo "usage: $0 <source-directory> <40-character-source-commit>" >&2; exit 2; }
source_dir=$(readlink -f "$1")
release_id=$2
[[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || { echo "release must be an exact 40-character source commit" >&2; exit 2; }
[[ -x "$source_dir/run-supervisor.sh" ]] || { echo "invalid OCR worker source directory" >&2; exit 1; }

mkdir -p "$ROOT/releases" "$ROOT/manifests"
exec 9>"$ROOT/stage.lock"
flock -x 9

target="$ROOT/releases/$release_id"
manifest="$ROOT/manifests/$release_id.sha256"
if [[ -e "$target" || -e "$manifest" ]]; then
  [[ -d "$target" && -s "$manifest" ]] || { echo "incomplete existing OCR worker candidate" >&2; exit 1; }
  (cd "$target" && sha256sum -c "$manifest" >/dev/null) || {
    echo "existing OCR worker candidate failed manifest verification" >&2; exit 1;
  }
  printf '%s\n' "$release_id"
  exit 0
fi

staging="$ROOT/releases/.$release_id.staging.$$"
manifest_tmp="$ROOT/manifests/.$release_id.sha256.$$"
trap 'rm -rf "$staging" "$manifest_tmp"' EXIT
mkdir -p "$staging"
cp -a "$source_dir/." "$staging/"
find "$staging" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$staging" -type f -name '*.pyc' -delete
(cd "$staging" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$manifest_tmp"
(cd "$staging" && sha256sum -c "$manifest_tmp" >/dev/null)
chmod -R a-w "$staging"
mv -T "$staging" "$target"
mv -T "$manifest_tmp" "$manifest"
trap - EXIT
printf '%s\n' "$release_id"
