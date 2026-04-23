#!/usr/bin/env bash
# deploy-v3.sh — One-command deploy of v3 host-layer to commercial-v3.
#
# What it does (in order):
#   1. Safety-check remote gateway: active WS connections must be ≤1.
#   2. Compute TAG = v3-<UTC-YYYYMMDDTHHMMZ>-<sourceHash> (tag suffix reflects
#      the pre-deploy source commit, NOT the tagged HEAD after version-bump).
#   3. Pre-check changelog.json for exactly-one version:"PENDING" entry.
#      0 entries → y/N prompt (or --no-changelog to skip). 2+ → abort.
#   4. Auto-bump cache-bust tokens (sw.js VERSION + ?v=XX) to source hash.
#   5. Finalize changelog: replace PENDING → TAG, bump currentVersion.
#   6. Stage + commit bump + changelog as `chore(deploy): v<TAG>`.
#   7. Snapshot remote /opt/openclaude/openclaude/ → /opt/openclaude/openclaude.prev/.
#   8. rsync /opt/openclaude/openclaude-v3/ → commercial-v3:/opt/openclaude/openclaude/.
#   9. Write VERSION.json on remote (atomic: scp → ssh mv).
#  10. rsync repo changelog.json → commercial-v3:/root/.openclaude/changelog.json
#      (because /api/changelog reads paths.home, not code dir). Failure aborts.
#  11. `systemctl restart openclaude` on remote + /healthz probe.
#  12. Run scripts/smoke-v3.sh <TAG> https://claudeai.chat. Failure → print
#      rollback hint and exit non-zero (NO auto-rollback — smoke bugs are too
#      costly if they trigger false rollback).
#  13. git tag <TAG> HEAD && git push origin <TAG> (failure is warn-only —
#      code is already live; tag is just a bookmark).
#
# Usage:
#   scripts/deploy-v3.sh
#   scripts/deploy-v3.sh --dry-run       # show what would happen, no writes
#   scripts/deploy-v3.sh --no-commit     # bump versions but don't auto-commit
#   scripts/deploy-v3.sh --no-changelog  # skip PENDING prompt when 0 entries
#   scripts/deploy-v3.sh --force         # skip remote WS-count safety check
#   scripts/deploy-v3.sh --rollback      # restore last snapshot (.prev/) + restart
#
# Rollback window = one deploy. Rollback does NOT restore changelog.json in
# paths.home (accepted small inconsistency — next forward deploy fixes it).

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
NO_CHANGELOG=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --no-commit)    NO_COMMIT=1 ;;
    --force)        FORCE=1 ;;
    --rollback)     ROLLBACK=1 ;;
    --no-changelog) NO_CHANGELOG=1 ;;
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
# TAG is computed once at the start and used for:
#   - VERSION.json (written on remote; /version endpoint serves it)
#   - changelog.json finalize (replaces PENDING markers)
#   - deploy commit message
#   - git tag at the end
# NOTE: the <hash> suffix is the *source* hash at deploy start, NOT the HEAD
# commit after the bump + changelog commit. Tag naming intentionally reflects
# "what code base this deploy shipped from", not the synthetic bump commit.
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TAG="v3-$(date -u +%Y%m%dT%H%MZ)-$HASH"
echo "=== deploy-v3 → tag $TAG  branch $BRANCH ==="

# ── 1. Remote safety check ──
remote_safety_check

# ── 2. Changelog PENDING pre-check ──
# Expect exactly one release entry with version:"PENDING". 0 → prompt (or skip
# via --no-changelog); 2+ → abort (ambiguous which to finalize).
PENDING_COUNT=$(bun "$REPO_ROOT/scripts/changelog-finalize.ts" --count)
echo "-- changelog PENDING entries: $PENDING_COUNT --"
case "$PENDING_COUNT" in
  0)
    if [[ $NO_CHANGELOG -eq 1 ]]; then
      echo "   (--no-changelog, skipping prompt)"
    elif [[ -t 0 ]]; then
      read -r -p "   No PENDING entry in changelog.json. Continue anyway? [y/N] " reply
      case "$reply" in
        y|Y|yes|YES) echo "   proceeding without changelog update" ;;
        *) echo "   aborted by user"; exit 1 ;;
      esac
    else
      echo "ERROR: 0 PENDING entries and stdin is not a TTY." >&2
      echo "       Either prepend a {version:\"PENDING\", ...} entry to changelog.json" >&2
      echo "       or pass --no-changelog." >&2
      exit 1
    fi
    ;;
  1) : ;; # OK
  *)
    echo "ERROR: $PENDING_COUNT PENDING entries in changelog.json (expect 0 or 1)." >&2
    echo "       Collapse them into one before deploying." >&2
    exit 1
    ;;
esac

# ── 3. Bump cache-bust versions ──
echo "-- bumping version tokens to $HASH --"
if [[ $DRY_RUN -eq 1 ]]; then
  bun "$REPO_ROOT/scripts/bump-version.ts" --dry-run "$HASH" || true
else
  bun "$REPO_ROOT/scripts/bump-version.ts" "$HASH"
fi

# ── 4. Finalize changelog (replace PENDING → TAG) ──
# Only when there's actually a PENDING entry. Otherwise no-op.
if [[ $DRY_RUN -eq 0 && "$PENDING_COUNT" == "1" ]]; then
  echo "-- finalizing changelog.json PENDING → $TAG --"
  bun "$REPO_ROOT/scripts/changelog-finalize.ts" "$TAG"
fi

# ── 5. Stage + commit version bump + changelog ──
VERSION_FILES=(
  packages/web/public/sw.js
  packages/web/public/index.html
  packages/web/public/admin.html
  packages/web/public/modules/main.js
  packages/web/public/modules/websocket.js
  packages/web/public/modules/commands.js
  changelog.json
)

if [[ $DRY_RUN -eq 0 && $NO_COMMIT -eq 0 ]]; then
  # Stage only the deploy-owned files — avoid grabbing unrelated WIP from the tree.
  git add "${VERSION_FILES[@]}" 2>/dev/null || true
  if git diff --cached --quiet; then
    echo "   (no deploy diff to commit — already at $HASH / no PENDING)"
  else
    echo "-- committing chore(deploy): $TAG --"
    git commit -m "chore(deploy): $TAG" >/dev/null
    # HEAD moved; record new HEAD but keep TAG (which embeds the pre-deploy hash).
    echo "   new HEAD: $(git rev-parse --short HEAD)"
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

# ── 6. Write VERSION.json on remote (atomic: scp → ssh mv) ──
# Must happen AFTER rsync (which could --delete stale files) and BEFORE restart
# (so /version serves this tag on first request). Atomicity matters because the
# gateway is still running at this point; a half-written file would surface as
# "tag":"unknown" to probes that race the write.
VERSION_TMP_LOCAL=$(mktemp -t VERSION.XXXXXX.json)
trap 'rm -f "$VERSION_TMP_LOCAL"' EXIT
# Use the DEPLOY commit (post bump + changelog finalize), NOT the pre-deploy
# source hash — that's what's actually running on the server. TAG suffix keeps
# the source hash as intended (traceability to the business change), but
# /version.commit must reflect the live code.
DEPLOY_COMMIT=$(git rev-parse --short HEAD)
cat > "$VERSION_TMP_LOCAL" <<EOF
{"tag":"$TAG","commit":"$DEPLOY_COMMIT","builtAt":"$BUILT_AT"}
EOF
echo "-- pushing VERSION.json → remote --"
scp -q "$VERSION_TMP_LOCAL" commercial-v3:/opt/openclaude/openclaude/.VERSION.json.tmp || {
  echo "FATAL: scp VERSION.json failed" >&2; exit 1
}
ssh commercial-v3 'mv /opt/openclaude/openclaude/.VERSION.json.tmp /opt/openclaude/openclaude/VERSION.json' || {
  echo "FATAL: remote mv VERSION.json failed" >&2; exit 1
}

# ── 7. rsync changelog.json to paths.home (/api/changelog reads from there) ──
# paths.home on prod = /root/.openclaude/ (OPENCLAUDE_HOME not set in commercial.env).
# This is separate from the code-dir rsync above because .env & paths.home live
# outside the code tree and are intentionally excluded from the main push.
echo "-- rsync changelog.json → commercial-v3:/root/.openclaude/changelog.json --"
rsync -az "$REPO_ROOT/changelog.json" commercial-v3:/root/.openclaude/changelog.json || {
  echo "FATAL: changelog rsync to paths.home failed — aborting before restart" >&2
  echo "       Frontend would show stale changelog for this release." >&2
  exit 1
}

# ── 8. Remote restart + health-check ──
if ! remote_restart_and_healthz; then
  echo "=== deploy-v3 $TAG FAILED at healthz ===" >&2
  echo "   rollback: scripts/deploy-v3.sh --rollback" >&2
  exit 1
fi

# ── 9. Smoke test ──
echo "-- running smoke-v3 --"
if ! bash "$REPO_ROOT/scripts/smoke-v3.sh" "$TAG" https://claudeai.chat; then
  echo "" >&2
  echo "=== deploy-v3 $TAG FAILED at smoke ===" >&2
  echo "   code is LIVE but one or more smoke checks failed." >&2
  echo "   inspect: curl https://claudeai.chat/version" >&2
  echo "   rollback: scripts/deploy-v3.sh --rollback" >&2
  exit 1
fi

# ── 10. Git tag + push (non-fatal) ──
# Tag only on full success (healthz + smoke). Failure here is just cosmetic —
# the code is already live, /version reports the tag, the deploy commit is in
# history. We warn but don't exit non-zero.
echo "-- tagging $TAG --"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "   WARN: local tag $TAG already exists (reusing)" >&2
elif ! git tag "$TAG" HEAD; then
  echo "   WARN: git tag failed; code is live but tag not created" >&2
fi
if ! git push origin "$TAG" 2>&1; then
  echo "   WARN: git push origin $TAG failed; tag exists locally only" >&2
fi

echo ""
echo "=== deploy-v3 $TAG complete ==="
echo "   live: curl https://claudeai.chat/version"
echo "   rollback: scripts/deploy-v3.sh --rollback"
