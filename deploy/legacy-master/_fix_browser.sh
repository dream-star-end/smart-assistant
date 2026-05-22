#!/bin/bash
echo "=== check what's installed ==="
ls /root/.cache/ms-playwright/ 2>&1
echo
echo "=== install chromium (not just headless shell) ==="
npx playwright install chromium 2>&1 | tail -5
echo
echo "=== verify ==="
ls /root/.cache/ms-playwright/ 2>&1
echo
echo "=== update config to use --browser chromium ==="
python3 << 'PYEOF'
import json
cfg_path = '/root/.openclaude/openclaude.json'
with open(cfg_path) as f:
    cfg = json.load(f)
for srv in cfg.get('mcpServers', []):
    if srv['id'] == 'browser':
        # Ensure --browser chromium is in args
        args = srv['args']
        if '--browser' not in args:
            args.insert(2, '--browser')
            args.insert(3, 'chromium')
        print('browser args:', args)
        break
with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print('config updated')
PYEOF

echo
echo "=== restart ==="
rm -rf /tmp/openclaude-*
systemctl restart openclaude
sleep 3
echo -n "status: "; systemctl is-active openclaude
