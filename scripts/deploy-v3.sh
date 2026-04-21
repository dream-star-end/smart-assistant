#!/usr/bin/env bash
# deploy-v3.sh — One-command deploy of v3 host-layer to commercial-v3.
#
# What it does (in order):
#   1. Safety-check remote gateway: active WS connections must be ≤1.
#   2. Auto-bump all cache-bust version tokens (sw.js VERSION + ?v=XX) to
#      `git rev-parse --short HEAD`.
#   3. Stage + commit the version bump as `chore(deploy): v{HASH}` so history
#      has a clean marker of what got shipped. Only the 5 web files are added —
#      any other dirty files in the tree stay untouched.
#   4. rsync /opt/openclaude/openclaude-v3/ → commercial-v3:/opt/openclaude/openclaude/
#      (mirrors the flow documented in project memory `v3 商用版部署机制`).
#   5. `systemctl restart openclaude` on remote.
#   6. Health-check via https://claudeai.chat/healthz.
#
# This is for **host-layer changes only** (commercial/gateway code, web/public/*).
# For container-runtime changes, you still need the build-image.sh / docker
# load path — see memory `project_v3_deploy_mechanism.md`.
#
# Usage:
#   scripts/deploy-v3.sh
#   scripts/deploy-v3.sh --dry-run       # show what would happen, no writes
#   scripts/deploy-v3.sh --no-commit     # bump versions but don't auto-commit
#   scripts/deploy-v3.sh --force         # skip remote WS-count safety check

set -euo pipefail

# ── Locate repo root ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Sanity: must be the v3 worktree, not master or elsewhere.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "v3" ]]; then
  echo "ERROR: current branch is '$BRANCH', expected 'v3'. Refusing to deploy." >&2
  exit 1
fi

# ── Parse flags ──
DRY_RUN=0
NO_COMMIT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --no-commit) NO_COMMIT=1 ;;
    --force)     FORCE=1 ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

HASH=$(git rev-parse --short HEAD)
echo "=== deploy-v3 → hash $HASH  branch $BRANCH ==="

# ── 1. Remote safety check ──
if [[ $FORCE -eq 0 ]]; then
  echo "-- checking remote WS connections --"
  # ss output includes header, so -1 for actual count.
  WS_COUNT=$(ssh -o BatchMode=yes commercial-v3 \
    "ss -tn state established '( sport = :18789 )' 2>/dev/null | tail -n +2 | wc -l")
  if [[ "$WS_COUNT" -gt 1 ]]; then
    echo "ERROR: remote has $WS_COUNT active WS on :18789 (>1 = real users)." >&2
    echo "       wait for them to drop or pass --force to override." >&2
    exit 1
  fi
  echo "   remote WS count: $WS_COUNT (ok)"
fi

# ── 2. Bump cache-bust versions ──
echo "-- bumping version tokens to $HASH --"
if [[ $DRY_RUN -eq 1 ]]; then
  bun "$REPO_ROOT/scripts/bump-version.ts" --dry-run "$HASH" || true
else
  bun "$REPO_ROOT/scripts/bump-version.ts" "$HASH"
fi

# ── 3. Stage + commit version bump ──
VERSION_FILES=(
  packages/web/public/sw.js
  packages/web/public/index.html
  packages/web/public/admin.html
  packages/web/public/modules/main.js
  packages/web/public/modules/websocket.js
)

if [[ $DRY_RUN -eq 0 && $NO_COMMIT -eq 0 ]]; then
  # Stage only the version files — avoid grabbing unrelated WIP from the tree.
  git add "${VERSION_FILES[@]}" 2>/dev/null || true
  if git diff --cached --quiet; then
    echo "   (no version-bump diff to commit — already at $HASH)"
  else
    echo "-- committing chore(deploy): v$HASH --"
    git commit -m "chore(deploy): v$HASH" >/dev/null
    # HEAD moved; update HASH for any downstream consumers.
    HASH=$(git rev-parse --short HEAD)
    echo "   new HEAD: $HASH"
  fi
fi

# ── 4. rsync to commercial-v3 ──
# Excludes mirror memory `project_v3_deploy_mechanism.md`.
RSYNC_OPTS=(
  -az
  --delete-after
  --exclude=.git
  --exclude=node_modules
  --exclude='*.log'
  --exclude=/dist
  --exclude=/data
  --exclude=.env
  --exclude=_prov.mjs
  --exclude=/.playwright-mcp
  --exclude=/.claude
  --exclude=/.codex
  --exclude=/claude-code-best
)
if [[ $DRY_RUN -eq 1 ]]; then
  RSYNC_OPTS+=(--dry-run -v)
fi

echo "-- rsync → commercial-v3:/opt/openclaude/openclaude/ --"
rsync "${RSYNC_OPTS[@]}" "$REPO_ROOT/" commercial-v3:/opt/openclaude/openclaude/

if [[ $DRY_RUN -eq 1 ]]; then
  echo "=== dry-run complete — no remote restart ==="
  exit 0
fi

# ── 5. Remote restart ──
echo "-- restarting remote gateway --"
ssh commercial-v3 "systemctl restart openclaude && sleep 4 && systemctl is-active openclaude" || {
  echo "FATAL: remote restart failed" >&2
  ssh commercial-v3 'journalctl -u openclaude --no-pager -n 40' >&2 || true
  exit 1
}

# ── 6. Health-check via CF edge ──
echo "-- health-checking claudeai.chat --"
for attempt in 1 2 3 4 5; do
  if curl -sf --max-time 5 https://claudeai.chat/healthz >/dev/null; then
    echo "   healthz OK (attempt $attempt)"
    echo "=== deploy-v3 $HASH complete ==="
    exit 0
  fi
  sleep 2
done

echo "WARNING: healthz not responding after 5 attempts (gateway may still be warming up)" >&2
echo "=== deploy-v3 $HASH finished with warnings ==="
