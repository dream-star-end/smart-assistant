#!/usr/bin/env bash
# sync-kl-standby.sh — Push code/VERSION/changelog/runtime-images to the KL hot
# standby (kuala-lumpur, 154.193.246.236) so it stays in lock-step with the
# commercial-v3 prod master between PG-replication and an eventual switchover.
#
# This is best-effort: deploy-v3.sh calls this AFTER smoke passed, and treats
# any failure here as non-blocking (commercial-v3 is already live). Boss may
# also invoke this manually right before triggering the actual cutover to
# guarantee KL is fully fresh.
#
# Concurrency model (closes the TOCTOU window a plain sentinel-check leaves):
#   * Local flock on 45.32  — /tmp/openclaude-kl-sync.lock — serializes
#     two concurrent deploy-v3.sh runs from this host.
#   * Remote flock on KL    — /var/lock/v3-kl-sync.lock — wraps an atomic
#     "check sentinels + set KL_SYNCING" critical section. switchover.sh
#     takes the same lock to atomically "check KL_SYNCING + set KL_PROMOTING".
#   * Two mutex sentinels   — /opt/openclaude/migration-ops/KL_SYNCING and
#     /opt/openclaude/migration-ops/KL_PROMOTING. Whichever script creates
#     its sentinel first wins; the other backs off.
#
# Gates evaluated atomically inside the remote flock:
#   1. KL openclaude       — must equal `inactive`. Any other state (active/
#                            activating/failed/etc) means KL is not a clean
#                            standby and we refuse to write to it.
#   2. KL_PROMOTING absent — switchover.sh not in flight.
#   3. KL_SYNCING absent   — no other sync (concurrent or stale).
#   4. pg_is_in_recovery() — must equal `t`. Promoted KL is the new
#                            authoritative writer; pushing stale code is a
#                            footgun.
#
# Failure semantics (exit codes):
#   0  — fully succeeded, OR gracefully skipped (KL unreachable / KL not a
#        clean standby / switchover in flight / SKIP_KL_SYNC=1). All
#        graceful-skips log WARN.
#   1  — hard failure: rsync code/changelog failed, VERSION write mismatched,
#        or final sanity check failed. Image transfer failures are warned but
#        not hard — KL retains the previous image and can still serve from it.
#
# Env knobs:
#   SKIP_KL_SYNC=1     — bypass entirely.
#   KL_SSH_ALIAS       — override SSH host alias (default kl-mirror).
#   TAG/DEPLOY_COMMIT/BUILT_AT — exported by deploy-v3.sh. If absent, the
#                                script reads VERSION.json from commercial-v3
#                                (the authoritative deployed state). This is
#                                what makes manual `bash scripts/sync-kl-standby.sh`
#                                retries work after a deploy hook fails.

set -euo pipefail

# ── 0. Locate repo root + load TAG/DEPLOY_COMMIT/BUILT_AT ─────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KL_SSH_ALIAS="${KL_SSH_ALIAS:-kl-mirror}"
TOKYO_SSH_ALIAS="commercial-v3"

if [[ "${SKIP_KL_SYNC:-0}" == "1" ]]; then
  echo "[sync-kl] SKIP_KL_SYNC=1 — exiting without action"
  exit 0
fi

# Single-instance lock: only one sync-kl-standby may run at a time on this host.
# This is what protects against concurrent deploy-v3.sh runs racing on KL's
# filesystem / docker daemon and producing inconsistent VERSION ↔ code state.
exec 9>/tmp/openclaude-kl-sync.lock
if ! flock -n 9; then
  echo "[sync-kl] another KL sync is already running — skipping" >&2
  exit 0
fi

# Allow override from env (deploy-v3.sh exports these); otherwise fall back to
# the live VERSION.json on commercial-v3 — that file is the authoritative
# record of what's currently deployed. Local repo VERSION.json doesn't exist
# in this worktree (it's only generated transiently during deploy and shipped
# to the remote), so a manual `bash scripts/sync-kl-standby.sh` retry must
# learn the deployed values from prod.
if [[ -z "${TAG:-}" || -z "${DEPLOY_COMMIT:-}" || -z "${BUILT_AT:-}" ]]; then
  echo "[sync-kl] TAG/DEPLOY_COMMIT/BUILT_AT not in env — fetching from $TOKYO_SSH_ALIAS"
  if ! REMOTE_VERSION=$(ssh "$TOKYO_SSH_ALIAS" "cat /opt/openclaude/openclaude/VERSION.json" 2>/dev/null); then
    echo "[sync-kl] FATAL: could not read VERSION.json from $TOKYO_SSH_ALIAS" >&2
    exit 1
  fi
  # Single-step `sed -n .../p` avoids the `grep | sed` pipefail gotcha — sed
  # returns 0 even on no-match, so set -e doesn't kill the script before the
  # explicit `if [[ -z ... ]]` check below produces a useful error message.
  TAG="$(printf '%s' "$REMOTE_VERSION" | sed -n 's/.*"tag":"\([^"]*\)".*/\1/p' | head -1)"
  DEPLOY_COMMIT="$(printf '%s' "$REMOTE_VERSION" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' | head -1)"
  BUILT_AT="$(printf '%s' "$REMOTE_VERSION" | sed -n 's/.*"builtAt":"\([^"]*\)".*/\1/p' | head -1)"
  if [[ -z "$TAG" || -z "$DEPLOY_COMMIT" || -z "$BUILT_AT" ]]; then
    echo "[sync-kl] FATAL: could not parse VERSION.json from $TOKYO_SSH_ALIAS: $REMOTE_VERSION" >&2
    exit 1
  fi
fi

echo "[sync-kl] target=$KL_SSH_ALIAS  tag=$TAG  commit=$DEPLOY_COMMIT  builtAt=$BUILT_AT"

# ── 1. Reachability probe ─────────────────────────────────────────────
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$KL_SSH_ALIAS" true 2>/dev/null; then
  echo "[sync-kl] WARN: $KL_SSH_ALIAS unreachable via SSH — graceful skip" >&2
  exit 0
fi

# ── 2. State gates + sync claim (atomic) ──────────────────────────────
# All three preconditions (openclaude inactive, no KL_PROMOTING, pg in
# recovery) and the claim file creation MUST happen atomically inside a
# remote flock — otherwise switchover can start between our check and our
# rsync. switchover.sh takes the same /var/lock/v3-kl-sync.lock and refuses
# to proceed if KL_SYNCING exists.
#
# We use a `flock -n -E 99 -x ...` so flock itself reports lock-contention
# via exit 99, distinct from the inner script's own non-zero exits. Inner
# script exit codes:
#   0   — claim acquired (KL_SYNCING touched)
#   11  — openclaude not inactive
#   12  — KL_PROMOTING present (switchover in flight)
#   13  — pg not in recovery
#   14  — KL_SYNCING already present (stale or concurrent — caller must clear)
#   99  — flock failed (another sync grabbed the lock in this ssh hop)
set +e
ssh "$KL_SSH_ALIAS" 'flock -n -E 99 -x /var/lock/v3-kl-sync.lock -c '"'"'
  mkdir -p /opt/openclaude/migration-ops
  state=$(systemctl is-active openclaude 2>/dev/null || true)
  if [ "$state" != "inactive" ]; then
    echo "openclaude=$state" >&2
    exit 11
  fi
  if [ -f /opt/openclaude/migration-ops/KL_PROMOTING ]; then
    exit 12
  fi
  if [ -f /opt/openclaude/migration-ops/KL_SYNCING ]; then
    exit 14
  fi
  rec=$(sudo -u postgres psql -tAc "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d "[:space:]")
  if [ "$rec" != "t" ]; then
    echo "pg_in_recovery=$rec" >&2
    exit 13
  fi
  touch /opt/openclaude/migration-ops/KL_SYNCING
'"'"
CLAIM_EXIT=$?
set -e
case "$CLAIM_EXIT" in
  0)
    echo "[sync-kl] gates OK: openclaude=inactive, switchover=clear, pg_in_recovery=t — KL_SYNCING claimed"
    ;;
  11)
    echo "[sync-kl] WARN: openclaude not inactive on $KL_SSH_ALIAS — graceful skip" >&2
    exit 0 ;;
  12)
    echo "[sync-kl] WARN: KL_PROMOTING sentinel present — switchover in flight, graceful skip" >&2
    exit 0 ;;
  13)
    echo "[sync-kl] WARN: pg not in recovery on $KL_SSH_ALIAS — KL is not a standby, graceful skip" >&2
    exit 0 ;;
  14)
    echo "[sync-kl] WARN: KL_SYNCING already present on $KL_SSH_ALIAS — another sync running or stale sentinel" >&2
    echo "        to clear stale sentinel: ssh $KL_SSH_ALIAS 'rm /opt/openclaude/migration-ops/KL_SYNCING'" >&2
    exit 0 ;;
  99)
    echo "[sync-kl] WARN: /var/lock/v3-kl-sync.lock contended on $KL_SSH_ALIAS — graceful skip" >&2
    exit 0 ;;
  *)
    echo "[sync-kl] FATAL: unexpected claim exit $CLAIM_EXIT" >&2
    exit 1 ;;
esac

# Release claim AND any local tempfile on any exit (success or failure). All
# cleanup must live in this one EXIT trap — bash only keeps the last `trap
# ... EXIT` registration, so introducing a second trap below would silently
# leak the KL_SYNCING sentinel.
VERSION_TMP_LOCAL=""
cleanup() {
  if [[ -n "$VERSION_TMP_LOCAL" ]]; then
    rm -f "$VERSION_TMP_LOCAL"
  fi
  # If ssh fails here we still must continue (it's an EXIT trap, raising would
  # be confusing), but log a WARN so a stale sentinel is visible at next-deploy
  # diagnosis time rather than silently leaving boss to figure it out.
  if ! ssh "$KL_SSH_ALIAS" "rm -f /opt/openclaude/migration-ops/KL_SYNCING" 2>/dev/null; then
    echo "[sync-kl] WARN: failed to remove KL_SYNCING sentinel on $KL_SSH_ALIAS." >&2
    echo "        Stale sentinel will block the next sync; clear with:" >&2
    echo "        ssh $KL_SSH_ALIAS 'rm /opt/openclaude/migration-ops/KL_SYNCING'" >&2
  fi
}
trap cleanup EXIT

# ── 3. rsync code → KL ────────────────────────────────────────────────
# MUST mirror deploy-v3.sh's RSYNC_OPTS exactly (around line 464). KL and
# commercial-v3 are the same logical master in two regions — any drift in
# exclude paths produces a different file tree on KL than on prod and silently
# breaks switchover. If you touch deploy-v3.sh's exclude list, touch this too.
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
  --exclude=/packages/desktop
  --exclude='dist-types/'
  --exclude='*.tsbuildinfo'
  # KL-specific: the worktree we run from does NOT carry VERSION.json (it's
  # generated transiently per-deploy), so --delete-after would otherwise wipe
  # the live VERSION.json on KL before step 4 rewrites it. Keep VERSION
  # management entirely in step 4.
  --exclude=/VERSION.json
)
echo "[sync-kl] rsync $REPO_ROOT/ → $KL_SSH_ALIAS:/opt/openclaude/openclaude/"
if ! rsync "${RSYNC_OPTS[@]}" "$REPO_ROOT/" "$KL_SSH_ALIAS:/opt/openclaude/openclaude/"; then
  echo "[sync-kl] FATAL: code rsync failed" >&2
  exit 1
fi

# ── 4. VERSION.json (atomic + sha256 verify) ──────────────────────────
# tempfile cleanup is handled by the unified `cleanup` EXIT trap above
VERSION_TMP_LOCAL=$(mktemp -t VERSION.XXXXXX.json)
cat > "$VERSION_TMP_LOCAL" <<EOF
{"tag":"$TAG","commit":"$DEPLOY_COMMIT","builtAt":"$BUILT_AT"}
EOF
LOCAL_SHA=$(sha256sum "$VERSION_TMP_LOCAL" | awk '{print $1}')

echo "[sync-kl] pushing VERSION.json (sha256=$LOCAL_SHA)"
if ! scp -q "$VERSION_TMP_LOCAL" "$KL_SSH_ALIAS:/opt/openclaude/openclaude/.VERSION.json.tmp"; then
  echo "[sync-kl] FATAL: scp VERSION.json failed" >&2
  exit 1
fi
if ! ssh "$KL_SSH_ALIAS" "mv /opt/openclaude/openclaude/.VERSION.json.tmp /opt/openclaude/openclaude/VERSION.json"; then
  echo "[sync-kl] FATAL: remote mv VERSION.json failed" >&2
  exit 1
fi
if ! REMOTE_SHA_LINE=$(ssh "$KL_SSH_ALIAS" "sha256sum /opt/openclaude/openclaude/VERSION.json" 2>/dev/null); then
  echo "[sync-kl] FATAL: could not read remote sha256 of VERSION.json" >&2
  exit 1
fi
REMOTE_SHA=$(printf '%s' "$REMOTE_SHA_LINE" | awk '{print $1}')
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo "[sync-kl] FATAL: VERSION.json sha mismatch local=$LOCAL_SHA remote=$REMOTE_SHA" >&2
  exit 1
fi

# ── 5. changelog.json ─────────────────────────────────────────────────
echo "[sync-kl] rsync changelog.json → $KL_SSH_ALIAS:/root/.openclaude/changelog.json"
if ! rsync -az "$REPO_ROOT/changelog.json" "$KL_SSH_ALIAS:/root/.openclaude/changelog.json"; then
  echo "[sync-kl] FATAL: changelog rsync failed" >&2
  exit 1
fi

# ── 6. Image diff + push (best-effort, image failures are WARN not FATAL) ──
# Pull current runtime image tag lists from both hosts, diff, push what KL
# is missing. We do this via direct commercial-v3 → KL streaming pipe (NOT via
# 45.32 staging) to save trans-Pacific bandwidth.
echo "[sync-kl] computing image diff between $TOKYO_SSH_ALIAS and $KL_SSH_ALIAS"
TOKYO_TAGS=$(ssh "$TOKYO_SSH_ALIAS" "docker images --format '{{.Repository}}:{{.Tag}}' | awk '/^openclaude\\/openclaude-runtime:/ {print}' | sort -u" 2>/dev/null || true)
KL_TAGS=$(ssh "$KL_SSH_ALIAS" "docker images --format '{{.Repository}}:{{.Tag}}' | awk '/^openclaude\\/openclaude-runtime:/ {print}' | sort -u" 2>/dev/null || true)

if [[ -z "$TOKYO_TAGS" ]]; then
  echo "[sync-kl] WARN: $TOKYO_SSH_ALIAS reports no openclaude-runtime images — skipping image phase" >&2
else
  MISSING_TAGS=$(comm -23 <(printf '%s\n' "$TOKYO_TAGS") <(printf '%s\n' "$KL_TAGS"))
  if [[ -z "$MISSING_TAGS" ]]; then
    echo "[sync-kl] image set already aligned ($(printf '%s' "$TOKYO_TAGS" | wc -l) tag(s))"
  else
    while IFS= read -r tag; do
      [[ -n "$tag" ]] || continue
      # Strict whitelist before interpolating into remote shells.
      if ! [[ "$tag" =~ ^openclaude/openclaude-runtime:[A-Za-z0-9._-]+$ ]]; then
        echo "[sync-kl] WARN: refusing to transfer suspect tag '$tag' (regex)" >&2
        continue
      fi
      echo "[sync-kl] streaming image $tag ($TOKYO_SSH_ALIAS → $KL_SSH_ALIAS)"
      START=$(date +%s)
      # pipefail propagates failure from either ssh end; -e then aborts the
      # while-loop iteration, but we wrap in `if ... ; then` so it doesn't kill
      # the whole script (image failures are intentionally non-fatal).
      if ssh "$TOKYO_SSH_ALIAS" "docker save '$tag' | pigz -1" \
           | ssh "$KL_SSH_ALIAS" "pigz -d | docker load" ; then
        ELAPSED=$(( $(date +%s) - START ))
        echo "[sync-kl]   ✓ $tag loaded in ${ELAPSED}s"
      else
        echo "[sync-kl]   WARN: image transfer for $tag failed (KL keeps existing image)" >&2
      fi
    done <<< "$MISSING_TAGS"
  fi
fi

# ── 7. Final sanity probe ─────────────────────────────────────────────
if ! REMOTE_VERSION_FINAL=$(ssh "$KL_SSH_ALIAS" "cat /opt/openclaude/openclaude/VERSION.json" 2>/dev/null); then
  echo "[sync-kl] FATAL: could not read remote VERSION.json for final probe" >&2
  exit 1
fi
# Same single-step sed pattern as the env-fallback parse above (no pipefail trap).
REMOTE_TAG=$(printf '%s' "$REMOTE_VERSION_FINAL" | sed -n 's/.*"tag":"\([^"]*\)".*/\1/p' | head -1)
if [[ "$REMOTE_TAG" != "$TAG" ]]; then
  echo "[sync-kl] FATAL: post-sync VERSION tag mismatch remote='$REMOTE_TAG' expected='$TAG'" >&2
  exit 1
fi

echo "[sync-kl] ✓ KL standby synced to $TAG ($DEPLOY_COMMIT)"
exit 0
