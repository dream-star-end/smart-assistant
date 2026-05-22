#!/bin/bash
echo "=== verify key features ==="
echo -n "config.ts displayName: "; grep -c 'displayName' /opt/openclaude/openclaude/packages/storage/src/config.ts || echo 0
echo -n "cron.ts oneshot: "; grep -c 'oneshot' /opt/openclaude/openclaude/packages/gateway/src/cron.ts || echo 0
echo -n "cron.ts addJob: "; grep -c 'addJob' /opt/openclaude/openclaude/packages/gateway/src/cron.ts || echo 0
echo -n "server.ts /api/cron: "; grep -c 'handleCronApi' /opt/openclaude/openclaude/packages/gateway/src/server.ts || echo 0
echo -n "index.html msg-actions: "; grep -c 'msg-actions' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo -n "index.html ctx-menu: "; grep -c 'ctx-menu' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo -n "index.html /remind: "; grep -c "cmd: '/remind'" /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo -n "index.html persona-display-name: "; grep -c 'persona-display-name' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo -n "index.html exportSessionMd: "; grep -c 'exportSessionMd' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0

echo
echo "=== restart ==="
systemctl restart openclaude
sleep 3
echo -n "status: "; systemctl is-active openclaude
echo
ss -lnt | grep 18789

echo
echo "=== test /api/cron endpoint ==="
TOKEN=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('gateway',{}).get('accessToken',''))")
echo -n "GET /api/cron: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/cron" -H "Authorization: Bearer $TOKEN"
echo
echo -n "POST /api/cron: "; curl -sS "http://127.0.0.1:18789/api/cron" -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"schedule":"0 0 31 12 *","prompt":"test reminder","oneshot":true,"label":"test"}' | head -c 200
echo

echo
echo "=== test agent persona fields ==="
echo -n "GET main agent: "; curl -sS "http://127.0.0.1:18789/api/agents/main" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;a=json.load(sys.stdin)['agent'];print('displayName:', a.get('displayName'), 'avatarEmoji:', a.get('avatarEmoji'), 'greeting:', a.get('greeting'))"

echo
echo "=== last 5 journal lines ==="
journalctl -u openclaude -n 5 --no-pager
