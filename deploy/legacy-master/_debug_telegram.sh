#!/bin/bash
echo "=== systemd service file ==="
cat /etc/systemd/system/openclaude.service 2>/dev/null

echo
echo "=== test bot token directly ==="
TOKEN=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('channels',{}).get('telegram',{}).get('botToken',''))")
echo "token length: ${#TOKEN}"
curl -sS "https://api.telegram.org/bot${TOKEN}/getMe" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d,indent=2,ensure_ascii=False))"

echo
echo "=== check gateway stdout (last 20 lines) ==="
journalctl -u openclaude --output=cat -n 20 --no-pager 2>&1

echo
echo "=== try quick restart and capture output ==="
systemctl restart openclaude
sleep 5
journalctl -u openclaude --output=cat -n 30 --no-pager 2>&1
