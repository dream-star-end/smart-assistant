#!/bin/bash
echo "=== Content-Type for style.css ==="
curl -sI "http://127.0.0.1:18789/style.css" | grep -i content-type
echo
echo "=== Content-Type for app.js ==="
curl -sI "http://127.0.0.1:18789/app.js" | grep -i content-type
echo
echo "=== check if service worker is caching old version ==="
cat /opt/openclaude/openclaude/packages/web/public/sw.js 2>/dev/null | head -20
