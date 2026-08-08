#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE=${H3_WORKER_ENV_FILE:-/root/.secrets/openclaude-h3-worker.env}

if [[ ! -s "$ENV_FILE" ]]; then
  echo "$ENV_FILE must define H3_WORKER_TOKEN before installing the service" >&2
  exit 1
fi
set -a
source "$ENV_FILE"
set +a
: "${H3_WORKER_TOKEN:?H3_WORKER_TOKEN is required}"

RELEASE=$(git -C "$ROOT" rev-parse HEAD)
RELEASE_ROOT=${H3_WORKER_RELEASE_ROOT:-/opt/openclaude-h3-worker}
TARGET="$RELEASE_ROOT/releases/$RELEASE"
mkdir -p "$RELEASE_ROOT/releases" "$RELEASE_ROOT/manifests"
MANIFEST="$RELEASE_ROOT/manifests/$RELEASE.sha256"
if [[ -e "$TARGET" || -e "$MANIFEST" ]]; then
  [[ -d "$TARGET" && -s "$MANIFEST" ]] || {
    echo "existing H3 worker candidate is incomplete or unsigned" >&2; exit 1;
  }
  (cd "$TARGET" && sha256sum -c "$MANIFEST" >/dev/null) || {
    echo "existing H3 worker candidate failed manifest verification" >&2; exit 1;
  }
else
  STAGING="$RELEASE_ROOT/releases/.${RELEASE}.staging.$$"
  manifest_tmp="$RELEASE_ROOT/manifests/.${RELEASE}.sha256.$$"
  trap 'rm -rf "$STAGING" "$manifest_tmp"' EXIT
  mkdir -p "$STAGING"
  # Archive the exact commit rather than copying a possibly dirty worktree.
  git -C "$ROOT" archive "$RELEASE" \
    scripts/minimax_h3_worker scripts/minimax_h3_sp | tar -x -C "$STAGING"
  find "$STAGING" -type d -name __pycache__ -prune -exec rm -rf {} +
  find "$STAGING" -type f -name '*.pyc' -delete
  (cd "$STAGING" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) >"$manifest_tmp"
  (cd "$STAGING" && sha256sum -c "$manifest_tmp" >/dev/null)
  chmod -R a-w "$STAGING"
  mv -T "$STAGING" "$TARGET"
  mv -T "$manifest_tmp" "$MANIFEST"
  trap - EXIT
fi
chmod -R a-w "$TARGET"

install -m 0644 "$TARGET/scripts/minimax_h3_worker/openclaude-h3-worker.service" \
  /etc/systemd/system/openclaude-h3-worker.service
install -m 0755 "$TARGET/scripts/minimax_h3_worker/activate-release.sh" \
  /usr/local/sbin/openclaude-h3-worker-activate
if [[ ! -L "$RELEASE_ROOT/current" ]]; then
  ln -sfn "$TARGET" "$RELEASE_ROOT/current.new"
  mv -Tf "$RELEASE_ROOT/current.new" "$RELEASE_ROOT/current"
fi
systemctl daemon-reload
systemctl enable --now openclaude-h3-worker.service
systemctl is-active --quiet openclaude-h3-worker.service
curl -fsS -H "Authorization: Bearer $H3_WORKER_TOKEN" \
  http://127.0.0.1:8390/v1/health
