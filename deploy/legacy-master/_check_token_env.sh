#!/bin/bash
sleep 5
PID=$(pgrep -f 'bun.*cli.tsx' | head -1)
if [ -z "$PID" ]; then
  echo "no bun process yet (need a new session)"
else
  echo "PID=$PID"
  cat /proc/$PID/environ 2>/dev/null | tr '\0' '\n' | grep -E 'CLAUDE_CODE_OAUTH|ANTHROPIC' | head -5
  if cat /proc/$PID/environ 2>/dev/null | tr '\0' '\n' | grep -q 'CLAUDE_CODE_OAUTH_TOKEN'; then
    echo "✓ CLAUDE_CODE_OAUTH_TOKEN is injected"
  else
    echo "✗ CLAUDE_CODE_OAUTH_TOKEN NOT found in process env"
  fi
fi
