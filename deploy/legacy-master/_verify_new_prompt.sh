#!/bin/bash
rm -rf /tmp/openclaude-*
systemctl restart openclaude
sleep 5

echo "=== new extra-prompt.md section headers ==="
grep '^# ' /tmp/openclaude-main/extra-prompt.md 2>&1

echo
echo "=== first 25 lines (should start with persona) ==="
head -25 /tmp/openclaude-main/extra-prompt.md 2>&1

echo
echo "=== total chars ==="
wc -c /tmp/openclaude-main/extra-prompt.md 2>&1
