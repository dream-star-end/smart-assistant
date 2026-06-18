#!/bin/bash
set -euo pipefail
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

# Browser MCP — same browser_* tool contract regardless of backend.
# Backend selected by env: BROWSER_BACKEND=chromium (default) | camoufox.
import os, sys
backend = os.environ.get('BROWSER_BACKEND', 'chromium').strip().lower()
if backend not in ('chromium', 'camoufox'):
    # Production switch: an unknown value must fail loudly, never silently
    # fall back to chromium (that would mask a typo in a deploy command).
    sys.exit(f"FATAL: unknown BROWSER_BACKEND={backend!r}; expected chromium|camoufox")

BROWSER_TOOLS = [
    "browser_navigate", "browser_click", "browser_type", "browser_fill_form",
    "browser_snapshot", "browser_take_screenshot", "browser_press_key",
    "browser_hover", "browser_select_option", "browser_tabs",
    "browser_navigate_back", "browser_wait_for", "browser_evaluate",
    "browser_console_messages", "browser_pdf_save", "browser_close"
]

if backend == 'camoufox':
    # Stealth backend: camoufox (patched Firefox) via a self-contained launcher
    # (/opt/camoufox/camoufox-mcp-launch.py — see deploy/CAMOUFOX.md). The launcher
    # generates a per-launch fingerprint geoip-aligned to the egress proxy exit and
    # routes the browser THROUGH the commercial JP proxy (:18991), so IP + locale +
    # timezone + WebRTC all converge. No --init-script: camoufox does fingerprinting
    # natively (the Chrome browser-stealth.js would be harmful on Firefox).
    # subprocessRunner still appends `--user-data-dir ...`; the launcher passes it
    # through. Requires `bash deploy/_install_camoufox.sh` to have run first.
    # browser_pdf_save is dropped: page.pdf() is Headless-Chromium-only and errors
    # on Firefox, so we don't advertise a tool that can't work on this backend.
    browser_mcp = {
        "id": "browser",
        "command": "/opt/camoufox/venv/bin/python3",
        "args": ["/opt/camoufox/camoufox-mcp-launch.py"],
        "tools": [t for t in BROWSER_TOOLS if t != "browser_pdf_save"],
        "enabled": True
    }
else:
    # Default backend: chromium (unchanged behavior).
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
        "tools": BROWSER_TOOLS,
        "enabled": True
    }

print(f'browser backend: {backend}')
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
echo -n "status: "; systemctl is-active openclaude || true   # diagnostic; don't abort under set -e

echo
echo "=== check app log ==="
tail -10 /var/log/openclaude.log 2>&1 || true
