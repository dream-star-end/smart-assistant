#!/bin/bash
echo "=== add browser MCP to openclaude.json ==="
python3 << 'PYEOF'
import json

cfg_path = '/root/.openclaude/openclaude.json'
with open(cfg_path) as f:
    cfg = json.load(f)

# Check if browser MCP already exists
existing_ids = [s['id'] for s in cfg.get('mcpServers', [])]
if 'browser' in existing_ids:
    print('browser MCP already configured, updating...')
    cfg['mcpServers'] = [s for s in cfg['mcpServers'] if s['id'] != 'browser']

# Add browser MCP (no provider field = universal)
browser_mcp = {
    "id": "browser",
    "command": "npx",
    "args": [
        "@playwright/mcp@latest",
        "--headless",
        "--caps", "core,tabs,pdf",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "--init-script", "/root/.openclaude/browser-stealth.js",
        "--viewport-size", "1280x800"
    ],
    "tools": [
        "browser_navigate", "browser_click", "browser_type", "browser_fill_form",
        "browser_snapshot", "browser_take_screenshot", "browser_press_key",
        "browser_hover", "browser_select_option", "browser_tabs",
        "browser_navigate_back", "browser_wait_for", "browser_evaluate",
        "browser_console_messages", "browser_pdf_save", "browser_close"
    ],
    "enabled": True
}

cfg['mcpServers'].append(browser_mcp)

with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print('browser MCP added successfully')
print('total MCP servers:', len(cfg['mcpServers']))
for s in cfg['mcpServers']:
    scope = f' (provider={s["provider"]})' if s.get('provider') else ' (universal)'
    print(f'  - {s["id"]}{scope}')
PYEOF

echo
echo "=== clean temp + restart ==="
rm -rf /tmp/openclaude-*
systemctl restart openclaude
sleep 4
echo -n "status: "; systemctl is-active openclaude

echo
echo "=== check app log ==="
tail -10 /var/log/openclaude.log 2>&1
