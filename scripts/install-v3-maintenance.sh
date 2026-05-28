#!/usr/bin/env bash
# Install production maintenance for claudeai.chat / OpenClaude v3:
#   - logrotate for /var/log/openclaude.log
#   - daily Docker build-cache prune timer
#
# Usage:
#   scripts/install-v3-maintenance.sh [--dry-run]
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '1,12p' "$0"
  exit 0
elif [[ -n "${1:-}" ]]; then
  echo "unknown arg: $1" >&2
  exit 2
fi

write_file() {
  local path="$1"
  local mode="$2"
  local tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "== would write $path mode=$mode =="
    cat "$tmp"
    rm -f "$tmp"
    return
  fi
  install -o root -g root -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  echo "installed $path"
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '== would run == '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

write_file /etc/logrotate.d/openclaude-v3 0644 <<'LOGROTATE'
/var/log/openclaude.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    create 0644 root root
}
LOGROTATE

write_file /etc/systemd/system/openclaude-docker-build-cache-prune.service 0644 <<'SERVICE'
[Unit]
Description=OpenClaude v3 Docker build cache prune
Documentation=https://claudeai.chat/
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker builder prune -af --filter until=72h
ExecStart=/usr/bin/docker image prune -f
SERVICE

write_file /etc/systemd/system/openclaude-docker-build-cache-prune.timer 0644 <<'TIMER'
[Unit]
Description=Daily OpenClaude v3 Docker build cache prune

[Timer]
OnCalendar=*-*-* 04:20:00 UTC
RandomizedDelaySec=20m
Persistent=true
Unit=openclaude-docker-build-cache-prune.service

[Install]
WantedBy=timers.target
TIMER

run_cmd systemctl daemon-reload
run_cmd systemctl enable --now openclaude-docker-build-cache-prune.timer

if [[ "$DRY_RUN" == "0" ]]; then
  echo "== timer =="
  systemctl list-timers --all openclaude-docker-build-cache-prune.timer || true
  echo "== logrotate dry check =="
  logrotate -d /etc/logrotate.d/openclaude-v3 >/tmp/openclaude-v3-logrotate-check.txt 2>&1 || {
    cat /tmp/openclaude-v3-logrotate-check.txt >&2
    exit 1
  }
  tail -20 /tmp/openclaude-v3-logrotate-check.txt
fi
