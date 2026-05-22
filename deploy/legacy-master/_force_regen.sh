#!/bin/bash
echo "=== verify memoryStore change on disk ==="
grep -n 'USER IDENTITY' /opt/openclaude/openclaude/packages/storage/src/memoryStore.ts || echo "NOT FOUND"
echo
echo "=== verify subprocessRunner change ==="
grep -n 'User identity FIRST' /opt/openclaude/openclaude/packages/gateway/src/subprocessRunner.ts || echo "NOT FOUND"
echo
echo "=== clean old prompt files ==="
rm -rf /tmp/openclaude-*
echo "cleaned"
echo
echo "=== restart to force regeneration ==="
systemctl restart openclaude
sleep 4
echo
echo "=== new extra-prompt.md first 10 lines ==="
head -10 /tmp/openclaude-main/extra-prompt.md 2>&1
echo
echo "=== section headers in order ==="
grep '^# ' /tmp/openclaude-main/extra-prompt.md 2>&1
