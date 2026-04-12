#!/bin/bash
echo "=== verify MCP config includes browser ==="
sleep 2
# Trigger a session to generate mcp-config.json
ls /tmp/openclaude-*/mcp-config.json 2>/dev/null | head -1
if [ -f /tmp/openclaude-main/mcp-config.json ]; then
  echo "mcp-config.json found"
  python3 -c "
import json
with open('/tmp/openclaude-main/mcp-config.json') as f:
    cfg = json.load(f)
servers = cfg.get('mcpServers', {})
print(f'{len(servers)} MCP servers configured:')
for name, srv in servers.items():
    cmd = srv.get('command', '') + ' ' + ' '.join(srv.get('args', [])[:2])
    print(f'  {name}: {cmd}')
if 'browser' in servers:
    print('\n✓ browser MCP is active')
else:
    print('\n✗ browser MCP NOT found')
  "
else
  echo "no mcp-config.json yet (need a session to trigger)"
fi

echo
echo "=== verify stealth script ==="
test -f /root/.openclaude/browser-stealth.js && echo "stealth.js OK" || echo "stealth.js MISSING"

echo
echo "=== verify browser-automation skill ==="
test -f /root/.openclaude/agents/main/skills/browser-automation/SKILL.md && echo "skill OK" || echo "skill MISSING"

echo
echo "=== extra-prompt has browser section? ==="
grep -c '浏览器操作' /tmp/openclaude-main/extra-prompt.md 2>/dev/null || echo "not generated yet"
