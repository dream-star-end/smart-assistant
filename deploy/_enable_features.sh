#!/bin/bash
echo "=== current service env ==="
grep 'Environment=' /etc/systemd/system/openclaude.service

echo
echo "=== adding feature flags ==="
# Check if flags already exist
if grep -q 'FEATURE_FORK_SUBAGENT' /etc/systemd/system/openclaude.service; then
  echo "FORK_SUBAGENT already set"
else
  sed -i '/^ExecStart=/i Environment="FEATURE_FORK_SUBAGENT=1"' /etc/systemd/system/openclaude.service
  echo "added FORK_SUBAGENT"
fi

if grep -q 'CLAUDE_AUTO_BACKGROUND_TASKS' /etc/systemd/system/openclaude.service; then
  echo "AUTO_BACKGROUND already set"
else
  sed -i '/^ExecStart=/i Environment="CLAUDE_AUTO_BACKGROUND_TASKS=1"' /etc/systemd/system/openclaude.service
  echo "added AUTO_BACKGROUND_TASKS"
fi

echo
echo "=== updated service file ==="
grep 'Environment=' /etc/systemd/system/openclaude.service

echo
echo "=== reload + restart ==="
systemctl daemon-reload
systemctl restart openclaude
sleep 3
echo -n "status: "; systemctl is-active openclaude
