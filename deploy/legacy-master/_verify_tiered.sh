#!/bin/bash
echo "=== verify files ==="
echo -n "archivalStore: "; test -f /opt/openclaude/openclaude/packages/storage/src/archivalStore.ts && echo "OK" || echo "MISSING"
echo -n "index.ts exports: "; grep -c 'archivalStore' /opt/openclaude/openclaude/packages/storage/src/index.ts || echo 0
echo -n "MCP archival tools: "; grep -c 'archival_add\|archival_search\|archival_delete' /opt/openclaude/openclaude/packages/mcp-memory/src/index.ts || echo 0
echo -n "prompt 三层记忆: "; grep -c '三层记忆' /opt/openclaude/openclaude/packages/gateway/src/subprocessRunner.ts || echo 0
echo -n "cron skill-check: "; grep -c 'skill-check' /opt/openclaude/openclaude/packages/gateway/src/cron.ts || echo 0
echo -n "cron heartbeat: "; grep -c 'heartbeat' /opt/openclaude/openclaude/packages/gateway/src/cron.ts || echo 0
echo -n "lastActiveChannel: "; grep -c 'lastActiveChannel' /opt/openclaude/openclaude/packages/gateway/src/server.ts || echo 0

echo
echo "=== delete old cron.yaml to pick up new defaults ==="
rm -f /root/.openclaude/cron.yaml
echo "deleted"

echo
echo "=== clean temp + restart ==="
rm -rf /tmp/openclaude-*
systemctl restart openclaude
sleep 4
echo -n "status: "; systemctl is-active openclaude

echo
echo "=== verify cron.yaml regenerated with new jobs ==="
grep 'id:' /root/.openclaude/cron.yaml 2>&1

echo
echo "=== check app log ==="
tail -8 /var/log/openclaude.log 2>&1
