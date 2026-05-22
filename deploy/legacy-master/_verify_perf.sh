#!/bin/bash
echo "=== Process chain (should be 1 process, not 5) ==="
ps -eo pid,ppid,cmd | grep -E 'openclaude|tsx.*gateway' | grep -v grep

echo
echo "=== WAL size after checkpoint ==="
ls -lh /root/.openclaude/sessions.db* 2>/dev/null

echo
echo "=== logrotate config ==="
test -f /etc/logrotate.d/openclaude && echo "OK" || echo "MISSING"

echo
echo "=== Gateway memory ==="
ps -eo pid,rss,cmd | grep 'tsx.*gateway' | grep -v grep
