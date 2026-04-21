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
#   4. Snapshot remote /opt/openclaude/openclaude/ → /opt/openclaude/openclaude.prev/
#      (for one-version-back rollback via `--rollback`).
#   5. rsync /opt/openclaude/openclaude-v3/ → commercial-v3:/opt/openclaude/openclaude/
#      (mirrors the flow documented in project memory `v3 商用版部署机制`).
#   6. `systemctl restart openclaude` on remote.
#   7. Health-check via https://claudeai.chat/healthz.
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
#   scripts/deploy-v3.sh --rollback      # restore last snapshot (.prev/) + restart
#
# Rollback window = one deploy. Each successful deploy overwrites the snapshot,
# so --rollback only un-does the most recent deploy. For older state, use git.

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
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --no-commit) NO_COMMIT=1 ;;
    --force)     FORCE=1 ;;
    --rollback)  ROLLBACK=1 ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ── Shared: remote WS safety check ──
# Returns the current active WS count; bails if >1 unless FORCE.
remote_safety_check() {
  if [[ $FORCE -eq 1 ]]; then
    echo "   (--force set, skipping WS safety check)"
    return 0
  fi
  echo "-- checking remote WS connections --"
  local ws_count
  ws_count=$(ssh -o BatchMode=yes commercial-v3 \
    "ss -tn state established '( sport = :18789 )' 2>/dev/null | tail -n +2 | wc -l")
  if [[ "$ws_count" -gt 1 ]]; then
    echo "ERROR: remote has $ws_count active WS on :18789 (>1 = real users)." >&2
    echo "       wait for them to drop or pass --force to override." >&2
    exit 1
  fi
  echo "   remote WS count: $ws_count (ok)"
}

# ── Shared: remote restart + healthz loop ──
remote_restart_and_healthz() {
  echo "-- restarting remote gateway --"
  ssh commercial-v3 "systemctl restart openclaude && sleep 4 && systemctl is-active openclaude" || {
    echo "FATAL: remote restart failed" >&2
    ssh commercial-v3 'journalctl -u openclaude --no-pager -n 40' >&2 || true
    exit 1
  }
  echo "-- health-checking claudeai.chat --"
  local attempt
  for attempt in 1 2 3 4 5; do
    if curl -sf --max-time 5 https://claudeai.chat/healthz >/dev/null; then
      echo "   healthz OK (attempt $attempt)"
      return 0
    fi
    sleep 2
  done
  echo "WARNING: healthz not responding after 5 attempts (gateway may still be warming up)" >&2
  return 1
}

# ── Rollback path ──
# Restores commercial-v3:/opt/openclaude/openclaude.prev/ back to
# /opt/openclaude/openclaude/, then restart + healthz. Skips bump/commit/push.
# The `.prev/` snapshot is created by the normal deploy path just before rsync.
if [[ $ROLLBACK -eq 1 ]]; then
  echo "=== deploy-v3 ROLLBACK ==="
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "ERROR: --dry-run with --rollback is not meaningful (nothing local changes)." >&2
    exit 2
  fi
  remote_safety_check

  # Verify snapshot exists on remote before touching anything.
  if ! ssh commercial-v3 'test -d /opt/openclaude/openclaude.prev && test -f /opt/openclaude/openclaude.prev/package.json' 2>/dev/null; then
    echo "ERROR: no rollback snapshot at commercial-v3:/opt/openclaude/openclaude.prev/" >&2
    echo "       (either no deploy has been run since --rollback was added, or the" >&2
    echo "        snapshot was manually removed). Cannot proceed." >&2
    exit 1
  fi

  echo "-- restoring /opt/openclaude/openclaude.prev/ → /opt/openclaude/openclaude/ --"
  # -a preserves perms/times; --delete mirrors the prev snapshot exactly.
  # Exclude data/node_modules so we don't churn those on restore — they live outside
  # the code layer and shouldn't diverge just from a rollback. .env likewise stays put.
  ssh commercial-v3 "rsync -a --delete \
    --exclude=/data \
    --exclude=/node_modules \
    --exclude=.env \
    /opt/openclaude/openclaude.prev/ /opt/openclaude/openclaude/" || {
    echo "FATAL: rollback rsync failed" >&2
    exit 1
  }

  remote_restart_and_healthz
  echo "=== deploy-v3 rollback complete ==="
  exit 0
fi

HASH=$(git rev-parse --short HEAD)
echo "=== deploy-v3 → hash $HASH  branch $BRANCH ==="

# ── 1. Remote safety check ──
remote_safety_check

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

# ── 4. Snapshot remote state for --rollback ──
# Runs BEFORE the push so .prev/ captures what's currently live. Using rsync
# with --delete inside the remote shell is fast (local disk) and atomic enough:
# if this step fails we exit before touching /opt/openclaude/openclaude/, so we
# never end up in a state where the live tree is half-updated and .prev is bad.
# data/node_modules/.env are excluded on purpose — they're not part of the code
# layer and rolling them back from an older snapshot could be destructive
# (e.g. fresh container user-data shouldn't revert).
#
# Codex review IMPORTANT#3:rsync --exclude 只是不从源复制,并不会删除
# destination 里已经存在的同名路径。如果之前的 snapshot 里残留了旧 .env/data/
# node_modules(历史迁移或手工操作),--delete 会保留它们,rollback 时又会被复
# 制回 live 树 —— 用明确的 rm + --delete-excluded 双保险。
# --delete-excluded 只在 snapshot 方向用;rollback 方向不加,否则会删 live 的
# .env/data/node_modules。
if [[ $DRY_RUN -eq 0 ]]; then
  echo "-- snapshotting remote live tree → /opt/openclaude/openclaude.prev/ --"
  ssh commercial-v3 "mkdir -p /opt/openclaude/openclaude.prev && \
    rsync -a --delete --delete-excluded \
      --exclude=/data \
      --exclude=/node_modules \
      --exclude=.env \
      /opt/openclaude/openclaude/ /opt/openclaude/openclaude.prev/" || {
    echo "FATAL: remote snapshot failed; aborting before push" >&2
    exit 1
  }
fi

# ── 5. rsync to commercial-v3 ──
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

# ── 6./7. Remote restart + health-check ──
if remote_restart_and_healthz; then
  echo "=== deploy-v3 $HASH complete ==="
  echo "   (rollback available: scripts/deploy-v3.sh --rollback)"
  exit 0
fi
echo "=== deploy-v3 $HASH finished with warnings ==="
echo "   (rollback available: scripts/deploy-v3.sh --rollback)"
