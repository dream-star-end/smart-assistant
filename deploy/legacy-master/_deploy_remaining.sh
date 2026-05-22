#!/bin/bash
mkdir -p /opt/openclaude/openclaude/packages/gateway/src/__tests__
echo "test dir created"
systemctl restart openclaude
sleep 3
echo -n "status: "; systemctl is-active openclaude
echo
echo "=== verify files ==="
ls -lh /opt/openclaude/openclaude/packages/web/public/{index.html,style.css,app.js} 2>&1
echo
echo "=== test run ==="
cd /opt/openclaude/openclaude && npx tsx --test packages/gateway/src/__tests__/security.test.ts 2>&1 | tail -5
