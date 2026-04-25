#!/usr/bin/env bash
# M8.2 / P2-19 — One-time bootstrap of health-smoke-v3 on a v3 VM.
#
# Run on the v3 VM as root. Idempotent.
#
# What it does:
#   1. install /usr/local/bin/health-smoke-v3.sh                (root:root 0755)
#   2. install /usr/local/bin/health-smoke-v3-runner.sh         (root:root 0700)
#   3. install /usr/local/share/health-smoke/insert-alert.sql   (root:root 0644)
#   4. install /etc/systemd/system/health-smoke-v3.service       (root:root 0644)
#   5. install /etc/systemd/system/health-smoke-v3.timer         (root:root 0644)
#   6. mkdir -m 700 /var/lib/openclaude (for marker file)
#   7. systemctl daemon-reload + enable --now health-smoke-v3.timer
#
# Re-run safety: install -m overwrites; systemctl daemon-reload picks up unit changes;
# enable --now is idempotent. Marker file under /var/lib/openclaude not touched.

set -euo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2; exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SMOKE_SRC="$REPO_ROOT/scripts/health-smoke-v3.sh"
RUNNER_SRC="$SCRIPT_DIR/health-smoke-v3-runner.sh"
SQL_SRC="$SCRIPT_DIR/insert-alert.sql"
UNIT_SVC_SRC="$REPO_ROOT/infra/systemd/health-smoke-v3.service"
UNIT_TIM_SRC="$REPO_ROOT/infra/systemd/health-smoke-v3.timer"

for f in "$SMOKE_SRC" "$RUNNER_SRC" "$SQL_SRC" "$UNIT_SVC_SRC" "$UNIT_TIM_SRC"; do
  if [ ! -f "$f" ]; then
    echo "missing source: $f" >&2; exit 3
  fi
done

echo "[1/6] install /usr/local/bin/health-smoke-v3.sh (0755)"
install -m 0755 -o root -g root "$SMOKE_SRC" /usr/local/bin/health-smoke-v3.sh

echo "[2/6] install /usr/local/bin/health-smoke-v3-runner.sh (0700)"
# 0700: runner reads DATABASE_URL line via grep on /etc/openclaude/commercial.env;
# it doesn't itself contain secrets, but tighter perms = fewer surprises.
install -m 0700 -o root -g root "$RUNNER_SRC" /usr/local/bin/health-smoke-v3-runner.sh

echo "[3/6] install /usr/local/share/health-smoke/insert-alert.sql (0644)"
install -d -m 0755 -o root -g root /usr/local/share/health-smoke
install -m 0644 -o root -g root "$SQL_SRC" /usr/local/share/health-smoke/insert-alert.sql

echo "[4/6] install systemd units"
install -m 0644 -o root -g root "$UNIT_SVC_SRC" /etc/systemd/system/health-smoke-v3.service
install -m 0644 -o root -g root "$UNIT_TIM_SRC" /etc/systemd/system/health-smoke-v3.timer

echo "[5/6] ensure /var/lib/openclaude (0700)"
install -d -m 0700 -o root -g root /var/lib/openclaude

echo "[6/6] systemctl daemon-reload + enable --now health-smoke-v3.timer"
systemctl daemon-reload
systemctl enable --now health-smoke-v3.timer

echo
echo "=== setup complete ==="
echo "Verify:"
echo "  systemctl status health-smoke-v3.timer"
echo "  systemctl list-timers | grep health-smoke"
echo "  systemctl start health-smoke-v3.service        # one-shot trigger"
echo "  tail -F /var/log/health-smoke-v3.log"
