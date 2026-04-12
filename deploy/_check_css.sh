#!/bin/bash
echo "=== check style.css served ==="
TOKEN=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('gateway',{}).get('accessToken',''))")
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/style.css")
echo "GET /style.css: $HTTP_CODE"
HTTP_CODE2=$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:18789/vendor/purify.min.js")
echo "GET /vendor/purify.min.js: $HTTP_CODE2"
echo
echo "=== index.html head ==="
head -25 /opt/openclaude/openclaude/packages/web/public/index.html
echo
echo "=== check if style.css exists and has content ==="
wc -l /opt/openclaude/openclaude/packages/web/public/style.css
head -5 /opt/openclaude/openclaude/packages/web/public/style.css
