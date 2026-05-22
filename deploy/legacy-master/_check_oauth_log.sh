#!/bin/bash
echo "=== last 20 lines with oauth ==="
grep -i 'oauth' /var/log/openclaude.log | tail -20
echo
echo "=== last 30 lines ==="
tail -30 /var/log/openclaude.log
