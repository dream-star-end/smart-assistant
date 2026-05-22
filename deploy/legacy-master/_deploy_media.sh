#!/bin/bash
echo "=== verify key patterns in deployed files ==="
echo -n "paths.ts generatedDir: "; grep -c 'generatedDir' /opt/openclaude/openclaude/packages/storage/src/paths.ts || echo 0
echo -n "server.ts mediaMatch: "; grep -c 'mediaMatch' /opt/openclaude/openclaude/packages/gateway/src/server.ts || echo 0
echo -n "server.ts MIME_MAP: "; grep -c 'MIME_MAP' /opt/openclaude/openclaude/packages/gateway/src/server.ts || echo 0
echo -n "server.ts savedMedia: "; grep -c 'savedMedia' /opt/openclaude/openclaude/packages/gateway/src/server.ts || echo 0
echo -n "index.html embedMediaUrls: "; grep -c 'embedMediaUrls' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0
echo -n "index.html lightbox: "; grep -c 'lightbox' /opt/openclaude/openclaude/packages/web/public/index.html || echo 0

echo
echo "=== ensure generated dir exists ==="
mkdir -p /root/.openclaude/generated

echo
echo "=== restart service ==="
systemctl restart openclaude
sleep 3
systemctl is-active openclaude

echo
echo "=== verify listening ==="
ss -lnt | grep 18789

echo
echo "=== last 5 log lines ==="
journalctl -u openclaude -n 5 --no-pager
