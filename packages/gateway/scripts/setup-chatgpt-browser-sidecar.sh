#!/usr/bin/env bash
# Idempotent provisioner for the ChatGPT real-browser screencast sidecar.
#
# Creates a dedicated Node project with Playwright + a Chromium build at a stable
# path, so the gateway can supervise a headful (Xvfb) browser that the user
# drives remotely. Reuses the shared Playwright browser cache, so Chromium is
# only downloaded if missing. Safe to re-run.
#
#   bash packages/gateway/scripts/setup-chatgpt-browser-sidecar.sh
#
# Env overrides:
#   OPENCLAUDE_CGB_HOME=/opt/openclaude/chatgpt-browser
#   PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
set -euo pipefail

HOME_DIR=${OPENCLAUDE_CGB_HOME:-/opt/openclaude/chatgpt-browser}
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/root/.cache/ms-playwright}

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "[setup] WARNING: Xvfb not found — the sidecar needs it for a headful browser." >&2
  echo "[setup]          install with: apt-get install -y xvfb" >&2
fi

mkdir -p "$HOME_DIR"
cd "$HOME_DIR"

if [[ ! -f package.json ]]; then
  echo "[setup] init node project at $HOME_DIR"
  npm init -y >/dev/null 2>&1
  # keep it ESM so the sidecar can `import`
  node -e "const f='package.json';const p=require(f);p.type='module';p.private=true;require('fs').writeFileSync(f,JSON.stringify(p,null,2))"
fi

echo "[setup] installing playwright + ws (reusing $PLAYWRIGHT_BROWSERS_PATH cache)"
npm install --no-audit --no-fund playwright ws >/dev/null 2>&1

echo "[setup] ensuring a Chromium build is present"
./node_modules/.bin/playwright install chromium >/dev/null 2>&1

node -e "import('playwright').then(p=>{console.log('[setup] playwright OK, chromium at', p.chromium.executablePath())})"
echo "[setup] sidecar runtime ready at $HOME_DIR"
