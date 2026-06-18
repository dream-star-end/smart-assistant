# Camoufox stealth backend for the built-in browser

The built-in browser MCP (`@playwright/mcp`, 16 `browser_*` tools) can run on one
of two backends, selected at config-write time by `BROWSER_BACKEND`:

| backend | binary | egress | fingerprint | default |
|---|---|---|---|---|
| `chromium` | `@playwright/mcp@latest` + Chrome | direct (Tokyo datacenter IP, `env -u *_PROXY`) | JS init-script (`browser-stealth.js`) | ✅ yes |
| `camoufox` | pinned `@playwright/mcp@0.0.70` + camoufox-bin (patched FF135) | **through commercial JP proxy `:18991`** | native C++ injection, geoip-aligned to the proxy exit | opt-in |

**The tool contract is the same for both, with one documented exception:**
camoufox advertises 15 of the 16 `browser_*` tools — it drops `browser_pdf_save`
because Playwright's `page.pdf()` is Headless-Chromium-only and errors on Firefox
("PDF generation is only supported for Headless Chromium"). Advertising a tool
that always errors would be worse than omitting it. Everything else is identical.
This is a *switchable backend*, not a second mechanism.

## Where it runs (deployment context)

The browser MCP is a child of the CCB subprocess, which the gateway spawns via
`TerminalBackend`. With `terminal.type` unset/`local` (the default, and what the
commercial box runs today), CCB + MCP are **host processes** — exactly like the
chromium path's `/usr/bin/playwright-mcp` and `/root/.openclaude/browser-stealth.js`.
So the host-installed `/opt/camoufox` is the correct, reachable location.

If a deploy ever sets `terminal.type=docker`, the camoufox stack must be baked
into / mounted in the runtime image — **the same requirement the chromium path
already has** (its `/usr/bin/playwright-mcp` is not in a stock `node:20-slim`
either). camoufox introduces no new class of deployment dependency; whatever
bakes the chromium browser stack into the image must also run
`_install_camoufox.sh` (or mount `/opt/camoufox`).

## Why a separate, pinned playwright-mcp (the version-coupling red line)

`camoufox-bin` (camoufox 0.4.x / Firefox 135) speaks the **Playwright 1.60**
Juggler protocol. The global `@playwright/mcp@latest` bundles a newer
`playwright-core` (1.61+), whose Juggler added fields the older camoufox-bin
rejects — e.g. `Browser.setDefaultViewport.isMobile`, which makes
`browser_navigate` fail immediately. Verified during the 2026-06 integration spike.

So the camoufox path uses its **own** pinned stack under `/opt/camoufox`:

- `camoufox==0.4.11` + `playwright==1.60.0` (python venv)
- `@playwright/mcp@0.0.70` (bundles `playwright-core` 1.60 — matches camoufox-bin)

The chromium path keeps `@latest` and is untouched. **Do not collapse the two
onto one playwright-mcp** without re-pairing the camoufox-bin version. When
bumping either side, bump the matching pair together and re-run the smoke test.

## Layout (laid down by `deploy/_install_camoufox.sh`)

```
/opt/camoufox/
  venv/                      # python venv: camoufox 0.4.11 + playwright 1.60.0
  mcp/node_modules/.bin/playwright-mcp   # pinned @playwright/mcp@0.0.70
  camoufox-mcp-launch.py     # the launcher (source of truth: deploy/camoufox-mcp-launch.py)
/root/.cache/camoufox/       # camoufox-bin + font pack (~1.3G), fetched once
```

## How the launcher works

`camoufox-mcp-launch.py` is invoked in place of `playwright-mcp`. Per launch it:

1. Resolves the fingerprint for this agent. **First launch:**
   `camoufox.launch_options(os=windows, geoip=True, proxy=:18991)` resolves the
   exit IP **through** `:18991`, derives locale/timezone/geolocation from the
   bundled GeoLite2 db, pins `webrtc:ipv4` to that exit IP, and **caches** the
   result in `<user-data-dir>/.camoufox-fp.json`. **Subsequent launches** of the
   same agent reuse the cache → a **stable identity** across restarts (a churning
   fingerprint behind the agent's persistent cookies would itself be a signal),
   and no repeat geoip round-trip. `executable_path` is always re-validated and
   re-resolved if the binary moved (image rebuild).
2. Injects the fingerprint as `CAMOU_CONFIG_*` env, strips inherited `*_PROXY`.
3. `exec`s the pinned playwright-mcp with `--browser firefox
   --executable-path <camoufox-bin> --proxy-server :18991 --caps core,tabs`,
   passing through any args appended downstream (notably `--user-data-dir`).

Result, verified end-to-end through the MCP tools: `navigator.webdriver=false`,
`platform=Win32`, UA `Firefox/135.0 Windows`, `languages=[ja-JP,ja]`,
`timezone=Asia/Tokyo`, and live egress IP == the `:18991` JP exit.

**Failure model.** If the geoip lookup fails, the launcher degrades to a pinned
`ja-JP` locale (still routed through `:18991`). If camoufox cannot launch *at
all* (missing binary / system deps / cache), the launcher exits non-zero and the
browser MCP simply fails to start — the error is visible in the app log. It never
silently serves a degraded or real-IP browser. `_install_camoufox.sh` Step 7 is a
hard end-to-end gate that catches these before the backend is enabled.

## Enable / disable / verify

```bash
bash deploy/_install_camoufox.sh                       # one-time install
BROWSER_BACKEND=camoufox bash deploy/_add_browser_mcp.sh   # switch to camoufox
BROWSER_BACKEND=chromium bash deploy/_add_browser_mcp.sh   # (or omit) revert to chromium
```

Reverting is just re-running with the default backend — fully reversible.

## Known trade-offs / honest caveats

- **Not a Cloudflare silver bullet.** Bench (residential JP IP, 2026-06): no engine
  — camoufox, CloakBrowser, patchright, baseline — passed Cloudflare *managed
  challenge* on hard targets. camoufox raises **fingerprint/IP consistency**, which
  helps with passive bot-scoring and naive checks; it does not guarantee CF bypass.
- **Image size.** camoufox-bin + font pack ≈ 1.3G (fonts are ~1G; needed so the
  spoofed OS's font metrics match the claimed font list — trimming them weakens the
  font/canvas fingerprint). Compare chromium ~150–200MB.
- **Egress load.** camoufox routes browser traffic through `:18991`; this adds load
  and latency vs the chromium path's direct egress. That routing is the whole point
  (residential-fingerprint + datacenter-IP is itself a detection signal).
- **Granularity (v1).** Backend is a **global** deploy switch. Per-agent / per-task
  opt-in is a clean future extension (subprocessRunner already special-cases the
  `browser` MCP per agent), deliberately deferred to keep this landing small.
- **OS spoof is pinned to Windows.** Per-launch OS rotation is possible (font pack
  covers Win/Mac/Linux) but deferred for predictability.
