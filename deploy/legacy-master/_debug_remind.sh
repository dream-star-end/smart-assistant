#!/bin/bash
echo "=== cron.yaml remind jobs ==="
grep -A5 'remind' /root/.openclaude/cron.yaml 2>/dev/null | head -20

echo
echo "=== last-run.json ==="
cat /root/.openclaude/cron/last-run.json 2>/dev/null

echo
echo "=== current local time ==="
TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S CST'
date '+%Y-%m-%d %H:%M:%S UTC'

echo
echo "=== cron outputs (last 5) ==="
ls -lt /root/.openclaude/cron/outputs/ 2>/dev/null | head -6

echo
echo "=== app log (last 20 lines with cron/remind) ==="
grep -iE 'cron|remind|create_reminder' /var/log/openclaude.log | tail -20

echo
echo "=== check if MCP create_reminder was called ==="
grep -i 'create_reminder\|api/cron.*POST' /var/log/openclaude.log | tail -10
