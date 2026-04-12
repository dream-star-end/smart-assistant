#!/bin/bash
# The old inline index.html should still be in git or a backup
# Check git for the last version that had inline CSS
cd /opt/openclaude/openclaude
echo "=== git log for index.html ==="
git log --oneline -5 packages/web/public/index.html 2>/dev/null || echo "no git"

echo
echo "=== check if there's a backup ==="
ls -la /opt/openclaude/openclaude/packages/web/public/index.html.bak 2>/dev/null || echo "no backup"

echo
echo "=== check local deploy source ==="
# The deploy scripts uploaded from Windows, check if old version exists on server
find /root -name "*.html.bak" -o -name "index_old.html" 2>/dev/null | head -3
