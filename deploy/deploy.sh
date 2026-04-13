#!/bin/bash
set -e
cd /opt/openclaude/openclaude

echo "=== Pulling latest code ==="
git fetch origin master
BEFORE=$(git rev-parse HEAD)
git reset --hard origin/master
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "Already up to date: $AFTER"
  exit 0
fi

echo "Updated: $BEFORE -> $AFTER"
git log --oneline $BEFORE..$AFTER

echo ""
echo "=== Restarting gateway ==="
# Kill old CCB processes so they pick up new code
pkill -9 -f claude-code-best 2>/dev/null || true
sleep 1
systemctl restart openclaude
sleep 3

if systemctl is-active openclaude > /dev/null 2>&1; then
  echo "=== Deploy OK ==="
  curl -s http://127.0.0.1:18789/healthz
else
  echo "=== Deploy FAILED — gateway not running ==="
  journalctl -u openclaude --no-pager -n 20
  exit 1
fi
