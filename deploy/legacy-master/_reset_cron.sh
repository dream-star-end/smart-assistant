#!/bin/bash
echo "=== delete old cron.yaml to pick up new defaults ==="
rm -f /root/.openclaude/cron.yaml

echo "=== set timezone env ==="
# Add TZ to systemd if not present
if ! grep -q 'TZ=' /etc/systemd/system/openclaude.service; then
  sed -i '/^ExecStart=/i Environment="TZ=Asia/Shanghai"' /etc/systemd/system/openclaude.service
  echo "added TZ=Asia/Shanghai"
  systemctl daemon-reload
else
  echo "TZ already set"
fi

echo "=== restart ==="
systemctl restart openclaude
sleep 3
echo -n "status: "; systemctl is-active openclaude

echo
echo "=== verify new cron.yaml ==="
grep -E 'id:|schedule:' /root/.openclaude/cron.yaml | head -10

echo
echo "=== verify timezone ==="
cat /proc/$(pgrep -f 'node.*gateway' | head -1)/environ 2>/dev/null | tr '\0' '\n' | grep TZ
