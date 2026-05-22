#!/bin/bash
# Trigger a new session to regenerate extra-prompt.md, then check order
sleep 3
echo "=== extra-prompt.md first 20 lines ==="
head -20 /tmp/openclaude-main/extra-prompt.md 2>&1
echo
echo "=== section headers in order ==="
grep '^# ' /tmp/openclaude-main/extra-prompt.md 2>&1
