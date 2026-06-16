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
# Restarting the gateway tears down its detached process group, which kills any
# child `claude` chat subprocesses, so they re-spawn against the new code. (No
# more `pkill -f claude-code-best` — the in-repo fork is gone, and we must NOT
# blanket-kill `claude` lest we also kill the official interactive terminal
# sessions, which are owned by the same gateway but should survive.)
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
