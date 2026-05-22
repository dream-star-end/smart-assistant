#!/bin/bash
echo "=== OAuth status ==="
grep -i 'oauth' /var/log/openclaude.log | tail -10

echo
echo "=== config auth section ==="
python3 -c "
import json
c = json.load(open('/root/.openclaude/openclaude.json'))
auth = c.get('auth', {})
print('mode:', auth.get('mode'))
oauth = auth.get('claudeOAuth', {})
if oauth:
    print('has accessToken:', bool(oauth.get('accessToken')))
    print('token length:', len(oauth.get('accessToken', '')))
    print('has refreshToken:', bool(oauth.get('refreshToken')))
    print('expiresAt:', oauth.get('expiresAt'))
    import time
    exp = oauth.get('expiresAt', 0) / 1000
    now = time.time()
    remaining = exp - now
    print('expires in:', round(remaining/60), 'minutes' if remaining > 0 else 'EXPIRED')
    print('scope:', oauth.get('scope', ''))
else:
    print('NO claudeOAuth tokens')
"

echo
echo "=== main agent config ==="
python3 -c "
import json, yaml
with open('/root/.openclaude/agents.yaml') as f:
    cfg = yaml.safe_load(f)
for a in cfg.get('agents', []):
    if a['id'] == 'main':
        print('agent main:', json.dumps(a, indent=2, ensure_ascii=False))
"

echo
echo "=== current subprocess env check ==="
ps aux | grep -E 'CLAUDE_CODE_OAUTH' | grep -v grep | head -3
cat /proc/$(pgrep -f 'bun.*cli.tsx' | head -1)/environ 2>/dev/null | tr '\0' '\n' | grep -E 'CLAUDE|OAUTH|ANTHROPIC' | head -10

echo
echo "=== extra-prompt.md provider section ==="
grep -A2 'provider\|Provider' /tmp/openclaude-main/extra-prompt.md 2>/dev/null | head -10
