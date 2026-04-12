#!/bin/bash
echo "=== verify new features ==="
echo -n "server.ts /api/file: "; grep -c 'api/file' /opt/openclaude/openclaude/packages/gateway/src/server.ts || echo 0
echo -n "index.html localPathToUrl: "; grep -c 'localPathToUrl' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0

echo
echo "=== restart ==="
systemctl restart openclaude
sleep 3
systemctl is-active openclaude

echo
echo "=== test /api/file endpoint ==="
# Create a test file
echo "hello media test" > /tmp/test-media-endpoint.txt
TOKEN=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('gateway',{}).get('token',''))")
echo -n "GET /api/file?path=/tmp/test-media-endpoint.txt: "
curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=/tmp/test-media-endpoint.txt" -H "Authorization: Bearer $TOKEN"
echo
echo -n "GET /api/file without auth (should 401): "
curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=/tmp/test-media-endpoint.txt"
echo
echo -n "GET /api/file traversal (should 400): "
curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/api/file?path=../etc/passwd" -H "Authorization: Bearer $TOKEN"
echo
rm -f /tmp/test-media-endpoint.txt
echo
echo "=== done ==="
