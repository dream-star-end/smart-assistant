#!/bin/bash
# Install the camoufox stealth backend for the built-in browser MCP.
#
# This is ADDITIVE: it does NOT touch the default chromium browser stack
# (_install_playwright.sh / @playwright/mcp@latest). It lays down a self-
# contained camoufox stack under /opt/camoufox so the two backends are
# version-decoupled (see deploy/CAMOUFOX.md for the version-coupling rationale).
#
# After this, enable the backend with:  BROWSER_BACKEND=camoufox bash deploy/_add_browser_mcp.sh
#
# Run from the repo root on the box:  bash deploy/_install_camoufox.sh
set -euo pipefail

# --- pinned, validated compatible pair (camoufox-bin <-> playwright juggler) ---
CAMOUFOX_PKG="camoufox==0.4.11"
PLAYWRIGHT_PIN="playwright==1.60.0"
MCP_PIN="@playwright/mcp@0.0.70"   # bundles playwright-core 1.60 (matches camoufox-bin)

PREFIX=/opt/camoufox
VENV="$PREFIX/venv"
MCP_DIR="$PREFIX/mcp"

# Resolve this script's directory so we can copy the launcher source-of-truth.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LAUNCHER_SRC="$SCRIPT_DIR/camoufox-mcp-launch.py"
if [ ! -f "$LAUNCHER_SRC" ]; then
  echo "FATAL: launcher not found at $LAUNCHER_SRC" >&2
  echo "Run this from the repo (so deploy/camoufox-mcp-launch.py is alongside)." >&2
  exit 1
fi

echo "=== Step 1: Firefox runtime deps (camoufox-bin is a patched Firefox) ==="
# Reuse the GLOBAL playwright just to pull system libs for firefox; harmless to the chromium path.
npx --yes playwright install-deps firefox 2>&1 | tail -5 || echo "(install-deps firefox best-effort)"

echo
echo "=== Step 2: Python venv + camoufox (pinned pair) ==="
mkdir -p "$PREFIX"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip >/dev/null
"$VENV/bin/pip" install "$CAMOUFOX_PKG" "$PLAYWRIGHT_PIN" 2>&1 | tail -6

echo
echo "=== Step 3: Fetch camoufox binary + font pack (~1.3G, includes OS font sets) ==="
# HOME governs the cache dir (/root/.cache/camoufox). launch_options() auto-discovers it.
HOME="${HOME:-/root}" "$VENV/bin/python" -m camoufox fetch 2>&1 | tail -8

echo
echo "=== Step 4: Pinned playwright-mcp for the camoufox path ($MCP_PIN) ==="
mkdir -p "$MCP_DIR"
npm install --prefix "$MCP_DIR" "$MCP_PIN" 2>&1 | tail -4
MCP_BIN="$MCP_DIR/node_modules/.bin/playwright-mcp"
test -x "$MCP_BIN" || { echo "FATAL: pinned playwright-mcp missing at $MCP_BIN" >&2; exit 1; }
echo -n "pinned playwright-core: "
python3 -c "import json;print(json.load(open('$MCP_DIR/node_modules/playwright-core/package.json'))['version'])"

echo
echo "=== Step 5: Install launcher ==="
install -m 755 "$LAUNCHER_SRC" "$PREFIX/camoufox-mcp-launch.py"
echo "launcher -> $PREFIX/camoufox-mcp-launch.py"

echo
echo "=== Step 6: Record a version manifest (auditable pinned set) ==="
{
  echo "# camoufox stealth backend — installed $(date -u +%FT%TZ 2>/dev/null || echo unknown)"
  echo "pip: $CAMOUFOX_PKG $PLAYWRIGHT_PIN"
  echo "mcp: $MCP_PIN"
  "$VENV/bin/pip" freeze 2>/dev/null | grep -iE "^(camoufox|playwright|browserforge)==" || true
  echo -n "playwright-core: "; python3 -c "import json;print(json.load(open('$MCP_DIR/node_modules/playwright-core/package.json'))['version'])"
} > "$PREFIX/manifest.txt"
cat "$PREFIX/manifest.txt"

echo
echo "=== Step 7: End-to-end MCP smoke test (HARD GATE) ==="
# Drives the *installed* launcher through the real MCP stdio contract: navigate +
# evaluate the spoofed fingerprint, routed through :18991. This catches missing
# firefox system deps, version mismatch, a down proxy, or a bad cache — anything
# that would make the browser unusable in production. Fails the install if broken.
HOME="${HOME:-/root}" "$VENV/bin/python" - "$PREFIX/camoufox-mcp-launch.py" "$VENV/bin/python3" <<'PY'
import json, os, subprocess, sys, time, select, tempfile
launcher, py = sys.argv[1], sys.argv[2]
udd = tempfile.mkdtemp(prefix="camoufox-smoke-")
p = subprocess.Popen([py, launcher, "--user-data-dir", udd],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, text=True, bufsize=1)
def send(o): p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()
def rd(t=80):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], max(0, end - time.time()))
        if r:
            l = p.stdout.readline()
            if l.strip():
                try: return json.loads(l)
                except Exception: pass
        elif p.poll() is not None:
            return None
    return None
ok = False
try:
    send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}})
    if not rd(40): raise SystemExit("initialize failed / no response")
    send({"jsonrpc":"2.0","method":"notifications/initialized"})
    send({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com"}}})
    nav = rd(70)
    if not nav or (nav.get("result") or {}).get("isError"):
        raise SystemExit(f"navigate failed: {json.dumps(nav)[:300] if nav else 'timeout'}")
    send({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_evaluate","arguments":{"function":"() => JSON.stringify({wd:navigator.webdriver, plat:navigator.platform, tz:Intl.DateTimeFormat().resolvedOptions().timeZone})"}}})
    ev = rd(40)
    try:
        text = ev["result"]["content"][0]["text"]
    except Exception:
        text = json.dumps(ev) if ev else ""
    if "Win32" in text and "false" in text:
        print("  OK: navigate + camoufox fingerprint (webdriver=false, Win32) verified")
        ok = True
    else:
        raise SystemExit(f"fingerprint check failed: {text[:300]}")
finally:
    p.terminate()
    try: p.wait(5)
    except Exception: p.kill()
    if not ok:
        sys.stderr.write("  STDERR: " + (p.stderr.read() or "")[-500:] + "\n")
sys.exit(0 if ok else 1)
PY
echo
echo "=== Done. Enable with: BROWSER_BACKEND=camoufox bash deploy/_add_browser_mcp.sh ==="
