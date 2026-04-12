#!/bin/bash
TOKEN=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('channels',{}).get('telegram',{}).get('botToken',''))")

echo "=== get recent updates (see if bot receives messages) ==="
curl -sS "https://api.telegram.org/bot${TOKEN}/getUpdates?limit=5" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('ok'):
    print('ERROR:', d)
else:
    updates = d.get('result', [])
    print(f'{len(updates)} recent updates')
    for u in updates[-3:]:
        msg = u.get('message', {})
        chat = msg.get('chat', {})
        print(f'  [{u[\"update_id\"]}] from={msg.get(\"from\",{}).get(\"username\",\"?\")} chat={chat.get(\"id\")} text={msg.get(\"text\",\"\")[:60]}')
"

echo
echo "=== check app log for telegram errors (last 20 lines) ==="
tail -20 /var/log/openclaude.log 2>&1
