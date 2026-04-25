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
#   7. Snapshot remote /opt/openclaude/openclaude/ → /opt/openclaude/openclaude.prev.1/
#      (rotates .prev.1..5/ ctime-ordered; oldest dropped). Legacy single-gen
#      .prev/ (if present) is migrated to .prev.1/ once on first new deploy.
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
#   scripts/deploy-v3.sh --rollback      # restore .prev.1/ (latest snapshot) + restart
#   scripts/deploy-v3.sh --rollback=N    # restore .prev.N/ (N=1..5) + restart
#
# Rollback window = up to 5 deploys (.prev.1..5/ rotation). Rollback does NOT
# restore changelog.json in paths.home (accepted small inconsistency — next
# forward deploy fixes it).

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
# Rollback request is two-state: ROLLBACK_REQUESTED tracks whether the user
# typed any --rollback* flag at all; ROLLBACK_N holds the literal target value
# (validated as a string regex ^[1-5]$ before any numeric eval). Splitting
# these avoids the silent surprise where `--rollback=` (empty value) or
# `--rollback=0` would otherwise look identical to "no flag" and fall through
# to the main deploy path.
ROLLBACK_REQUESTED=0
ROLLBACK_N=""
NO_CHANGELOG=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --no-commit)    NO_COMMIT=1 ;;
    --force)        FORCE=1 ;;
    --rollback)     ROLLBACK_REQUESTED=1; ROLLBACK_N=1 ;;             # latest snapshot (.prev.1/)
    --rollback=*)   ROLLBACK_REQUESTED=1; ROLLBACK_N="${arg#*=}" ;;   # specific generation; validated below
    --no-changelog) NO_CHANGELOG=1 ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ── Load CF credentials from .env.keys (optional; purge is graceful-degrade) ──
# Only read the two specific vars we need — don't `source` the whole file
# to avoid polluting the deploy script's env with unrelated keys.
CLOUDFLARE_API_TOKEN=""
CLOUDFLARE_ZONE_ID_CLAUDEAI=""
ENV_KEYS_PATH="/root/.openclaude/.env.keys"
if [[ -f "$ENV_KEYS_PATH" ]]; then
  CLOUDFLARE_API_TOKEN=$(grep -E '^CLOUDFLARE_API_TOKEN=' "$ENV_KEYS_PATH" | head -1 | cut -d= -f2- || true)
  CLOUDFLARE_ZONE_ID_CLAUDEAI=$(grep -E '^CLOUDFLARE_ZONE_ID_CLAUDEAI=' "$ENV_KEYS_PATH" | head -1 | cut -d= -f2- || true)
fi

# ── Shared: CF edge cache purge ──
# Why this exists: SW's `cache: 'no-store'` only bypasses the browser's HTTP
# cache, NOT CF's edge cache. Versioned URLs (main.js?v=HASH) miss CF cleanly,
# but bare-URL imports inside main.js (e.g. `import './state.js'`) hit the edge
# and get the OLD file for up to 4h (max-age=14400). Result: new main.js calls
# a symbol the old state.js doesn't export → module graph fails → black screen.
# This purge tells CF to drop the cached copies so the next fetch returns new.
#
# Failure mode: warn-only. Code is already live at this point; purge failing
# just means users might see stale cache for the normal TTL (4h). We don't want
# to mark the deploy as failed and block the git tag / smoke flow over a cache op.
cf_purge() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "   (--dry-run, skipping CF purge)"
    return 0
  fi
  if [[ -z "$CLOUDFLARE_API_TOKEN" || -z "$CLOUDFLARE_ZONE_ID_CLAUDEAI" ]]; then
    echo "   WARN: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID_CLAUDEAI not set in $ENV_KEYS_PATH — skipping CF purge" >&2
    echo "         new deploys may take up to 4h (CF edge max-age) to propagate fully." >&2
    return 0
  fi

  echo "-- purging CF edge cache --"

  # Extract the SHELL array literals from sw.js. Scoped strictly to the
  # `const SHELL = [ ... ]` block so we don't pick up unrelated path strings
  # ('/api/', '/ws', '/healthz', etc.) that appear in the fetch handler.
  local shell_paths=()
  mapfile -t shell_paths < <(
    awk '/^const SHELL = \[/,/^\]/' packages/web/public/sw.js \
      | grep -oE "'/[^']*'" | tr -d "'" | sort -u
  )
  # Fallback guard: if the parser picked up too few items, format likely changed.
  # Refuse to run a degenerate purge (which would leave most files stale anyway).
  if (( ${#shell_paths[@]} < 5 )); then
    echo "   WARN: parsed only ${#shell_paths[@]} paths from sw.js SHELL — format may have changed; skipping purge" >&2
    return 0
  fi

  # URLs to purge = SHELL entries + a few that are served but not in SHELL.
  local urls=()
  local p
  for p in "${shell_paths[@]}"; do
    urls+=("https://claudeai.chat$p")
  done
  # admin.html is served but not in SHELL (admins only, no SW precache).
  urls+=("https://claudeai.chat/admin.html")

  echo "   purging ${#urls[@]} URLs in batches of 30"

  # CF's purge_cache endpoint caps `files` at 30 per call. Batch it.
  local i batch body_files resp
  for ((i=0; i<${#urls[@]}; i+=30)); do
    batch=("${urls[@]:i:30}")
    body_files=$(printf '"%s",' "${batch[@]}" | sed 's/,$//')
    resp=$(curl -sS -X POST \
      "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID_CLAUDEAI/purge_cache" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "{\"files\":[$body_files]}" 2>&1) || {
        echo "   WARN: CF purge batch $((i/30+1)) curl failed: $resp" >&2
        continue
      }
    # CF returns {"success":true,...} on happy path.
    if ! grep -q '"success":true' <<<"$resp"; then
      echo "   WARN: CF purge batch $((i/30+1)) returned non-success: $resp" >&2
    fi
  done
  echo "   CF purge done"
}

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
# Restores commercial-v3:/opt/openclaude/openclaude.prev.N/ back to
# /opt/openclaude/openclaude/, then restart + healthz. Skips bump/commit/push.
# .prev.1..5/ snapshots are created by the normal deploy path (rotation just
# before rsync). N=1 = latest snapshot; N=5 = oldest still-retained snapshot.
if [[ $ROLLBACK_REQUESTED -eq 1 ]]; then
  # String-first validation: covers --rollback=0, --rollback=, --rollback=1.5,
  # --rollback=abc, --rollback=6 etc. before any numeric eval.
  if ! [[ "$ROLLBACK_N" =~ ^[1-5]$ ]]; then
    echo "ERROR: --rollback=N requires N in 1..5 (got: '$ROLLBACK_N')" >&2
    exit 2
  fi
  echo "=== deploy-v3 ROLLBACK → .prev.${ROLLBACK_N}/ ==="
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "ERROR: --dry-run with --rollback is not meaningful (nothing local changes)." >&2
    exit 2
  fi
  remote_safety_check

  PREV_DIR="/opt/openclaude/openclaude.prev.${ROLLBACK_N}"
  # Verify snapshot exists on remote before touching anything.
  if ! ssh commercial-v3 "test -d '${PREV_DIR}' && test -f '${PREV_DIR}/package.json'" 2>/dev/null; then
    echo "ERROR: no rollback snapshot at commercial-v3:${PREV_DIR}/" >&2
    echo "       (snapshot from ${ROLLBACK_N} deploys ago not yet rotated into existence," >&2
    echo "        or was manually removed). Cannot proceed." >&2
    exit 1
  fi

  echo "-- restoring ${PREV_DIR}/ → /opt/openclaude/openclaude/ --"
  # -a preserves perms/times; --delete mirrors the prev snapshot exactly.
  # Exclude data/node_modules so we don't churn those on restore — they live outside
  # the code layer and shouldn't diverge just from a rollback. .env likewise stays put.
  ssh commercial-v3 "rsync -a --delete \
    --exclude=/data \
    --exclude=/node_modules \
    --exclude=.env \
    '${PREV_DIR}/' /opt/openclaude/openclaude/" || {
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

# ── 4. Snapshot remote state for --rollback (5-gen rotation) ──
# Runs BEFORE the push so .prev.1/ captures what's currently live. Using rsync
# with --delete inside the remote shell is fast (local disk) and atomic enough:
# if this step fails we exit before touching /opt/openclaude/openclaude/, so we
# never end up in a state where the live tree is half-updated and .prev.1 is bad.
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
#
# Rotation strategy (P2-18):
#   1. Legacy migration: if a single-gen .prev/ exists from before this script
#      version (and no .prev.1/ yet), rename it to .prev.1/. One-shot, idempotent.
#      If both exist (corrupt mixed state), keep the rotated chain and warn —
#      don't auto-delete legacy data without operator review.
#   2. Stage new snapshot in .prev.new/. If rsync fails, .prev.1..5/ are
#      untouched; .prev.new/ remains for inspection and is overwritten next run
#      (every snapshot starts with `rm -rf .prev.new` before the rsync).
#   3. Rotate via mv (O(1) metadata): drop .prev.5, shift 4→5, 3→4, 2→3, 1→2,
#      then promote .prev.new → .prev.1. Each `mv` is guarded against
#      dest-exists (would otherwise nest dirs under a corrupt mixed state).
#
# Crash safety: live tree is not touched until after this block returns 0. A
# crash during the mv-chain can leave a gap in the chain; deploy aborts before
# push and operator can inspect/repair. Not a full transaction system by
# design — see Codex review M8.1 for rationale.
if [[ $DRY_RUN -eq 0 ]]; then
  echo "-- snapshotting remote live tree → /opt/openclaude/openclaude.prev.1/ (5-gen rotation) --"
  ssh commercial-v3 'bash -s' <<'REMOTE' || {
set -euo pipefail
PREV_BASE=/opt/openclaude/openclaude.prev
LIVE=/opt/openclaude/openclaude

# 1. Legacy single-gen .prev/ migration (one-shot, idempotent).
if [ -d "${PREV_BASE}" ] && [ ! -d "${PREV_BASE}.1" ]; then
  echo "   (migrating legacy ${PREV_BASE}/ → ${PREV_BASE}.1/)"
  mv "${PREV_BASE}" "${PREV_BASE}.1"
elif [ -d "${PREV_BASE}" ]; then
  echo "   WARN: legacy ${PREV_BASE}/ exists alongside rotated snapshots; leaving untouched" >&2
fi

# 2. Stage new snapshot in .prev.new/ (any prior residue cleared first).
NEW="${PREV_BASE}.new"
rm -rf "$NEW"
mkdir -p "$NEW"
rsync -a --delete --delete-excluded \
  --exclude=/data \
  --exclude=/node_modules \
  --exclude=.env \
  "${LIVE}/" "${NEW}/"

# 3. Rotate: drop oldest, shift older→older+1, promote new→1.
[ -d "${PREV_BASE}.5" ] && rm -rf "${PREV_BASE}.5"
for i in 4 3 2 1; do
  if [ -d "${PREV_BASE}.${i}" ]; then
    if [ -e "${PREV_BASE}.$((i+1))" ]; then
      echo "FATAL: ${PREV_BASE}.$((i+1)) unexpectedly exists; aborting rotation" >&2
      exit 1
    fi
    mv "${PREV_BASE}.${i}" "${PREV_BASE}.$((i+1))"
  fi
done
mv "$NEW" "${PREV_BASE}.1"
REMOTE
    echo "FATAL: remote snapshot/rotation failed; aborting before push" >&2
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
  echo "   rollback (latest):  scripts/deploy-v3.sh --rollback" >&2
  echo "   rollback older:     scripts/deploy-v3.sh --rollback=N   (N=1..5)" >&2
  exit 1
fi

# ── 8.5. CF edge cache purge ──
# After healthz passes (= new code is live), tell CF to drop cached copies of
# the app shell so users stop getting the 4h-stale pre-deploy versions. Without
# this, bare-URL module imports (import './state.js') keep hitting edge cache
# and loading the old file, causing module-graph load failures → black screen.
# Graceful-degrade: failure here doesn't block smoke/tag (code is already live).
cf_purge

# ── 9. Smoke test ──
echo "-- running smoke-v3 --"
if ! bash "$REPO_ROOT/scripts/smoke-v3.sh" "$TAG" https://claudeai.chat; then
  echo "" >&2
  echo "=== deploy-v3 $TAG FAILED at smoke ===" >&2
  echo "   code is LIVE but one or more smoke checks failed." >&2
  echo "   inspect: curl https://claudeai.chat/version" >&2
  echo "   rollback (latest):  scripts/deploy-v3.sh --rollback" >&2
  echo "   rollback older:     scripts/deploy-v3.sh --rollback=N   (N=1..5)" >&2
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
echo "   rollback (latest):  scripts/deploy-v3.sh --rollback"
echo "   rollback older:     scripts/deploy-v3.sh --rollback=N   (N=1..5)"
