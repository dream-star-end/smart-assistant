#!/bin/bash
echo "=== skills on disk ==="
ls -la /root/.openclaude/agents/main/skills/
echo
echo "=== skill names + descriptions ==="
for d in /root/.openclaude/agents/main/skills/*/; do
  name=$(basename "$d")
  desc=$(grep '^description:' "$d/SKILL.md" | head -1 | sed 's/description: *//; s/^"//; s/"$//')
  echo "  $name — $desc"
done
echo
echo "=== restart to pick up new skills ==="
systemctl restart openclaude
sleep 3
systemctl is-active openclaude
echo
echo "=== check extra-prompt.md has skill list ==="
sleep 5
# The extra-prompt will be generated on next session init, let's check existing ones
find /tmp/openclaude-* -name 'extra-prompt.md' -newer /root/.openclaude/agents.yaml 2>/dev/null | head -3
