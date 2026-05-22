#!/bin/bash
echo "=== check config structure ==="
python3 -c "
import json
c = json.load(open('/root/.openclaude/openclaude.json'))
gw = c.get('gateway', {})
print('gateway keys:', list(gw.keys()))
print('token (first 10):', str(gw.get('token', 'MISSING'))[:10])
print('root keys:', list(c.keys()))
# check if token is at root level
if 'token' in c:
    print('root token (first 10):', str(c['token'])[:10])
"
echo
echo "=== try with different token sources ==="
TOKEN1=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('gateway',{}).get('token',''))")
TOKEN2=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('token',''))")
echo "token1 len: ${#TOKEN1}"
echo "token2 len: ${#TOKEN2}"

echo "hello" > /tmp/t.txt
echo -n "T1: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=/tmp/t.txt" -H "Authorization: Bearer $TOKEN1"
echo
echo -n "T2: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=/tmp/t.txt" -H "Authorization: Bearer $TOKEN2"
echo
echo -n "Query: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=/tmp/t.txt&token=$TOKEN1"
echo
# Try webchat UI endpoint without auth (should work since it's not /api/)
echo -n "healthz: "; curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/healthz"
echo
rm -f /tmp/t.txt
