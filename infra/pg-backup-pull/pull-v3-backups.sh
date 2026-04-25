#!/usr/bin/env bash
# M7/P1-10 — Pull latest PG dump from each v3 commercial VM to 45.32 (cross-cloud cold copy).
#
# Runs on 45.32 (Vultr Tokyo) as root via cron, daily after the v3 17:15 UTC backup window.
#
# Architecture:
#   - Each v3 VM runs pg-backup-openclaude.timer @ 17:15 UTC, dumps locally
#   - This script runs @ 18:00 UTC, SSHes to each VM as `backup-pull` user
#     (forced-command-restricted, key-only, source-IP-locked) and pulls the latest dump
#   - Two-step protocol: `info` returns (FILENAME, SIZE, SHA256); `fetch=<basename>` streams bytes
#   - Local sha256 verified against server-reported sha; mismatch = abort + Telegram alert
#   - 30-day retention (rotated by mtime)
#   - Per-host marker file `.pull-failed` for OK→FAIL transition alerting (no spam)
#
# Adding a new VM: edit HOSTS array, drop a key, run setup-v3-backup-pull.sh on the VM.
#
# Failure model:
#   - Per-host: failure on host A doesn't block host B (continue)
#   - Telegram alert on first failure transition; recovery alert on first OK after failure
#   - Local marker .pull-failed retained until next OK (so cron-only failures stay visible
#     even if Telegram channel is broken)

set -euo pipefail
umask 077

DEST_ROOT=/var/backups/v3-commercial
LOG=/var/log/pull-v3-backups.log
RETAIN_DAYS=30
SSH_KEY=/root/.ssh/v3-backup-pull
KNOWN_HOSTS=/root/.ssh/known_hosts.v3-pull
SSH_OPTS=(
  -i "$SSH_KEY"
  -o "StrictHostKeyChecking=yes"
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
  -o "BatchMode=yes"
  -o "ConnectTimeout=15"
  -o "ServerAliveInterval=30"
  -o "IdentitiesOnly=yes"
)

# Telegram credentials live in OpenClaude's env file. Source non-fatally; absence
# means we silently skip Telegram (marker still written, journal still has trace).
set +u
# shellcheck disable=SC1091
. /root/.openclaude/.env.keys 2>/dev/null || true
set -u

# host_label:ssh_target — append a row to add a new VM
HOSTS=(
  "v3-staging:backup-pull@34.146.172.239"
)

install -d -m 700 "$DEST_ROOT"
if [ ! -e "$LOG" ]; then install -m 600 /dev/null "$LOG"; fi
chmod 600 "$LOG" 2>/dev/null || true

notify_telegram() {
  local msg="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    return 0
  fi
  curl -fsS --max-time 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    >/dev/null 2>&1 || true
}

fail() {
  local host_dir="$1"
  local label="$2"
  local reason="$3"
  local marker="$host_dir/.pull-failed"
  echo "FAIL($label): $reason" >&2
  if [ ! -e "$marker" ]; then
    touch "$marker"
    notify_telegram "[v3-backup-pull] FAIL $label: $reason"
  fi
}

ok() {
  local host_dir="$1"
  local label="$2"
  local detail="$3"
  local marker="$host_dir/.pull-failed"
  echo "OK($label): $detail"
  if [ -e "$marker" ]; then
    rm -f "$marker"
    notify_telegram "[v3-backup-pull] RECOVERED $label: $detail"
  fi
}

{
  echo
  echo "=== $(date -u +%FT%TZ) pull-v3-backups start ==="

  for entry in "${HOSTS[@]}"; do
    label="${entry%%:*}"
    target="${entry#*:}"
    host_dir="$DEST_ROOT/$label"
    install -d -m 700 "$host_dir"

    # Rotate first to free space if disk tight.
    find "$host_dir" -maxdepth 1 -type f -name '*.dump' -mtime +$RETAIN_DAYS -print -delete
    # Cleanup stale .part (>1d) from prior failed pulls
    find "$host_dir" -maxdepth 1 -type f -name '*.dump.part' -mtime +1 -print -delete

    # 1. info — single SSH returns FILENAME, SIZE, SHA256 atomically
    info=$(ssh "${SSH_OPTS[@]}" "$target" info 2>&1) || {
      fail "$host_dir" "$label" "info call failed: $info"
      continue
    }
    fname=$(printf '%s\n' "$info" | awk -F= '/^FILENAME=/{print $2; exit}')
    expected_size=$(printf '%s\n' "$info" | awk -F= '/^SIZE=/{print $2; exit}')
    expected_sha=$(printf '%s\n' "$info" | awk -F= '/^SHA256=/{print $2; exit}')
    if [ -z "$fname" ] || [ -z "$expected_size" ] || [ -z "$expected_sha" ]; then
      fail "$host_dir" "$label" "bad info response"
      continue
    fi

    local_path="$host_dir/$fname"
    if [ -e "$local_path" ]; then
      ok "$host_dir" "$label" "already pulled $fname"
      continue
    fi

    # 2. fetch=basename — server validates and streams bytes for the exact file we asked about
    if ! ssh "${SSH_OPTS[@]}" "$target" "fetch=$fname" > "$local_path.part" 2>/dev/null; then
      rm -f "$local_path.part"
      fail "$host_dir" "$label" "fetch failed for $fname"
      continue
    fi

    actual_size=$(stat -c%s "$local_path.part" 2>/dev/null || echo 0)
    actual_sha=$(sha256sum "$local_path.part" | awk '{print $1}')

    if [ "$actual_size" != "$expected_size" ]; then
      rm -f "$local_path.part"
      fail "$host_dir" "$label" "size mismatch (expected $expected_size, got $actual_size)"
      continue
    fi
    if [ "$actual_sha" != "$expected_sha" ]; then
      rm -f "$local_path.part"
      fail "$host_dir" "$label" "sha256 mismatch (expected $expected_sha, got $actual_sha)"
      continue
    fi

    mv -f "$local_path.part" "$local_path"
    chmod 600 "$local_path"
    ok "$host_dir" "$label" "pulled $fname ($actual_size bytes, sha256=$actual_sha)"
  done

  echo "=== pull-v3-backups end ==="
} >> "$LOG" 2>&1
