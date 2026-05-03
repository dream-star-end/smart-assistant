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
# Wrap with `env -u *_PROXY ...` so playwright-mcp + spawned chrome do NOT
# inherit the residential proxy from /etc/openclaude/secrets.env.
# Reason: that proxy exists for claude/codex model-call anti-fingerprinting,
# but Chrome can't auth a URL-embedded user:pass and fails ERR_INVALID_AUTH_CREDENTIALS;
# also GCE Tokyo direct egress is fine for general browsing — proxying is pure cost here.
browser_mcp = {
    "id": "browser",
    "command": "/usr/bin/env",
    "args": [
        "-u", "HTTP_PROXY", "-u", "HTTPS_PROXY",
        "-u", "http_proxy", "-u", "https_proxy",
        "-u", "ALL_PROXY", "-u", "all_proxy",
        "-u", "NO_PROXY", "-u", "no_proxy",
        "/usr/bin/playwright-mcp",
        "--headless",
        "--no-sandbox",
        "--browser", "chrome",
        "--caps", "core,tabs,pdf",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "--init-script", "/root/.openclaude/browser-stealth.js",
        "--viewport-size", "1280x800",
        "--allow-unrestricted-file-access"
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
