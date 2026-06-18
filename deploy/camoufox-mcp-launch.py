#!/opt/camoufox/venv/bin/python3
"""camoufox-backed launcher for @playwright/mcp (built-in browser, stealth backend).

This is the ONLY place camoufox specifics live. It is invoked in place of the
plain `playwright-mcp` command when the browser MCP runs with the camoufox
backend (see `_add_browser_mcp.sh`, BROWSER_BACKEND=camoufox). It:

  1. Resolves a per-agent fingerprint config aligned to the egress proxy's exit
     IP (geoip -> locale / timezone / WebRTC ipv4 all match the JP exit). The
     config is CACHED in the agent's profile dir so the SAME agent keeps a STABLE
     fingerprint across browser restarts (a churning fingerprint behind stable
     cookies is itself a detection signal). First launch also avoids a repeat
     geoip network round-trip.
  2. exec()s a *version-pinned* @playwright/mcp with `--browser firefox` pointed
     at the camoufox binary, injecting the fingerprint via CAMOU_CONFIG_* env.

The rest of the browser-MCP plumbing is unchanged: the same browser_* tool
contract (minus browser_pdf_save — see below), and the per-agent
`--user-data-dir ...` that subprocessRunner appends is passed straight through.

browser_pdf_save is NOT advertised for this backend: Playwright's page.pdf() is
Headless-Chromium-only and errors on Firefox ("PDF generation is only supported
for Headless Chromium"). So the camoufox `--caps` omit `pdf` and
`_add_browser_mcp.sh` drops `browser_pdf_save` from the camoufox tool list.

CRITICAL version coupling (root cause of the 2026-06 integration spike):
  camoufox-bin (FF135 / camoufox 0.4.x) speaks Playwright 1.60 Juggler. The
  global @playwright/mcp@latest bundles a newer playwright-core (1.61+) whose
  Juggler adds fields (e.g. setDefaultViewport.isMobile) that the older
  camoufox-bin rejects. So the camoufox path uses its OWN pinned playwright-mcp
  (CAMOUFOX_MCP_BIN). The chromium path keeps @latest, untouched. These two are
  decoupled on purpose; do NOT collapse them onto one playwright-mcp without
  re-pairing the camoufox-bin version. See deploy/CAMOUFOX.md.

Failure model: if camoufox cannot launch at all (missing binary / deps / cache),
this process exits non-zero and the browser MCP simply fails to start — the error
is visible in the app log. It NEVER silently serves a degraded/real-IP browser.
"""

import json
import os
import sys

# --- knobs (env-overridable so the image layout can move without code edits) ---
PROXY = os.environ.get("CAMOUFOX_PROXY", "http://127.0.0.1:18991")
# Pinned playwright-mcp whose playwright-core matches camoufox-bin's Juggler.
MCP_BIN = os.environ.get(
    "CAMOUFOX_MCP_BIN", "/opt/camoufox/mcp/node_modules/.bin/playwright-mcp"
)
# Spoofed OS for the fleet. Real Windows-Firefox is an extremely common config.
SPOOF_OS = os.environ.get("CAMOUFOX_OS", "windows")
# Per-agent fingerprint cache filename (lives inside the agent's profile dir).
FP_CACHE_NAME = ".camoufox-fp.json"

_PROXY_ENV_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
)


def _log(msg: str) -> None:
    sys.stderr.write(f"[camoufox-mcp-launch] {msg}\n")
    sys.stderr.flush()


def _user_data_dir(argv):
    """Extract the per-agent profile dir that subprocessRunner appends, if any."""
    for i, a in enumerate(argv):
        if a == "--user-data-dir" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--user-data-dir="):
            return a.split("=", 1)[1]
    return None


def generate_options():
    """Compute camoufox launch options, aligning geoip to the proxy exit IP.

    Falls back to a pinned JP locale if the live geoip lookup through the proxy
    fails, so a transient proxy hiccup degrades fidelity instead of breaking the
    browser. A genuinely broken install (missing binary/deps) still raises.
    """
    from camoufox.utils import launch_options

    common = dict(
        headless=True,
        os=SPOOF_OS,
        proxy={"server": PROXY},
        i_know_what_im_doing=True,
    )
    try:
        # geoip=True -> camoufox resolves the exit IP *through* the proxy, then
        # derives locale/timezone/geolocation and pins WebRTC ipv4 to that IP.
        return launch_options(geoip=True, **common)
    except Exception as e:  # noqa: BLE001 - degrade geoip only, never the binary
        _log(f"geoip via proxy failed ({e!r}); falling back to locale=ja-JP")
        return launch_options(locale="ja-JP", **common)


def resolve_options(udd):
    """Return {executable_path, env, firefox_user_prefs} for this launch.

    Stable per agent: cache the fingerprint under the profile dir and reuse it so
    restarts of the same agent keep one identity. executable_path is always
    re-resolved (it can move across image rebuilds) and re-validated.
    """
    from camoufox.utils import launch_options

    cache = os.path.join(udd, FP_CACHE_NAME) if udd else None

    cached = None
    if cache and os.path.isfile(cache):
        try:
            cached = json.load(open(cache))
        except Exception as e:  # noqa: BLE001
            _log(f"ignoring corrupt fp cache {cache}: {e!r}")
            cached = None

    if cached and isinstance(cached.get("env"), dict) and cached.get("env"):
        env_extra = cached["env"]
        prefs = cached.get("firefox_user_prefs") or {}
        exe = cached.get("executable_path")
        if not exe or not os.path.exists(exe):
            # Binary moved (image rebuild) — re-resolve path, keep the fingerprint.
            opts = launch_options(headless=True, os=SPOOF_OS, proxy={"server": PROXY},
                                  i_know_what_im_doing=True, locale="ja-JP")
            exe = str(opts["executable_path"])
        _log(f"reusing cached fingerprint from {cache}")
        return str(exe), env_extra, prefs

    opts = generate_options()
    env_extra = {k: str(v) for k, v in (opts.get("env") or {}).items()}
    prefs = opts.get("firefox_user_prefs") or {}
    exe = str(opts["executable_path"])
    if cache:
        try:
            os.makedirs(udd, exist_ok=True)
            tmp = cache + ".tmp"
            json.dump({"executable_path": exe, "env": env_extra,
                       "firefox_user_prefs": prefs}, open(tmp, "w"))
            os.replace(tmp, cache)  # atomic
            _log(f"persisted fingerprint to {cache}")
        except Exception as e:  # noqa: BLE001
            _log(f"could not persist fp cache (non-fatal): {e!r}")
    return exe, env_extra, prefs


def main() -> None:
    passthrough = sys.argv[1:]  # e.g. --user-data-dir /tmp/openclaude-browser-<agentId>
    udd = _user_data_dir(passthrough)

    exe, env_extra, _prefs = resolve_options(udd)

    env = dict(os.environ)
    # Inject the camoufox fingerprint (CAMOU_CONFIG_*) + FONTCONFIG_PATH etc.
    env.update(env_extra)
    # Egress is governed explicitly by --proxy-server below; strip inherited
    # *_PROXY (URL-embedded-auth model-call proxy) so it can't interfere.
    for k in _PROXY_ENV_KEYS:
        env.pop(k, None)

    cmd = [
        MCP_BIN,
        "--headless",
        "--no-sandbox",
        "--browser", "firefox",
        "--executable-path", exe,
        "--proxy-server", PROXY,
        # No `pdf` cap: page.pdf() is Headless-Chromium-only and errors on Firefox.
        "--caps", "core,tabs",
        "--allow-unrestricted-file-access",
        *passthrough,
    ]

    _log(f"exec pinned playwright-mcp (firefox) -> {exe} via {PROXY}")
    # Replace this process: after exec we ARE playwright-mcp; stdio fds (the MCP
    # JSON-RPC channel back to CCB) are preserved.
    os.execvpe(cmd[0], cmd, env)


if __name__ == "__main__":
    main()
