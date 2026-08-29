#!/usr/bin/env bash
# Stage an exact-commit H3 worker archive on a systemd-less SCNet notebook.
# Usage: stage-notebook-release.sh <archive.tar> <40-char-release> <archive-sha256>
set -euo pipefail

ROOT=${H3_WORKER_RELEASE_ROOT:-/opt/openclaude-h3-worker}
[[ $# -eq 3 ]] || {
  echo "usage: $0 <archive.tar> <40-char-release> <archive-sha256>" >&2
  exit 2
}
archive=$(readlink -f "$1")
release=$2
expected_archive_sha=$3
[[ -f "$archive" ]] || { echo "worker archive is missing" >&2; exit 1; }
[[ "$release" =~ ^[0-9a-f]{40}$ ]] || {
  echo "release must be an exact 40-character commit" >&2
  exit 2
}
[[ "$expected_archive_sha" =~ ^[0-9a-f]{64}$ ]] || {
  echo "archive SHA-256 must be 64 lowercase hex characters" >&2
  exit 2
}
actual_archive_sha=$(sha256sum "$archive" | awk '{print $1}')
[[ "$actual_archive_sha" == "$expected_archive_sha" ]] || {
  echo "worker archive SHA-256 mismatch" >&2
  exit 1
}

mkdir -p "$ROOT/releases" "$ROOT/manifests"
exec 9>"$ROOT/stage.lock"
flock -x 9

target="$ROOT/releases/$release"
manifest="$ROOT/manifests/$release.sha256"
if [[ -e "$target" || -e "$manifest" ]]; then
  [[ -d "$target" && -s "$manifest" ]] || {
    echo "existing H3 worker candidate is incomplete or unsigned" >&2
    exit 1
  }
  (cd "$target" && sha256sum -c "$manifest" >/dev/null) || {
    echo "existing H3 worker candidate failed manifest verification" >&2
    exit 1
  }
  [[ "$(cat "$target/.release")" == "$release" ]] || {
    echo "existing H3 worker candidate release mismatch" >&2
    exit 1
  }
  [[ "$(cat "$target/.archive-sha256")" == "$expected_archive_sha" ]] || {
    echo "existing H3 worker candidate archive mismatch" >&2
    exit 1
  }
  printf '%s\n' "$release"
  exit 0
fi

staging="$ROOT/releases/.$release.staging.$$"
manifest_tmp="$ROOT/manifests/.$release.sha256.$$"
trap 'rm -rf "$staging" "$manifest_tmp"' EXIT
mkdir -p "$staging"
tar -xf "$archive" -C "$staging"
[[ -f "$staging/scripts/minimax_h3_worker/worker.py" \
  && -f "$staging/scripts/minimax_h3_worker/session_supervisor.py" \
  && -x "$staging/scripts/minimax_h3_sp/start.sh" \
  && -f "$staging/scripts/minimax_h3_sp/coordinator.py" ]] || {
  echo "worker archive is incomplete" >&2
  exit 1
}
find "$staging" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$staging" -type f -name '*.pyc' -delete
printf '%s\n' "$release" >"$staging/.release"
printf '%s\n' "$expected_archive_sha" >"$staging/.archive-sha256"
(cd "$staging" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$manifest_tmp"
(cd "$staging" && sha256sum -c "$manifest_tmp" >/dev/null)
chmod -R a-w "$staging"
mv -T "$staging" "$target"
mv -T "$manifest_tmp" "$manifest"
trap - EXIT
printf '%s\n' "$release"
