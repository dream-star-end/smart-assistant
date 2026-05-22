#!/bin/bash
echo "=== USER.md on disk ==="
cat /root/.openclaude/agents/main/USER.md 2>&1
echo
echo "=== MEMORY.md on disk ==="
cat /root/.openclaude/agents/main/MEMORY.md 2>&1
echo
echo "=== extra-prompt.md (injected into agent) ==="
cat /tmp/openclaude-main/extra-prompt.md 2>&1 | head -80
echo
echo "=== check if USER.md block is present ==="
grep -c 'user\|USER\|boss\|What you know' /tmp/openclaude-main/extra-prompt.md 2>&1
