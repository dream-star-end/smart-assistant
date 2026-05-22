#!/bin/bash
echo "=== style.css line 1570 ==="
sed -n '1568,1580p' /opt/openclaude/openclaude/packages/web/public/style.css
echo
echo "=== SW version ==="
grep VERSION /opt/openclaude/openclaude/packages/web/public/sw.js
echo
echo "=== curl style.css modal-head ==="
curl -sS "http://127.0.0.1:18789/style.css" | grep -A5 '\.modal-head {' | head -8
