#!/bin/bash
echo "=== Telegram channel source ==="
ls -la /opt/openclaude/openclaude/packages/channels/telegram/src/ 2>&1
echo
echo "=== grammy installed? ==="
ls /opt/openclaude/openclaude/node_modules/grammy/package.json 2>/dev/null && echo "YES" || echo "NO"
echo
echo "=== config channels ==="
python3 -c "
import json
c = json.load(open('/root/.openclaude/openclaude.json'))
ch = c.get('channels', {})
print('channels keys:', list(ch.keys()))
tg = ch.get('telegram', {})
print('telegram config:', {k: (v[:10]+'...' if isinstance(v, str) and len(v)>10 else v) for k,v in tg.items()})
"
echo
echo "=== gateway.ts channel loading ==="
grep -n 'telegram\|channel.*factory\|channelFactories' /opt/openclaude/openclaude/packages/cli/src/commands/gateway.ts 2>/dev/null | head -20
echo
echo "=== server.ts channel init ==="
grep -n 'channel\|adapter\|telegram' /opt/openclaude/openclaude/packages/gateway/src/server.ts | head -15
echo
echo "=== current processes ==="
ps aux | grep -i grammy | grep -v grep
ps aux | grep -i telegram | grep -v grep
