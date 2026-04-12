#!/bin/bash
echo "=== last 30 journal lines ==="
journalctl -u openclaude -n 30 --no-pager 2>&1 | grep -iE 'telegram|channel|error|fail|warn'
echo
echo "=== full startup sequence ==="
journalctl -u openclaude -n 50 --no-pager 2>&1 | tail -30
echo
echo "=== telegram adapter source first 50 lines ==="
head -50 /opt/openclaude/openclaude/packages/channels/telegram/src/index.ts
