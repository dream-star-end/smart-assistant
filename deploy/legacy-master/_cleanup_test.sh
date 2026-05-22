#!/bin/bash
# Remove the test reminder we just created
TOKEN=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('gateway',{}).get('accessToken',''))")
JOBS=$(curl -sS "http://127.0.0.1:18789/api/cron" -H "Authorization: Bearer $TOKEN")
echo "$JOBS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for j in data.get('jobs', []):
    if j.get('label') == 'test':
        print('removing test job:', j['id'])
" 2>/dev/null

# Delete test jobs
for ID in $(echo "$JOBS" | python3 -c "import sys,json;[print(j['id']) for j in json.load(sys.stdin).get('jobs',[]) if j.get('label')=='test']" 2>/dev/null); do
  curl -sS -X DELETE "http://127.0.0.1:18789/api/cron/$ID" -H "Authorization: Bearer $TOKEN"
  echo " deleted $ID"
done
echo "done"
